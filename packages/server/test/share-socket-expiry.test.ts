/**
 * A websocket is authorized ONCE, at its upgrade. Revocation already closes
 * the sockets it opened (the /api/share/:id DELETE route calls
 * closeSocketsForShare). EXPIRY has no request to hang off — the share just
 * quietly stops being live — so a periodic sweep does it instead. The sweep
 * was wired and shipped untested; this covers its predicate and its effect.
 *
 * The 60s interval itself isn't waited on: the test invokes the same call the
 * interval makes, so the assertion is about what the sweep DOES rather than
 * about setInterval.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const MSG_SYNC = 0;
const PUBLIC_HOST = 'feedback.example.com';

interface Conn {
  closeCode: number | null;
  closed: Promise<number>;
  synced: Promise<void>;
  hangUp: () => void;
}

/** Connect a real Yjs client and expose both its sync and its close. */
function connect(url: string, headers: Record<string, string>): Conn {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const conn: Conn = {
    closeCode: null,
    closed: new Promise<number>(() => {}),
    synced: new Promise<void>(() => {}),
    hangUp: () => ws.close(),
  };
  conn.closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (ev) => {
      conn.closeCode = (ev as CloseEvent).code;
      resolve(conn.closeCode);
    });
  });
  conn.synced = new Promise<void>((resolve) => {
    ws.addEventListener('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, ydoc);
      ws.send(encoding.toUint8Array(enc));
    });
    ws.addEventListener('message', (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== MSG_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      resolve();
    });
  });
  return conn;
}

/** Await a close, but fail with a readable message instead of a bare timeout
 *  when the socket stays open — which is exactly what a broken sweep looks
 *  like. */
async function closeCodeWithin(conn: Conn, ms = 2000): Promise<number | 'still-open'> {
  return Promise.race([
    conn.closed,
    new Promise<'still-open'>((r) => setTimeout(() => r('still-open'), ms)),
  ]);
}

/** The server's own sweep — the function its 60s interval calls. Tests drive
 *  the real thing so a change to what the sweep covers can't pass here while
 *  failing in production. */
function sweep(handle: ServerHandle): void {
  handle.sweepDeadShares();
}

describe('expired shares lose their sockets', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ base: string; cookie: string; shareId: string }> {
    dataDir = mkdtempSync(join(tmpdir(), 'share-expiry-'));
    writeFileSync(join(dataDir, 'notes.md'), '# Notes\n\nBody.\n');
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    const base = `http://localhost:${handle.port}`;
    const local = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          host: `localhost:${handle?.port}`,
          'content-type': 'application/json',
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });

    // A BOARD is the unit of sharing, so the doc is filed on a grouping, the
    // grouping is filed on a board, and the share covers the board. `shared`
    // is the grouping's only member, which keeps the socket under test —
    // /y/shared — exactly the one the share authorized.
    await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        docId: 'shared',
        type: 'markdown',
        sourceUrl: join(dataDir, 'notes.md'),
        workspaceId: 'ws-shared',
      }),
    });
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Expiry board' }),
    });
    expect(board.status).toBe(200);
    const boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    const filed = await local(`/api/workspaces/${encodeURIComponent(boardId)}/docs`, {
      method: 'POST',
      body: JSON.stringify({ docId: 'ws-shared' }),
    });
    expect(filed.status).toBe(200);
    const mint = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    });
    expect(mint.status).toBe(200);
    const { share } = (await mint.json()) as { share: { slug: string; shareId: string } };
    const redeemed = await fetch(`${base}/s/${share.slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    const cookie =
      (redeemed.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1] ?? '';
    expect(cookie).not.toBe('');
    return { base, cookie, shareId: share.shareId };
  }

  it('closes a visitor socket once the share has expired', async () => {
    const { base, cookie, shareId } = await setup();
    const port = handle?.port ?? 0;
    const conn = connect(`ws://localhost:${port}/y/shared`, {
      host: PUBLIC_HOST,
      cookie: `${SHARE_COOKIE}=${cookie}`,
    });
    // POSITIVE CONTROL: the socket has to be genuinely connected and synced,
    // or "it closed" would just mean it never opened.
    await conn.synced;

    // A sweep while the share is live must leave it alone — otherwise the
    // next assertion proves nothing about expiry.
    sweep(handle as ServerHandle);
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.closeCode).toBeNull();

    // Expire it the way time does: the share record's own deadline.
    const share = handle?.shares?.list().find((s) => s.shareId === shareId);
    expect(share).toBeTruthy();
    if (share) share.expiresAt = Date.now() - 1;

    sweep(handle as ServerHandle);
    // 1008 = policy violation, which is what an expired grant is.
    expect(await closeCodeWithin(conn)).toBe(1008);
    void base;
  });

  it('leaves the owner’s own socket alone — it carries no shareId', async () => {
    const { cookie, shareId } = await setup();
    const port = handle?.port ?? 0;
    const owner = connect(`ws://localhost:${port}/y/shared`, { host: `localhost:${port}` });
    const visitor = connect(`ws://localhost:${port}/y/shared`, {
      host: PUBLIC_HOST,
      cookie: `${SHARE_COOKIE}=${cookie}`,
    });
    await owner.synced;
    await visitor.synced;

    const share = handle?.shares?.list().find((s) => s.shareId === shareId);
    if (share) share.expiresAt = Date.now() - 1;
    sweep(handle as ServerHandle);

    expect(await closeCodeWithin(visitor)).toBe(1008);
    expect(owner.closeCode).toBeNull();
    owner.hangUp();
  });
});
