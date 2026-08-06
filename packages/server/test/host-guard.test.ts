import { describe, expect, it } from 'bun:test';
import {
  classifyHost,
  isTrustedLocalHost,
  normalizeHost,
  shareScopeAllows,
} from '../src/middleware/host-guard.ts';

const LOCAL = {
  tailscaleHost: 'mac-mini.<private-network>',
  lanHosts: ['mac-mini.local', '192.168.50.227'],
};

describe('normalizeHost', () => {
  it('lowercases and strips the port', () => {
    expect(normalizeHost('Mac-Mini.Local:8787')).toBe('mac-mini.local');
    expect(normalizeHost('localhost:8787')).toBe('localhost');
  });

  it('handles bracketed IPv6 with and without a port', () => {
    expect(normalizeHost('[::1]:8787')).toBe('::1');
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('is empty for a missing header', () => {
    expect(normalizeHost(null)).toBe('');
    expect(normalizeHost(undefined)).toBe('');
  });
});

describe('isTrustedLocalHost', () => {
  it('trusts loopback and the machine’s own tailnet / LAN names', () => {
    for (const h of [
      'localhost:8787',
      '127.0.0.1:8787',
      '[::1]:8787',
      'mac-mini.<private-network>',
      'mac-mini.local:8787',
      '192.168.50.227:8787',
    ]) {
      expect(isTrustedLocalHost(h, LOCAL), h).toBe(true);
    }
  });

  it('does NOT trust a public tunnel hostname — the whole point of the fix', () => {
    for (const h of [
      'share-2026-08-05-a3f.tunnel.example.com',
      'anything.tunnel.example.com',
      'example.com',
    ]) {
      expect(isTrustedLocalHost(h, LOCAL), h).toBe(false);
    }
  });

  it('refuses a missing Host header', () => {
    expect(isTrustedLocalHost(null, LOCAL)).toBe(false);
    expect(isTrustedLocalHost('', LOCAL)).toBe(false);
  });

  it('matches exactly — a lookalike suffix/prefix must not pass', () => {
    expect(isTrustedLocalHost('evil-mac-mini.local', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('mac-mini.local.attacker.com', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('mac-mini.<private-network>.evil.com', LOCAL)).toBe(false);
  });

  it('trusts only THIS machine’s addresses — not private ranges in general', () => {
    // Host is client-controlled. Trusting the whole 10/8, 192.168/16,
    // 172.16/12 and CGNAT ranges would let any caller self-classify as
    // local by sending `Host: 10.0.0.4`, reopening the very hole this
    // guard closes. The machine's real addresses are enumerated (LAN
    // interfaces AND the tailnet utun address), so nothing is lost.
    expect(isTrustedLocalHost('192.168.50.227', LOCAL)).toBe(true); // in lanHosts
    expect(isTrustedLocalHost('10.0.0.4', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('172.16.3.9', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('100.101.102.103', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('8.8.8.8', LOCAL)).toBe(false);
  });

  it('never trusts a request that arrived through the Cloudflare edge', () => {
    // cloudflared forwards the visitor's Host verbatim, so a tunnel
    // visitor could otherwise send `Host: localhost`. Cloudflare stamps
    // its own cf-ray on everything it proxies; a request carrying one
    // did not originate on our LAN, whatever its Host claims.
    expect(isTrustedLocalHost('localhost', { ...LOCAL, viaProxy: true })).toBe(false);
    expect(isTrustedLocalHost('192.168.50.227', { ...LOCAL, viaProxy: true })).toBe(false);
    expect(isTrustedLocalHost('mac-mini.local', { ...LOCAL, viaProxy: true })).toBe(false);
  });
});

describe('classifyHost', () => {
  const lookupShare = (h: string) =>
    h === 'share-abc.tunnel.example.com' ? { docId: 'shared-doc' } : null;

  it('local → no gate', () => {
    expect(classifyHost('localhost:8787', { ...LOCAL, lookupShare })).toEqual({ kind: 'local' });
  });

  it('active share host → gate + what it is scoped to', () => {
    expect(classifyHost('share-abc.tunnel.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'share',
      target: { docId: 'shared-doc' },
    });
  });

  it('carries the workspaceId through for a workspace share', () => {
    const wsLookup = () => ({ docId: 'ws-1:index.md', workspaceId: 'ws-1' });
    expect(
      classifyHost('share-ws.tunnel.example.com', { ...LOCAL, lookupShare: wsLookup }),
    ).toEqual({ kind: 'share', target: { docId: 'ws-1:index.md', workspaceId: 'ws-1' } });
  });

  it('unknown host → DENY (previously this fell through to the open API)', () => {
    expect(classifyHost('anything.tunnel.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
    expect(classifyHost(null, { ...LOCAL, lookupShare })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
  });

  it('a proxied request claiming a local Host is denied, not trusted', () => {
    expect(classifyHost('localhost', { ...LOCAL, lookupShare, viaProxy: true })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
    // …but a proxied request to a real share host is still a share.
    expect(
      classifyHost('share-abc.tunnel.example.com', { ...LOCAL, lookupShare, viaProxy: true }),
    ).toEqual({ kind: 'share', target: { docId: 'shared-doc' } });
  });
});

describe('shareScopeAllows (doc share)', () => {
  const DOC = { docId: 'auth-rfc' };

  it('allows the app shell and assets', () => {
    expect(shareScopeAllows('/app/app.js', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/app/styles.css', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/favicon.ico', 'GET', DOC)).toBe(true);
  });

  it('allows the shared doc’s own surfaces', () => {
    expect(shareScopeAllows(`/review/${DOC.docId}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/y/${DOC.docId}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/events/${DOC.docId}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC.docId}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC.docId}/threads`, 'POST', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC.docId}/threads/t1/comments`, 'POST', DOC)).toBe(true);
  });

  it('matches a percent-encoded docId (workspace members encode `:` and `~`)', () => {
    const member = { docId: 'rev-1:docs~main.md' };
    expect(shareScopeAllows(`/review/${encodeURIComponent(member.docId)}`, 'GET', member)).toBe(
      true,
    );
    expect(
      shareScopeAllows(`/api/docs/${encodeURIComponent(member.docId)}/threads`, 'POST', member),
    ).toBe(true);
  });

  it('BLOCKS other docs', () => {
    expect(shareScopeAllows('/review/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/y/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc/threads', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/events/other-doc', 'GET', DOC)).toBe(false);
  });

  it('BLOCKS doc enumeration and workspace/diff creation', () => {
    expect(shareScopeAllows('/api/docs', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/workspaces', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/diffs', 'POST', DOC)).toBe(false);
  });

  it('BLOCKS the share admin surface — a visitor must not mint or revoke shares', () => {
    expect(shareScopeAllows('/api/share', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/share/doc', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/share/abc123', 'DELETE', DOC)).toBe(false);
  });

  it('BLOCKS mockups, demos, and anything unlisted (closed by default)', () => {
    expect(shareScopeAllows('/demos/whatever/index.html', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/mockup/some-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/webhooks/log', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/some/route/added/later', 'GET', DOC)).toBe(false);
  });

  it('is not fooled by a prefix that merely starts with the shared id', () => {
    expect(shareScopeAllows(`/review/${DOC.docId}-other`, 'GET', DOC)).toBe(false);
    expect(shareScopeAllows(`/api/docs/${DOC.docId}-other/threads`, 'GET', DOC)).toBe(false);
  });
});

describe('shareScopeAllows (workspace share)', () => {
  const WS = { docId: 'ws-1:index.md', workspaceId: 'ws-1' };
  // Members of ws-1, plus a doc that belongs to a DIFFERENT workspace and
  // one that belongs to none — the two things scoping has to keep out.
  const MEMBERS: Record<string, string> = {
    'ws-1:index.md': 'ws-1',
    'ws-1:docs~design.md': 'ws-1',
    'ws-2:secrets.md': 'ws-2',
  };
  const workspaceOf = (docId: string) => MEMBERS[docId] ?? null;

  it('covers every member doc of the shared workspace', () => {
    for (const p of [
      '/review/ws-1%3Adocs~design.md',
      '/y/ws-1%3Adocs~design.md',
      '/events/ws-1%3Adocs~design.md',
      '/api/docs/ws-1%3Adocs~design.md',
      '/api/docs/ws-1%3Adocs~design.md/threads',
    ]) {
      expect(shareScopeAllows(p, 'GET', WS, workspaceOf), p).toBe(true);
    }
  });

  it('allows the navigation endpoints the sidebar needs', () => {
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'GET', WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/workspaces/ws-1/grouped', 'GET', WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/workspaces/ws-1/threads', 'GET', WS, workspaceOf)).toBe(true);
  });

  it('allows the LAZY-OPEN endpoints — without them a shared folder shows one file', () => {
    // bind_folder binds only the entry doc; every other member comes into
    // being through these calls. Bounded by the workspace root (rooms
    // rejects an escaping relPath with 'bad-path').
    expect(shareScopeAllows('/api/workspaces/ws-1/files', 'GET', WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/workspaces/ws-1/context-file', 'POST', WS, workspaceOf)).toBe(
      true,
    );
    expect(shareScopeAllows('/api/workspaces/ws-1/editable-file', 'POST', WS, workspaceOf)).toBe(
      true,
    );
  });

  it('BLOCKS a method the endpoint does not offer', () => {
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'POST', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/ws-1/context-file', 'GET', WS, workspaceOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/workspaces/ws-1/anything-new', 'GET', WS, workspaceOf)).toBe(
      false,
    );
  });

  it('BLOCKS destroying the workspace', () => {
    expect(shareScopeAllows('/api/workspaces/ws-1', 'DELETE', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'DELETE', WS, workspaceOf)).toBe(false);
  });

  it('BLOCKS another workspace and its docs', () => {
    expect(shareScopeAllows('/api/workspaces/ws-2/tree', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/ws-2/context-file', 'POST', WS, workspaceOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/review/ws-2%3Asecrets.md', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs/ws-2%3Asecrets.md', 'GET', WS, workspaceOf)).toBe(false);
  });

  it('BLOCKS a doc that belongs to no workspace', () => {
    expect(shareScopeAllows('/review/loose-doc', 'GET', WS, workspaceOf)).toBe(false);
  });

  it('BLOCKS workspace listing and share admin, same as a doc share', () => {
    expect(shareScopeAllows('/api/workspaces', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/share', 'GET', WS, workspaceOf)).toBe(false);
  });

  it('a DOC share never widens to the workspace, even with a resolver', () => {
    const docShare = { docId: 'ws-1:index.md' }; // no workspaceId
    expect(shareScopeAllows('/review/ws-1%3Adocs~design.md', 'GET', docShare, workspaceOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'GET', docShare, workspaceOf)).toBe(false);
  });
});

describe('shareScopeAllows — a visitor is a reviewer, not an operator', () => {
  const DOC = { docId: 'auth-rfc' };
  const WS = { docId: 'ws-1:index.md', workspaceId: 'ws-1' };
  const workspaceOf = (d: string) => (d.startsWith('ws-1:') ? 'ws-1' : null);

  it('allows what the review UI actually calls', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/diff', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/content', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/activity', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/by_find', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/t1/comments', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/t1/resolve', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/t1/reanchor', 'POST', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/suggestions/s1/accept', 'POST', DOC)).toBe(true);
  });

  it('BLOCKS deleting the doc', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc', 'DELETE', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/ws-1%3Aindex.md', 'DELETE', WS, workspaceOf)).toBe(false);
  });

  it('BLOCKS whole-doc replacement and disk reparse', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/content', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/auth-rfc/reparse_from_disk', 'POST', DOC)).toBe(false);
  });

  it('BLOCKS the agent-side document-surgery verbs hung off a thread', () => {
    for (const verb of ['rewrite_region', 'insert_after', 'insert_blocks_after']) {
      expect(shareScopeAllows(`/api/docs/auth-rfc/threads/t1/${verb}`, 'POST', DOC), verb).toBe(
        false,
      );
    }
  });

  it('BLOCKS a doc subroute added later (closed by default)', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/export', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/auth-rfc/rename', 'POST', DOC)).toBe(false);
  });
});
