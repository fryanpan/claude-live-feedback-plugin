import { describe, expect, it } from 'vitest';
import { extractWorkspaceLinks } from './md-links.ts';

const HOST = 'https://feedback.example.com';

describe('extractWorkspaceLinks', () => {
  it('reads all three spellings: markdown links, bare absolute, bare root-relative', () => {
    const md = [
      `See [the plan](${HOST}/workspaces/w-abc123/docs/d-plan42) first.`,
      `Then ${HOST}/workspaces/w-abc123?task=t-42fixture and the notes at /workspaces/w-abc123/docs/huddle-0817.`,
    ].join('\n');
    const links = extractWorkspaceLinks(md);
    expect(links.map((l) => l.link)).toEqual([
      { kind: 'doc', workspaceId: 'w-abc123', docId: 'd-plan42' },
      { kind: 'task', workspaceId: 'w-abc123', taskId: 't-42fixture' },
      { kind: 'doc', workspaceId: 'w-abc123', docId: 'huddle-0817' },
    ]);
  });

  it('drops non-workspace URLs and text without links', () => {
    const md =
      'See https://github.com/o/r/pull/9 and [docs](https://example.com/page). A 1/2 ratio.';
    expect(extractWorkspaceLinks(md)).toEqual([]);
  });

  it('dedupes a URL written twice and trims sentence punctuation off a bare URL', () => {
    const url = `${HOST}/workspaces/w-abc123?goal=g-7fixture`;
    const md = `Goal: ${url}. And again [here](${url}).`;
    const links = extractWorkspaceLinks(md);
    expect(links).toHaveLength(1);
    expect(links[0]?.link).toEqual({ kind: 'goal', workspaceId: 'w-abc123', goalId: 'g-7fixture' });
  });

  it('reads a goal deep link and a mockup path as their own kinds', () => {
    const md =
      '[the goal](/workspaces/w-abc123?goal=g-7fixture) beside /workspaces/w-abc123/mockups/nav-sketch';
    expect(extractWorkspaceLinks(md).map((l) => l.link.kind)).toEqual(['goal', 'mockup']);
  });

  it('does not read an unanchored slash path as a link', () => {
    // `/workspaces/...` only counts at a boundary — mid-word slashes (file
    // paths, fractions) must not match.
    const md = 'path packages/workspaces/thing and code`/workspaces/w-1/docs/x`';
    const links = extractWorkspaceLinks(md);
    // The backtick is not in the boundary set, and `packages/workspaces/` is
    // mid-word — assert exactly what qualifies.
    expect(links.map((l) => l.url)).toEqual([]);
  });
});
