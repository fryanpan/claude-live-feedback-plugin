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
  // The resolver answers with the SET of workspaces an id belongs to (see
  // shareScopeAllows). A flat folder bind has one level, so each member
  // answers with a one-element list.
  const workspaceOf = (docId: string) => {
    const ws = MEMBERS[docId];
    return ws ? [ws] : [];
  };

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
  const workspaceOf = (d: string) => (d.startsWith('ws-1:') ? ['ws-1'] : []);

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

  it('BLOCKS writing the audit trail — moves and their evidence alike', () => {
    // The allowlist above is the positive control: these same predicates say
    // yes to the review verbs, so a `false` here is a decision and not a
    // probe that can never see anything.
    for (const target of [DOC, WS] as const) {
      expect(shareScopeAllows('/api/tasks/t-1/transition', 'POST', target, workspaceOf)).toBe(
        false,
      );
      expect(shareScopeAllows('/api/tasks/t-1/evidence', 'POST', target, workspaceOf)).toBe(false);
    }
  });
});

describe('shareScopeAllows (workspace-hub surfaces — §3.12 commit 8)', () => {
  // A hub workspace share: the entry is the hub page, not a review doc, so
  // docId is empty. Scope comes entirely from workspaceId.
  const HUB = { docId: '', workspaceId: 'hub-1' };
  const DOC = { docId: 'auth-rfc' };
  const workspaceOf = (d: string) => (d.startsWith('hub-1:') ? ['hub-1'] : []);

  it('allows the hub page for a workspace-scope share', () => {
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', HUB)).toBe(true);
    expect(shareScopeAllows(`/workspaces/${encodeURIComponent('hub-1')}`, 'GET', HUB)).toBe(true);
  });

  it('never lets a share host reach the plugin refresh', () => {
    // The only route that acts on the HOST rather than on workspace content:
    // it runs `claude plugin update`, which rewrites this machine's plugin
    // cache. Holding a share link is not a reason to be able to run a deploy
    // step on someone's laptop. The allowlist is closed-by-default so this
    // was already true the moment the route existed — this pins it, because
    // "closed by default" is a property of a file somebody can edit.
    for (const target of [HUB, DOC]) {
      expect(shareScopeAllows('/api/plugin/refresh', 'POST', target, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/plugin/refresh', 'GET', target, workspaceOf)).toBe(false);
    }
    // Positive control: the same targets DO reach their own surfaces, so the
    // refusals above are about this path and not about the fixture.
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', HUB, workspaceOf)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC.docId}`, 'GET', DOC, workspaceOf)).toBe(true);
  });

  it('allows the ws:<id> board room socket (the resolver knows nothing of it)', () => {
    // The room is not a member doc — its allowance is explicit, so pass a
    // resolver that knows nothing about it and watch it still pass.
    expect(shareScopeAllows('/y/ws%3Ahub-1', 'GET', HUB, () => [])).toBe(true);
    expect(shareScopeAllows('/y/ws:hub-1', 'GET', HUB, () => [])).toBe(true);
  });

  it('allows the workspace SSE feed', () => {
    expect(shareScopeAllows('/events/workspace/hub-1', 'GET', HUB, () => [])).toBe(true);
  });

  it('a DOC-scoped share gets NONE of the three (the §3.3 rule-2 boundary)', () => {
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', DOC, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/y/ws%3Ahub-1', 'GET', DOC, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/y/ws:hub-1', 'GET', DOC, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/events/workspace/hub-1', 'GET', DOC, workspaceOf)).toBe(false);
  });

  it('BLOCKS another workspace’s hub surfaces', () => {
    expect(shareScopeAllows('/workspaces/hub-2', 'GET', HUB)).toBe(false);
    expect(shareScopeAllows('/y/ws%3Ahub-2', 'GET', HUB)).toBe(false);
    expect(shareScopeAllows('/events/workspace/hub-2', 'GET', HUB)).toBe(false);
  });

  it('BLOCKS non-GET on the hub page and anything nested under it', () => {
    expect(shareScopeAllows('/workspaces/hub-1', 'POST', HUB)).toBe(false);
    expect(shareScopeAllows('/workspaces/hub-1/extra', 'GET', HUB)).toBe(false);
    expect(shareScopeAllows('/workspaces', 'GET', HUB)).toBe(false);
  });

  it('is not fooled by a prefix that merely starts with the workspace id', () => {
    expect(shareScopeAllows('/workspaces/hub-1-other', 'GET', HUB)).toBe(false);
    expect(shareScopeAllows('/y/ws%3Ahub-1-other', 'GET', HUB)).toBe(false);
    expect(shareScopeAllows('/events/workspace/hub-1-other', 'GET', HUB)).toBe(false);
  });

  /**
   * The strip's thread half rides REST while its decision half rides the board
   * room. Blocked, the client swallows the non-ok and a visitor's strip shows
   * decisions only — the same silent transport/surface disagreement that closed
   * `<ws>` and `<ws>/attachments` were reopened to fix.
   */
  it('allows the review queue for a workspace share, and only its own workspace', () => {
    expect(shareScopeAllows('/api/workspaces/hub-1/review-items', 'GET', HUB)).toBe(true);
    expect(shareScopeAllows('/api/workspaces/hub-2/review-items', 'GET', HUB)).toBe(false);
    // A DOC-scoped share never reaches a board, review queue included.
    expect(shareScopeAllows('/api/workspaces/hub-1/review-items', 'GET', DOC)).toBe(false);
    // Read-only, like every other allowance here.
    expect(shareScopeAllows('/api/workspaces/hub-1/review-items', 'POST', HUB)).toBe(false);
  });

  it('visitors are read-only on the gate: every task/goal/decision mutation route is out of scope', () => {
    const cases: Array<[string, string]> = [
      ['/api/tasks/t-1/transition', 'POST'],
      ['/api/tasks/t-1/answer', 'POST'],
      ['/api/tasks/t-1/goal', 'POST'],
      ['/api/tasks/t-1/title', 'POST'],
      ['/api/tasks/t-1/links', 'POST'],
      ['/api/tasks/t-1/links', 'DELETE'],
      ['/api/tasks/t-1/links', 'GET'],
      ['/api/workspaces/hub-1/goal', 'PUT'],
      ['/api/workspaces/hub-1/goals', 'PUT'],
      ['/api/workspaces/hub-1/tasks', 'POST'],
      ['/api/workspaces/hub-1/tasks', 'GET'],
      ['/api/workspaces/hub-1/docs', 'POST'],
      ['/api/workspaces/hub-1/attachments', 'POST'],
      // The audit log carries actor IDs — owner-only (commit 7's flag).
      ['/api/workspaces/hub-1/events', 'GET'],
    ];
    for (const [p, m] of cases) {
      expect(
        shareScopeAllows(p, m, HUB, () => []),
        `${m} ${p}`,
      ).toBe(false);
    }
  });

  it('BLOCKS promoting a thread to a task — a mutation hiding under /api/docs', () => {
    // threads/* is broadly allowed for commenting; promote creates a TASK
    // and must stay owner-only like the other document-surgery verbs.
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/t1/promote', 'POST', DOC)).toBe(false);
  });

  it('allows the task-chip resolution endpoint (GET only) — §3.3 rule 2', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/tasks', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/tasks', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc/tasks', 'GET', DOC)).toBe(false);
  });
});

