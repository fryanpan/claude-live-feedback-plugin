/**
 * The share-link flow over HTTP: mint, redeem, and everything the share
 * hostname refuses afterwards.
 *
 * The design Bryan chose on 2026-09-03. ONE Cloudflare Access application
 * covers the share hostname with an "everyone" policy, so what arrives is a
 * verified email and nothing else; the server decides which workspace that
 * email may open. Redeeming a link makes a lasting member, and from then on
 * the membership grants access rather than the link.
 *
 * These drive the real route table because the route layer is the part
 * nothing type-checks — a gate wired in after a route that already answered
 * still passes a unit test. The store's own decisions are unit-tested in
 * `share-links-store.test.ts`; nothing here re-asserts them.
 *
 * ONE harness: a single server with a share hostname, an owner hostname, two
 * boards and a doc on each. Every describe below is a question about that one
 * fixture.
 *
 * Two things worth knowing before reading a failure:
 *
 *  - the two hostnames sit behind two Access APPLICATIONS with two audiences,
 *    and the cross-check tests are the reason both exist in the fixture. A
 *    single audience would make every one of them pass vacuously.
 *  - the share hostname is also configured with the retired per-share mode
 *    alongside, because that is what prod looks like while the old records
 *    drain, and the last describe asserts one of those still serves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailDisplayName } from '@feedback/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'share-link-kid';
/** The share hostname's own Access application — policy "everyone". */
const SHARE_AUD = 'aud-for-the-share-app';
/** The owner hostname's application — a different one, with a real policy. */
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const REVIEWER = 'reviewer@partner.example';
const SECOND_REVIEWER = 'second@partner.example';
const STRANGER = 'stranger@elsewhere.example';
const OWNER_EMAIL = 'owner@example.test';

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud, email) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-share-visitor')
      .sign(privateKey);
});

