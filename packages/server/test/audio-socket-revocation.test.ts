/**
 * Ending a member's access closes their MICROPHONE, not just their editor.
 *
 * A websocket is authorized once, at its upgrade, so every way of ending
 * access has to be able to find the connections it already opened. The
 * editing socket carries the share and the membership that authorized it
 * (`WsCtx.shareId` / `shareMember`) and `DocStore`'s sweeps match on those.
 *
 * The meeting's `/audio/<docId>` socket carried neither, and it is not in any
 * room's `conns` either — it lives in `MeetingRelay`'s WeakMap, which cannot
 * be enumerated. So removing a member, or throwing the sharing master switch,
 * closed the board and the doc and left an open microphone running a billed
 * transcription session against a doc the person may no longer read.
 *
 * All fixtures are synthetic — invented names in the `partner.example`
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'audio-revocation-kid';
const SHARE_AUD = 'aud-for-the-share-app';
const OWNER_AUD = 'aud-for-the-owner-app';
const SHARE_HOST = 'share.example.test';
const OWNER_HOST = 'workspaces.example.test';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OWNER_EMAIL = 'owner@example.test';

/** One live socket, and the two facts a sweep test asks about it. */
interface Socket {
  closeCode: number | null;
  opened: Promise<void>;
  closed: Promise<number>;
  hangUp: () => void;
}

function open(url: string, headers: Record<string, string>): Socket {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const socket: Socket = {
    closeCode: null,
    opened: Promise.resolve(),
    closed: Promise.resolve(0),
    hangUp: () => ws.close(),
  };
  socket.opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`socket never opened: ${url}`)));
  });
  socket.closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (ev) => {
      socket.closeCode = (ev as CloseEvent).code;
      resolve(socket.closeCode);
    });
  });
  return socket;
}

/** Await a close, but say "still open" rather than time out — which is
 *  exactly what a sweep that cannot see this socket looks like. */
async function closeCodeWithin(socket: Socket, ms = 2000): Promise<number | 'still-open'> {
  return Promise.race([
    socket.closed,
    new Promise<'still-open'>((r) => setTimeout(() => r('still-open'), ms)),
  ]);
}

describe('ending share access closes an open meeting socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let docId: string;
  let signJwt: (aud: string, email: string) => Promise<string>;

  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  const local = (path: string, init: RequestInit = {}) =>
    req(path, `localhost:${handle.port}`, init);

  const postLocal = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Headers a redeemed member puts on every request, socket or not. */
  const memberHeaders = async (email: string): Promise<Record<string, string>> => ({
    host: SHARE_HOST,
    ...CF_RAY,
    'cf-access-jwt-assertion': await signJwt(SHARE_AUD, email),
  });

  /** Mint a link for the board and redeem it as `email`, making a member. */
  const admit = async (email: string): Promise<Record<string, string>> => {
    const minted = await postLocal('/api/share/workspace', { workspaceId: board });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { link } = (await minted.json()) as { link: { linkId: string } };
    const headers = await memberHeaders(email);
    const redeemed = await req(`/s/${link.linkId}`, SHARE_HOST, { headers });
    expect(redeemed.status).toBe(302);
    return headers;
  };

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };
    signJwt = (aud, email) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-audio-visitor')
        .sign(privateKey);

    dataDir = mkdtempSync(join(tmpdir(), 'audio-revocation-'));
    handle = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OWNER_AUD, jwks },
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
    });
    base = `http://localhost:${handle.port}`;

    const created = await postLocal('/workspaces', { name: 'Meeting board' });
    expect(created.status).toBe(200);
    board = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    const path = join(dataDir, 'meeting-notes.md');
    writeFileSync(path, '# Meeting notes\n\nBody.\n');
    const doc = await postLocal('/api/docs', {
      docId: 'meeting-notes',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(doc.status).toBe(200);
    docId = ((await doc.json()) as { docId: string }).docId;
    const filed = await postLocal(`/workspaces/${encodeURIComponent(board)}/docs`, { docId });
    expect(filed.status).toBe(200);
  });

  afterAll(async () => {
    await handle?.stop();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('hangs up the removed member’s microphone and leaves everyone else recording', async () => {
    const ejected = 'ejected-member@partner.example';
    const staying = 'staying-member@partner.example';
    const ejectedHeaders = await admit(ejected);
    const stayingHeaders = await admit(staying);

    // The route the member's browser opens the microphone on.
    const url = `ws://localhost:${handle.port}/audio/${encodeURIComponent(docId)}`;
    const ejectedMic = open(url, ejectedHeaders);
    const stayingMic = open(url, stayingHeaders);
    // POSITIVE CONTROL: both sockets are genuinely up, so "it closed" cannot
    // just mean "it was never allowed to open in the first place".
    await ejectedMic.opened;
    await stayingMic.opened;
    expect(ejectedMic.closeCode).toBeNull();
    expect(stayingMic.closeCode).toBeNull();

    const removed = await postLocal('/api/share/member/remove', {
      workspaceId: board,
      email: ejected,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    const { closedSockets } = (await removed.json()) as { closedSockets: number };
    // The route's own count has to see it too — a socket closed by some other
    // path would satisfy the close assertion below and still mean the sweep
    // is blind.
    expect(closedSockets).toBeGreaterThan(0);

    // 1008 = policy violation, which is what an ended grant is.
    expect(await closeCodeWithin(ejectedMic)).toBe(1008);
    // Exactly this membership: somebody else's meeting on the same doc is
    // not ended by one person being removed from the board.
    await new Promise((r) => setTimeout(r, 100));
    expect(stayingMic.closeCode).toBeNull();
    stayingMic.hangUp();
  });

  it('hangs up every microphone when the sharing master switch goes off', async () => {
    const listener = 'switch-member@partner.example';
    const headers = await admit(listener);
    const url = `ws://localhost:${handle.port}/audio/${encodeURIComponent(docId)}`;
    const mic = open(url, headers);
    await mic.opened;
    expect(mic.closeCode).toBeNull();

    // The owner's own socket on the same doc carries no membership, so the
    // switch must not reach it — the control that says the sweep matches on
    // the stamp rather than closing everything it can see.
    const ownerMic = open(url, { host: `localhost:${handle.port}` });
    await ownerMic.opened;

    const off = await postLocal('/api/share/enabled', { enabled: false });
    expect(off.status, await off.clone().text()).toBe(200);

    expect(await closeCodeWithin(mic)).toBe(1008);
    expect(ownerMic.closeCode).toBeNull();
    ownerMic.hangUp();

    // Put the switch back, so this file leaves the fixture as it found it.
    const on = await postLocal('/api/share/enabled', { enabled: true });
    expect(on.status).toBe(200);
  });
});
