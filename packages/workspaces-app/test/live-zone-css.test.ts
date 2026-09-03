import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The live zone's stylesheet contract (meeting-live-zone.ts). happy-dom
 * lays nothing out, so what the browser measurement in the PR proves — the
 * transcript's first line within one prose line-height of the doc's last
 * line — is guarded here by the two declarations that produce it: the zone
 * brings no top margin of its own (the paragraph's bottom margin is the
 * whole gap), and the label floats into the corner instead of taking a row
 * above the words.
 */
const CSS = readFileSync(resolve('packages/workspaces-app/src/styles.css'), 'utf8');

function rule(selector: string): string {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  return at?.[2] ?? '';
}

describe('the transcript starts on the next line down from the doc', () => {
  it('the zone adds no top margin of its own', () => {
    const zone = rule('.live-zone');
    expect(zone, 'the zone has no rule at all').not.toBe('');
    const margin = /margin:\s*([^;]+);/.exec(zone)?.[1]?.trim() ?? '';
    expect(margin.split(/\s+/)[0]).toBe('0');
    expect(zone).not.toMatch(/margin-top:\s*[1-9]/);
  });

  it('the label floats into the corner rather than taking a row above the words', () => {
    expect(rule('.lz-head')).toMatch(/float:\s*right/);
  });

  it('the split-off card is not positioned, so it cannot paint over the floated label', () => {
    expect(rule('.lz-chunk')).not.toMatch(/position:/);
  });

  it('turns are inline and the stream has no per-turn block rule left', () => {
    expect(rule('.lz-turn')).toMatch(/display:\s*inline/);
    expect(rule('.lz-line')).toBe('');
    expect(rule('.lz-ts')).toBe('');
  });
});
