/**
 * The last three ways past the member boundary, and the two suspicions beside
 * them. Every one is a MEMBER of a real board doing something on it — the
 * gate has already said yes to the path — so none of these can be caught by a
 * unit test of a predicate. They are driven over HTTP against the real route
 * table for that reason.
 *
 *   A. A cross-reference names its target in the BODY, so no path check ever
 *      saw it. A member could point one of their own rows at a row, doc or
 *      thread on a board they were never given, and backlinks are computed
 *      per read — so the chip landed over there, written from outside.
 *   B. The Home read marker took the person from `?user=` and `author.name`,
 *      which is one member naming another and being served their queue.
 *   C. The chip surfaces that answer "what points at this?" span every
 *      workspace. Filtered on `GET /api/tasks/<id>/links` and NOT on the doc
 *      and thread spellings of the same question.
 *   D. A widget popup-token outranked the Cloudflare Access identity in
 *      `authorFor`, on the one surface where Access IS the identity.
 *   E. Retiring a board admits and revokes nobody. That was written down
 *      backwards; this pins what actually happens.
 *   F. A dependency edge LOOKS like A with no `Ref` around it — `after` and
 *      the `blockedBy` arm of `park` take task ids straight out of the body.
 *      It is not: the store refuses a cross-board edge to everybody, in one
 *      word that tells a foreign id and a made-up one apart from nothing.
 *      Both halves are pinned here, because the reason the transition gate's
 *      report is safe lives three modules from the route that sends it.
 *
 * Each suite carries its own positive control: the same call, inside the
 * member's own board, still working. A refusal test with no control passes
 * just as well when the route is broken for everybody.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'member-boundary-kid';
const COLLAB_AUD = 'aud-for-the-collab-app';
const TUNNEL_HOST = 'workspaces.example.test';
const LINK_HOST = 'links.example.test';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

/** Admitted to `board` by a domain entry on its share, and to nothing else. */
const MEMBER_EMAIL = 'collaborator@partner.example';
/** What the roster derives as that address's display name — the key the Home
 *  marker is really written under once the verified identity decides it. */
const MEMBER_NAME = 'Collaborator';
/** A second person, who exists only so the member has somebody to try to be. */
const IMPOSTOR_EMAIL = 'someone.else@partner.example';
const IMPOSTOR_NAME = 'Someone Else';
/** An origin the browser-origin policy treats as a dev server on this box. */
const DEV_ORIGIN = 'http://127.0.0.1:5173';
/** The collaboration host's own origin — see `allowedOrigins` in the boot. */
const COLLAB_ORIGIN = `http://${TUNNEL_HOST}`;

// The log sender masks the emailed code unless this is set; suite D drives a
// real sign-in to mint a widget token the way a developer does.
process.env.CW_LOG_LOGIN_CODES = '1';
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

let jwks: JSONWebKeySet;
let signJwt: (aud: string, email: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud: string, email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-member-boundary')
      .sign(privateKey);
});

