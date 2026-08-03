import { describe, expect, it } from 'vitest';
import { normalizeMarkdown } from '../src/prose.ts';

/**
 * Sync arbitration treats normalizeMarkdown(disk) === serialized(live) as
 * "in-sync, don't touch the file". That is only safe if serializer output is
 * a FIXED POINT of the round-trip — if it ever isn't, suppression can fire
 * while the live doc has un-flushed edits and swallow the flush re-arm, and
 * those edits silently never reach disk. Pin the property.
 */
const FIXTURES: Record<string, string> = {
  simple: '# Title\n\nA paragraph.\n\n## Section\n\nAnother one.\n',
  frontmatter: '---\ntitle: Doc\ntags: [a, b]\n---\n\n# Body\n\nText.\n',
  'nested lists': [
    '- top one',
    '  - nested a',
    '  - nested b',
    '- top two',
    '',
    '  continuation paragraph of top two',
    '',
    '1. ordered',
    '2. items',
    '',
  ].join('\n'),
  'fence with blank line': '```mermaid\nflowchart TB\n    a --> b\n\n    c --> d\n```\n',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  blockquote: '> quoted line one\n> quoted line two\n',
  'drifty blank runs': '# T\n\n\n\nBody text.\n\n\n## S\n\nMore.\n',
  'inline junk': 'Text with `code`, **bold**, <br/> and a [link](https://x.example).\n',
};

describe('normalizeMarkdown', () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    it(`is idempotent on ${name}`, () => {
      const once = normalizeMarkdown(md);
      expect(normalizeMarkdown(once)).toBe(once);
    });
  }

  it('returns empty for empty and whitespace-only input', () => {
    expect(normalizeMarkdown('')).toBe('');
    expect(normalizeMarkdown('   \n\n  \n')).toBe('');
  });

  it('collapses pure formatting drift to the same normal form', () => {
    const clean = '# T\n\nBody.\n';
    const drifty = '# T\n\n\n\nBody.\n\n';
    expect(normalizeMarkdown(drifty)).toBe(normalizeMarkdown(clean));
  });
});
