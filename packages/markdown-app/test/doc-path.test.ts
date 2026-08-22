import { describe, expect, it } from 'vitest';
import { docHref, docIdFromPath, workspaceIdFromPath } from '../src/doc-path.ts';

describe('docIdFromPath', () => {
  it('reads a doc under the workspace path', () => {
    expect(docIdFromPath('/workspaces/w-1/docs/auth-rfc')).toBe('auth-rfc');
  });

  it('still reads the old /review/ path, which is what every old bookmark says', () => {
    expect(docIdFromPath('/review/auth-rfc')).toBe('auth-rfc');
  });

  it('decodes an encoded member docId', () => {
    // Review members are `<reviewId>:<relPath with / as ~>`, so the colon
    // arrives percent-encoded.
    expect(docIdFromPath('/workspaces/w-1/docs/rev-1%3Asrc~app.ts')).toBe('rev-1:src~app.ts');
    expect(docIdFromPath('/review/rev-1%3Asrc~app.ts')).toBe('rev-1:src~app.ts');
  });

  it('ignores query and hash', () => {
    expect(docIdFromPath('/workspaces/w-1/docs/d?mobile=iphone#c1')).toBe('d');
    expect(docIdFromPath('/review/d?mobile=iphone#c1')).toBe('d');
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

  it('falls back to the legacy path when no workspace is known', () => {
    // Not a 404: the old route still answers, and it redirects itself once
    // the doc's workspace is resolvable server-side.
    expect(docHref('auth-rfc', null)).toBe('/review/auth-rfc');
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
      expect(docIdFromPath(docHref(id, null))).toBe(id);
    }
  });
});
