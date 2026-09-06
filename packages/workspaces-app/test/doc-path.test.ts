import { describe, expect, it } from 'vitest';
import {
  docHref,
  docIdFromPath,
  docIdFromPathOrNull,
  workspaceIdFromPath,
} from '../src/doc-path.ts';

describe('docIdFromPath', () => {
  it('reads a doc under the workspace path', () => {
    expect(docIdFromPath('/workspaces/w-1/docs/auth-rfc')).toBe('auth-rfc');
  });

  it('does NOT read the deleted /review/ path — an old bookmark names no doc', () => {
    // The cutover deleted the address and the parse together: recognising the
    // old shape here is the dual-address the cutover exists to remove, and a
    // doc id without the board that owns it cannot be read anyway.
    expect(docIdFromPath('/review/auth-rfc')).toBe('default');
    expect(docIdFromPathOrNull('/review/auth-rfc')).toBeNull();
  });

  it('decodes an encoded member docId', () => {
    // Review members are `<reviewId>:<relPath with / as ~>`, so the colon
    // arrives percent-encoded.
    expect(docIdFromPath('/workspaces/w-1/docs/rev-1%3Asrc~app.ts')).toBe('rev-1:src~app.ts');
  });

  it('ignores query and hash', () => {
    expect(docIdFromPath('/workspaces/w-1/docs/d?mobile=iphone#c1')).toBe('d');
  });

  it('accepts an absolute URL, which sidebar hrefs can be', () => {
    expect(docIdFromPath('http://host:8787/workspaces/w-1/docs/d')).toBe('d');
  });

  it('falls back to `default` off a doc path, matching the old behaviour', () => {
    expect(docIdFromPath('/workspaces/w-1')).toBe('default');
    expect(docIdFromPath('/')).toBe('default');
  });

  it('does not read a mockup path as a doc — a different surface entirely', () => {
    expect(docIdFromPath('/workspaces/w-1/mockups/m')).toBe('default');
  });
});

describe('workspaceIdFromPath', () => {
  it('reads the workspace the page is under', () => {
    expect(workspaceIdFromPath('/workspaces/w-1/docs/d')).toBe('w-1');
    expect(workspaceIdFromPath('/workspaces/w-1')).toBe('w-1');
    expect(workspaceIdFromPath('/workspaces/w-1/tasks')).toBe('w-1');
  });

  it('is null on a legacy doc path, which names no workspace', () => {
    // This is why the caller needs a fallback: `backTo` from /api/docs. A
    // visitor arriving on an old bookmark has no workspace in the URL.
    expect(workspaceIdFromPath('/review/d')).toBeNull();
    expect(workspaceIdFromPath('/')).toBeNull();
  });
});

describe('docHref', () => {
  it('builds the workspace path when a workspace is known', () => {
    expect(docHref('auth-rfc', 'w-1')).toBe('/workspaces/w-1/docs/auth-rfc');
  });

  it('builds an unresolvable path when no workspace is known', () => {
    // The cutover deleted `/review/<docId>`, so there is no second address to
    // fall back to. A missing workspace leaves the segment empty, which the
    // router's own parser refuses — a loud 404 at the first click, rather
    // than a link that quietly keeps the old shape alive.
    expect(docHref('auth-rfc', null)).toBe('/workspaces//docs/auth-rfc');
  });

  it('encodes both ids', () => {
    expect(docHref('rev-1:src~app.ts', 'w-1')).toBe('/workspaces/w-1/docs/rev-1%3Asrc~app.ts');
  });

  it('appends a query string when given one', () => {
    expect(docHref('d', 'w-1', 'mobile=iphone')).toBe('/workspaces/w-1/docs/d?mobile=iphone');
    expect(docHref('d', 'w-1', '')).toBe('/workspaces/w-1/docs/d');
  });

  it('round-trips with docIdFromPath', () => {
    for (const id of ['plain', 'rev-1:src~app.ts', 'a b']) {
      expect(docIdFromPath(docHref(id, 'w-1'))).toBe(id);
      // A workspace-less href does NOT round-trip: the empty segment fails
      // the doc-path match, so the id is unreadable rather than resolving to
      // something plausible. That is the point of not emitting `/review/`.
      expect(docIdFromPath(docHref(id, null))).toBe('default');
    }
  });
});
