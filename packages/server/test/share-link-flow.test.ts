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
    const created = await postLocal('/api/workspaces', { name });
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
    const filed = await postLocal(`/api/workspaces/${encodeURIComponent(id)}/docs`, {
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
      const made = await fetch(`${probeBase}/api/workspaces`, {
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
      const meta = await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, REVIEWER);
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
      const after = await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, STRANGER);
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
        (await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, STRANGER)).status,
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
        (await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, member)).status,
      ).toBe(200);
      const doc = await onShareHost(`/api/docs/${docId}`, member);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { meta: { docId: string } }).meta.docId).toBe(docId);
      expect((await onShareHost(`/api/docs/${docId}/threads`, member)).status).toBe(200);
    });

    it('is refused every workspace it was not given', async () => {
      expect(
        (await onShareHost(`/api/workspaces/${encodeURIComponent(otherBoard)}`, member)).status,
      ).toBe(403);
      expect((await onShareHost(`/api/docs/${otherDocId}`, member)).status).toBe(403);
      expect(
        (await onShareHost(`/workspaces/${encodeURIComponent(otherBoard)}`, member)).status,
      ).toBe(403);
    });

    it('is refused the operator verbs on the board it DOES hold', async () => {
      // The point of routing this through `collabScope`: a route a share
      // visitor is refused is refused here by the same lines.
      for (const [path, init] of [
        ['/api/docs', {}],
        ['/api/share', {}],
        [`/api/workspaces/${encodeURIComponent(board)}/settings`, {}],
        [`/api/workspaces/${encodeURIComponent(board)}/events`, {}],
      ] as Array<[string, RequestInit]>) {
        const r = await onShareHost(path, member, init);
        expect(r.status, path).toBe(403);
      }
      const del = await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, member, {
        method: 'DELETE',
      });
      expect(del.status).toBe(403);
    });

    it('works the board it DOES hold — files a task, moves it, and is named for it', async () => {
      // Bryan, 2026-09-03: "Let's allow everything for now." A member is a
      // participant, so this is the positive control the refusals above are
      // measured against.
      const filed = await onShareHost(
        `/api/workspaces/${encodeURIComponent(board)}/tasks`,
        member,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Filed by a member', assignee: 'human' }),
        },
      );
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
      const other = await postLocal(`/api/workspaces/${encodeURIComponent(otherBoard)}/tasks`, {
        title: 'On the private board',
        assignee: 'human',
      });
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
      for (const path of ['/', '/api/workspaces', '/api/diffs', '/demos']) {
        const r = await onShareHost(path, member);
        expect(r.status, path).toBe(403);
        expect(await r.json(), path).toEqual({ error: 'out_of_share_scope' });
      }
    });

    it('refuses a signed-in stranger every board, in the same words', async () => {
      // Same body as the out-of-scope refusal on purpose: two different
      // replies would tell an admitted stranger which guessed ids are real.
      for (const wsId of [board, otherBoard]) {
        const r = await onShareHost(`/api/workspaces/${encodeURIComponent(wsId)}`, STRANGER);
        expect(r.status, wsId).toBe(403);
        expect(await r.json(), wsId).toEqual({ error: 'out_of_share_scope' });
      }
    });

    it('is refused everything while the sharing switch is off', async () => {
      expect((await postLocal('/api/share/enabled', { enabled: false })).status).toBe(200);
      try {
        const r = await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, member);
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'sharing_disabled' });
      } finally {
        expect((await postLocal('/api/share/enabled', { enabled: true })).status).toBe(200);
      }
      // Positive control: back on, the same member reaches the board again.
      expect(
        (await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, member)).status,
      ).toBe(200);
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
      const r = await fetch(`http://localhost:${probe.port}/api/workspaces`, {
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
      const made = await fetch(`${probeBase}/api/workspaces`, {
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
      const boardPath = `/api/workspaces/${encodeURIComponent(probeBoard)}`;
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
      const made = await fetch(`${probeBase}/api/workspaces`, {
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
      const board = `/api/workspaces/${encodeURIComponent(probeBoard)}`;
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
        (await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, staying)).status,
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
      const after = await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, staying);
      expect(after.status).toBe(403);
      // Positive control: another member of the same board is unaffected.
      const { linkId } = await mintLink(board);
      const other = 'unaffected@partner.example';
      expect((await onShareHost(`/s/${linkId}`, other)).status).toBe(302);
      expect(
        (await onShareHost(`/api/workspaces/${encodeURIComponent(board)}`, other)).status,
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
    it('still mints and still serves, so records already out there keep working', async () => {
      // Criterion: shares minted under the old mode keep working until they
      // expire. `/api/share/link` is the mint that still makes one, and the
      // per-share HOSTNAME with its own audience is how it is served.
      const r = await postLocal('/api/share/link', {
        workspaceId: board,
        allowDomains: ['@partner.example'],
      });
      expect(r.status).toBe(200);
      const { share } = (await r.json()) as {
        share: { hostname: string; audience: string };
      };
      const visitor = await req(`/api/workspaces/${encodeURIComponent(board)}`, share.hostname, {
        headers: {
          ...CF_RAY,
          'cf-access-jwt-assertion': await signJwt(share.audience, REVIEWER),
        },
      });
      expect(visitor.status).toBe(200);
    });

    it('does not redeem a share link on a per-share hostname', async () => {
      // Redemption belongs to the share hostname alone. An old-mode visitor
      // holds one board and a path allowlist that has no `/s/` in it, so the
      // id below — a real one, for a board they were never given — is refused
      // by the scope check before any registry is consulted. That is the seam:
      // one hostname redeems, and it is not this one.
      const { linkId } = await mintLink(otherBoard);
      const old = await postLocal('/api/share/link', {
        workspaceId: board,
        allowDomains: ['@partner.example'],
      });
      const { share } = (await old.json()) as { share: { hostname: string; audience: string } };
      const r = await req(`/s/${linkId}`, share.hostname, {
        headers: {
          ...CF_RAY,
          'cf-access-jwt-assertion': await signJwt(share.audience, STRANGER),
        },
      });
      expect(r.status).toBe(403);
      expect(r.headers.get('location')).toBeNull();
      // …and nobody became a member of the board that link names.
      expect(
        (await onShareHost(`/api/workspaces/${encodeURIComponent(otherBoard)}`, STRANGER)).status,
      ).toBe(403);
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