/**
 * A GROUPING filed on a HUB board — the shape PR #131 made the default.
 *
 * A folder bind / diff review is one row on a board, and its members answer
 * with the GROUPING's id while the share carries the HUB's. Exact equality
 * refused every one of them, so a shared board showed a review row that
 * opened onto nothing.
 *
 * The resolver is the ONE rule: it answers with the whole set an id belongs
 * to — the grouping, and the board that grouping is filed on. Both the member
 * check and the `/api/workspaces/<id>/…` check read it, so there is no second
 * rule to drift.
 */
describe('shareScopeAllows — a grouping filed on a shared board', () => {
  const HUB = { docId: '', workspaceId: 'hub-1' };
  const OTHER_HUB = { docId: '', workspaceId: 'hub-2' };
  /** grouping `rev-a` sits on hub-1; grouping `rev-b` sits on hub-2. */
  const OWNERS: Record<string, string[]> = {
    'rev-a': ['hub-1'],
    'rev-a:src~app.ts': ['rev-a', 'hub-1'],
    'rev-b': ['hub-2'],
    'rev-b:src~app.ts': ['rev-b', 'hub-2'],
    'hub-1:plan.md': ['hub-1'], // a doc attached to the board directly
  };
  const workspacesOf = (id: string) => OWNERS[id] ?? [];

  it('opens the grouping’s navigation endpoints from the board share', () => {
    for (const sub of ['tree', 'grouped', 'threads', 'files']) {
      expect(shareScopeAllows(`/api/workspaces/rev-a/${sub}`, 'GET', HUB, workspacesOf), sub).toBe(
        true,
      );
    }
    expect(shareScopeAllows('/api/workspaces/rev-a/context-file', 'POST', HUB, workspacesOf)).toBe(
      true,
    );
    expect(shareScopeAllows('/api/workspaces/rev-a/editable-file', 'POST', HUB, workspacesOf)).toBe(
      true,
    );
  });

  it('opens the grouping’s member docs from the board share', () => {
    for (const p of [
      '/review/rev-a%3Asrc~app.ts',
      '/y/rev-a%3Asrc~app.ts',
      '/events/rev-a%3Asrc~app.ts',
      '/api/docs/rev-a%3Asrc~app.ts',
      '/api/docs/rev-a%3Asrc~app.ts/threads',
    ]) {
      expect(shareScopeAllows(p, 'GET', HUB, workspacesOf), p).toBe(true);
    }
  });

  // ── the half that matters ──
  it('BLOCKS a grouping filed on a DIFFERENT board, and its members', () => {
    for (const sub of ['tree', 'grouped', 'threads', 'files']) {
      expect(shareScopeAllows(`/api/workspaces/rev-b/${sub}`, 'GET', HUB, workspacesOf), sub).toBe(
        false,
      );
    }
    expect(shareScopeAllows('/api/workspaces/rev-b/context-file', 'POST', HUB, workspacesOf)).toBe(
      false,
    );
    for (const p of [
      '/review/rev-b%3Asrc~app.ts',
      '/y/rev-b%3Asrc~app.ts',
      '/api/docs/rev-b%3Asrc~app.ts',
      '/api/docs/rev-b%3Asrc~app.ts/threads',
    ]) {
      expect(shareScopeAllows(p, 'GET', HUB, workspacesOf), p).toBe(false);
    }
    // Mirrored, so neither board is special.
    expect(shareScopeAllows('/api/workspaces/rev-a/tree', 'GET', OTHER_HUB, workspacesOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/review/rev-a%3Asrc~app.ts', 'GET', OTHER_HUB, workspacesOf)).toBe(
      false,
    );
  });

  it('BLOCKS deleting the grouping, and the workspace list', () => {
    expect(shareScopeAllows('/api/workspaces/rev-a', 'DELETE', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/rev-a/tree', 'DELETE', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces', 'GET', HUB, workspacesOf)).toBe(false);
  });

  it('BLOCKS the grouping’s hub-only surfaces — reachable is not the same as on the board', () => {
    // These three are allowed for the SHARED workspace id only. A grouping has
    // no board record, no agent presence and no review queue; granting them by
    // reachability would answer a board question with a grouping's id.
    for (const sub of ['', '/attachments', '/review-items']) {
      expect(shareScopeAllows(`/api/workspaces/rev-a${sub}`, 'GET', HUB, workspacesOf), sub).toBe(
        false,
      );
    }
    expect(shareScopeAllows('/workspaces/rev-a', 'GET', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/y/ws%3Arev-a', 'GET', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/events/workspace/rev-a', 'GET', HUB, workspacesOf)).toBe(false);
  });

  it('a DOC share is not widened by any of it', () => {
    const docShare = { docId: 'rev-a:src~app.ts' }; // no workspaceId
    // Positive control: its own doc still opens.
    expect(shareScopeAllows('/api/docs/rev-a%3Asrc~app.ts', 'GET', docShare, workspacesOf)).toBe(
      true,
    );
    expect(shareScopeAllows('/api/workspaces/rev-a/tree', 'GET', docShare, workspacesOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/docs/hub-1%3Aplan.md', 'GET', docShare, workspacesOf)).toBe(
      false,
    );
  });

  it('refuses a resolver still returning the OLD `string | null` shape', () => {
    // A string answers `.includes` too, so the old shape would have granted on
    // any substring. Closing rather than trusting it can only refuse more.
    const legacy = (id: string) => (id.startsWith('rev-a') ? 'hub-1' : null);
    expect(
      shareScopeAllows(
        '/api/workspaces/rev-a/tree',
        'GET',
        HUB,
        legacy as unknown as (id: string) => string[],
      ),
    ).toBe(false);
  });
});
