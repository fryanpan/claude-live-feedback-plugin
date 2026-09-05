/**
 * Every browser-facing hostname is behind Cloudflare Access, over HTTP.
 *
 * Bryan, 2026-09-02: *"Every access including share link or reading requires
 * sign in via one time code or otherwise… Let's make everyone go through
 * cloudflare access. No internal hole."*
 *
 * The hole had two halves, and both are asserted here rather than in the
 * predicate tests, because the route layer is where a gate is actually
 * bypassed:
 *
 *  1. **The LAN / tailnet grant.** A `TRUSTED_HOSTS` entry, or any hostname
 *     that resolved to this machine, was served like loopback — no token, no
 *     sign-in, the whole product. Anyone on the tailnet had everything.
 *  2. **The Host header.** A request arriving from anywhere with
 *     `Host: localhost` read as loopback, because the header was the only
 *     thing consulted. The socket's peer address is now required too.
 *
 * The rule is one line — the box, and nothing else, is served without a
 * token — and the surfaces below are the ones a person actually reads: the
 * board, a doc, its attachments, a folder tree, a diff review's file, the
 * Yjs socket and the SSE stream. Every refusal is paired with the SAME
 * request carrying a valid Access token, so nothing here can pass on a
 * server that refuses everything.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'access-only-kid';
const OPERATOR_AUD = 'aud-for-the-operator-app';
/** The operator's own browser-facing hostname, through the tunnel. */
const OPERATOR_HOST = 'operator.example.com';
/** A `TRUSTED_HOSTS` entry: the LAN / tailnet name this change closed. */
const LAN_ALIAS = 'mac-mini-alias.example.com';
const OPERATOR_EMAIL = 'operator@example.com';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

/** This machine's non-loopback IPv4 addresses, to dial its own server from
 *  an address that genuinely is not loopback. */
const nonLoopbackIPv4 = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => (i as { address: string }).address);

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email?: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email = OPERATOR_EMAIL) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-operator')
      .sign(privateKey);
});

