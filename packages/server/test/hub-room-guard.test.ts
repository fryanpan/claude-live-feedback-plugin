/**
 * Two ways the "only the server writes" claim (§3.3) could be false, both
 * proven through a REAL Yjs client (a raw socket never completes the sync
 * handshake, so every absence it reports is vacuous — learnings.md).
 *
 *  1. **The `meta` map is a file-bind vector.** The projection guards the
 *     `tasks` and `workspace` maps; every OTHER type in a hub room was
 *     freely writable by any connected peer, share visitors included. The
 *     hub rooms (`ws:<id>`, `task:<id>`) are the only visitor-writable rooms
 *     with no private-meta sidecar, so a peer-written `meta.sourceUrl`
 *     survived `readPrivateMeta` returning `{}` and was promoted into
 *     `room.meta` on the next load — where `hydrateFromDisk` binds the room
 *     to that path, seeds the fragment with the file's bytes, and wires the
 *     write-back. Read, then overwrite, any file the server can reach.
 *
 *  2. **The revert guard was keyed to the workspaceId, not to the ydoc.**
 *     Deleting the board room and letting it be recreated handed back a NEW
 *     Y.Doc while `wired` still said "guarded", so every later client write
 *     stood — silently, until the process restarted.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId, workspaceRoomId } from '../src/task-projection.ts';

const CANARY = 'CANARY-9271 the contents of a private file\n';

const MSG_SYNC = 0;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

/** The repo's own minimal Yjs client (ws.test.ts / projection.test.ts shape):
 *  completes the handshake AND pushes local transactions to the server. */
function connectDoc(url: string): {
  ws: WebSocket;
  ydoc: Y.Doc;
  ready: Promise<void>;
  close: () => void;
} {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let gotSyncStep2 = false;

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (
        !gotSyncStep2 &&
        (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
      ) {
        gotSyncStep2 = true;
        resolveReady?.();
      }
    }
  });
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });

  return { ws, ydoc, ready, close: () => ws.close() };
}

describe('hub rooms defend everything the server owns', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let secretPath: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });

  const restart = async () => {
    await settle(600); // let the debounced .ydoc + sidecar writes land
    await handle.stop();
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  };

  async function makeWorkspace(name: string): Promise<string> {
    const r = await post('/api/workspaces', { name, goal: 'Ship the search revamp.' });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  }

  async function makeTask(wsId: string, opts: Record<string, unknown>): Promise<string> {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { assignee: 'human', ...opts });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-guard-'));
    secretPath = join(dataDir, 'private-notes.md');
    writeFileSync(secretPath, CANARY);
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a peer cannot bind the board room to a file by writing meta.sourceUrl', async () => {
    const wsId = await makeWorkspace('meta-injection');
    const roomId = workspaceRoomId(wsId);
    const client = connectDoc(`${wsBase}/y/${roomId}`);
    try {
      await waitForOpen(client.ws);
      await client.ready;
      await settle(200);
      client.ydoc.transact(() => {
        const meta = client.ydoc.getMap('meta');
        meta.set('type', 'markdown');
        meta.set('sourceUrl', secretPath);
        meta.set('probeReachedTheServer', 'yes');
      });
      await settle(400);
    } finally {
      client.close();
    }

    const room = handle.rooms.get(roomId);
    if (!room) throw new Error('ws room missing');
    // POSITIVE CONTROL: the write really reached the server's copy of the
    // room — a non-private key the guard has no opinion about survives, so
    // "sourceUrl is gone" is not a claim about a socket that did nothing.
    expect(room.ydoc.getMap('meta').get('probeReachedTheServer')).toBe('yes');
    expect(room.ydoc.getMap('meta').get('sourceUrl')).toBeUndefined();
    expect(room.meta.sourceUrl).toBeUndefined();

    await restart();
    const after = handle.rooms.get(roomId);
    if (!after) throw new Error('ws room missing after restart');
    expect(after.meta.sourceUrl).toBeUndefined();
    // The file's bytes never entered the room the peer still syncs.
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(after.ydoc))).not.toContain(
      'CANARY-9271',
    );
    // POSITIVE CONTROL for the restart itself: hydrate DOES bind a doc whose
    // sourceUrl the server actually recorded, so the assertion above is
    // about the guard rather than about a hydrate that never runs.
    const bound = join(dataDir, 'bound.md');
    writeFileSync(bound, `${CANARY}`);
    expect(
      (await post('/api/docs', { docId: 'bound', type: 'markdown', sourceUrl: bound })).status,
    ).toBe(200);
    await restart();
    const boundRoom = handle.rooms.get('bound');
    if (!boundRoom) throw new Error('bound doc missing after restart');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(boundRoom.ydoc))).toContain(
      'CANARY-9271',
    );
  });

  it('a peer cannot bind a task body room to a file either', async () => {
    const wsId = await makeWorkspace('body-injection');
    const taskId = await makeTask(wsId, { title: 'Write the rollout note' });
    const docId = taskBodyDocId(taskId);
    const client = connectDoc(`${wsBase}/y/${docId}`);
    try {
      await waitForOpen(client.ws);
      await client.ready;
      await settle(200);
      client.ydoc.transact(() => {
        client.ydoc.getMap('meta').set('sourceUrl', secretPath);
        client.ydoc.getMap('meta').set('probeReachedTheServer', 'yes');
      });
      await settle(400);
    } finally {
      client.close();
    }
    const room = handle.rooms.get(docId);
    if (!room) throw new Error('body room missing');
    expect(room.ydoc.getMap('meta').get('probeReachedTheServer')).toBe('yes'); // positive control
    expect(room.ydoc.getMap('meta').get('sourceUrl')).toBeUndefined();

    await restart();
    const after = handle.rooms.get(docId);
    if (!after) throw new Error('body room missing after restart');
    expect(after.meta.sourceUrl).toBeUndefined();
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(after.ydoc))).not.toContain(
      'CANARY-9271',
    );
  });

  it('re-arms the revert guard when the board room is deleted and recreated', async () => {
    const wsId = await makeWorkspace('guard-rearm');
    const roomId = workspaceRoomId(wsId);
    await makeTask(wsId, { title: 'Real task' });

    const forge = async (id: string): Promise<unknown> => {
      const client = connectDoc(`${wsBase}/y/${roomId}`);
      try {
        await waitForOpen(client.ws);
        await client.ready;
        await settle(200);
        client.ydoc.transact(() => {
          client.ydoc.getMap('tasks').set(id, { id, title: 'Forged', status: 'done' });
        });
        await settle(400);
      } finally {
        client.close();
      }
      return handle.rooms.get(roomId)?.ydoc.getMap('tasks').get(id);
    };

    // POSITIVE CONTROL: the guard is armed on the freshly created room.
    expect(await forge('t-forged-1')).toBeUndefined();

    const del = await local(`/api/docs/${encodeURIComponent(roomId)}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    // Any store mutation re-creates the board room — with a NEW Y.Doc.
    await makeTask(wsId, { title: 'Task after the delete' });
    expect(handle.rooms.get(roomId)).toBeDefined();

    expect(await forge('t-forged-2')).toBeUndefined();
  });
});