describe('share links over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  /** The board that gets shared, and one that never does. */
  let board: string;
  let otherBoard: string;
  /** A doc filed on each — what a scope answer is actually about. */
  let docId: string;
  let otherDocId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As the machine's owner — loopback, no proxy hop, no token. */
  const local = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);

  const postLocal = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** On the SHARE hostname, holding a token from the share application. */
  const onShareHost = async (path: string, email: string, init: RequestInit = {}) =>
    req(path, SHARE_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** On the OWNER hostname, holding a token from the owner application. */
  const onOwnerHost = async (path: string, email: string, init: RequestInit = {}) =>
    req(path, OWNER_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(OWNER_AUD, email),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** Mint a share link for a board and hand back its id and URL. */
  const mintLink = async (
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ linkId: string; url: string }> => {
    const r = await postLocal('/api/share/workspace', { workspaceId, ...extra });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { link: { linkId: string }; url: string };
    return { linkId: body.link.linkId, url: body.url };
  };

  const boardWith = async (name: string, docName: string) => {
    const created = await postLocal('/workspaces', { name });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    const path = join(dataDir, `${docName}.md`);
    writeFileSync(path, `# ${docName}\n\nBody.\n`);
    const doc = await postLocal('/api/docs', {
      docId: docName,
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    const mintedDocId = ((await doc.json()) as { docId: string }).docId;
    const filed = await postLocal(`/workspaces/${encodeURIComponent(id)}/docs`, {
      docId: docName,
    });
    expect(filed.status).toBe(200);
    return { boardId: id, mintedDocId };
  };

  const serverOptions = () => ({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
    shareLinkHosts: [SHARE_HOST],
    shareLinkAudience: SHARE_AUD,
    proxiedTrustedHosts: [OWNER_HOST],
    proxiedTrustedEmails: [OWNER_EMAIL],
    // The retired per-share mode configured alongside, because that is what
    // prod looks like while its old records drain — and because a shared
    // verifier would resolve the share hostname's audience from the share
    // registry and refuse every request here.
    share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
  });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-link-flow-'));
    handle = createServer(serverOptions());
    base = `http://localhost:${handle.port}`;
    ({ boardId: board, mintedDocId: docId } = await boardWith('Shared board', 'design-doc'));
    ({ boardId: otherBoard, mintedDocId: otherDocId } = await boardWith(
      'Private board',
      'private-doc',
    ));
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('minting a link', () => {
    it('returns a share.<domain>/s/<id> URL and makes nothing in Cloudflare', async () => {
      // The mock Cloudflare client counts what a mint would have created. A
      // share link must add none of it — that is the whole cost this design
      // removed. The old mode is wired in this fixture, so a route that still
      // called Cloudflare would succeed and be caught only here.
      const cfState = { apps: [] as unknown[], policies: [] as unknown[] };
      const probe = createServer({
        ...serverOptions(),
        dataDir: mkdtempSync(join(tmpdir(), 'share-link-mint-')),
        share: {
          config: ACCESS_SHARE_CONFIG,
          cfApi: mockCfApi(cfState as never),
        },
      });
      const probeBase = `http://localhost:${probe.port}`;
      const made = await fetch(`${probeBase}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Probe board' }),
      });
      const probeBoard = ((await made.json()) as { workspace: { id: string } }).workspace.id;
      const r = await fetch(`${probeBase}/api/share/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: probeBoard }),
      });
      expect(r.status).toBe(200);
      const { link, url } = (await r.json()) as {
        link: { linkId: string; workspaceId: string; expiresAt: number | null };
        url: string;
      };
      expect(url).toBe(`https://${SHARE_HOST}/s/${link.linkId}`);
      expect(link.workspaceId).toBe(probeBoard);
      // Long-living by default (Bryan, 2026-09-03).
      expect(link.expiresAt).toBeNull();
      expect(cfState.apps).toHaveLength(0);
      expect(cfState.policies).toHaveLength(0);
      await probe.stop();
    });

    it('still accepts the old payload, and says the audience no longer means anything', async () => {
      // Peers keep calling the shared server with the payload THEIR bundle
      // sends. `allowDomains` and `name` were the per-share-application mint's
      // two arguments; ignoring them silently would let a caller believe the
      // link is narrower than it is, so the reply names what it dropped.
      const r = await postLocal('/api/share/workspace', {
        workspaceId: board,
        allowDomains: ['@partner.example'],
        name: 'some-slug',
        ttlSeconds: undefined,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { allowDomainsIgnored?: boolean };
      expect(body.allowDomainsIgnored).toBe(true);
    });

    it('honours an expiry when one is asked for', async () => {
      const r = await postLocal('/api/share/workspace', { workspaceId: board, ttlSeconds: 3600 });
      expect(r.status).toBe(200);
      const { link } = (await r.json()) as {
        link: { createdAt: number; expiresAt: number | null };
      };
      // Measured off the record's own clock rather than against `Date.now()`:
      // the assertion is the arithmetic, and a wall-clock comparison would
      // pass for any future moment at all.
      expect(link.expiresAt).toBe(link.createdAt + 3600 * 1000);
    });

    // Whether a BROWSER may call this route is asserted in
    // `share-routes-browser.test.ts`, which pairs every refusal with the agent
    // request that must still succeed on the same body. Moving the mint here
    // did not move that question, so it is not re-asked in this file.
  });

  describe('redeeming a link', () => {
    it('records the verified email as a member and opens the board', async () => {
      const { linkId } = await mintLink(board);
      const r = await onShareHost(`/s/${linkId}`, REVIEWER);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(board)}`);
      // …and the membership is what the next request is judged on.
      const meta = await onShareHost(
        `/workspaces/${encodeURIComponent(board)}?format=json`,
        REVIEWER,
      );
      expect(meta.status).toBe(200);
    });

    it('is idempotent — a second visit adds no second redemption', async () => {
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, SECOND_REVIEWER)).status).toBe(302);
      expect((await onShareHost(`/s/${linkId}`, SECOND_REVIEWER)).status).toBe(302);
      const listed = await listShares();
      const link = listed.links.find((l) => l.linkId === linkId);
      expect(link?.redemptions.filter((x) => x.email === SECOND_REVIEWER)).toHaveLength(1);
    });

    it('lets a member back in without the link at all', async () => {
      const { linkId } = await mintLink(board);
      await onShareHost(`/s/${linkId}`, REVIEWER);
      // No link in this request — the membership is the grant now.
      const doc = await onShareHost(`/api/docs/${docId}`, REVIEWER);
      expect(doc.status).toBe(200);
    });

    it('demands a token — reaching the hostname is not reaching a board', async () => {
      // Access normally challenges before the request arrives. This is the
      // server's own answer if it does not, which is the case that matters.
      const { linkId } = await mintLink(board);
      const r = await req(`/s/${linkId}`, SHARE_HOST, { headers: CF_RAY });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_jwt' });
    });

    it('refuses the hostname when the request did not come through the edge', async () => {
      // A LAN client can send any Host. Without the proxy hop there is no
      // Access application in front of it, so the list must not recognise it.
      const { linkId } = await mintLink(board);
      const r = await req(`/s/${linkId}`, SHARE_HOST, {
        headers: { 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, REVIEWER) },
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });
  });

  describe('a link that is not live', () => {
    it('answers one page for revoked and for never-existed, and records nothing', async () => {
      const { linkId } = await mintLink(board);
      expect((await local(`/api/share/${linkId}`, { method: 'DELETE' })).status).toBe(200);

      const revoked = await onShareHost(`/s/${linkId}`, STRANGER);
      expect(revoked.status).toBe(404);
      const revokedBody = await revoked.text();
      expect(revokedBody).toContain('This link no longer works');
      // It names nothing about the workspace behind it.
      expect(revokedBody).not.toContain(board);

      const unknown = await onShareHost(`/s/${'a'.repeat(32)}`, STRANGER);
      expect(unknown.status).toBe(404);
      expect(await unknown.text()).toBe(revokedBody);

      // Nobody was admitted by either.
      const after = await onShareHost(
        `/workspaces/${encodeURIComponent(board)}?format=json`,
        STRANGER,
      );
      expect(after.status).toBe(403);
    });

    it('answers the same page once the link has expired, and admits nobody', async () => {
      // Time is moved by rewriting the record and restarting, not by waiting:
      // the expiry is a number on disk and the server reads it at boot.
      const { linkId } = await mintLink(board, { ttlSeconds: 3600 });
      await handle.stop();
      const path = join(dataDir, 'share-links.json');
      const state = JSON.parse(readFileSync(path, 'utf8')) as {
        links: Array<{ linkId: string; expiresAt: number | null }>;
      };
      const record = state.links.find((l) => l.linkId === linkId);
      expect(record).toBeTruthy();
      record!.expiresAt = Date.now() - 1000;
      writeFileSync(path, JSON.stringify(state, null, 2));
      handle = createServer(serverOptions());
      base = `http://localhost:${handle.port}`;

      const r = await onShareHost(`/s/${linkId}`, STRANGER);
      expect(r.status).toBe(404);
      expect(await r.text()).toContain('This link no longer works');
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, STRANGER))
          .status,
      ).toBe(403);
      // Positive control on the same restarted server: a live link still
      // admits, so the refusal above is the expiry rather than a dead store.
      // A different address on purpose — admitting STRANGER here would leave
      // them a member of the board the tests below expect them locked out of.
      const { linkId: live } = await mintLink(board);
      expect((await onShareHost(`/s/${live}`, 'after-restart@partner.example')).status).toBe(302);
    });
  });

  describe('the audience cross-check', () => {
    it("refuses an owner-hostname token on the share host, and the share host's on the owner's", async () => {
      const { linkId } = await mintLink(board);
      // A token minted for the OWNER application, presented on the share host.
      const wrongOnShare = await req(`/s/${linkId}`, SHARE_HOST, {
        headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(OWNER_AUD, OWNER_EMAIL) },
      });
      expect(wrongOnShare.status).toBe(401);

      // …and a token minted at the everyone-policy SHARE application,
      // presented at the operator's own door. This is the direction that
      // matters most: anyone on the internet can mint one by typing an email.
      const wrongOnOwner = await req('/api/docs', OWNER_HOST, {
        headers: { ...CF_RAY, 'cf-access-jwt-assertion': await signJwt(SHARE_AUD, OWNER_EMAIL) },
      });
      expect(wrongOnOwner.status).toBe(401);
    });

    it('positive controls: each token works on the hostname it was minted for', async () => {
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, REVIEWER)).status).toBe(302);
      // The owner's own door, with the owner's own application and an email
      // on the operator allowlist: the whole product.
      expect((await onOwnerHost('/api/docs', OWNER_EMAIL)).status).toBe(200);
    });

    it('a share-host member is still nobody at the owner door', async () => {
      // Membership grants a board on the share hostname. It is not a grant to
      // the operator's address, whose allowlist is a different record.
      const { linkId } = await mintLink(board);
      await onShareHost(`/s/${linkId}`, REVIEWER);
      const r = await onOwnerHost('/api/docs', REVIEWER);
      expect(r.status).toBe(403);
    });
  });

  describe('what a share-host visitor may reach', () => {
    let member: string;
    beforeAll(async () => {
      member = 'scoped-member@partner.example';
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, member)).status).toBe(302);
    });

    it('opens the board it was given, and the docs filed on it', async () => {
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, member)).status,
      ).toBe(200);
      const doc = await onShareHost(`/api/docs/${docId}`, member);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { meta: { docId: string } }).meta.docId).toBe(docId);
      expect((await onShareHost(`/api/docs/${docId}/threads`, member)).status).toBe(200);
    });

    it('is refused every workspace it was not given', async () => {
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(otherBoard)}?format=json`, member))
          .status,
      ).toBe(403);
      expect((await onShareHost(`/api/docs/${otherDocId}`, member)).status).toBe(403);
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(otherBoard)}?format=json`, member))
          .status,
      ).toBe(403);
    });

    it('is refused the operator verbs on the board it DOES hold', async () => {
      // The point of routing this through `collabScope`: a route a share
      // visitor is refused is refused here by the same lines.
      for (const [path, init] of [
        ['/api/docs', {}],
        ['/api/share', {}],
        [`/workspaces/${encodeURIComponent(board)}/rename`, { method: 'POST' }],
        [`/workspaces/${encodeURIComponent(board)}/retired`, { method: 'PUT' }],
        [`/workspaces/${encodeURIComponent(board)}/lead`, { method: 'PUT' }],
        [`/workspaces/${encodeURIComponent(board)}/voice`, { method: 'POST' }],
      ] as Array<[string, RequestInit]>) {
        const r = await onShareHost(path, member, init);
        expect(r.status, path).toBe(403);
      }
      const del = await onShareHost(`/workspaces/${encodeURIComponent(board)}`, member, {
        method: 'DELETE',
      });
      expect(del.status).toBe(403);
    });

    it('works the board it DOES hold — files a task, moves it, and is named for it', async () => {
      // Bryan, 2026-09-03: "Let's allow everything for now." A member is a
      // participant, so this is the positive control the refusals above are
      // measured against.
      const filed = await onShareHost(`/workspaces/${encodeURIComponent(board)}/tasks`, member, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Filed by a member', assignee: 'human' }),
      });
      expect(filed.status, await filed.clone().text()).toBe(200);
      const { task } = (await filed.json()) as { task: { id: string; createdBy?: string } };
      // Attributed to the address Cloudflare Access verified, not to a claim.
      expect(task.createdBy).toBe(emailDisplayName(member));

      const moved = await onShareHost(`/api/tasks/${task.id}/transition`, member, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'in-progress' }),
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      // The same row is refused to a signed-in stranger, and to a member of
      // no board at all — the boundary is the board, not the verb.
      const byStranger = await onShareHost(`/api/tasks/${task.id}/transition`, STRANGER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'done' }),
      });
      expect(byStranger.status).toBe(403);
      expect(await byStranger.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('is refused a row on a board it was never given', async () => {
      const other = await postLocal(
        `/workspaces/${encodeURIComponent(otherBoard)}/tasks?format=json`,
        {
          title: 'On the private board',
          assignee: 'human',
        },
      );
      expect(other.status).toBe(200);
      const otherTask = ((await other.json()) as { task: { id: string } }).task.id;
      const r = await onShareHost(`/api/tasks/${otherTask}/transition`, member, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'done' }),
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('gets nothing useful from root or any path naming no workspace', async () => {
      for (const path of ['/', '/workspaces', '/api/diffs', '/demos']) {
        const r = await onShareHost(path, member);
        expect(r.status, path).toBe(403);
        expect(await r.json(), path).toEqual({ error: 'out_of_share_scope' });
      }
    });

    it('refuses a signed-in stranger every board, in the same words', async () => {
      // Same body as the out-of-scope refusal on purpose: two different
      // replies would tell an admitted stranger which guessed ids are real.
      for (const wsId of [board, otherBoard]) {
        const r = await onShareHost(
          `/workspaces/${encodeURIComponent(wsId)}?format=json`,
          STRANGER,
        );
        expect(r.status, wsId).toBe(403);
        expect(await r.json(), wsId).toEqual({ error: 'out_of_share_scope' });
      }
    });

    it('is refused everything while the sharing switch is off', async () => {
      expect((await postLocal('/api/share/enabled', { enabled: false })).status).toBe(200);
      try {
        const r = await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, member);
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'sharing_disabled' });
      } finally {
        expect((await postLocal('/api/share/enabled', { enabled: true })).status).toBe(200);
      }
      // Positive control: back on, the same member reaches the board again.
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, member)).status,
      ).toBe(200);
    });
  });

  /**
   * FULL ACCESS to the board a link was given (Bryan, 2026-09-03: "We want
   * users that have the share link to have full access to the board").
   *
   * The four acts a member used to be refused — filing a doc on the board,
   * holding a meeting on it, opening its settings, reading its Activity tab —
   * plus the roster the strip is drawn from. Each one is asserted twice: once
   * on the board this member holds, and once on the board they do not, so a
   * test cannot pass by reaching nothing.
   *
   * Three of the four were refused for a REASON rather than out of caution,
   * and each reason is a leak that had to be closed somewhere else for the
   * route to open. Those closures are the second half of this describe.
   */
  describe('what full access to the shared board means', () => {
    let member: string;
    /** What the store kept for the notes home — the value the member's read
     *  must not contain. Filled by the settings test, which sets it. */
    let storedRepoRoot = '';
    beforeAll(async () => {
      member = 'full-access-member@partner.example';
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, member)).status).toBe(302);
    });

    const asMember = (path: string, init: RequestInit = {}) => onShareHost(path, member, init);
    const postAsMember = (path: string, body: unknown) =>
      asMember(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('starts a meeting on its own board, and is refused one on another', async () => {
      const started = await postAsMember(`/workspaces/${encodeURIComponent(board)}/huddles`, {
        kind: 'discussion',
        topic: 'Member meeting',
      });
      expect(started.status, await started.clone().text()).toBe(200);
      const body = (await started.json()) as {
        docId: string;
        hubWorkspaceId: string;
        meta: Record<string, unknown>;
      };
      expect(body.hubWorkspaceId).toBe(board);
      // The doc it minted is on this board, so the member can now open it.
      expect((await asMember(`/api/docs/${body.docId}`)).status).toBe(200);

      // …and the reply says nothing about the machine. A huddle is seeded
      // into a file under the owner's data directory, and this route answers
      // with the room's own meta — the second door beside `GET /api/docs/<id>`.
      expect(body.meta.sourceUrl).toBeUndefined();
      expect(body.meta.owner).toBeUndefined();
      expect(body.meta.workspaceRoot).toBeUndefined();
      expect(JSON.stringify(body.meta)).not.toContain(dataDir);

      const elsewhere = await postAsMember(
        `/workspaces/${encodeURIComponent(otherBoard)}/huddles`,
        { kind: 'discussion' },
      );
      expect(elsewhere.status).toBe(403);
      expect(await elsewhere.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('files onto its board a doc it can already see, and cannot pull one in', async () => {
      // What attaching does is make a doc readable HERE — share scoping
      // answers on the boards holding a doc, and this call adds one. So the
      // question the route asks a member is the guard's own: can you already
      // open this? Its real subject is a file inside a folder bind filed on
      // the board, which a member can open but which has no row of its own;
      // this fixture has no folder bind, so the reachable case is asserted on
      // the board's own doc, where the call is a no-op that still has to be
      // ALLOWED for the boundary below to mean anything.
      const reachable = await postAsMember(`/workspaces/${encodeURIComponent(board)}/docs`, {
        docId,
      });
      expect(reachable.status, await reachable.clone().text()).toBe(200);

      // The private board's doc is what this must never reach. The path names
      // the member's own board, so the scope check says yes; what refuses it
      // is the target.
      const stolen = await postAsMember(`/workspaces/${encodeURIComponent(board)}/docs`, {
        docId: otherDocId,
      });
      expect(stolen.status).toBe(403);
      expect(await stolen.json()).toEqual({ error: 'out_of_share_scope' });
      // …and nothing landed: the doc is still refused, which the status alone
      // does not establish.
      expect((await asMember(`/api/docs/${otherDocId}`)).status).toBe(403);

      // The 200 above is this refusal's control: one route, one member, two
      // targets, two answers — so the 403 is the target and not an attach
      // that never works. The board is deliberately left as it was; nothing
      // here files the private doc anywhere, because later tests in this file
      // read `otherDocId` as the doc this member cannot see.

      // Refused a board it was never given, whatever the target.
      const elsewhere = await postAsMember(`/workspaces/${encodeURIComponent(otherBoard)}/docs`, {
        docId,
      });
      expect(elsewhere.status).toBe(403);
      expect(await elsewhere.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('answers a doc id it may not have the same way whether or not it exists', async () => {
      // The route checked EXISTENCE before scope, so a member learned which
      // doc ids are real on the whole server: a doc on somebody else's board
      // came back 403 and a made-up id came back 404. Doc ids are readable
      // slugs, and the doc LIST is refused precisely to stop that
      // enumeration — answering it one id at a time is the same disclosure
      // through a narrower window.
      const real = await postAsMember(`/workspaces/${encodeURIComponent(board)}/docs`, {
        docId: otherDocId,
      });
      const invented = await postAsMember(`/workspaces/${encodeURIComponent(board)}/docs`, {
        docId: 'no-such-doc-anywhere',
      });
      expect(real.status).toBe(403);
      expect(invented.status).toBe(real.status);
      const inventedBody = await invented.json();
      expect(inventedBody).toEqual(await real.json());
      // Named, so a future change that made both 404 would still fail here:
      // the answer a member gets is the out-of-board refusal, not the miss.
      expect(inventedBody).toEqual({ error: 'out_of_share_scope' });

      // The owner is unaffected — a typo from the box still says what went
      // wrong, which is what makes the member's answer a redaction rather
      // than a route that stopped working.
      const owner = await postLocal(`/workspaces/${encodeURIComponent(board)}/docs`, {
        docId: 'no-such-doc-anywhere',
      });
      expect(owner.status).toBe(404);
      expect(await owner.json()).toEqual({ error: 'doc not found', docId: 'no-such-doc-anywhere' });
    });

    it('opens board settings without being told anything about the machine', async () => {
      // A notes home is `repoRoot` on the owner's disk. Set from the box, so
      // the member's read below is measured against a board that really has
      // one — without this the assertion passes on an absent field.
      const wrote = await local(`/workspaces/${encodeURIComponent(board)}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          notesHome: { repoRoot: process.cwd(), branch: 'main', dir: 'docs' },
          author: { id: 'owner', name: 'Owner', kind: 'person' },
        }),
      });
      expect(wrote.status, await wrote.clone().text()).toBe(200);
      const owner = await local(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(owner.status).toBe(200);
      const ownerView = (await owner.json()) as { notesHome?: { repoRoot?: string } };
      // Read back rather than compared to what was sent: the store keeps the
      // MAIN checkout's root, so a linked worktree's path is not what lands.
      storedRepoRoot = ownerView.notesHome?.repoRoot ?? '';
      expect(storedRepoRoot.length).toBeGreaterThan(0);

      const read = await asMember(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(read.status, await read.clone().text()).toBe(200);
      const view = (await read.json()) as {
        reviewItemCriteria?: { value?: string };
        notesHome?: unknown;
      };
      // The panel's own fields arrive…
      expect(typeof view.reviewItemCriteria?.value).toBe('string');
      // …and the machine's does not.
      expect(view.notesHome).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(storedRepoRoot);
    });

    it('shows who moved the parallelism cap by name, on both doors that say so', async () => {
      // The settings panel says "set by X". The actor behind it is a full
      // `TaskActor`, and the settings read handed a member the whole record —
      // id included — while `GET /workspaces/<id>`, the other door onto
      // the same fact, had been reducing it to name and kind since the cap
      // shipped. Two doors onto one fact cannot answer differently.
      const moverId = 'agent-cap-mover-probe';
      const moved = await local(`/workspaces/${encodeURIComponent(board)}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parallelismCap: 3,
          author: { id: moverId, name: 'Cap Mover', kind: 'agent' },
        }),
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      // Positive control: the id IS on the owner's read, so the member's read
      // below is measured against a payload that has something to hide.
      const owner = await local(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(owner.status).toBe(200);
      const ownerText = await owner.text();
      expect(ownerText).toContain('lastChange');
      expect(ownerText).toContain(moverId);

      type CapView = {
        parallelismCap?: {
          value?: number;
          lastChange?: { from?: number; to?: number; actor?: Record<string, unknown> };
        };
      };
      const read = await asMember(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(read.status, await read.clone().text()).toBe(200);
      const settingsText = await read.clone().text();
      const settingsView = (await read.json()) as CapView;
      // A real read, not an empty one: the cap and the move both survive.
      expect(settingsView.parallelismCap?.value).toBe(3);
      expect(settingsView.parallelismCap?.lastChange?.to).toBe(3);
      expect(settingsView.parallelismCap?.lastChange?.actor).toEqual({
        name: 'Cap Mover',
        kind: 'agent',
      });
      expect(settingsText).not.toContain(moverId);

      // The board record answers the same fact the same way.
      const record = await asMember(`/workspaces/${encodeURIComponent(board)}?format=json`);
      expect(record.status, await record.clone().text()).toBe(200);
      const recordText = await record.clone().text();
      const recordView = (await record.json()) as CapView;
      expect(recordView.parallelismCap?.lastChange?.actor).toEqual({
        name: 'Cap Mover',
        kind: 'agent',
      });
      expect(recordText).not.toContain(moverId);
    });

    it('edits the board settings it can see, and is refused the one field it cannot', async () => {
      const saved = await asMember(`/workspaces/${encodeURIComponent(board)}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewItemCriteria: 'Written by a member.' }),
      });
      expect(saved.status, await saved.clone().text()).toBe(200);
      const after = await local(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(
        ((await after.json()) as { reviewItemCriteria: { value: string } }).reviewItemCriteria
          .value,
      ).toBe('Written by a member.');

      // `notesHome` names a path on the owner's machine, and validating one
      // would answer "does this path exist there" besides. Refused BEFORE
      // that validation runs, so the refusal is the same for a real path and
      // an invented one — no oracle either way.
      for (const repoRoot of [process.cwd(), '/definitely/not/a/checkout']) {
        const r = await asMember(`/workspaces/${encodeURIComponent(board)}/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notesHome: { repoRoot, branch: 'main', dir: 'docs' } }),
        });
        expect(r.status, repoRoot).toBe(403);
        expect((await r.json()) as { error: string }).toMatchObject({
          error: 'not available to share visitors',
        });
      }
      // …and the stored value did not move.
      const unchanged = await local(`/workspaces/${encodeURIComponent(board)}/settings`);
      const home = ((await unchanged.json()) as { notesHome?: { repoRoot?: string } }).notesHome;
      expect(home?.repoRoot).toBe(storedRepoRoot);

      // Refused on the board it was not given, whatever the field.
      const elsewhere = await asMember(`/workspaces/${encodeURIComponent(otherBoard)}/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewItemCriteria: 'Not yours.' }),
      });
      expect(elsewhere.status).toBe(403);
      expect(await elsewhere.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('reads the Activity tab with actors named the way the live feed names them', async () => {
      // An actor id is what the board's live event stream refuses to send a
      // visitor. The audit log is the same bytes modulo transport, so it has
      // to refuse the same thing — this is the door nothing was checking.
      const actorId = 'agent-activity-probe';
      const filed = await postLocal(`/workspaces/${encodeURIComponent(board)}/tasks`, {
        title: 'Row that writes an audit line',
        assignee: 'human',
        author: { id: actorId, name: 'Activity Probe', kind: 'agent' },
      });
      expect(filed.status, await filed.clone().text()).toBe(200);

      const owner = await local(`/workspaces/${encodeURIComponent(board)}/events`);
      expect(owner.status).toBe(200);
      // The positive control: the id IS in the log, so the member's read
      // below is measured against a payload that has something to hide.
      expect(await owner.text()).toContain(actorId);

      const read = await asMember(`/workspaces/${encodeURIComponent(board)}/events`);
      expect(read.status, await read.clone().text()).toBe(200);
      const text = await read.clone().text();
      expect(text).not.toContain(actorId);
      // …and it is a real read, not an empty one: the display name survives.
      expect(text).toContain('Activity Probe');
      const { events } = (await read.json()) as { events: unknown[] };
      expect(events.length).toBeGreaterThan(0);

      const elsewhere = await asMember(`/workspaces/${encodeURIComponent(otherBoard)}/events`);
      expect(elsewhere.status).toBe(403);
      expect(await elsewhere.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('reads a review_item row on the Activity tab without the asker\u2019s id', async () => {
      // The row above covers `task.*`. `review_item.*` was outside the
      // redaction's prefix set entirely, so those three events crossed to a
      // member with the asker's full actor on them — while `decision.*`, the
      // answer to the very same ask, was reduced to name and kind.
      const askerId = 'agent-review-item-probe';
      const asker = { id: askerId, name: 'Review Item Probe', kind: 'agent' };
      const filed = await postLocal(`/workspaces/${encodeURIComponent(board)}/tasks`, {
        title: 'Row that carries a review item',
        assignee: 'human',
        author: asker,
      });
      expect(filed.status, await filed.clone().text()).toBe(200);
      const taskId = ((await filed.json()) as { task: { id: string } }).task.id;

      const headline = 'Which of the two goal orders do you want?';
      const raised = await postLocal(`/api/tasks/${encodeURIComponent(taskId)}/review-items`, {
        review: {
          shape: 'review',
          headline,
          detail: 'Both orders ship the same work; they differ in what lands first.',
        },
        author: asker,
      });
      expect(raised.status, await raised.clone().text()).toBe(200);

      // Positive control: the id IS in the log, so the member's read below is
      // measured against a payload that has something to hide.
      const owner = await local(`/workspaces/${encodeURIComponent(board)}/events`);
      expect(owner.status).toBe(200);
      const ownerText = await owner.text();
      expect(ownerText).toContain('review_item.added');
      expect(ownerText).toContain(askerId);

      const read = await asMember(`/workspaces/${encodeURIComponent(board)}/events`);
      expect(read.status, await read.clone().text()).toBe(200);
      const text = await read.text();
      expect(text).not.toContain(askerId);
      // A real read, not an empty one: the row, the ask and the display name
      // all survive — the ask is board content, and the member may see it.
      expect(text).toContain('review_item.added');
      expect(text).toContain(headline);
      expect(text).toContain('Review Item Probe');
    });

    it('reads the agent roster of its own board, and no other', async () => {
      const roster = await asMember(`/workspaces/${encodeURIComponent(board)}/agents`);
      expect(roster.status, await roster.clone().text()).toBe(200);
      // The roster's host-machine field never rides to a visitor.
      expect(await roster.text()).not.toContain('"endpoint"');
      expect((await asMember(`/workspaces/${encodeURIComponent(otherBoard)}/agents`)).status).toBe(
        403,
      );
    });

    it('is still refused a tracker import — it names a path on the owner’s disk', async () => {
      // The one act on this board a member does NOT gain. The route reads the
      // file named in the request body and answers with what it parsed, so
      // admitting it would be an arbitrary file read on the owner's machine
      // for anyone holding a link. The browser gate in front of it refuses
      // pages, and a member's non-browser client is not a page — so the board
      // gate is what has to refuse, and does.
      const path = join(dataDir, 'tracker.md');
      writeFileSync(
        path,
        '# Tracker\n\n## Now\n\n| Task | Status | Owner |\n| --- | --- | --- |\n',
      );
      const asClient = await postAsMember(`/workspaces/${encodeURIComponent(board)}/import-tasks`, {
        path,
      });
      expect(asClient.status).toBe(403);
      expect(await asClient.json()).toEqual({ error: 'out_of_share_scope' });

      // Positive control on the same client shape and the same board: a
      // route the member DOES hold answers, so the refusal is the route.
      const allowed = await asMember(`/workspaces/${encodeURIComponent(board)}/settings`);
      expect(allowed.status).toBe(200);

      // …and the owner, over loopback, still imports.
      const byOwner = await postLocal(`/workspaces/${encodeURIComponent(board)}/import-tasks`, {
        path,
        author: { id: 'owner', name: 'Owner', kind: 'person' },
      });
      expect(byOwner.status, await byOwner.clone().text()).toBe(200);
    });

    it('edits a doc filed on the board through the region verbs, and no other doc', async () => {
      // Anchored by FINDING its text, so the region the rewrite targets
      // really resolves in the doc — a hand-built fingerprint orphans, and a
      // 409 would let this test pass without the guard ever being asked.
      const th = await postLocal(`/api/docs/${docId}/threads/by_find`, {
        author: { id: 'owner', name: 'Owner', kind: 'person' },
        text: 'Tighten this',
        find: 'Body.',
      });
      expect(th.status, await th.clone().text()).toBe(200);
      const tid = ((await th.json()) as { thread: { id: string } }).thread.id;

      const edited = await postAsMember(`/api/docs/${docId}/threads/${tid}/rewrite_region`, {
        replacement: 'Body, rewritten by a member.',
      });
      expect(edited.status, await edited.clone().text()).toBe(200);

      // The same verb on the private board's doc is refused by the same line
      // that refuses reading it.
      const elsewhere = await postAsMember(
        `/api/docs/${otherDocId}/threads/${tid}/rewrite_region`,
        { replacement: 'Not yours.' },
      );
      expect(elsewhere.status).toBe(403);
      expect(await elsewhere.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('reads the meeting surface of its own board’s doc, and cannot dial a bot out', async () => {
      expect((await asMember('/api/meeting-engines')).status).toBe(200);
      expect((await asMember(`/api/docs/${docId}/meetings`)).status).toBe(200);
      const bot = await asMember(`/api/docs/${docId}/meeting-bot`);
      expect(bot.status).toBe(200);
      // Inviting one spends money at a vendor and sends a participant into a
      // call outside this server. Not a way to work THIS board.
      const invite = await postAsMember(`/api/docs/${docId}/meeting-bot`, {
        meetingUrl: 'https://meet.example.com/abc',
      });
      expect(invite.status).toBe(403);
      expect(await invite.json()).toEqual({ error: 'out_of_share_scope' });
      // …and the same reads on the private board's doc.
      expect((await asMember(`/api/docs/${otherDocId}/meetings`)).status).toBe(403);
      expect((await asMember(`/api/docs/${otherDocId}/meeting-bot`)).status).toBe(403);
    });

    it('is still refused everything outside the board it was given', async () => {
      const cases: Array<[string, RequestInit]> = [
        // The list of boards, and every other board's rows.
        ['/workspaces', {}],
        [`/workspaces/${encodeURIComponent(otherBoard)}/tasks?format=json`, {}],
        // Share administration: minting, revoking, the member list, the switch.
        ['/api/share', {}],
        ['/api/share/workspace', { method: 'POST' }],
        ['/api/share/enabled', { method: 'POST' }],
        // Deploy and the operator surface.
        ['/api/deploy', { method: 'POST' }],
        ['/api/plugin/refresh', { method: 'POST' }],
        // Anything that names a path on the owner's machine.
        ['/workspaces', { method: 'POST' }],
        ['/api/docs', { method: 'POST' }],
        ['/api/diffs', { method: 'POST' }],
        // This board's own lifecycle: it was given to work on, not to retire.
        [`/workspaces/${encodeURIComponent(board)}/retired`, { method: 'PUT' }],
        [`/workspaces/${encodeURIComponent(board)}`, { method: 'DELETE' }],
      ];
      for (const [path, init] of cases) {
        const r = await asMember(path, {
          ...init,
          headers: { 'content-type': 'application/json' },
          ...(init.method && init.method !== 'GET' ? { body: '{}' } : {}),
        });
        expect(r.status, `${init.method ?? 'GET'} ${path}`).toBe(403);
      }
      // The board is still there, which a status code alone does not say.
      expect((await asMember(`/workspaces/${encodeURIComponent(board)}?format=json`)).status).toBe(
        200,
      );
    });

    /**
     * The two share verbs that END somebody's access, asked by a member.
     *
     * They are the sharp half of "share administration", and the list above
     * named them in its comment without ever sending them: revoking is
     * `DELETE /api/share/<id>` and removing a member is
     * `POST /api/share/member/remove`, neither of which matches the
     * `/api/share/workspace` and `/api/share/enabled` paths it did send.
     *
     * The target here is the member's OWN live link and the member's OWN
     * address, so a hole would not be a stray 403 somewhere harmless — it
     * would be a member able to cut off the people they were let in beside,
     * this test's own access included. That is also what makes the control at
     * the end meaningful: the member is still a member afterwards, so the two
     * refusals are the guard and not a request that never arrived.
     */
    it('cannot revoke a link or remove a member, not even its own', async () => {
      const { linkId } = await mintLink(board);
      const revoked = await asMember(`/api/share/${encodeURIComponent(linkId)}`, {
        method: 'DELETE',
      });
      expect(revoked.status, await revoked.clone().text()).toBe(403);

      const removedSelf = await postAsMember('/api/share/member/remove', {
        workspaceId: board,
        email: member,
      });
      expect(removedSelf.status, await removedSelf.clone().text()).toBe(403);

      const removedOther = await postAsMember('/api/share/member/remove', {
        workspaceId: board,
        email: 'someone-else@partner.example',
      });
      expect(removedOther.status).toBe(403);

      // Neither landed: the link the owner just minted still redeems, and
      // this member is still on the board. A 403 alone would not say either.
      const newcomer = 'still-admitted@partner.example';
      expect((await onShareHost(`/s/${linkId}`, newcomer)).status).toBe(302);
      expect((await asMember(`/workspaces/${encodeURIComponent(board)}?format=json`)).status).toBe(
        200,
      );
    });
  });

  /**
   * Three ways out of the shared board that the participation grant opened,
   * found by a security review of the change that opened it.
   *
   * Each one starts from a route the member is SUPPOSED to reach, so none of
   * them is caught by asking whether the path is in scope — the path is. What
   * moves is where the answer goes (a board named in the body), where it comes
   * from (a store lookup that spans every board), or whether an answer is
   * produced at all.
   */
  describe('the ways out of the shared board a member must not have', () => {
    let member: string;
    let threadId: string;
    beforeAll(async () => {
      member = 'escape-member@partner.example';
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, member)).status).toBe(302);
      const th = await postLocal(`/api/docs/${docId}/threads`, {
        author: { id: 'owner', name: 'Owner', kind: 'person' },
        text: 'Worth a ticket',
        anchor: {
          kind: 'element',
          fingerprint: {
            tag: 'P',
            stableAttrs: {},
            classes: [],
            text: 'Body.',
            path: 'P[0] > BODY[0]',
            dataAttrs: {},
          },
          snippet: { text: 'Body.' },
        },
      });
      expect(th.status, await th.clone().text()).toBe(200);
      threadId = ((await th.json()) as { thread: { id: string } }).thread.id;
    });

    const promote = (destination: string) =>
      onShareHost(`/api/docs/${docId}/threads/${threadId}/promote`, member, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: destination, title: 'Promoted by a member' }),
      });

    it('promotes a thread onto the board it holds, and refuses any other destination', async () => {
      // The path names the DOC, which is in scope; the destination board is
      // named in the BODY, which the scope check never read. So the guard
      // said yes to a write that landed on a board this member was never
      // given.
      const escaped = await promote(otherBoard);
      expect(escaped.status).toBe(403);
      expect(await escaped.json()).toEqual({ error: 'out_of_share_scope' });

      // …and nothing landed there. A 403 whose row was already written is
      // the failure this test exists for, so the board is read back rather
      // than the status being trusted.
      const listed = await local(`/workspaces/${encodeURIComponent(otherBoard)}/tasks?format=json`);
      expect(listed.status).toBe(200);
      const { tasks } = (await listed.json()) as { tasks: Array<{ title: string }> };
      expect(tasks.map((t) => t.title)).not.toContain('Promoted by a member');

      // Positive control: the same call naming their own board succeeds, so
      // the refusal above is the destination and not a broken promote.
      const kept = await promote(board);
      expect(kept.status, await kept.clone().text()).toBe(200);
      const { task } = (await kept.json()) as { task: { id: string; workspaceId: string } };
      expect(task.workspaceId).toBe(board);
    });

    it('reads a row’s backlinks without learning what a private board points at', async () => {
      // `backlinksFor` walks every workspace, because a ref may cross one.
      // Read through a member's scope that is a private row's title, id,
      // status and assignee arriving on a route the member is allowed.
      const onShared = await postLocal(
        `/workspaces/${encodeURIComponent(board)}/tasks?format=json`,
        {
          title: 'The shared row',
          assignee: 'human',
        },
      );
      expect(onShared.status).toBe(200);
      const sharedTask = ((await onShared.json()) as { task: { id: string } }).task.id;

      const onPrivate = await postLocal(
        `/workspaces/${encodeURIComponent(otherBoard)}/tasks?format=json`,
        {
          title: 'Secret roadmap row',
          assignee: 'human',
        },
      );
      expect(onPrivate.status).toBe(200);
      const privateTask = ((await onPrivate.json()) as { task: { id: string } }).task.id;
      const linked = await postLocal(`/api/tasks/${privateTask}/links`, {
        ref: { kind: 'task', taskId: sharedTask },
      });
      expect(linked.status, await linked.clone().text()).toBe(200);

      const asMember = await onShareHost(`/api/tasks/${sharedTask}/links`, member);
      expect(asMember.status, await asMember.clone().text()).toBe(200);
      const memberView = (await asMember.json()) as {
        backlinks: Array<{ id: string; title: string }>;
      };
      expect(memberView.backlinks.map((b) => b.id)).not.toContain(privateTask);
      expect(JSON.stringify(memberView)).not.toContain('Secret roadmap row');

      // Positive control on the same row: the owner, who may see both boards,
      // still gets the backlink. Without this the assertion above passes on a
      // route that answers nothing at all.
      const asOwner = await local(`/api/tasks/${sharedTask}/links`);
      expect(asOwner.status).toBe(200);
      const ownerView = (await asOwner.json()) as { backlinks: Array<{ id: string }> };
      expect(ownerView.backlinks.map((b) => b.id)).toContain(privateTask);
    });

    it('answers a prototype-named subroute instead of dropping the connection', async () => {
      // The route tables are looked up by a segment the caller types. On a
      // plain object literal `toString` resolves up the prototype chain to a
      // function, `.includes` on it is undefined, and the TypeError escaped
      // the handler — so the connection closed with no response at all, which
      // is neither an allow nor a deny.
      const filed = await postLocal(`/workspaces/${encodeURIComponent(board)}/tasks?format=json`, {
        title: 'Row for the prototype probe',
        assignee: 'human',
      });
      expect(filed.status).toBe(200);
      const rowId = ((await filed.json()) as { task: { id: string } }).task.id;

      for (const seg of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
        const r = await onShareHost(`/api/tasks/${rowId}/${seg}`, member, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to: 'done' }),
        });
        expect([403, 404], `${seg} status`).toContain(r.status);
        // Also on the board prefix and the goal prefix, which read their own
        // tables the same way. Both are spelled under the board now — the
        // goal one especially, since `/api/goals/<id>` named no board at all.
        const board2 = await onShareHost(`/workspaces/${encodeURIComponent(board)}/${seg}`, member);
        expect([403, 404], `board ${seg} status`).toContain(board2.status);
        const goal = await onShareHost(
          `/workspaces/${encodeURIComponent(board)}/goals/${rowId}/${seg}`,
          member,
        );
        expect([403, 404], `goal ${seg} status`).toContain(goal.status);
      }

      // Positive control: a real subroute on the same row still answers, so
      // the loop above is not passing because the row or the member is broken.
      const real = await onShareHost(`/api/tasks/${rowId}/transition`, member, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'in-progress' }),
      });
      expect(real.status, await real.clone().text()).toBe(200);
    });
  });

  describe('once the retired mode is gone entirely', () => {
    /**
     * The end state this design is heading for: a share hostname, no per-share
     * Access applications, and none of their configuration left behind.
     *
     * Access being configured at all used to mean the WHOLE deployment sat
     * behind it, agents on the box included, and the thing that lifted that
     * was the presence of the per-share sharing surface. An operator who
     * finishes draining the old records and deletes their settings must not
     * fall back into it by subtraction.
     */
    const withoutOldMode = () => {
      const opts = { ...serverOptions(), dataDir: mkdtempSync(join(tmpdir(), 'share-link-only-')) };
      // biome-ignore lint/performance/noDelete: the absence IS the fixture
      delete (opts as { share?: unknown }).share;
      return createServer(opts);
    };

    it('leaves the agents on this machine unauthenticated', async () => {
      const probe = withoutOldMode();
      const r = await fetch(`http://localhost:${probe.port}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Board on a share-link-only server' }),
      });
      expect(r.status).toBe(200);
      await probe.stop();
    });

    it('can still shut the outside door, and open it again', async () => {
      // The master switch used to be keyed on the retired Cloudflare registry
      // alone, so on the deployment this flow is FOR it answered "sharing not
      // enabled" — while the gate it controls went on refusing share-link
      // requests. The only way to close the outside door was an env var plus a
      // restart, and that one is deliberately one-way, so the way back was a
      // restart too.
      const probe = withoutOldMode();
      const probeBase = `http://localhost:${probe.port}`;
      const made = await fetch(`${probeBase}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Switch board' }),
      });
      const probeBoard = ((await made.json()) as { workspace: { id: string } }).workspace.id;
      const minted = await fetch(`${probeBase}/api/share/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: probeBoard }),
      });
      const { link } = (await minted.json()) as { link: { linkId: string } };

      const flip = (enabled: boolean) =>
        fetch(`${probeBase}/api/share/enabled`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      const visit = (path: string) =>
        signJwt(SHARE_AUD, REVIEWER).then((jwt) =>
          fetch(`${probeBase}${path}`, {
            redirect: 'manual',
            headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
          }),
        );

      expect((await visit(`/s/${link.linkId}`)).status).toBe(302);
      const boardPath = `/workspaces/${encodeURIComponent(probeBoard)}?format=json`;
      expect((await visit(boardPath)).status).toBe(200);

      const off = await flip(false);
      expect(off.status).toBe(200);
      const refused = await visit(boardPath);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'sharing_disabled' });
      // Redeeming is shut too, not merely the board behind it.
      expect((await visit(`/s/${link.linkId}`)).status).toBe(403);

      expect((await flip(true)).status).toBe(200);
      expect((await visit(boardPath)).status).toBe(200);
      await probe.stop();
    });

    it('still serves the share hostname, and still refuses a stranger there', async () => {
      const probe = withoutOldMode();
      const probeBase = `http://localhost:${probe.port}`;
      const made = await fetch(`${probeBase}/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Share-link-only board' }),
      });
      const probeBoard = ((await made.json()) as { workspace: { id: string } }).workspace.id;
      const minted = await fetch(`${probeBase}/api/share/workspace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: probeBoard }),
      });
      expect(minted.status).toBe(200);
      const { link } = (await minted.json()) as { link: { linkId: string } };

      const visit = (path: string, email: string) =>
        signJwt(SHARE_AUD, email).then((jwt) =>
          fetch(`${probeBase}${path}`, {
            redirect: 'manual',
            headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
          }),
        );

      expect((await visit(`/s/${link.linkId}`, REVIEWER)).status).toBe(302);
      const board = `/workspaces/${encodeURIComponent(probeBoard)}?format=json`;
      expect((await visit(board, REVIEWER)).status).toBe(200);
      expect((await visit(board, STRANGER)).status).toBe(403);
      await probe.stop();
    });
  });

  describe('revoking a link versus removing a member', () => {
    const staying = 'stays-in@partner.example';

    it('revoking the link leaves the people who already came through it', async () => {
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, staying)).status).toBe(302);
      const revoke = await local(`/api/share/${linkId}`, { method: 'DELETE' });
      expect(revoke.status).toBe(200);
      expect(await revoke.json()).toMatchObject({ revoked: 'link', members: 'unchanged' });
      // Still in.
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, staying)).status,
      ).toBe(200);
      // But nobody new.
      const newcomer = await onShareHost(`/s/${linkId}`, STRANGER);
      expect(newcomer.status).toBe(404);
    });

    it('removing the member ends their access on the next request', async () => {
      const removed = await postLocal('/api/share/member/remove', {
        workspaceId: board,
        email: staying,
      });
      expect(removed.status).toBe(200);
      const after = await onShareHost(
        `/workspaces/${encodeURIComponent(board)}?format=json`,
        staying,
      );
      expect(after.status).toBe(403);
      // Positive control: another member of the same board is unaffected.
      const { linkId } = await mintLink(board);
      const other = 'unaffected@partner.example';
      expect((await onShareHost(`/s/${linkId}`, other)).status).toBe(302);
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(board)}?format=json`, other)).status,
      ).toBe(200);
    });

    it('says so when the address it was given is not a member', async () => {
      const r = await postLocal('/api/share/member/remove', {
        workspaceId: board,
        email: 'never-here@partner.example',
      });
      expect(r.status).toBe(404);
    });
  });

  describe('hanging up what is already connected', () => {
    /**
     * A websocket and an SSE stream are authorized ONCE, at their upgrade, and
     * never re-checked. So the two verbs that end access have to be able to
     * find them: without the membership stamped on the connection, ejecting a
     * member left their `/y/<doc>` reading AND writing until it dropped.
     */
    const openSocket = async (docPath: string, email: string) => {
      const jwt = await signJwt(SHARE_AUD, email);
      const ws = new WebSocket(`ws://localhost:${handle.port}/y/${docPath}`, {
        headers: { host: SHARE_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
      } as unknown as string[]);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener('open', () => resolve(true));
        ws.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });
      return { ws, opened };
    };

    const closeCode = (ws: WebSocket) =>
      new Promise<number>((resolve) => {
        ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
        setTimeout(() => resolve(-1), 5000);
      });

    /** The owner's own socket, which neither sweep may ever reach. */
    const ownerSocket = async (docPath: string) => {
      const jwt = await signJwt(OWNER_AUD, OWNER_EMAIL);
      const ws = new WebSocket(`ws://localhost:${handle.port}/y/${docPath}`, {
        headers: { host: OWNER_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
      } as unknown as string[]);
      const opened = await new Promise<boolean>((resolve) => {
        ws.addEventListener('open', () => resolve(true));
        ws.addEventListener('error', () => resolve(false));
        setTimeout(() => resolve(false), 3000);
      });
      return { ws, opened };
    };

    it('removing a member closes their socket, and leaves the owner’s open', async () => {
      const who = 'hung-up@partner.example';
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, who)).status).toBe(302);

      const member = await openSocket(docId, who);
      expect(member.opened).toBe(true);
      const owner = await ownerSocket(docId);
      expect(owner.opened).toBe(true);

      const memberClosed = closeCode(member.ws);
      const r = await postLocal('/api/share/member/remove', { workspaceId: board, email: who });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true, closedSockets: 1 });
      // 1008 is policy violation, which is what an ended membership is.
      expect(await memberClosed).toBe(1008);
      // The positive control: the owner was connected to the same doc through
      // the whole thing, and a sweep that reached them would be the real bug.
      expect(owner.ws.readyState).toBe(WebSocket.OPEN);
      owner.ws.close();
    });

    it('a member of another board keeps their socket when this one is ejected', async () => {
      const staying = 'other-board@partner.example';
      const { linkId } = await mintLink(otherBoard);
      expect((await onShareHost(`/s/${linkId}`, staying)).status).toBe(302);
      const held = await openSocket(otherDocId, staying);
      expect(held.opened).toBe(true);

      // Eject the SAME address from the other board. Membership is per
      // workspace, so this connection is not theirs to close.
      const { linkId: onBoard } = await mintLink(board);
      expect((await onShareHost(`/s/${onBoard}`, staying)).status).toBe(302);
      const r = await postLocal('/api/share/member/remove', {
        workspaceId: board,
        email: staying,
      });
      expect(r.status).toBe(200);
      expect(held.ws.readyState).toBe(WebSocket.OPEN);
      held.ws.close();
    });

    it('the master switch hangs up every share-link visitor, and not the owner', async () => {
      const who = 'switched-off@partner.example';
      const { linkId } = await mintLink(board);
      expect((await onShareHost(`/s/${linkId}`, who)).status).toBe(302);
      const member = await openSocket(docId, who);
      expect(member.opened).toBe(true);
      const owner = await ownerSocket(docId);
      expect(owner.opened).toBe(true);

      const memberClosed = closeCode(member.ws);
      try {
        const off = await postLocal('/api/share/enabled', { enabled: false });
        expect(off.status).toBe(200);
        expect((await off.json()) as { closedSockets?: number }).toMatchObject({
          closedSockets: 1,
        });
        expect(await memberClosed).toBe(1008);
        expect(owner.ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        expect((await postLocal('/api/share/enabled', { enabled: true })).status).toBe(200);
        owner.ws.close();
      }
    });
  });

  describe('what list_shares shows', () => {
    it('names each link, its state, who redeemed it and who is a member', async () => {
      const { linkId } = await mintLink(board, { label: 'Listing check' });
      const who = 'listed@partner.example';
      await onShareHost(`/s/${linkId}`, who);
      const listed = await listShares();
      const link = listed.links.find((l) => l.linkId === linkId);
      expect(link?.state).toBe('live');
      expect(link?.label).toBe('Listing check');
      expect(link?.redemptions.map((r) => r.email)).toContain(who);
      expect(listed.members.some((m) => m.workspaceId === board && m.email === who)).toBe(true);
    });

    it('marks a revoked link revoked rather than dropping it', async () => {
      const { linkId } = await mintLink(board);
      await local(`/api/share/${linkId}`, { method: 'DELETE' });
      const listed = await listShares();
      expect(listed.links.find((l) => l.linkId === linkId)?.state).toBe('revoked');
    });
  });

  describe('the retired per-share-application mode', () => {
    /**
     * Two machineries answered "who may open this board", and this describe is
     * about the seam between them. A per-share Access APPLICATION carries its
     * own hostname, audience and Cloudflare policy; a share LINK is a row in
     * this server's own file. Prod runs the second, so the first stops
     * minting — and the records it already made keep serving until they lapse.
     *
     * The fixture is a MIGRATION rather than a mock: one data directory, first
     * served by a deployment with no share hostname (which still mints), then
     * by one with a share hostname (which does not). That is the only way to
     * get an old record onto a new-flow server without hand-writing the
     * registry file, and it is also exactly what the operator does.
     */
    let migratedDir: string;
    let oldBoard: string;
    let oldShare: { hostname: string; audience: string };

    beforeAll(async () => {
      migratedDir = mkdtempSync(join(tmpdir(), 'share-link-migrate-'));
      // Phase one: the OLD deployment. No share hostname configured, so the
      // per-share mint is the only way to publish and still answers.
      const oldOpts = { ...serverOptions(), dataDir: migratedDir };
      // biome-ignore lint/performance/noDelete: the absence IS the fixture
      delete (oldOpts as { shareLinkHosts?: unknown }).shareLinkHosts;
      const before = createServer(oldOpts);
      const beforeBase = `http://localhost:${before.port}`;
      const post = (path: string, body: unknown) =>
        fetch(`${beforeBase}${path}`, {
          method: 'POST',
          headers: { host: `localhost:${before.port}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      const created = await post('/workspaces', { name: 'Board shared the old way' });
      expect(created.status).toBe(200);
      oldBoard = ((await created.json()) as { workspace: { id: string } }).workspace.id;
      const minted = await post('/api/share/link', {
        workspaceId: oldBoard,
        allowDomains: ['@partner.example'],
      });
      // POSITIVE CONTROL for every refusal below: on a deployment with no
      // share hostname the same call still mints, so the 410s are the share
      // hostname's doing and not a route that stopped working everywhere.
      expect(minted.status, await minted.clone().text()).toBe(200);
      oldShare = ((await minted.json()) as { share: { hostname: string; audience: string } }).share;
      await before.stop();
    });

    afterAll(() => rmSync(migratedDir, { recursive: true, force: true }));

    /** The same data directory, now served by a deployment on the new flow. */
    const migrated = () => createServer({ ...serverOptions(), dataDir: migratedDir });

    it('mints nothing once the share hostname is configured', async () => {
      const after = migrated();
      const r = await fetch(`http://localhost:${after.port}/api/share/link`, {
        method: 'POST',
        headers: { host: `localhost:${after.port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: oldBoard, allowDomains: ['@partner.example'] }),
      });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe('link_share_mint_retired');
      // …and nothing was written: the registry still holds the one record
      // phase one made. A 410 that minted on its way out would be worse than
      // a 200.
      const listed = await fetch(`http://localhost:${after.port}/api/share`, {
        headers: { host: `localhost:${after.port}` },
      });
      const { shares } = (await listed.json()) as { shares: unknown[] };
      expect(shares).toHaveLength(1);
      await after.stop();
    });

    it('still serves the record it already made, on its own hostname', async () => {
      // Criterion: shares minted under the old mode keep working until they
      // expire. The per-share HOSTNAME with its own audience is how one is
      // served, and the mint being gone does not touch that.
      const after = migrated();
      const visitor = await fetch(
        `http://localhost:${after.port}/workspaces/${encodeURIComponent(oldBoard)}?format=json`,
        {
          headers: {
            host: oldShare.hostname,
            ...CF_RAY,
            'cf-access-jwt-assertion': await signJwt(oldShare.audience, REVIEWER),
          },
        },
      );
      expect(visitor.status).toBe(200);
      await after.stop();
    });

    it('does not redeem a share link on a per-share hostname', async () => {
      // Redemption belongs to the share hostname alone, and this is the
      // non-vacuous form of that: the link is REAL, minted on this very
      // server, and it names the very board this visitor already holds. It is
      // still refused, because `/s/<id>` is not on a share visitor's path
      // allowlist and the scope check runs before any registry is consulted.
      // One hostname redeems, and it is not this one.
      const after = migrated();
      const port = after.port;
      const minted = await fetch(`http://localhost:${port}/api/share/workspace`, {
        method: 'POST',
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: oldBoard }),
      });
      expect(minted.status, await minted.clone().text()).toBe(200);
      const { link } = (await minted.json()) as { link: { linkId: string } };
      const r = await fetch(`http://localhost:${port}/s/${link.linkId}`, {
        redirect: 'manual',
        headers: {
          host: oldShare.hostname,
          ...CF_RAY,
          'cf-access-jwt-assertion': await signJwt(oldShare.audience, STRANGER),
        },
      });
      expect(r.status).toBe(403);
      expect(r.headers.get('location')).toBeNull();
      // POSITIVE CONTROL: the same id on the SHARE hostname does redeem, so
      // the refusal above is the hostname and not a dead link.
      const good = await fetch(`http://localhost:${port}/s/${link.linkId}`, {
        redirect: 'manual',
        headers: {
          host: SHARE_HOST,
          ...CF_RAY,
          'cf-access-jwt-assertion': await signJwt(SHARE_AUD, STRANGER),
        },
      });
      expect(good.status).toBe(302);
      await after.stop();
    });
  });

  const listShares = async (): Promise<{
    links: Array<{
      linkId: string;
      state: string;
      label?: string;
      redemptions: Array<{ email: string }>;
    }>;
    members: Array<{ workspaceId: string; email: string }>;
  }> => {
    const r = await local('/api/share');
    expect(r.status).toBe(200);
    return (await r.json()) as never;
  };
});
