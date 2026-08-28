/**
 * Revocation and expiry have to reach the SSE stream too.
 *
 * `/y/*` sockets are hung up on revoke and swept on expiry. `/events/<docId>`
 * is the same shape of problem — authorized once, then long-lived — and it was
 * left open: a visitor who already had the review page up kept receiving every
 * new comment after their access was pulled.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

/** Read an SSE stream until `stop()`, collecting the event names seen. */
function listen(res: Response): {
  events: string[];
  ended: Promise<void>;
  stop: () => void;
} {
  const events: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  const ended = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || stopped) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
        }
      }
    } catch {
      // Stream torn down — that IS the expected end for the revoked case.
    }
  })();
  return {
    events,
    ended,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('a revoked share loses its event stream', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function setup() {
    dataDir = mkdtempSync(join(tmpdir(), 'sse-revoke-'));
    const docPath = join(dataDir, 'notes.md');
    writeFileSync(docPath, '# Notes\n\nBody text here.\n');
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    const port = handle.port;
    const base = `http://localhost:${port}`;
    const local = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          host: `localhost:${port}`,
          'content-type': 'application/json',
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });

    // A BOARD is the unit of sharing: the doc is filed on the grouping
    // `ws-shared`, that grouping is filed on a board, and the link covers the
    // board. `shared` is the grouping's only member, so the stream under test
    // — /events/shared — is still exactly the one this share authorized, which
    // is what revocation has to reach.
    await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        docId: 'shared',
        type: 'markdown',
        sourceUrl: docPath,
        workspaceId: 'ws-shared',
      }),
    });
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Revocation board' }),
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
    const { share } = (await mint.json()) as { share: { url: string; shareId: string } };
    const shareUrl = new URL(share.url);
    const redeemed = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    const cookie =
      (redeemed.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1] ?? '';
    expect(cookie).not.toBe('');

    /** Post a comment as the owner — every live stream should see it. */
    const comment = (text: string) =>
      local('/api/docs/shared/threads/by_find', {
        method: 'POST',
        body: JSON.stringify({
          find: 'Body text here',
          text,
          author: { id: 'bryan', name: 'Bryan', kind: 'person' },
        }),
      });

    const openStream = () =>
      fetch(`${base}/events/shared`, {
        headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` },
      });

    return { base, local, comment, openStream, shareId: share.shareId };
  }

  it('stops delivering events after the share is revoked', async () => {
    const { local, comment, openStream, shareId } = await setup();
    const stream = listen(await openStream());

    // POSITIVE CONTROL: the stream is genuinely wired before revocation.
    await comment('first');
    await settle();
    expect(stream.events.length).toBeGreaterThan(0);
    const before = stream.events.length;

    const del = await local(`/api/share/${shareId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    await settle();

    await comment('second');
    await settle();
    expect(stream.events.length).toBe(before);
    stream.stop();
    await stream.ended;
  });

  it('stops delivering events once the share has expired', async () => {
    const { comment, openStream, shareId } = await setup();
    const stream = listen(await openStream());
    await comment('first');
    await settle();
    expect(stream.events.length).toBeGreaterThan(0);
    const before = stream.events.length;

    const share = handle?.shares?.list().find((s) => s.shareId === shareId);
    if (share) share.expiresAt = Date.now() - 1;
    handle?.sweepDeadShares(); // the real sweep, not a re-implementation
    await settle();

    await comment('second');
    await settle();
    expect(stream.events.length).toBe(before);
    stream.stop();
    await stream.ended;
  });

  it("leaves the owner's own stream alone", async () => {
    const { base, local, comment, shareId } = await setup();
    const ownerStream = listen(
      await fetch(`${base}/events/shared`, { headers: { host: `localhost:${handle?.port}` } }),
    );
    await comment('first');
    await settle();
    const before = ownerStream.events.length;
    expect(before).toBeGreaterThan(0);

    await local(`/api/share/${shareId}`, { method: 'DELETE' });
    await settle();
    await comment('second');
    await settle();
    expect(ownerStream.events.length).toBeGreaterThan(before);
    ownerStream.stop();
    await ownerStream.ended;
  });
});
