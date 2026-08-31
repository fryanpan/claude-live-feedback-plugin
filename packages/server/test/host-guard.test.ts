import { describe, expect, it } from 'bun:test';
import {
  type ShareTarget,
  classifyHost,
  collabScope,
  isAccessTunnelHost,
  isProxiedTrustedHost,
  isRecallCallbackHost,
  isTrustedLocalHost,
  normalizeHost,
  shareScopeAllows,
} from '../src/middleware/host-guard.ts';

const LOCAL = {
  tailscaleHost: 'mac-mini.tail-example.ts.net',
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
      'mac-mini.tail-example.ts.net',
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
    expect(isTrustedLocalHost('mac-mini.tail-example.ts.net.evil.com', LOCAL)).toBe(false);
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

describe('isRecallCallbackHost', () => {
  const RECALL = { recallCallbackHost: 'recall.example.com' };

  it('matches the one configured name, port and case ignored', () => {
    expect(isRecallCallbackHost('recall.example.com', RECALL)).toBe(true);
    expect(isRecallCallbackHost('RECALL.Example.COM:8787', RECALL)).toBe(true);
  });

  it('matches EXACTLY — no suffix, no prefix', () => {
    // The rule every list in this file shares, and the one that would turn
    // this hostname into "anything the attacker can name".
    expect(isRecallCallbackHost('recall.example.com.attacker.com', RECALL)).toBe(false);
    expect(isRecallCallbackHost('evil-recall.example.com', RECALL)).toBe(false);
    expect(isRecallCallbackHost('sub.recall.example.com', RECALL)).toBe(false);
  });

  it('is false for every host when unconfigured', () => {
    // The ordinary state. An empty setting must not match an empty Host, or
    // an HTTP/1.0 request with no Host header would land in this class.
    for (const opts of [{}, { recallCallbackHost: '' }, { recallCallbackHost: null }]) {
      expect(isRecallCallbackHost('recall.example.com', opts)).toBe(false);
      expect(isRecallCallbackHost('', opts)).toBe(false);
      expect(isRecallCallbackHost(null, opts)).toBe(false);
    }
  });

  it('does NOT require the request to have come through the proxy', () => {
    // The opposite of `isAccessTunnelHost` and `isProxiedTrustedHost`, on
    // purpose: those grant a surface to PEOPLE and lean on an Access token
    // that only exists at the edge. This grants two credential-carrying
    // routes to a vendor's backend, and requiring `cf-ray` would break any
    // deployment fronted by something that is not Cloudflare.
    expect(isRecallCallbackHost('recall.example.com', { ...RECALL, viaProxy: true })).toBe(true);
    expect(isRecallCallbackHost('recall.example.com', { ...RECALL, viaProxy: false })).toBe(true);
  });

  it('does NOT require Cloudflare Access to be configured', () => {
    // Access is a browser flow; Recall's backend has no browser. Gating this
    // host on `accessFronted` would refuse every real caller — which is the
    // failure the dedicated hostname exists to remove.
    expect(isRecallCallbackHost('recall.example.com', { ...RECALL, accessFronted: false })).toBe(
      true,
    );
  });

  it('the lists cannot leak into each other', () => {
    // A name on the recall list is not a local name, not a collab name and
    // not the operator's. Each door keeps its own key.
    const only = { ...LOCAL, ...RECALL, viaProxy: true, accessFronted: true };
    expect(isTrustedLocalHost('recall.example.com', only)).toBe(false);
    expect(isAccessTunnelHost('recall.example.com', only)).toBe(false);
    expect(isProxiedTrustedHost('recall.example.com', only)).toBe(false);
    // …and conversely, the operator's own hostname is not the recall host.
    expect(
      isRecallCallbackHost('ops.example.com', {
        ...only,
        proxiedTrustedHosts: ['ops.example.com'],
      }),
    ).toBe(false);
  });
});

describe('classifyHost', () => {
  const lookupShare = (h: string) =>
    h === 'share-abc.tunnel.example.com' ? { workspaceId: 'ws-shared' } : null;

  it('local → no gate', () => {
    expect(classifyHost('localhost:8787', { ...LOCAL, lookupShare })).toEqual({ kind: 'local' });
  });

  it('active share host → gate + what it is scoped to', () => {
    expect(classifyHost('share-abc.tunnel.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'share',
      target: { workspaceId: 'ws-shared' },
    });
  });

  it('the target it carries names a BOARD and nothing else', () => {
    // This used to read "carries the workspaceId through", paired with a
    // target that named an ENTRY DOC beside its workspace. A board share opens
    // the board, so there is no entry doc left to carry and the field is gone.
    // Asserted as an absence of the old key as well as a match on the new
    // shape: a target that quietly regrew a `docId` is precisely the
    // regression the removal exists to prevent, and `toEqual` on its own would
    // be satisfied by a lookup that never had one to begin with.
    const wsLookup = () => ({ workspaceId: 'ws-1' });
    const decision = classifyHost('share-ws.tunnel.example.com', {
      ...LOCAL,
      lookupShare: wsLookup,
    });
    expect(decision).toEqual({ kind: 'share', target: { workspaceId: 'ws-1' } });
    expect(decision.kind).toBe('share');
    if (decision.kind === 'share') expect('docId' in decision.target).toBe(false);
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

  it('the recall callback host is its own kind, proxied or not', () => {
    const opts = { ...LOCAL, lookupShare, recallCallbackHost: 'recall.example.com' };
    expect(classifyHost('recall.example.com', opts)).toEqual({ kind: 'recall-callback' });
    expect(classifyHost('recall.example.com', { ...opts, viaProxy: true })).toEqual({
      kind: 'recall-callback',
    });
  });

  it('unconfigured, that same hostname is denied like any other', () => {
    expect(classifyHost('recall.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
  });

  it('the recall host never widens into another kind, and never narrows one', () => {
    // Checked FIRST among the external kinds because it is the narrowest, so
    // a collision can only ever LOSE surface. Proven both ways: a name that
    // is on the recall list AND the operator list classifies recall (the
    // narrow one wins), and adding a recall host leaves every other
    // hostname's classification exactly where it was.
    const both = {
      ...LOCAL,
      lookupShare,
      viaProxy: true,
      accessFronted: true,
      recallCallbackHost: 'ops.example.com',
      proxiedTrustedHosts: ['ops.example.com'],
    };
    expect(classifyHost('ops.example.com', both)).toEqual({ kind: 'recall-callback' });
    expect(classifyHost('share-abc.tunnel.example.com', both)).toEqual({
      kind: 'share',
      target: { workspaceId: 'ws-shared' },
    });
    expect(classifyHost('anything.tunnel.example.com', both)).toEqual({
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
    ).toEqual({ kind: 'share', target: { workspaceId: 'ws-shared' } });
  });
});

/**
 * A BOARD is the unit of sharing (Bryan, 2026-08-17). A target that names no
 * workspace is what a PER-DOC share was, and it must now grant nothing at all
 * — not the doc it used to name, and not even the app shell.
 *
 * The empty object IS that shape now. A target once carried the entry doc
 * beside its workspace, so "the old doc-share shape" could be written out as
 * `{ docId }`; the field went with board-only sharing, which leaves `{}` as
 * the only way a workspace-less target can be constructed at all. Nothing
 * about what is under test moved — the paths below still name `auth-rfc`, and
 * the question is still whether a target with no workspace reaches it.
 *
 * Every assertion here is an absence, so each one carries its positive
 * control IN THE SAME `it`: the identical path, against a board target
 * covering the same doc, must be allowed. Without that pair, a bare
 * `return false` at the top of the function would pass this whole block while
 * breaking every share on the server.
 */
describe('shareScopeAllows — a target with no workspace grants nothing', () => {
  const NO_WS: ShareTarget = {}; // the old doc-share shape, as it survives
  const WS: ShareTarget = { workspaceId: 'ws-1' }; // the board `auth-rfc` is filed on
  const workspaceOf = (d: string) => (d === 'auth-rfc' ? ['ws-1'] : []);

  it('refuses the app shell and assets a doc share used to get', () => {
    for (const p of ['/app/app.js', '/app/styles.css', '/favicon.ico', '/widget.js']) {
      expect(shareScopeAllows(p, 'GET', NO_WS, workspaceOf), `${p} (no workspace)`).toBe(false);
      // Positive control: the same asset IS served to a board share.
      expect(shareScopeAllows(p, 'GET', WS, workspaceOf), `${p} (workspace)`).toBe(true);
    }
  });

  it('refuses a doc’s own surfaces — the target names no workspace to be in', () => {
    for (const [p, method] of [
      ['/review/auth-rfc', 'GET'],
      ['/y/auth-rfc', 'GET'],
      ['/events/auth-rfc', 'GET'],
      ['/api/docs/auth-rfc', 'GET'],
      ['/api/docs/auth-rfc/threads', 'POST'],
      ['/api/docs/auth-rfc/threads/t1/comments', 'POST'],
    ] as const) {
      expect(shareScopeAllows(p, method, NO_WS, workspaceOf), `${p} (no workspace)`).toBe(false);
      // Positive control: the doc is reachable once it is filed on the shared
      // board — which is the whole replacement story.
      expect(shareScopeAllows(p, method, WS, workspaceOf), `${p} (workspace)`).toBe(true);
    }
  });

  it('refuses even with a resolver that would place the doc in a workspace', () => {
    // The resolver says `auth-rfc` is in ws-1; the TARGET names no workspace,
    // so there is nothing for that membership to match against.
    expect(shareScopeAllows('/review/auth-rfc', 'GET', NO_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'GET', NO_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'GET', WS, workspaceOf)).toBe(true);
  });
});

describe('shareScopeAllows — what stays closed to every share', () => {
  // The share covers the BOARD; `MEMBER` is the one doc filed on it. They used
  // to be one object (the target carried the entry doc), and separating them
  // is the point: everything below reaches the member through membership, so
  // nothing here can pass because the target happened to name it.
  const MEMBER = 'ws-1:index.md';
  const SHARE: ShareTarget = { workspaceId: 'ws-1' };
  // EXACT membership, not a prefix test: scope is now decided entirely by
  // this resolver, so a fixture that answers on `startsWith` would grant
  // `ws-1:index.md-other` and hide the prefix case below.
  const wsOf = (d: string) => (d === MEMBER ? ['ws-1'] : []);
  const shareScopeAllowsDoc = (p: string, m: string) => shareScopeAllows(p, m, SHARE, wsOf);

  it('matches a percent-encoded docId (workspace members encode `:` and `~`)', () => {
    expect(shareScopeAllowsDoc('/review/ws-1%3Aindex.md', 'GET')).toBe(true);
    expect(shareScopeAllowsDoc('/api/docs/ws-1%3Aindex.md/threads', 'POST')).toBe(true);
  });

  it('BLOCKS other docs', () => {
    expect(shareScopeAllowsDoc('/review/other-doc', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/y/other-doc', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/api/docs/other-doc', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/api/docs/other-doc/threads', 'POST')).toBe(false);
    expect(shareScopeAllowsDoc('/events/other-doc', 'GET')).toBe(false);
  });

  it('BLOCKS doc enumeration and workspace/diff creation', () => {
    expect(shareScopeAllowsDoc('/api/docs', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/api/docs', 'POST')).toBe(false);
    expect(shareScopeAllowsDoc('/api/workspaces', 'POST')).toBe(false);
    expect(shareScopeAllowsDoc('/api/diffs', 'POST')).toBe(false);
  });

  it('BLOCKS the share admin surface — a visitor must not mint or revoke shares', () => {
    expect(shareScopeAllowsDoc('/api/share', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/api/share/link', 'POST')).toBe(false);
    expect(shareScopeAllowsDoc('/api/share/workspace', 'POST')).toBe(false);
    expect(shareScopeAllowsDoc('/api/share/abc123', 'DELETE')).toBe(false);
  });

  it('BLOCKS mockups, demos, and anything unlisted (closed by default)', () => {
    expect(shareScopeAllowsDoc('/demos/whatever/index.html', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/mockup/some-doc', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/api/webhooks/log', 'GET')).toBe(false);
    expect(shareScopeAllowsDoc('/some/route/added/later', 'GET')).toBe(false);
  });

  it('is not fooled by a prefix that merely starts with a member id', () => {
    expect(shareScopeAllowsDoc(`/review/${MEMBER}-other`, 'GET')).toBe(false);
    expect(shareScopeAllowsDoc(`/api/docs/${MEMBER}-other/threads`, 'GET')).toBe(false);
    // Positive control: the member itself, un-suffixed, is reachable — so the
    // two refusals are about the extra characters and not about the fixture.
    expect(shareScopeAllowsDoc(`/review/${MEMBER}`, 'GET')).toBe(true);
  });
});

describe('shareScopeAllows (workspace share)', () => {
  const WS: ShareTarget = { workspaceId: 'ws-1' };
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

  describe('the same rule judges /api/reviews/<setId>/…', () => {
    // The endpoints are called this now. The alias exists for callers that
    // cannot restart, so a visitor must be able to reach EITHER spelling —
    // and must be refused on either one for the same reasons.
    it('allows the navigation and lazy-open endpoints', () => {
      expect(shareScopeAllows('/api/reviews/ws-1/tree', 'GET', WS, workspaceOf)).toBe(true);
      expect(shareScopeAllows('/api/reviews/ws-1/grouped', 'GET', WS, workspaceOf)).toBe(true);
      expect(shareScopeAllows('/api/reviews/ws-1/threads', 'GET', WS, workspaceOf)).toBe(true);
      expect(shareScopeAllows('/api/reviews/ws-1/files', 'GET', WS, workspaceOf)).toBe(true);
      expect(shareScopeAllows('/api/reviews/ws-1/context-file', 'POST', WS, workspaceOf)).toBe(
        true,
      );
      expect(shareScopeAllows('/api/reviews/ws-1/editable-file', 'POST', WS, workspaceOf)).toBe(
        true,
      );
    });

    it('BLOCKS a review the share does not cover', () => {
      expect(shareScopeAllows('/api/reviews/ws-2/tree', 'GET', WS, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/reviews/ws-2/context-file', 'POST', WS, workspaceOf)).toBe(
        false,
      );
    });

    it('BLOCKS the mutating verbs and anything unlisted', () => {
      // refresh and groups rewrite the review; delete destroys it. A visitor
      // is a reviewer, and none of the three is a review action.
      expect(shareScopeAllows('/api/reviews/ws-1/refresh', 'POST', WS, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/reviews/ws-1/groups', 'POST', WS, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/reviews/ws-1', 'DELETE', WS, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/reviews/ws-1/anything-new', 'GET', WS, workspaceOf)).toBe(
        false,
      );
    });
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

  it('BLOCKS workspace listing and share admin', () => {
    expect(shareScopeAllows('/api/workspaces', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs', 'GET', WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/share', 'GET', WS, workspaceOf)).toBe(false);
  });

  it('the old doc-only target reaches nothing here, resolver or no resolver', () => {
    // `{}` is what the old doc-only shape reduces to: the target no longer has
    // a docId field to put `ws-1:index.md` in, and a workspace-less target is
    // the whole of what that shape was.
    const docShare: ShareTarget = {}; // no workspaceId
    expect(shareScopeAllows('/review/ws-1%3Adocs~design.md', 'GET', docShare, workspaceOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/workspaces/ws-1/tree', 'GET', docShare, workspaceOf)).toBe(false);
    // Not even the doc it used to name, which is the half that was granted.
    expect(shareScopeAllows('/review/ws-1%3Aindex.md', 'GET', docShare, workspaceOf)).toBe(false);
    // Positive control: identical path, workspace target → allowed.
    expect(shareScopeAllows('/review/ws-1%3Aindex.md', 'GET', WS, workspaceOf)).toBe(true);
  });
});

describe('shareScopeAllows — a visitor is a reviewer, not an operator', () => {
  // `auth-rfc` is a member of `ws-a`; every share is a board share, so the
  // per-subroute contract is exercised through one. The target no longer names
  // the doc — it never needed to, and now it cannot — so every allowance below
  // is reached through membership in the shared board.
  const WS_A: ShareTarget = { workspaceId: 'ws-a' };
  const WS_1: ShareTarget = { workspaceId: 'ws-1' };
  const workspaceOf = (d: string) =>
    d === 'auth-rfc' ? ['ws-a'] : d.startsWith('ws-1:') ? ['ws-1'] : [];

  it('allows what the review UI actually calls', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc', 'GET', WS_A, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/diff', 'GET', WS_A, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/content', 'GET', WS_A, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/activity', 'POST', WS_A, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads', 'POST', WS_A, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/threads/by_find', 'POST', WS_A, workspaceOf)).toBe(
      true,
    );
    expect(
      shareScopeAllows('/api/docs/auth-rfc/threads/t1/comments', 'POST', WS_A, workspaceOf),
    ).toBe(true);
    expect(
      shareScopeAllows('/api/docs/auth-rfc/threads/t1/resolve', 'POST', WS_A, workspaceOf),
    ).toBe(true);
    expect(
      shareScopeAllows('/api/docs/auth-rfc/threads/t1/reanchor', 'POST', WS_A, workspaceOf),
    ).toBe(true);
    expect(
      shareScopeAllows('/api/docs/auth-rfc/suggestions/s1/accept', 'POST', WS_A, workspaceOf),
    ).toBe(true);
  });

  it('BLOCKS deleting the doc', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc', 'DELETE', WS_A, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs/ws-1%3Aindex.md', 'DELETE', WS_1, workspaceOf)).toBe(false);
  });

  it('BLOCKS whole-doc replacement and disk reparse', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/content', 'POST', WS_A, workspaceOf)).toBe(false);
    expect(
      shareScopeAllows('/api/docs/auth-rfc/reparse_from_disk', 'POST', WS_A, workspaceOf),
    ).toBe(false);
  });

  it('BLOCKS the agent-side document-surgery verbs hung off a thread', () => {
    for (const verb of ['rewrite_region', 'insert_after', 'insert_blocks_after']) {
      expect(
        shareScopeAllows(`/api/docs/auth-rfc/threads/t1/${verb}`, 'POST', WS_A, workspaceOf),
        verb,
      ).toBe(false);
    }
  });

  it('BLOCKS a doc subroute added later (closed by default)', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/export', 'GET', WS_A, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs/auth-rfc/rename', 'POST', WS_A, workspaceOf)).toBe(false);
  });

  it('BLOCKS writing the audit trail, including the retired evidence route', () => {
    // The allowlist above is the positive control: these same predicates say
    // yes to the review verbs, so a `false` here is a decision and not a
    // probe that can never see anything.
    for (const target of [WS_A, WS_1] as const) {
      expect(shareScopeAllows('/api/tasks/t-1/transition', 'POST', target, workspaceOf)).toBe(
        false,
      );
      expect(shareScopeAllows('/api/tasks/t-1/evidence', 'POST', target, workspaceOf)).toBe(false);
    }
  });
});

describe('shareScopeAllows (workspace-hub surfaces — §3.12 commit 8)', () => {
  // A board share. Every share is one now — it opens `/workspaces/<id>` and
  // scope comes entirely from workspaceId, which is why the target is a single
  // field rather than a landing doc plus a grant.
  const HUB: ShareTarget = { workspaceId: 'hub-1' };
  // A share scoped to a DIFFERENT board — the neighbour that must not reach
  // this one. It used to be a doc-scoped share, then a doc-plus-workspace one;
  // the boundary it tests has always been board-to-board.
  const OTHER_WS: ShareTarget = { workspaceId: 'ws-a' };
  const workspaceOf = (d: string) =>
    d === 'auth-rfc' ? ['ws-a'] : d.startsWith('hub-1:') ? ['hub-1'] : [];

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
    for (const target of [HUB, OTHER_WS]) {
      expect(shareScopeAllows('/api/plugin/refresh', 'POST', target, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/api/plugin/refresh', 'GET', target, workspaceOf)).toBe(false);
    }
    // Positive control: the same targets DO reach their own surfaces, so the
    // refusals above are about this path and not about the fixture.
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', HUB, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc', 'GET', OTHER_WS, workspaceOf)).toBe(true);
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

  it('a share on ANOTHER board gets NONE of the three (the §3.3 rule-2 boundary)', () => {
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', OTHER_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/y/ws%3Ahub-1', 'GET', OTHER_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/y/ws:hub-1', 'GET', OTHER_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/events/workspace/hub-1', 'GET', OTHER_WS, workspaceOf)).toBe(false);
    // Positive control: the same three, for the board that share DOES cover.
    // Without it a target that reached no board at all would pass this test.
    expect(shareScopeAllows('/workspaces/ws-a', 'GET', OTHER_WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/y/ws%3Aws-a', 'GET', OTHER_WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/events/workspace/ws-a', 'GET', OTHER_WS, workspaceOf)).toBe(true);
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
    // A share on another board never reaches this one, review queue included.
    expect(
      shareScopeAllows('/api/workspaces/hub-1/review-items', 'GET', OTHER_WS, workspaceOf),
    ).toBe(false);
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
    expect(
      shareScopeAllows('/api/docs/auth-rfc/threads/t1/promote', 'POST', OTHER_WS, workspaceOf),
    ).toBe(false);
  });

  it('allows the task-chip resolution endpoint (GET only) — §3.3 rule 2', () => {
    expect(shareScopeAllows('/api/docs/auth-rfc/tasks', 'GET', OTHER_WS, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc/tasks', 'POST', OTHER_WS, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc/tasks', 'GET', OTHER_WS, workspaceOf)).toBe(false);
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
  // Both targets are board shares, which since the board-only removal is the
  // only kind there is: a grouping cannot be shared on its own, so reaching
  // one is always the board→grouping hop under test here.
  const HUB: ShareTarget = { workspaceId: 'hub-1' };
  const OTHER_HUB: ShareTarget = { workspaceId: 'hub-2' };
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

  it('the old doc-only target reaches nothing at all, not even its own doc', () => {
    // This used to be "a DOC share is not widened by any of it", whose
    // positive control was that the share still opened its one doc. That
    // grant is what per-doc sharing WAS, so the control has to move: the
    // reachable-half is now the same doc under a board target. The shape
    // itself is now just an absent workspaceId — the docId field the old
    // target carried went with board-only sharing.
    const docShare: ShareTarget = {}; // no workspaceId
    expect(shareScopeAllows('/api/docs/rev-a%3Asrc~app.ts', 'GET', docShare, workspacesOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/workspaces/rev-a/tree', 'GET', docShare, workspacesOf)).toBe(
      false,
    );
    expect(shareScopeAllows('/api/docs/hub-1%3Aplan.md', 'GET', docShare, workspacesOf)).toBe(
      false,
    );
    // Positive control, same path, same resolver: the board share reaches it.
    expect(shareScopeAllows('/api/docs/rev-a%3Asrc~app.ts', 'GET', HUB, workspacesOf)).toBe(true);
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

describe('shareScopeAllows — resources under the workspace path', () => {
  // Everything a reviewer opens now hangs off `/workspaces/<id>/…`. The
  // allowlist is closed-by-default, so each nested shape needs an allowance —
  // and each allowance needs a matching refusal, or "it works" and "it is
  // open" look the same from a passing test.
  const HUB: ShareTarget = { workspaceId: 'w-1' };
  // `d-in` is a doc on the shared workspace; `rev-1` is a review filed on it;
  // `d-out` and `rev-out` belong to a DIFFERENT workspace.
  const workspacesOf = (id: string): string[] => {
    if (id === 'd-in' || id === 'rev-1' || id === 'rev-1:src~a.ts') return ['w-1'];
    if (id === 'd-out' || id === 'rev-out') return ['w-2'];
    return [];
  };

  it('serves the workspace’s own nav pages — the bug this fixes', () => {
    // Before this, the allowance was `!seg.includes('/')`, so the bare hub
    // page passed and every tab on it was refused. A visitor landing on the
    // share link could not click Tasks.
    for (const p of [
      '/workspaces/w-1',
      '/workspaces/w-1/home',
      '/workspaces/w-1/tasks',
      '/workspaces/w-1/mine',
      '/workspaces/w-1/activity',
    ]) {
      expect(shareScopeAllows(p, 'GET', HUB, workspacesOf), p).toBe(true);
    }
  });

  it('refuses another workspace’s nav pages', () => {
    for (const p of ['/workspaces/w-2', '/workspaces/w-2/home', '/workspaces/w-2/tasks']) {
      expect(shareScopeAllows(p, 'GET', HUB, workspacesOf), p).toBe(false);
    }
  });

  it('refuses a nav suffix nobody defined, rather than anything after the id', () => {
    // The allowance is a named list, not "one more segment". Otherwise a
    // route added later is granted before anyone decides it should be.
    for (const p of ['/workspaces/w-1/settings', '/workspaces/w-1/admin', '/workspaces/w-1/x/y']) {
      expect(shareScopeAllows(p, 'GET', HUB, workspacesOf), p).toBe(false);
    }
  });

  it('serves a doc on the shared workspace', () => {
    expect(shareScopeAllows('/workspaces/w-1/docs/d-in', 'GET', HUB, workspacesOf)).toBe(true);
    expect(
      shareScopeAllows('/workspaces/w-1/docs/rev-1%3Asrc~a.ts', 'GET', HUB, workspacesOf),
    ).toBe(true);
  });

  it('refuses a doc that is NOT on the shared workspace, however the URL is spelled', () => {
    // Negative control for the line above: the workspace segment matching is
    // not enough on its own — the doc has to be in scope too, or naming your
    // own workspace would serve you every doc on the server.
    expect(shareScopeAllows('/workspaces/w-1/docs/d-out', 'GET', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/workspaces/w-1/docs/unknown', 'GET', HUB, workspacesOf)).toBe(false);
    // …and naming the doc correctly under the WRONG workspace is refused too.
    expect(shareScopeAllows('/workspaces/w-2/docs/d-in', 'GET', HUB, workspacesOf)).toBe(false);
  });

  it('serves a review filed on the shared workspace, and refuses one that is not', () => {
    expect(shareScopeAllows('/workspaces/w-1/reviews/rev-1', 'GET', HUB, workspacesOf)).toBe(true);
    expect(shareScopeAllows('/workspaces/w-1/reviews/rev-out', 'GET', HUB, workspacesOf)).toBe(
      false,
    );
  });

  it('serves a mockup on the shared workspace, and refuses one that is not', () => {
    expect(shareScopeAllows('/workspaces/w-1/mockups/d-in', 'GET', HUB, workspacesOf)).toBe(true);
    expect(shareScopeAllows('/workspaces/w-1/mockups/d-out', 'GET', HUB, workspacesOf)).toBe(false);
  });

  it('refuses every write to a workspace path, however in-scope the ids are', () => {
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/workspaces/w-1', '/workspaces/w-1/home', '/workspaces/w-1/docs/d-in']) {
        expect(shareScopeAllows(p, m, HUB, workspacesOf), `${m} ${p}`).toBe(false);
      }
    }
  });

  it('refuses a deeper path under an allowed prefix', () => {
    // `/docs/<id>` and nothing below it: a doc id never contains a slash, so
    // an extra segment is either a typo or someone probing.
    expect(shareScopeAllows('/workspaces/w-1/docs/d-in/raw', 'GET', HUB, workspacesOf)).toBe(false);
    expect(shareScopeAllows('/workspaces/w-1/reviews/rev-1/files', 'GET', HUB, workspacesOf)).toBe(
      false,
    );
  });

  it('refuses the old per-doc share target on every new path', () => {
    // Same rule as everywhere else: a target naming no workspace grants
    // nothing, including the shapes added here.
    const NO_WS: ShareTarget = {};
    for (const p of ['/workspaces/w-1', '/workspaces/w-1/home', '/workspaces/w-1/docs/d-in']) {
      expect(shareScopeAllows(p, 'GET', NO_WS, workspacesOf), p).toBe(false);
    }
  });
});

/**
 * The collaboration hostname — one stable public address, an Access
 * application in front of it, the SHARE surface behind it.
 *
 * The predicate half. Every assertion here is about the three conditions that
 * must ALL hold before a proxied hostname classifies as anything but `deny`,
 * because each one on its own is the whole gate: drop the proxy requirement
 * and a LAN client claims the name unauthenticated, drop the Access
 * requirement and the tunnel does, drop exact matching and a lookalike does.
 */
describe('isAccessTunnelHost', () => {
  const OPTED_IN = {
    ...LOCAL,
    proxiedAccessHosts: ['workspaces.example.com'],
    accessFronted: true,
  };

  it('accepts a listed host that really arrived through the edge', () => {
    expect(isAccessTunnelHost('workspaces.example.com', { ...OPTED_IN, viaProxy: true })).toBe(
      true,
    );
    // …and the port is stripped like everywhere else.
    expect(isAccessTunnelHost('workspaces.example.com:443', { ...OPTED_IN, viaProxy: true })).toBe(
      true,
    );
  });

  it('refuses the same host when the request did NOT come through the edge', () => {
    // The inverse of the local veto, and the reason the two lists cannot leak
    // into each other: a LAN client sending `Host: workspaces.example.com`
    // has no Access token in front of it, so there is nothing to verify.
    expect(isAccessTunnelHost('workspaces.example.com', OPTED_IN)).toBe(false);
    expect(isAccessTunnelHost('workspaces.example.com', { ...OPTED_IN, viaProxy: false })).toBe(
      false,
    );
  });

  it('refuses everything when Access is not configured', () => {
    // The load-bearing refusal: without an Access application the hostname
    // would be the API exposed to anyone who can reach the tunnel.
    expect(
      isAccessTunnelHost('workspaces.example.com', {
        ...OPTED_IN,
        accessFronted: false,
        viaProxy: true,
      }),
    ).toBe(false);
  });

  it('refuses a host nobody opted in, and a lookalike of one who did', () => {
    const proxied = { ...OPTED_IN, viaProxy: true };
    expect(isAccessTunnelHost('attacker.example.com', proxied)).toBe(false);
    expect(isAccessTunnelHost('workspaces.example.com.attacker.com', proxied)).toBe(false);
    expect(isAccessTunnelHost('evil-workspaces.example.com', proxied)).toBe(false);
    expect(isAccessTunnelHost(null, proxied)).toBe(false);
    expect(isAccessTunnelHost('', proxied)).toBe(false);
  });

  it('never makes a listed host LOCAL — the cf-ray veto is untouched', () => {
    // The narrowing has to be a new kind, not a hole in the old predicate.
    // If this ever goes true, a tunnel visitor has the unauthenticated
    // product and every assertion about scope below is moot.
    const proxied = { ...OPTED_IN, viaProxy: true };
    expect(isTrustedLocalHost('workspaces.example.com', proxied)).toBe(false);
    expect(isTrustedLocalHost('localhost', proxied)).toBe(false);
  });
});

describe('classifyHost — collaboration hosts', () => {
  const lookupShare = (h: string) =>
    h === 'share-abc.tunnel.example.com' ? { workspaceId: 'ws-shared' } : null;
  const OPTED_IN = {
    ...LOCAL,
    lookupShare,
    proxiedAccessHosts: ['workspaces.example.com'],
    accessFronted: true,
  };

  it('a proxied opt-in host → collab', () => {
    expect(classifyHost('workspaces.example.com', { ...OPTED_IN, viaProxy: true })).toEqual({
      kind: 'collab',
    });
  });

  it('WITHOUT the opt-in, behaviour is exactly what it was — deny', () => {
    // A deployment that has not opted in must be bit-for-bit unchanged, so
    // the same request against an empty list has to land where it always did.
    expect(
      classifyHost('workspaces.example.com', { ...LOCAL, lookupShare, viaProxy: true }),
    ).toEqual({ kind: 'deny', reason: 'unknown_host' });
    expect(
      classifyHost('workspaces.example.com', {
        ...OPTED_IN,
        proxiedAccessHosts: [],
        viaProxy: true,
      }),
    ).toEqual({ kind: 'deny', reason: 'unknown_host' });
  });

  it('WITHOUT Access configured, an opt-in host is denied rather than served', () => {
    expect(
      classifyHost('workspaces.example.com', {
        ...OPTED_IN,
        accessFronted: false,
        viaProxy: true,
      }),
    ).toEqual({ kind: 'deny', reason: 'unknown_host' });
  });

  it('does not take a hostname away from the share or link rule', () => {
    // Collab is checked last, so a name that is already a share hostname or
    // the link hostname keeps the narrower meaning it had.
    expect(
      classifyHost('share-abc.tunnel.example.com', {
        ...OPTED_IN,
        proxiedAccessHosts: ['share-abc.tunnel.example.com'],
        viaProxy: true,
      }),
    ).toEqual({ kind: 'share', target: { workspaceId: 'ws-shared' } });
    expect(
      classifyHost('links.example.com', {
        ...OPTED_IN,
        proxiedAccessHosts: ['links.example.com'],
        linkHost: 'links.example.com',
        viaProxy: true,
      }),
    ).toEqual({ kind: 'link' });
  });
});

/**
 * What a collaboration host may touch.
 *
 * The fixture is two boards, one doc each, and NEITHER is shared — which is
 * the point of the surface: scope is decided per request from the path, so a
 * visitor reaches the board they were sent a link to and the docs filed on
 * it, and nothing that is not a workspace resource at all.
 */
describe('collabScope', () => {
  const workspacesOf = (id: string): string[] => {
    if (id === 'design-doc') return ['ws-a'];
    if (id === 'other-doc') return ['ws-b'];
    return [];
  };
  const allows = (p: string, m = 'GET') => collabScope(p, m, workspacesOf).allowed;

  it('reaches a board, its tabs, and the docs filed on it', () => {
    for (const p of [
      '/workspaces/ws-a',
      '/workspaces/ws-a/tasks',
      '/workspaces/ws-a/docs/design-doc',
      '/api/workspaces/ws-a',
      '/api/workspaces/ws-a/attachments',
      '/api/workspaces/ws-a/tree',
      '/api/docs/design-doc',
      '/api/docs/design-doc/threads',
      '/review/design-doc',
      '/y/design-doc',
      '/y/ws:ws-a',
      '/events/design-doc',
      '/events/workspace/ws-a',
    ]) {
      expect(allows(p), p).toBe(true);
    }
    expect(allows('/api/workspaces/ws-a/editable-file', 'POST')).toBe(true);
  });

  it('reaches the app shell, which names no workspace at all', () => {
    for (const p of ['/app/app.js', '/app/styles.css', '/widget.js', '/favicon.ico']) {
      expect(allows(p), p).toBe(true);
    }
    // …and the target it produces names no workspace either, so nothing
    // downstream can read a shell request as scoped to one.
    expect(collabScope('/app/app.js', 'GET', workspacesOf)).toEqual({
      allowed: true,
      target: {},
    });
  });

  it('names the workspace the path belongs to, so the visitor is scoped to it', () => {
    expect(collabScope('/api/docs/design-doc', 'GET', workspacesOf)).toEqual({
      allowed: true,
      target: { workspaceId: 'ws-a' },
    });
    expect(collabScope('/workspaces/ws-b', 'GET', workspacesOf)).toEqual({
      allowed: true,
      target: { workspaceId: 'ws-b' },
    });
  });

  it('refuses a doc filed on no workspace — reach is workspace membership', () => {
    expect(allows('/api/docs/loose-doc')).toBe(false);
    expect(allows('/review/loose-doc')).toBe(false);
    expect(allows('/y/loose-doc')).toBe(false);
  });

  it('refuses the enumeration routes — the doc list and the workspace list', () => {
    expect(allows('/api/docs')).toBe(false);
    expect(allows('/api/workspaces')).toBe(false);
    expect(allows('/api/activity')).toBe(false);
  });

  it('refuses the landing page and the demo surfaces', () => {
    // The collaboration address is not "the product at a nicer name" — a
    // visitor arrives at a board link, not at Bryan's home screen.
    expect(allows('/')).toBe(false);
    expect(allows('/demos/mockup')).toBe(false);
    expect(allows('/mockup/anything')).toBe(false);
  });

  it('refuses share administration, deploy, and the plugin refresh', () => {
    expect(allows('/api/share')).toBe(false);
    expect(allows('/api/share/workspace', 'POST')).toBe(false);
    expect(allows('/api/share/link', 'POST')).toBe(false);
    expect(allows('/api/share/some-id', 'DELETE')).toBe(false);
    expect(allows('/api/deploy', 'POST')).toBe(false);
    expect(allows('/api/deploy')).toBe(false);
    expect(allows('/api/plugin/refresh', 'POST')).toBe(false);
  });

  it('refuses the operator verbs on a doc it CAN read', () => {
    // Paired deliberately: the read is allowed in the first test above, so
    // these refusals are about the verb rather than about the doc.
    expect(allows('/api/docs/design-doc', 'DELETE')).toBe(false);
    expect(allows('/api/docs/design-doc/content', 'POST')).toBe(false);
    expect(allows('/api/docs/design-doc/reparse_from_disk', 'POST')).toBe(false);
    expect(allows('/api/docs/design-doc/threads/t-1/promote', 'POST')).toBe(false);
    expect(allows('/api/docs/design-doc/threads/t-1/rewrite_region', 'POST')).toBe(false);
    expect(allows('/api/workspaces/ws-a', 'DELETE')).toBe(false);
    expect(allows('/api/workspaces/ws-a/refresh', 'POST')).toBe(false);
    expect(allows('/api/workspaces/ws-a/groups', 'POST')).toBe(false);
    expect(allows('/api/workspaces', 'POST')).toBe(false); // bind a folder
    expect(allows('/api/diffs', 'POST')).toBe(false);
  });

  it('refuses a doc reached through a workspace it does not belong to', () => {
    // Spelling your own workspace in front of someone else's doc is the
    // widening this inherits from `shareScopeAllows`, so it is asserted here
    // too: the workspace segment and the membership check are two conditions,
    // not one.
    expect(allows('/workspaces/ws-a/docs/other-doc')).toBe(false);
    expect(allows('/workspaces/ws-b/docs/design-doc')).toBe(false);
  });

  it('gives a path that names no workspace the shell and nothing else', () => {
    // `collabScope` falls back to an unspellable workspace id when a path
    // names none, so the static allowances survive and every
    // workspace-dependent rule refuses. A caller who guesses that id must
    // gain nothing — it resolves through `workspacesOf`, which knows no such
    // workspace, so no doc is ever inside it.
    const sentinel = '\u0000collab-no-workspace';
    expect(allows(`/api/docs/${encodeURIComponent(sentinel)}`)).toBe(false);
    expect(allows(`/api/docs/${encodeURIComponent(sentinel)}/threads`)).toBe(false);
    expect(allows(`/review/${encodeURIComponent(sentinel)}`)).toBe(false);
    // Naming it as a WORKSPACE buys nothing either: it is exactly as reachable
    // as any other id that names no workspace, and the routes behind it 404.
    expect(allows(`/workspaces/${encodeURIComponent(sentinel)}/docs/design-doc`)).toBe(false);
  });
});

/**
 * The operator's own product at a public hostname: the third opt-in list.
 * Same three conditions as the collaboration list — through the edge, Access
 * in front, exact membership — and a different grant at the end: `local`
 * after the token, not `collab`. What is pinned here is that neither of the
 * other two lists leaks into it, and that it leaks into neither of them.
 */
describe('isProxiedTrustedHost', () => {
  const OPT_IN = { proxiedTrustedHosts: ['operator.example.com'], accessFronted: true };

  it('recognises a listed host that came through the edge with Access in front', () => {
    expect(isProxiedTrustedHost('operator.example.com', { ...OPT_IN, viaProxy: true })).toBe(true);
    expect(isProxiedTrustedHost('Operator.Example.com:443', { ...OPT_IN, viaProxy: true })).toBe(
      true,
    );
  });

  it('requires the proxy hop — a LAN client naming the host has no Access in front', () => {
    expect(isProxiedTrustedHost('operator.example.com', { ...OPT_IN, viaProxy: false })).toBe(
      false,
    );
    expect(isProxiedTrustedHost('operator.example.com', OPT_IN)).toBe(false);
  });

  it('requires Access to really be configured — the list is otherwise ignored', () => {
    expect(
      isProxiedTrustedHost('operator.example.com', {
        ...OPT_IN,
        viaProxy: true,
        accessFronted: false,
      }),
    ).toBe(false);
  });

  it('matches exactly — no lookalikes, no missing Host', () => {
    for (const h of ['attacker.operator.example.com', 'operator.example.com.evil', null, '']) {
      expect(isProxiedTrustedHost(h, { ...OPT_IN, viaProxy: true }), String(h)).toBe(false);
    }
  });

  it('is NOT reached from the other two lists', () => {
    // A TRUSTED_HOSTS entry and a collaboration entry are both refused here…
    const others = {
      extraHosts: ['lan-alias.example.com'],
      proxiedAccessHosts: ['collab.example.com'],
      accessFronted: true,
      viaProxy: true,
    };
    expect(isProxiedTrustedHost('lan-alias.example.com', others)).toBe(false);
    expect(isProxiedTrustedHost('collab.example.com', others)).toBe(false);
    // …and an entry here is still refused by the local predicate through the
    // proxy, so the cf-ray veto is exactly what it was.
    expect(
      isTrustedLocalHost('operator.example.com', { ...LOCAL, ...OPT_IN, viaProxy: true }),
    ).toBe(false);
  });
});

describe('classifyHost — the proxied trusted host', () => {
  const lookupShare = () => null;
  const OPT_IN = { ...LOCAL, lookupShare, proxiedTrustedHosts: ['operator.example.com'] };

  it('classifies proxied-local: the token is still to come, then the product', () => {
    expect(
      classifyHost('operator.example.com', { ...OPT_IN, accessFronted: true, viaProxy: true }),
    ).toEqual({ kind: 'proxied-local' });
  });

  it('is deny without the proxy hop, and deny without Access', () => {
    expect(classifyHost('operator.example.com', { ...OPT_IN, accessFronted: true })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
    expect(classifyHost('operator.example.com', { ...OPT_IN, viaProxy: true })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
  });

  it('a host on BOTH opt-in lists is collab — the narrower grant wins', () => {
    expect(
      classifyHost('operator.example.com', {
        ...OPT_IN,
        proxiedAccessHosts: ['operator.example.com'],
        accessFronted: true,
        viaProxy: true,
      }),
    ).toEqual({ kind: 'collab' });
  });

  it('never classifies a TRUSTED_HOSTS entry proxied-local', () => {
    expect(
      classifyHost('lan-alias.example.com', {
        ...OPT_IN,
        extraHosts: ['lan-alias.example.com'],
        accessFronted: true,
        viaProxy: true,
      }),
    ).toEqual({ kind: 'deny', reason: 'unknown_host' });
  });
});
