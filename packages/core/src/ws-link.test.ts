import { describe, expect, it } from 'vitest';
import { parseWorkspaceLink } from './ws-link.ts';

/** All ids below are synthetic fixtures — the repo is public. */
const HOST = 'http://reviewhost.example:8787';

describe('parseWorkspaceLink', () => {
  it('parses a workspace hub URL', () => {
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

  it('parses doc URLs in both address shapes', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/docs/doc-1`)).toEqual({
      kind: 'doc',
      workspaceId: 'w-abc123',
      docId: 'doc-1',
    });
    expect(parseWorkspaceLink(`${HOST}/review/doc-1`)).toEqual({
      kind: 'doc',
      workspaceId: null,
      docId: 'doc-1',
    });
    // Relative path with no host — sidebar/board comments use these.
    expect(parseWorkspaceLink('/review/doc-1')).toEqual({
      kind: 'doc',
      workspaceId: null,
      docId: 'doc-1',
    });
  });

  it('decodes percent-encoded ids', () => {
    expect(parseWorkspaceLink(`${HOST}/review/set%3Areadme.md`)).toEqual({
      kind: 'doc',
      workspaceId: null,
      docId: 'set:readme.md',
    });
  });

  it('parses mockup URLs in both address shapes', () => {
    expect(parseWorkspaceLink(`${HOST}/workspaces/w-abc123/mockups/mock-1`)).toEqual({
      kind: 'mockup',
      workspaceId: 'w-abc123',
      docId: 'mock-1',
    });
    expect(parseWorkspaceLink(`${HOST}/mockup/mock-1`)).toEqual({
      kind: 'mockup',
      workspaceId: null,
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
