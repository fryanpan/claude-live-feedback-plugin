import { describe, expect, it } from 'vitest';
import { parseWorkspaceLink } from './ws-link.ts';

/** All ids below are synthetic fixtures — the repo is public. */
const HOST = 'http://reviewhost.example:8787';

describe('parseWorkspaceLink', () => {
  it('parses a workspace board URL', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123`)).toEqual({
      kind: 'workspace',
      workspaceId: 'w-abc123',
    });
    // Trailing slash tolerated — a hand-trimmed paste often carries one.
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/`)).toEqual({
      kind: 'workspace',
      workspaceId: 'w-abc123',
    });
  });

  it('parses a task deep link (?task= on the board URL)', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123?task=t-42fixture`)).toEqual({
      kind: 'task',
      workspaceId: 'w-abc123',
      taskId: 't-42fixture',
    });
  });

  it('parses a task deep link copied from a nav page — /home carries ?task= too', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/home?task=t-42fixture`)).toEqual({
      kind: 'task',
      workspaceId: 'w-abc123',
      taskId: 't-42fixture',
    });
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/mine`)).toEqual({
      kind: 'workspace',
      workspaceId: 'w-abc123',
    });
  });

  it('parses a goal deep link (?goal= on the board URL)', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123?goal=t-goalfix9`)).toEqual({
      kind: 'goal',
      workspaceId: 'w-abc123',
      goalId: 't-goalfix9',
    });
    // Task wins over goal, matching the board's own panel rule.
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123?task=t-1&goal=t-2`)).toEqual({
      kind: 'task',
      workspaceId: 'w-abc123',
      taskId: 't-1',
    });
  });

  it('a thread param does not change what the link addresses', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123?task=t-1&thread=th-9`)).toEqual({
      kind: 'task',
      workspaceId: 'w-abc123',
      taskId: 't-1',
    });
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/docs/doc-1?thread=th-9`)).toEqual({
      kind: 'doc',
      workspaceId: 'w-abc123',
      docId: 'doc-1',
    });
  });

  it('parses a doc URL, absolute or root-relative', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/docs/doc-1`)).toEqual({
      kind: 'doc',
      workspaceId: 'w-abc123',
      docId: 'doc-1',
    });
    // Relative path with no host — sidebar/board comments use these.
    expect(parseWorkspaceLink('/workspaces/w-abc123/docs/doc-1')).toEqual({
      kind: 'doc',
      workspaceId: 'w-abc123',
      docId: 'doc-1',
    });
  });

  it('CONTROL: the deleted `/review/` and `/mockup/` shapes parse as nothing', () => {
    // A doc without the board that owns it is not an address any more. These
    // two spellings named no workspace, which is exactly why the cutover
    // removed them — leaving them parseable would keep a second address alive
    // in every comment the board renders.
    expect(parseWorkspaceLink(`${HOST}/review/doc-1`)).toBeNull();
    expect(parseWorkspaceLink('/review/doc-1')).toBeNull();
    expect(parseWorkspaceLink(`${HOST}/mockup/mock-1`)).toBeNull();
  });

  it('decodes percent-encoded ids', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/docs/set%3Areadme.md`)).toEqual({
      kind: 'doc',
      workspaceId: 'w-abc123',
      docId: 'set:readme.md',
    });
  });

  it('parses a mockup URL', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/mockups/mock-1`)).toEqual({
      kind: 'mockup',
      workspaceId: 'w-abc123',
      docId: 'mock-1',
    });
  });

  it('parses a review URL', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/reviews/set-9`)).toEqual({
      kind: 'review',
      workspaceId: 'w-abc123',
      reviewId: 'set-9',
    });
  });

  it('returns null for everything else', () => {
    expect(parseWorkspaceLink('https://example.com/')).toBeNull();
    expect(parseWorkspaceLink('https://github.com/owner/repo/pull/1')).toBeNull();
    expect(parseWorkspaceLink(`${HOST}/`)).toBeNull();
    expect(parseWorkspaceLink(`${HOST}/api/docs`)).toBeNull();
    expect(parseWorkspaceLink(`${HOST}/s/sharetoken`)).toBeNull();
    expect(parseWorkspaceLink('mailto:someone@example.com')).toBeNull();
    expect(parseWorkspaceLink('not a url')).toBeNull();
    expect(parseWorkspaceLink('')).toBeNull();
    // Deeper paths under a doc are not the doc.
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/docs/doc-1/extra`)).toBeNull();
  });
});