describe('access-only browser hosts', () => {
  let handle: ServerHandle;
  /** The same server with the rule turned OFF — the positive control for
   *  every "the LAN used to reach this" claim below. */
  let legacy: ServerHandle;
  let dataDir: string;
  let legacyDataDir: string;
  let folder: string;
  let repo: string;
  let base: string;
  let jwt: string;

  let boardId: string;
  let docId: string;
  let treeId: string;
  let diffMemberDocId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A request through the tunnel to the operator's hostname. */
  const proxied = (path: string, withToken: boolean) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: {
        host: OPERATOR_HOST,
        ...CF_RAY,
        ...(withToken ? { 'cf-access-jwt-assertion': jwt } : {}),
      },
    });

  /** A request naming the LAN alias, arriving directly (no proxy hop). */
  const onLan = (h: ServerHandle, path: string) =>
    fetch(`http://localhost:${h.port}${path}`, { headers: { host: LAN_ALIAS } });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'access-only-'));
    legacyDataDir = mkdtempSync(join(tmpdir(), 'access-only-legacy-'));
    folder = mkdtempSync(join(tmpdir(), 'access-only-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nThe bind entry.\n');

    repo = mkdtempSync(join(tmpdir(), 'access-only-repo-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@partner.example',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@partner.example',
        },
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.md'), '# App\n\nBefore.\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'app.md'), '# App\n\nAfter.\n');

    const opts = {
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      // Share hostnames wired, as prod has them. Without `shares` the server
      // falls into legacy whole-server mode and demands a token from loopback
      // too, which would hide the one grant this file has to prove survives.
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      trustedHosts: [LAN_ALIAS],
      proxiedTrustedHosts: [OPERATOR_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
      // A separate axis with its own suite (auth-routes). Off here so the
      // loopback fixtures below can be built without a session, and because
      // leaving it on would make every assertion in this file ambiguous
      // between two gates. It does not weaken the write test at the end: a
      // VERIFIED identity outranks the claimed body whichever way this flag
      // is set.
      requireSignInToWrite: false,
    };
    handle = createServer({ port: 0, dataDir, ...opts });
    // Same declarations, rule off. Nothing else differs, which is what makes
    // it a control for the rule and not for the configuration.
    legacy = createServer({
      port: 0,
      dataDir: legacyDataDir,
      ...opts,
      accessOnlyBrowserHosts: false,
    });
    base = `http://localhost:${handle.port}`;
    jwt = await signJwt(OPERATOR_AUD);

    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Access-only board' }),
    });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;

    const docPath = join(dataDir, 'note.md');
    writeFileSync(docPath, '# Note\n\nBody.\n');
    docId = 'note';
    expect(
      (
        await local('/api/docs', {
          method: 'POST',
          body: JSON.stringify({ docId, type: 'markdown', sourceUrl: docPath }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await local(`/api/workspaces/${boardId}/docs`, {
          method: 'POST',
          body: JSON.stringify({ docId }),
        })
      ).status,
    ).toBe(200);

    const bind = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: boardId }),
    });
    expect(bind.status).toBe(200);
    treeId = ((await bind.json()) as { workspaceId: string }).workspaceId;

    const diff = await local('/api/diffs', {
      method: 'POST',
      body: JSON.stringify({ repo, base: 'main', hubWorkspaceId: boardId }),
    });
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { files: Array<{ docId: string }> };
    diffMemberDocId = diffBody.files[0]?.docId ?? '';
    expect(diffMemberDocId).not.toBe('');
  });

  afterAll(async () => {
    await handle.stop();
    await legacy.stop();
    for (const d of [dataDir, legacyDataDir, folder, repo]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** Every browser-readable surface, by the name a person would use. */
  const surfaces = (): Array<[string, string]> => [
    ['the board page', `/workspaces/${boardId}`],
    ['the board record', `/api/workspaces/${boardId}`],
    ['a doc', `/api/docs/${docId}`],
    ['its comment threads', `/api/docs/${docId}/threads`],
    ['the board attachments', `/workspaces/${boardId}/agents`],
    ['a bound folder tree', `/api/workspaces/${treeId}/tree`],
    ['a diff review file', `/api/docs/${encodeURIComponent(diffMemberDocId)}`],
    ['the doc SSE stream', `/events/${encodeURIComponent(docId)}`],
  ];

  describe('a proxied browser host: no token, no content', () => {
    it('refuses every readable surface without an Access token', async () => {
      for (const [name, path] of surfaces()) {
        const r = await proxied(path, false);
        expect(r.status, name).toBe(401);
        // …and nothing of the payload leaks in the refusal body.
        expect(await r.text(), name).not.toContain(boardId);
      }
    });

    it('POSITIVE CONTROL: the same requests WITH a valid token are served', async () => {
      // Without this the block above would pass on a server that answered
      // 401 to the operator as well — which is an outage, not a gate.
      for (const [name, path] of surfaces()) {
        const r = await proxied(path, true);
        expect(r.status, name).toBe(200);
      }
    });

    it('refuses the Yjs websocket without a token, and completes it with one', async () => {
      const upgrade = (withToken: boolean) =>
        fetch(`${base}/y/${encodeURIComponent(docId)}`, {
          headers: {
            host: OPERATOR_HOST,
            ...CF_RAY,
            'x-forwarded-proto': 'https',
            ...(withToken ? { 'cf-access-jwt-assertion': jwt } : {}),
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            origin: `https://${OPERATOR_HOST}`,
          },
        });
      expect((await upgrade(false)).status).toBe(401);
      // 101 is the upgrade; anything else means the guard refused it.
      expect((await upgrade(true)).status).toBe(101);
    });
  });

  describe('the LAN / tailnet grant is closed', () => {
    it('refuses a TRUSTED_HOSTS name on every surface', async () => {
      for (const [name, path] of surfaces()) {
        const r = await onLan(handle, path);
        expect(r.status, name).toBe(403);
      }
    });

    it('POSITIVE CONTROL: the same name on the same build, rule off, is served', async () => {
      // The declaration still works — what changed is that a declaration is
      // no longer a sign-in. Without this control the 403s above would be
      // indistinguishable from a trusted-host list that stopped being read.
      const r = await onLan(legacy, '/api/docs');
      expect(r.status).toBe(200);
    });
  });

  describe('loopback is the one door left open', () => {
    it('serves the agent on the box with no token at all', async () => {
      // The MCP client resolves `http://localhost:<port>` from the discovery
      // file. If this ever 401s, every agent on the machine is locked out.
      for (const [name, path] of surfaces()) {
        expect((await local(path)).status, name).toBe(200);
      }
    });

    it('refuses Host: localhost from a peer that is not on the box', async () => {
      const addrs = nonLoopbackIPv4();
      if (addrs.length === 0) {
        // Stated rather than silently skipped: this machine cannot host the
        // scenario. The predicate is pinned in host-guard.test.ts.
        expect(addrs).toEqual([]);
        return;
      }
      const from = addrs[0] as string;
      const r = await fetch(`http://${from}:${handle.port}/api/docs`, {
        // The spoof IS the test: the header says loopback, the socket does not.
        headers: { host: `localhost:${handle.port}` },
      });
      expect(r.status).toBe(403);

      // POSITIVE CONTROL on the same address and the same build: with the
      // rule off, that spoof is exactly what used to work.
      const before = await fetch(`http://${from}:${legacy.port}/api/docs`, {
        headers: { host: `localhost:${legacy.port}` },
      });
      expect(before.status).toBe(200);
    });
  });

  describe("the server's own emailed-code sign-in is off", () => {
    // Under access-only a person has already proven an address before the
    // page loads. A second sign-in would ask them to authenticate twice, and
    // its "you are not signed in" state is a dead end on a surface where
    // nobody can be un-signed-in.
    it('404s the page and both challenge routes, from the box itself', async () => {
      expect((await local('/signin')).status).toBe(404);
      expect(
        (
          await local('/api/auth/start', {
            method: 'POST',
            body: JSON.stringify({ email: 'someone@example.com' }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await local('/api/auth/verify', {
            method: 'POST',
            body: JSON.stringify({ email: 'someone@example.com', code: '000000' }),
          })
        ).status,
      ).toBe(404);
    });

    it('POSITIVE CONTROL: with the rule off, the same build serves them', async () => {
      // Without this, the 404s above would be indistinguishable from a
      // sign-in page that had simply stopped being built.
      const legacyBase = `http://localhost:${legacy.port}`;
      const page = await fetch(`${legacyBase}/signin`, {
        headers: { host: `localhost:${legacy.port}` },
      });
      expect(page.status).toBe(200);
      const start = await fetch(`${legacyBase}/api/auth/start`, {
        method: 'POST',
        headers: { host: `localhost:${legacy.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com' }),
      });
      expect(start.status).toBe(200);
    });

    it('leaves the session, profile and logout routes open', async () => {
      // A session minted before the flag moved still has to be readable and
      // endable, and the me-menu reads this route to show the Access
      // identity. Turning the CHALLENGE off is not turning identity off.
      const r = await local('/api/auth/session');
      expect(r.status).toBe(200);
      const body = (await r.json()) as { emailCodeSignIn?: boolean };
      // …and it says so, which is what stops the client painting a link to
      // the 404 above.
      expect(body.emailCodeSignIn).toBe(false);
      expect((await local('/api/auth/logout', { method: 'POST' })).status).toBe(200);
    });
  });

  describe('a signed-in visitor writes under their proven email', () => {
    it('posts a comment attributed to the Access identity, not the body', async () => {
      const r = await fetch(`${base}/api/docs/${docId}/threads/by_find`, {
        method: 'POST',
        headers: {
          host: OPERATOR_HOST,
          ...CF_RAY,
          'cf-access-jwt-assertion': jwt,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          author: { id: 'someone-else', name: 'Mallory', kind: 'known', color: '#123456' },
          text: 'A comment from a signed-in reader.',
          find: 'Body',
        }),
      });
      // There is no read-only tier: proving who you are is what buys the write.
      expect(r.status).toBe(200);
      const { thread } = (await r.json()) as {
        thread: { comments: Array<{ author: { id: string; name: string } }> };
      };
      expect(thread.comments[0]?.author.id).not.toBe('someone-else');
      expect(thread.comments[0]?.author.name).not.toBe('Mallory');
    });
  });
});
