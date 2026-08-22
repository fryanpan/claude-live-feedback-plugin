/**
 * The sync channel must not hand a share visitor what REST redacts.
 *
 * `redactMetaForVisitor` cleaned up `GET /api/docs/<id>`, but a visitor also
 * opens `/y/<docId>` — and Yjs sync is a state exchange, not a per-connection
 * projection, so whatever is in the `meta` map goes out verbatim. A probe with
 * a raw WebSocket reported "no leak" and was worthless: it never completed the
 * sync handshake, so it received nothing at all. Every test here therefore
 * asserts a POSITIVE CONTROL first — the doc's own text has to arrive before
 * an absence of secrets means anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMeta } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { readPrivateMeta } from '../src/private-meta.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const MSG_SYNC = 0;
const PUBLIC_HOST = 'feedback.example.com';
const CANARY = 'CanaryBodyText';
const OWNER = '/Volumes/Data/Users/someone/dev/private-repo';

/** Real Yjs client — same framing the browser uses. */
function connectDoc(url: string, headers: Record<string, string>) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let synced = false;

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(data);
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (
      !synced &&
      (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
    ) {
      synced = true;
      resolveReady?.();
    }
  });
  return { ws, ydoc, ready, close: () => ws.close() };
}

async function syncAs(
  port: number,
  docId: string,
  headers: Record<string, string>,
): Promise<{ text: string; meta: Record<string, unknown>; close: () => void }> {
  const c = connectDoc(`ws://localhost:${port}/y/${docId}`, headers);
  const timedOut = await Promise.race([
    c.ready.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), 5000)),
  ]);
  expect(timedOut).toBe(false);
  return {
    text: c.ydoc.getXmlFragment('prose').toString(),
    meta: getMeta(c.ydoc).toJSON() as Record<string, unknown>,
    close: c.close,
  };
}

