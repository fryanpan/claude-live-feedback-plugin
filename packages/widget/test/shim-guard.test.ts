import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertShimCovers,
  exportedNames,
  pickCondition,
  resolveBrowserEsm,
} from '../scripts/shim-guard.ts';

/**
 * The widget stands two lib0 modules in for the real ones to stay under its
 * bundle budget. A shim short an export does not fail to build — it ships
 * `undefined` into lib0 and surfaces as a runtime TypeError on someone's host
 * page. So the build refuses to run when the lists diverge, and these pin that
 * it actually would: a guard nobody has watched fail is not a guard.
 */

const widgetRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const shims = join(widgetRoot, 'scripts', 'shims');

describe('exportedNames', () => {
  it('reads const, function and class declarations', () => {
    const names = exportedNames(
      ['export const a = 1;', 'export function b() {}', 'export class C {}'].join('\n'),
    );
    expect([...names].sort()).toEqual(['C', 'a', 'b']);
  });

  it('reads a re-export list, using the alias that is visible to importers', () => {
    const names = exportedNames("export { A, B as C } from './x.js'");
    expect([...names].sort()).toEqual(['A', 'C']);
  });

  it('ignores a non-exported declaration', () => {
    expect([...exportedNames('const hidden = 1;\nexport const shown = 2;')]).toEqual(['shown']);
  });
});

describe('resolveBrowserEsm', () => {
  it('lands on the ES source, not the CommonJS build', () => {
    // The bug this pins: require.resolve() follows the `require` condition and
    // returns dist/logging.node.cjs, whose source declares no `export` at all,
    // so every shim compared clean against an empty set.
    const p = resolveBrowserEsm('lib0/logging', widgetRoot);
    expect(p.endsWith('/lib0/logging.js')).toBe(true);
    expect(p).not.toContain('/dist/');
    expect(exportedNames(readFileSync(p, 'utf8')).size).toBeGreaterThan(5);
  });

  it('prefers the browser condition over node', () => {
    expect(
      pickCondition({ node: './n.js', browser: { module: './b.js', default: './b2.js' } }),
    ).toBe('./b.js');
  });

  it('follows a plain string entry', () => {
    expect(pickCondition('./x.js')).toBe('./x.js');
  });

  it('returns undefined when no condition matches', () => {
    expect(pickCondition({ types: './t.d.ts' })).toBeUndefined();
  });
});

describe('assertShimCovers', () => {
  it('passes for the logging shim the build actually uses', () => {
    expect(() =>
      assertShimCovers('lib0/logging', join(shims, 'lib0-logging.js'), widgetRoot),
    ).not.toThrow();
  });

  it('passes for the environment shim the build actually uses', () => {
    expect(() =>
      assertShimCovers('lib0/environment', join(shims, 'lib0-environment.js'), widgetRoot),
    ).not.toThrow();
  });

  it('names the missing export when a shim does not cover the real module', () => {
    // lib0/logging against the environment shim: two unrelated surfaces, so
    // this fails the way a drifted shim would, and must say what is missing.
    expect(() =>
      assertShimCovers('lib0/logging', join(shims, 'lib0-environment.js'), widgetRoot),
    ).toThrow(/missing .* export\(s\) that lib0\/logging declares: .*\bprint\b/);
  });

  it('explains itself when the real module cannot be resolved', () => {
    expect(() =>
      assertShimCovers('lib0/not-a-real-module', join(shims, 'lib0-logging.js'), widgetRoot),
    ).toThrow(/cannot resolve/);
  });
});
