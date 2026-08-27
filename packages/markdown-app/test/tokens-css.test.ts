import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPEN_PROPS_FILES } from '../src/tokens-manifest.ts';

/**
 * The Open Props trial layer (board task t-9Ujf8EcjSpbR).
 *
 * `/app/tokens.css` is built by concatenating the vendored Open Props subset
 * (tokens-manifest.ts) with the mapping layer in `src/tokens.css`. These
 * tests pin the three ways that composition can silently rot:
 *
 *  1. the mapping references an Open Props var whose file was dropped from
 *     the manifest — the var() falls back to nothing and the token computes
 *     to the guaranteed-invalid initial value, with no build error anywhere;
 *  2. the mapping invents a NEW token name instead of remapping an existing
 *     one — call sites were promised to keep their names, so a name that
 *     styles.css neither defines nor reads is a typo, not a mapping;
 *  3. the shells load tokens.css BEFORE styles.css — both define the same
 *     `:root` custom properties at equal specificity, so document order is
 *     the only thing that lets the trial layer win. (Removing the link is
 *     the designed way to revert the whole trial.)
 */

const here = import.meta.dirname;
const pkgRoot = resolve(here, '..');
const TOKENS = readFileSync(join(pkgRoot, 'src', 'tokens.css'), 'utf8');
const STYLES = readFileSync(join(pkgRoot, 'src', 'styles.css'), 'utf8');
const INDEX = readFileSync(join(pkgRoot, 'index.html'), 'utf8');

// Resolve exactly the way scripts/build.ts does: from this package's root,
// where the open-props dependency is declared.
const req = createRequire(join(pkgRoot, 'package.json'));

/** CSS with its comments removed — prose about `var(--name, …)` is not a
 *  reference, and both stylesheets narrate their tokens heavily. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every custom property NAME defined (`--x:`) in the given CSS text. */
function definedProps(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/--([\w-]+)\s*:/g)].map((m) => `--${m[1]}`));
}

/** Every custom property NAME read via `var(--x…)` in the given CSS text. */
function referencedProps(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/var\(\s*--([\w-]+)/g)].map((m) => `--${m[1]}`));
}

describe('open-props vendored subset (tokens-manifest.ts)', () => {
  it('every manifest file resolves from the installed package', () => {
    expect(OPEN_PROPS_FILES.length).toBeGreaterThan(0);
    for (const file of OPEN_PROPS_FILES) {
      const path = req.resolve(`open-props/${file}`);
      expect(readFileSync(path, 'utf8')).toContain('--');
    }
  });

  it('defines every open-props var the mapping layer reads', () => {
    const shipped = definedProps(
      OPEN_PROPS_FILES.map((f) => readFileSync(req.resolve(`open-props/${f}`), 'utf8')).join('\n'),
    );
    // Positive control: the subset really carries the scales the mapping
    // leans on — an empty `shipped` must not pass vacuously.
    expect(shipped.has('--gray-9')).toBe(true);
    expect(shipped.has('--shadow-5')).toBe(true);

    const defined = definedProps(TOKENS);
    const referenced = referencedProps(TOKENS);
    expect(referenced.size).toBeGreaterThan(0);
    const unresolved = [...referenced].filter((p) => !defined.has(p) && !shipped.has(p));
    expect(unresolved, `tokens.css reads vars no vendored file defines: ${unresolved}`).toEqual([]);
  });
});

describe('tokens.css mapping layer', () => {
  it('remaps the core semantic tokens rather than a partial set', () => {
    const defined = definedProps(TOKENS);
    for (const name of [
      '--fg',
      '--bg-panel',
      '--bg-hover',
      '--border',
      '--border-strong',
      '--accent',
      '--orange',
      '--red',
      '--green',
      '--green-strong',
      '--red-strong',
      '--radius',
      '--shadow',
      '--shadow-lg',
    ]) {
      expect(defined.has(name), `${name} missing from tokens.css`).toBe(true);
    }
  });

  it('introduces no token name styles.css neither defines nor reads', () => {
    const known = new Set([...definedProps(STYLES), ...referencedProps(STYLES)]);
    // Positive control: styles.css parsing found the base tokens.
    expect(known.has('--fg')).toBe(true);
    expect(known.has('--warn-wash')).toBe(true);
    const invented = [...definedProps(TOKENS)].filter((p) => !known.has(p));
    expect(invented, `tokens.css defines names no call site uses: ${invented}`).toEqual([]);
  });
});

describe('shell link order', () => {
  it('index.html links styles.css first, then tokens.css', () => {
    const styles = INDEX.indexOf('/app/styles.css');
    const tokens = INDEX.indexOf('/app/tokens.css');
    expect(styles).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(styles);
  });
});