describe('the sync channel leaks no host metadata', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let docPath: string;
  let base: string;
  let cookie: string;
  /**
   * The id the server MINTED for the doc the caller named `leaky`.
   *
   * The sync channel is addressed by the doc's ADDRESS: `ws.data.docId` is
   * re-resolved per frame and share scope is checked against the board's
   * membership, both of which hold the minted id. `leaky` stays a working
   * name on the REST reads below.
   */
  let leakyId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-meta-leak-'));
    docPath = join(dataDir, 'secret-project-notes.md');
    writeFileSync(docPath, `# Notes\n\n${CANARY}.\n`);
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    // A BOARD is the unit of sharing, so `leaky` is filed on one and the
    // share below covers that board. `ws-leaky` is the doc's GROUPING tag —
    // a PUBLIC meta field (it is how the sidebar groups), and no longer
    // shareable on its own. `workspaceRoot`, the absolute host path, is the
    // private one, and this test is about that distinction.
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Leak board' }),
    }).then((r) => r.json());
    const boardId = board.workspace.id as string;
    expect(boardId).toBeTruthy();

    const created = await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        docId: 'leaky',
        type: 'markdown',
        sourceUrl: docPath,
        owner: OWNER,
        workspaceId: 'ws-leaky',
        workspaceRoot: OWNER,
        hubWorkspaceId: boardId,
        producedBy: { agentId: 'secret-agent', sessionId: 'sess-1' },
      }),
    });
    leakyId = ((await created.json()) as { docId: string }).docId;
    expect(leakyId).toBeTruthy();

    const mint = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    });
    const { share } = (await mint.json()) as { share: { slug: string } };
    const redeemed = await fetch(`${base}/s/${share.slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    cookie =
      (redeemed.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1] ?? '';
    expect(cookie).not.toBe('');
  });

  afterAll(async () => {
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('gives a share visitor the document and none of the machine', async () => {
    const { text, meta, close } = await syncAs(handle.port, leakyId, {
      host: PUBLIC_HOST,
      cookie: `${SHARE_COOKIE}=${cookie}`,
    });
    // POSITIVE CONTROL — without this every assertion below is vacuous.
    expect(text).toContain(CANARY);

    expect(meta.sourceUrl).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    expect(meta.workspaceRoot).toBeUndefined();
    expect(meta.producedBy).toBeUndefined();
    const dump = JSON.stringify(meta);
    expect(dump).not.toContain('/Volumes/');
    expect(dump).not.toContain('private-repo');
    expect(dump).not.toContain('secret-agent');
    expect(dump).not.toContain(dataDir);
    close();
  });

  it('withholds them from the trusted host too — they are simply not in the CRDT', async () => {
    // Not a per-connection filter: there is nothing to filter. Asserting on
    // the owner's own connection is what keeps a future "just re-add it for
    // the local UI" change from quietly reopening the share hole.
    const { text, meta, close } = await syncAs(handle.port, leakyId, {
      host: `localhost:${handle.port}`,
    });
    expect(text).toContain(CANARY);
    expect(meta.sourceUrl).toBeUndefined();
    expect(meta.owner).toBeUndefined();
    close();
  });

  it('still knows the binding server-side, from the sidecar', async () => {
    // The values didn't get dropped, they moved. The doc has to stay bound —
    // a doc that silently stops writing back to disk is the worse bug.
    await new Promise((r) => setTimeout(r, 400)); // saveToDisk is debounced
    const doc = await (await local('/api/docs/leaky')).json();
    expect(doc.meta.sourceUrl).toBe(docPath);
    expect(doc.meta.owner).toBe(OWNER);
    expect(doc.meta.producedBy).toEqual({ agentId: 'secret-agent', sessionId: 'sess-1' });
    expect(readPrivateMeta(dataDir, leakyId).sourceUrl).toBe(docPath);
  });

  it('keeps the write-back binding alive across the move', async () => {
    await local('/api/docs/leaky/find_and_replace', {
      method: 'POST',
      body: JSON.stringify({ find: CANARY, replace: 'RewrittenBody' }),
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(readFileSync(docPath, 'utf8')).toContain('RewrittenBody');
  });
});

describe('legacy docs are migrated, not grandfathered', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  afterAll(async () => {
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lifts private keys out of a .ydoc written before this change', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-meta-legacy-'));
    const docPath = join(dataDir, 'legacy.md');
    writeFileSync(docPath, `# Legacy\n\n${CANARY}.\n`);

    // Hand-build the OLD on-disk shape: private keys inside the CRDT.
    const seed = new Y.Doc();
    const m = getMeta(seed);
    seed.transact(() => {
      m.set('docId', 'legacy');
      m.set('type', 'markdown');
      m.set('createdAt', 1);
      m.set('sourceUrl', docPath);
      m.set('owner', OWNER);
      m.set('producedBy', { agentId: 'secret-agent', sessionId: 'sess-1' });
    });
    writeFileSync(join(dataDir, 'legacy.ydoc'), Y.encodeStateAsUpdate(seed));
    expect(existsSync(join(dataDir, 'legacy.private.json'))).toBe(false);

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    // Loading the room is what triggers the migration.
    const doc = await (
      await fetch(`${base}/api/docs/legacy`, { headers: { host: `localhost:${handle.port}` } })
    ).json();
    expect(doc.meta.owner).toBe(OWNER);
    expect(doc.meta.producedBy).toEqual({ agentId: 'secret-agent', sessionId: 'sess-1' });

    const { text, meta, close } = await syncAs(handle.port, 'legacy', {
      host: `localhost:${handle.port}`,
    });
    expect(text).toContain(CANARY);
    expect(meta.owner).toBeUndefined();
    expect(meta.sourceUrl).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('secret-agent');
    close();

    // And the lift is persisted, so a restart doesn't lose the binding.
    await new Promise((r) => setTimeout(r, 400));
    expect(readPrivateMeta(dataDir, 'legacy').owner).toBe(OWNER);
  });
});