describe('the member boundary, on the surfaces a path check cannot see', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let jwt: string;

  /** The board the member holds… */
  let board: string;
  /** …and one they do not. Everything in here is what must not leak. */
  let otherBoard: string;
  /** A doc filed on `board`, which the member may open. */
  let docId: string;
  /** A row on each board. */
  let ownTask: string;
  let foreignTask: string;
  /** A thread on `docId`, for the thread spelling of the chip question. */
  let threadId: string;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As the machine's owner — loopback, no proxy hop, no token. */
  const asOwner = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);

  const asOwnerJson = (path: string, method: string, body: unknown) =>
    asOwner(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** As the Access-authenticated member of `board`, arriving through the edge. */
  const asMember = (path: string, init: RequestInit = {}) =>
    req(path, TUNNEL_HOST, {
      ...init,
      headers: {
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const asMemberJson = (
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    asMember(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const createBoard = async (name: string): Promise<string> => {
    const res = await asOwnerJson('/workspaces', 'POST', { name });
    expect(res.status).toBe(200);
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };

  const createTask = async (workspaceId: string, title: string): Promise<string> => {
    const res = await asOwnerJson(`/workspaces/${encodeURIComponent(workspaceId)}/tasks`, 'POST', {
      title,
      assignee: 'owner',
      author: { id: 'known-owner', name: 'Owner', kind: 'known' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { task: { id: string } }).task.id;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'member-boundary-lows-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: COLLAB_AUD, jwks },
      // Present because a board's allow list is only ever written down as a
      // share — minting one is how anybody becomes a member at all.
      share: {
        config: { ...ACCESS_SHARE_CONFIG, publicHostname: LINK_HOST },
        cfApi: mockCfApi(),
      },
      accessTunnelHosts: [TUNNEL_HOST],
      // Suite D needs a widget token whose page origin the SHARE surface will
      // accept, and on that surface the only one is its own. Configured here
      // so the mint (which runs on the local surface) will issue for it.
      allowedOrigins: [`http://${TUNNEL_HOST}`],
      // Suite D mints a widget popup-token, which is exchanged for a session
      // cookie — and the server's own emailed-code sign-in is off by default.
      emailCodeSignIn: true,
    });
    base = `http://localhost:${handle.port}`;
    jwt = await signJwt(COLLAB_AUD, MEMBER_EMAIL);

    board = await createBoard('Shared work');
    otherBoard = await createBoard('Private work');

    const path = join(dataDir, 'shared-doc.md');
    writeFileSync(path, '# Shared doc\n\nA line worth a comment.\n');
    const doc = await asOwnerJson(`/workspaces/${board}/docs`, 'POST', {
      docId: 'shared-doc',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    docId = ((await doc.json()) as { docId: string }).docId;
    expect(
      (await asOwnerJson(`/workspaces/${encodeURIComponent(board)}/docs:attach`, 'POST', { docId }))
        .status,
    ).toBe(200);

    const thread = await asOwnerJson(
      `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/by_find`,
      'POST',
      {
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
        text: 'the first note',
        find: 'A line worth a comment.',
      },
    );
    expect(thread.status, await thread.clone().text()).toBe(200);
    threadId = ((await thread.json()) as { thread: { id: string } }).thread.id;

    ownTask = await createTask(board, 'A row the member holds');
    foreignTask = await createTask(otherBoard, 'A row they were never given');

    // `board` by domain; `otherBoard` shared with nobody.
    const shared = await asOwnerJson('/api/share/link', 'POST', {
      workspaceId: board,
      allowDomains: ['@partner.example'],
    });
    expect(shared.status, await shared.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('A. a cross-reference cannot reach off the board', () => {
    // The BOARD is part of a task's address now, so a row on the other board
    // is reached through the other board — asking for it under this one is a
    // 404 about the pair, not a refusal about the link.
    const linkPath = (taskId: string, ws: string = board) =>
      `/workspaces/${ws}/tasks/${encodeURIComponent(taskId)}/links`;

    it('refuses a link from the member’s own row to a row on another board', async () => {
      const res = await asMemberJson(linkPath(ownTask), 'POST', {
        ref: { kind: 'task', taskId: foreignTask },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CONTROL: the same call inside their own board still works', async () => {
      const second = await createTask(board, 'Another row on the shared board');
      const res = await asMemberJson(linkPath(ownTask), 'POST', {
        ref: { kind: 'task', taskId: second },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: true });
      // …and it can be taken off again, which is the DELETE half of the rule.
      const undo = await asMemberJson(linkPath(ownTask), 'DELETE', {
        ref: { kind: 'task', taskId: second },
      });
      expect(undo.status).toBe(200);
    });

    it('answers a MADE-UP id in the same words, so it is not an existence oracle', async () => {
      const res = await asMemberJson(linkPath(ownTask), 'POST', {
        // Not spelled like a real row id on purpose: the pre-push leak
        // scanner reads `t-<slug>` as one wherever it appears.
        ref: { kind: 'task', taskId: 'no-such-row-anywhere' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('refuses the DELETE spelling too — unlinking is a write on the same row', async () => {
      const res = await asMemberJson(linkPath(ownTask), 'DELETE', {
        ref: { kind: 'task', taskId: foreignTask },
      });
      expect(res.status).toBe(403);
    });

    it('refuses a doc ref pointing at a board they were never given', async () => {
      const path = join(dataDir, 'private-doc.md');
      writeFileSync(path, '# Private\n\nNot theirs.\n');
      // Filed on the OTHER board, which is the whole point: a doc created on
      // the member's own board would be one they are entitled to.
      const created = await asOwnerJson(`/workspaces/${otherBoard}/docs`, 'POST', {
        docId: 'private-doc',
        type: 'markdown',
        sourceUrl: path,
      });
      expect(created.status).toBe(200);
      const privateDocId = ((await created.json()) as { docId: string }).docId;
      expect(
        (
          await asOwnerJson(`/workspaces/${encodeURIComponent(otherBoard)}/docs:attach`, 'POST', {
            docId: privateDocId,
          })
        ).status,
      ).toBe(200);
      const res = await asMemberJson(linkPath(ownTask), 'POST', {
        ref: { kind: 'doc', docId: privateDocId },
      });
      expect(res.status).toBe(403);
      // CONTROL: a doc on their OWN board is a link they may make.
      const ok = await asMemberJson(linkPath(ownTask), 'POST', {
        ref: { kind: 'doc', docId },
      });
      expect(ok.status, await ok.clone().text()).toBe(200);
    });

    it('refuses the same ref on a CREATE, which is the other door to the field', async () => {
      const res = await asMemberJson(
        `/workspaces/${encodeURIComponent(board)}/tasks?format=json`,
        'POST',
        {
          title: 'A row that points somewhere it should not',
          assignee: 'collaborator',
          links: [{ kind: 'task', taskId: foreignTask }],
        },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CONTROL: a create whose links stay on the board is filed', async () => {
      const res = await asMemberJson(`/workspaces/${encodeURIComponent(board)}/tasks`, 'POST', {
        title: 'A row that points at its own board',
        assignee: 'collaborator',
        links: [{ kind: 'task', taskId: ownTask }],
      });
      expect(res.status, await res.clone().text()).toBe(200);
    });

    it('refuses an out-of-board `origin` on a create', async () => {
      const res = await asMemberJson(
        `/workspaces/${encodeURIComponent(board)}/tasks?format=json`,
        'POST',
        {
          title: 'A row spun off somebody else’s doc',
          assignee: 'collaborator',
          origin: { kind: 'task', taskId: foreignTask },
        },
      );
      expect(res.status).toBe(403);
    });

    it('refuses the same ref when a promoted thread carries it', async () => {
      const promote = `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/promote`;
      const res = await asMemberJson(promote, 'POST', {
        workspaceId: board,
        title: 'Promoted with a reach off the board',
        assignee: 'collaborator',
        links: [{ kind: 'task', taskId: foreignTask }],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
      // CONTROL: the same promotion, pointing at their own board, lands.
      const ok = await asMemberJson(promote, 'POST', {
        workspaceId: board,
        title: 'Promoted with a link they may make',
        assignee: 'collaborator',
        links: [{ kind: 'task', taskId: ownTask }],
      });
      expect(ok.status, await ok.clone().text()).toBe(200);
    });

    it('leaves NO backlink chip on the board they were never given', async () => {
      // The point of all of the above, asked from the other side: the owner
      // reading the private row sees nothing pointing at it from outside.
      const res = await asOwner(linkPath(foreignTask, otherBoard));
      expect(res.status).toBe(200);
      const { backlinks } = (await res.json()) as { backlinks: Array<{ id: string }> };
      expect(backlinks).toEqual([]);
    });

    it('CONTROL: the owner may still link across boards — this is a member rule', async () => {
      const res = await asOwnerJson(linkPath(ownTask), 'POST', {
        ref: { kind: 'task', taskId: foreignTask },
      });
      expect(res.status, await res.clone().text()).toBe(200);
      // …and having done so, clean up so the chip suites below start level.
      expect(
        (
          await asOwnerJson(linkPath(ownTask), 'DELETE', {
            ref: { kind: 'task', taskId: foreignTask },
          })
        ).status,
      ).toBe(200);
    });
  });

  describe('B. the Home read marker belongs to whoever was verified', () => {
    // A function, not a constant: this body runs at registration time, when
    // `beforeAll` has not filed a board yet and `board` is still undefined.
    const homeRead = () => `/workspaces/${encodeURIComponent(board)}/home/read`;
    const homeOf = (person: string) =>
      `/workspaces/${encodeURIComponent(board)}/home?user=${encodeURIComponent(person)}&format=json`;

    it('records a member’s mark under their own name, not the one the body claims', async () => {
      const at = 1_700_000_000_000;
      const res = await asMemberJson(homeRead(), 'POST', {
        author: { id: 'known-someone', name: IMPOSTOR_NAME, kind: 'known' },
        at,
      });
      expect(res.status, await res.clone().text()).toBe(200);

      const claimed = await asOwner(homeOf(IMPOSTOR_NAME));
      expect(claimed.status).toBe(200);
      expect(((await claimed.json()) as { lastReadAt: number }).lastReadAt).toBe(0);

      const real = await asOwner(homeOf(MEMBER_NAME));
      expect(real.status).toBe(200);
      expect(((await real.json()) as { lastReadAt: number }).lastReadAt).toBe(at);
    });

    it('serves a member their OWN queue however the query names somebody else', async () => {
      // `?user=` is ignored for a verified caller, so the payload that comes
      // back carries the marker the test above wrote for the member — not the
      // untouched one belonging to the name in the query string.
      const res = await asMember(homeOf(IMPOSTOR_NAME));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { lastReadAt: number }).lastReadAt).toBe(1_700_000_000_000);
    });

    it('CONTROL: an agent over loopback still names its own reader', async () => {
      const at = 1_700_000_111_000;
      const res = await asOwnerJson(homeRead(), 'POST', {
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
        at,
      });
      expect(res.status).toBe(200);
      const back = await asOwner(homeOf('Owner'));
      expect(((await back.json()) as { lastReadAt: number }).lastReadAt).toBe(at);
    });
  });

  describe('C. the chip surfaces do not answer with another board’s rows', () => {
    beforeAll(async () => {
      // A private row pointing at a doc — and at a thread in it — that the
      // member IS allowed to open. This is the whole setup for the leak: the
      // doc is theirs to read, and the chip rides in on the back of it.
      expect(
        (
          await asOwnerJson(
            `/workspaces/${otherBoard}/tasks/${encodeURIComponent(foreignTask)}/links`,
            'POST',
            {
              ref: { kind: 'doc', docId },
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await asOwnerJson(
            `/workspaces/${otherBoard}/tasks/${encodeURIComponent(foreignTask)}/links`,
            'POST',
            {
              ref: { kind: 'thread', docId, threadId },
            },
          )
        ).status,
      ).toBe(200);
      // The same two links from a row on the member's own board, which is the
      // positive control every assertion below is measured against.
      expect(
        (
          await asOwnerJson(
            `/workspaces/${board}/tasks/${encodeURIComponent(ownTask)}/links`,
            'POST',
            {
              ref: { kind: 'doc', docId },
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await asOwnerJson(
            `/workspaces/${board}/tasks/${encodeURIComponent(ownTask)}/links`,
            'POST',
            {
              ref: { kind: 'thread', docId, threadId },
            },
          )
        ).status,
      ).toBe(200);
    });

    it('the doc’s own chips carry the member’s board and not the other one', async () => {
      const res = await asMember(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}?format=json`,
      );
      expect(res.status).toBe(200);
      const { tasks = [] } = (await res.json()) as { tasks?: Array<{ id: string; title: string }> };
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain(ownTask); // CONTROL
      expect(ids).not.toContain(foreignTask);
      // Not only the id: the title of a private row is the thing that hurts.
      expect(tasks.some((t) => t.title === 'A row they were never given')).toBe(false);
    });

    it('the dedicated chip route answers the same way', async () => {
      const res = await asMember(`/workspaces/${board}/docs/${encodeURIComponent(docId)}/tasks`);
      expect(res.status).toBe(200);
      const { tasks } = (await res.json()) as { tasks: Array<{ id: string }> };
      expect(tasks.map((t) => t.id)).toContain(ownTask); // CONTROL
      expect(tasks.map((t) => t.id)).not.toContain(foreignTask);
    });

    it('a thread’s chips do too — same question, second spelling', async () => {
      const res = await asMember(`/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads`);
      expect(res.status).toBe(200);
      const { threads } = (await res.json()) as {
        threads: Array<{ id: string; tasks?: Array<{ id: string }> }>;
      };
      const target = threads.find((t) => t.id === threadId);
      expect(target).toBeDefined();
      const chipIds = (target?.tasks ?? []).map((t) => t.id);
      expect(chipIds).toContain(ownTask); // CONTROL
      expect(chipIds).not.toContain(foreignTask);
    });

    it('CONTROL: the owner still sees both, because the span is the point', async () => {
      const res = await asOwner(`/workspaces/${board}/docs/${encodeURIComponent(docId)}/tasks`);
      const { tasks } = (await res.json()) as { tasks: Array<{ id: string }> };
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain(ownTask);
      expect(ids).toContain(foreignTask);
    });
  });

  describe('D. a widget popup-token does not outrank the Access identity', () => {
    /**
     * Sign in over loopback as somebody else and take a widget token for it.
     *
     * `origin` is which page the token may be presented from. The share
     * surface accepts no configured origin at all — `allowedOrigins` is
     * emptied for it — so the collaboration host's OWN origin is the only one
     * a token can carry and still get through the browser-origin gate there.
     * That is what makes the precedence question below reachable rather than
     * theoretical, and it is also the honest limit of the finding: a token
     * minted for a dev server never reaches a share host at all.
     */
    const mintImpostorToken = async (origin: string = COLLAB_ORIGIN): Promise<string> => {
      const before = codes.length;
      const started = await asOwnerJson('/api/auth/start', 'POST', { email: IMPOSTOR_EMAIL });
      expect(started.status).toBe(200);
      expect(codes.length).toBe(before + 1);
      const verified = await asOwnerJson('/api/auth/verify', 'POST', {
        email: IMPOSTOR_EMAIL,
        code: codes[codes.length - 1],
      });
      expect(verified.status, await verified.clone().text()).toBe(200);
      const cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      const minted = await asOwner('/api/auth/widget-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ origin }),
      });
      expect(minted.status, await minted.clone().text()).toBe(200);
      return ((await minted.json()) as { token: string }).token;
    };

    it('attributes the write to the email Cloudflare confirmed', async () => {
      const token = await mintImpostorToken();
      const res = await asMemberJson(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/by_find`,
        'POST',
        { text: 'written on the share host', find: 'A line worth a comment.' },
        { authorization: `Bearer ${token}`, origin: COLLAB_ORIGIN },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const { thread } = (await res.json()) as {
        thread: { comments: Array<{ author: { name: string } }> };
      };
      const author = thread.comments[thread.comments.length - 1]?.author;
      expect(author?.name).toBe(MEMBER_NAME);
      expect(author?.name).not.toBe(IMPOSTOR_NAME);
    });

    it('CONTROL: the same token still speaks for its own holder off the share host', async () => {
      // The rung this narrows is otherwise untouched: on the local surface a
      // widget token is still exactly the attribution it was minted to be.
      const token = await mintImpostorToken(DEV_ORIGIN);
      const res = await asOwner(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/by_find`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            origin: DEV_ORIGIN,
          },
          body: JSON.stringify({ text: 'written from the dev server', find: 'Shared doc' }),
        },
      );
      expect(res.status, await res.clone().text()).toBe(200);
      const { thread } = (await res.json()) as {
        thread: { comments: Array<{ author: { name: string } }> };
      };
      expect(thread.comments[thread.comments.length - 1]?.author.name).toBe(IMPOSTOR_NAME);
    });

    it('and a token minted for a DEV SERVER never reaches the share host at all', async () => {
      // The second wall, measured rather than assumed: the browser-origin gate
      // on a share surface accepts only its own origin, so the header cannot
      // even be presented from the page it was minted for. Named here because
      // it is what makes the precedence bug above unreachable in a deployment
      // that has not listed its collaboration hostname as an allowed origin.
      const token = await mintImpostorToken(DEV_ORIGIN);
      const res = await asMemberJson(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/by_find`,
        'POST',
        { text: 'from a dev server, at the share host', find: 'Shared doc' },
        { authorization: `Bearer ${token}`, origin: DEV_ORIGIN },
      );
      expect(res.status).toBe(403);
      // …and stripping the Origin does not help: the token is refused without
      // the one it was minted for.
      const bare = await asMemberJson(
        `/workspaces/${board}/docs/${encodeURIComponent(docId)}/threads/by_find`,
        'POST',
        { text: 'no origin at all', find: 'Shared doc' },
        { authorization: `Bearer ${token}` },
      );
      expect(bare.status).toBe(401);
    });
  });

  // A dependency edge reads like the `links` hole with no `Ref` around it:
  // two member-allowed writes take task ids straight out of the body, and
  // the transition gate then READS the row at the other end and reports its
  // id, title, status and `needs` back to whoever moved the pointing row.
  // The reason it is not that hole is the store, which refuses a
  // cross-board edge to everybody — pinned below, because a route test that
  // only showed the 403 would not say why the 409 is safe.
  describe('F. a dependency edge cannot reach off the board either', () => {
    const afterPath = (taskId: string) =>
      `/workspaces/${board}/tasks/${encodeURIComponent(taskId)}/after`;
    const parkPath = (taskId: string) =>
      `/workspaces/${board}/tasks/${encodeURIComponent(taskId)}/park`;
    /** Not spelled like a real row id: the pre-push leak scanner reads
     *  `t-<slug>` as one wherever it appears. */
    const MADE_UP = 'no-such-row-anywhere';

    /** Put the row back to no edges at all, as the owner, between tests. */
    const clearEdges = async (taskId: string) => {
      const res = await asOwnerJson(afterPath(taskId), 'POST', {
        after: [],
        afterEnforce: [],
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };

    it('refuses `after` naming a row on a board they were never given', async () => {
      const res = await asMemberJson(afterPath(ownTask), 'POST', { after: [foreignTask] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('refuses it in `afterEnforce` too — the arm that actually gates', async () => {
      const res = await asMemberJson(afterPath(ownTask), 'POST', {
        after: [],
        afterEnforce: [foreignTask],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('answers a MADE-UP id in the same words, so it is not an existence oracle', async () => {
      const res = await asMemberJson(afterPath(ownTask), 'POST', { after: [MADE_UP] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CONTROL: the same edge inside their own board still lands', async () => {
      const sibling = await createTask(board, 'A sibling on the shared board');
      const res = await asMemberJson(afterPath(ownTask), 'POST', { after: [sibling] });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()) as { task: { after: string[] } }).toMatchObject({
        task: { after: [sibling] },
      });
      await clearEdges(ownTask);
    });

    it('refuses `blockedBy` on the park verb naming another board’s row', async () => {
      const res = await asMemberJson(parkPath(ownTask), 'POST', { blockedBy: [foreignTask] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('answers a MADE-UP id on the park verb in the same words', async () => {
      const res = await asMemberJson(parkPath(ownTask), 'POST', { blockedBy: MADE_UP });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CONTROL: blocking on a row of their own board still lands', async () => {
      const sibling = await createTask(board, 'Another sibling on the shared board');
      const res = await asMemberJson(parkPath(ownTask), 'POST', { blockedBy: [sibling] });
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()) as { after: string[] }).toMatchObject({ after: [sibling] });
      await clearEdges(ownTask);
    });

    // The write refusals above are the boundary's words on a door the STORE
    // already holds shut: `setDependencies` and `createTask` both check the
    // dependency against the board's own task map, so no route can build a
    // cross-board edge for anybody — which is also why the transition gate's
    // report cannot name a foreign row. Pinned here because the whole reason
    // the 409 body is safe is this refusal, and it is three modules away.
    it('the STORE refuses a cross-board edge to the OWNER too, in one word', async () => {
      const res = await asOwnerJson(afterPath(ownTask), 'POST', {
        after: [foreignTask],
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'unknown-after' });
    });

    it('…and answers a made-up id with that same one word, so it tells nothing apart', async () => {
      const res = await asOwnerJson(afterPath(ownTask), 'POST', {
        after: [MADE_UP],
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'unknown-after' });
    });

    it('CONTROL: an edge on their own board still gates, and still names itself', async () => {
      const blocker = await createTask(board, 'The row that holds the other one');
      const wired = await asOwnerJson(afterPath(ownTask), 'POST', {
        after: [blocker],
        afterEnforce: [blocker],
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(wired.status, await wired.clone().text()).toBe(200);
      const res = await asMemberJson(
        `/workspaces/${board}/tasks/${encodeURIComponent(ownTask)}/transition`,
        'POST',
        { to: 'in-progress' },
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: string;
        blockers: Array<{ taskId: string; title: string }>;
      };
      expect(body.error).toBe('blocked');
      expect(body.blockers).toHaveLength(1);
      expect(body.blockers[0]).toMatchObject({
        taskId: blocker,
        title: 'The row that holds the other one',
      });
      await clearEdges(ownTask);
    });
  });

  describe('E. retiring a board is not a revocation', () => {
    it('a member of a RETIRED board still reaches it — the comment used to say otherwise', async () => {
      const retired = await asOwnerJson(`/workspaces/${encodeURIComponent(board)}/retired`, 'PUT', {
        retired: true,
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(retired.status, await retired.clone().text()).toBe(200);
      const res = await asMember(`/workspaces/${encodeURIComponent(board)}?format=json`);
      expect(res.status).toBe(200);
      const back = await asOwnerJson(`/workspaces/${encodeURIComponent(board)}/retired`, 'PUT', {
        retired: false,
        author: { id: 'known-owner', name: 'Owner', kind: 'known' },
      });
      expect(back.status).toBe(200);
    });

    it('revoking the share IS one — the board stops admitting them at once', async () => {
      const listing = await asOwner('/api/share');
      expect(listing.status).toBe(200);
      const listed = (await listing.json()) as { shares: Array<{ shareId: string }> };
      const id = listed.shares[0]?.shareId;
      expect(typeof id).toBe('string');
      const revoked = await asOwner(`/api/share/${encodeURIComponent(String(id))}`, {
        method: 'DELETE',
      });
      expect(revoked.status, await revoked.clone().text()).toBe(200);
      const res = await asMember(`/workspaces/${encodeURIComponent(board)}`);
      expect(res.status).toBe(403);
    });
  });
});
