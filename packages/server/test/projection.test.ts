/**
 * Ydoc projection + workspace room (plan §3.3, §6).
 *
 * Tasks live in the server-owned store; the `ws:<workspaceId>` room's `tasks`
 * Y.Map is a PROJECTION only the server writes. Two rules make "only the
 * server writes" true rather than aspirational, both proven here through a
 * real Yjs client (a raw socket never completes the sync handshake — every
 * absence below sits next to a presence):
 *
 *  - the server observes the map and REVERTS any transaction whose Yjs
 *    origin is not its own, and no task.* event fires for the reverted write;
 *  - on hydrate the sidecar is authoritative for gated fields — a crash (or
 *    a forged .ydoc) can't leave fake board state standing.
 *
 * Task BODIES are the deliberate exception: each lives in its own
 * `task:<taskId>` doc room so the whole editing/thread machinery applies
 * unchanged, and body-anchored threads survive projection refreshes and
 * server restarts because a refresh never touches the body room.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId, workspaceRoomId } from '../src/task-projection.ts';
import { eventsLogPath } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

const MSG_SYNC = 0;
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

/** Minimal real Yjs client — completes the sync handshake and pushes local
 *  transactions to the server (the positive control a raw socket lacks). */
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

/** Read an SSE stream until stop(), collecting event names. */
function listen(res: Response): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
        }
      }
    } catch {}
  })();
  return {
    events,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

function auditLines(dataDir: string, workspaceId: string): number {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

type ProjectedTask = {
  id: string;
  title: string;
  status: string;
  assignee: string;
  goal: string;
  order: number;
  bodyDocId: string;
  transitions: Array<{ by: Record<string, unknown>; from: string; to: string }>;
};

describe('ydoc projection + workspace room', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

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

  async function makeWorkspace(name: string): Promise<string> {
    const r = await post('/api/workspaces', { name, goal: 'Ship the search revamp.' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { workspace: { id: string } };
    return body.workspace.id;
  }

  async function makeTask(wsId: string, opts: Record<string, unknown>): Promise<string> {
    const r = await post(`/api/workspaces/${wsId}/tasks`, opts);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { task: { id: string } };
    return body.task.id;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'projection-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a REST-created task appears in the ws room tasks map, and a transition updates it', async () => {
    const wsId = await makeWorkspace('search-revamp');
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room was not created');
    // The workspace map carries the goal text (visitor-contract field).
    expect(room.ydoc.getMap('workspace').get('goal')).toBe('Ship the search revamp.');

    const taskId = await makeTask(wsId, { title: 'Wire the index' });
    const projected = room.ydoc.getMap('tasks').get(taskId) as ProjectedTask | undefined;
    if (!projected) throw new Error('task missing from projection');
    expect(projected.title).toBe('Wire the index');
    expect(projected.status).toBe('todo');
    expect(projected.bodyDocId).toBe(taskBodyDocId(taskId));

    const t = await post(`/api/tasks/${taskId}/transition`, { to: 'in-progress', author: AGENT });
    expect(t.status).toBe(200);
    const after = room.ydoc.getMap('tasks').get(taskId) as ProjectedTask;
    expect(after.status).toBe('in-progress');
    // Transitions ship actor DISPLAY names, not ids (§3.3 visitor contract).
    expect(after.transitions).toHaveLength(1);
    expect(after.transitions[0]?.by).toEqual({ name: 'Search Revamp', kind: 'agent' });

    // A goal edit through the route reaches the workspace map too.
    const g = await local(`/api/workspaces/${wsId}/goal`, {
      method: 'PUT',
      body: JSON.stringify({ goal: 'Ship it faster.', author: PERSON }),
    });
    expect(g.status).toBe(200);
    expect(room.ydoc.getMap('workspace').get('goal')).toBe('Ship it faster.');
  });

  it('reverts a foreign Yjs client write into the tasks map and fires no task.* event', async () => {
    const wsId = await makeWorkspace('projection-guard');
    const taskId = await makeTask(wsId, { title: 'Real task' });

    // Watch the hub workspace event stream for the whole exercise.
    const sseRes = await local(`/events/workspace/${wsId}`);
    expect(sseRes.status).toBe(200);
    const sse = listen(sseRes);

    const client = connectDoc(`${wsBase}/y/${workspaceRoomId(wsId)}`);
    try {
      await waitForOpen(client.ws);
      await client.ready;
      await settle(200);
      // POSITIVE CONTROL: the client really syncs the map — it can see the
      // task, so a later "the forgery is gone" is not vacuous.
      const synced = client.ydoc.getMap('tasks').get(taskId) as ProjectedTask | undefined;
      expect(synced?.title).toBe('Real task');

      const auditBefore = auditLines(dataDir, wsId);
      client.ydoc.transact(() => {
        client.ydoc.getMap('tasks').set(taskId, { ...synced, status: 'done' });
        client.ydoc
          .getMap('tasks')
          .set('t-forged', { id: 't-forged', title: 'Forged', status: 'done' });
      });
      await settle();

      // Server state reverted…
      const room = handle.rooms.get(workspaceRoomId(wsId));
      if (!room) throw new Error('ws room missing');
      const serverTask = room.ydoc.getMap('tasks').get(taskId) as ProjectedTask;
      expect(serverTask.status).toBe('todo');
      expect(room.ydoc.getMap('tasks').get('t-forged')).toBeUndefined();
      // …and the revert propagated BACK to the writer.
      const clientTask = client.ydoc.getMap('tasks').get(taskId) as ProjectedTask;
      expect(clientTask.status).toBe('todo');
      expect(client.ydoc.getMap('tasks').get('t-forged')).toBeUndefined();
      // The store never saw it either.
      expect(handle.tasks.getTask(taskId)?.status).toBe('todo');

      // No task.* event fired for the reverted write — neither on the SSE
      // stream nor in the audit log.
      expect(sse.events.filter((e) => e.startsWith('task.'))).toEqual([]);
      expect(auditLines(dataDir, wsId)).toBe(auditBefore);

      // POSITIVE CONTROL: the same stream and log DO see a legitimate change.
      const t = await post(`/api/tasks/${taskId}/transition`, { to: 'in-progress', author: AGENT });
      expect(t.status).toBe(200);
      await settle(300);
      expect(sse.events).toContain('task.transitioned');
      expect(auditLines(dataDir, wsId)).toBe(auditBefore + 1);
      const clientAfter = client.ydoc.getMap('tasks').get(taskId) as ProjectedTask;
      expect(clientAfter.status).toBe('in-progress');
    } finally {
      client.close();
      sse.stop();
    }
  });

  it('rejects the workspace event stream for an unknown workspace', async () => {
    const r = await local('/events/workspace/w-does-not-exist');
    expect(r.status).toBe(404);
  });

  it('seeds the task body room from the snapshot and snapshots live edits back', async () => {
    const wsId = await makeWorkspace('body-rooms');
    const taskId = await makeTask(wsId, {
      title: 'Write the rollout note',
      body: '## Steps\n\nCheck the flow works end to end.\n',
    });
    const bodyRoom = handle.rooms.get(taskBodyDocId(taskId));
    if (!bodyRoom) throw new Error('body room missing');
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(bodyRoom.ydoc));
    expect(md).toContain('Check the flow works end to end.');

    // A live edit through the doc surface flows back into the store snapshot
    // (search/export), debounced.
    const r = await post(`/api/docs/${taskBodyDocId(taskId)}/content`, {
      markdown: '## Steps\n\nRevised: verify on a phone as well.\n',
    });
    expect(r.status).toBe(200);
    await settle(700);
    expect(handle.tasks.getTask(taskId)?.body).toContain('verify on a phone');
  });

  it('a body-anchored thread survives a projection refresh and a server restart', async () => {
    const wsId = await makeWorkspace('anchor-durability');
    const taskId = await makeTask(wsId, {
      title: 'Harden the import',
      body: 'The importer must anchor me here so review threads stick.\n',
    });
    const docId = taskBodyDocId(taskId);
    const tr = await post(`/api/docs/${docId}/threads/by_find`, {
      find: 'anchor me here',
      author: PERSON,
      text: 'Does this hold across restarts?',
    });
    expect(tr.status).toBe(200);
    const { thread } = (await tr.json()) as { thread: { id: string } };

    const resolves = (h: ServerHandle): boolean => {
      const room = h.rooms.get(docId);
      if (!room) return false;
      const stored = h.rooms.getThread(docId, thread.id);
      if (!stored || stored.anchor.kind !== 'text-range') return false;
      return prose.resolveRelativePosition(room.ydoc, stored.anchor.startRel) !== null;
    };
    // POSITIVE CONTROL: the anchor resolves right after creation.
    expect(resolves(handle)).toBe(true);

    // Force a projection refresh (a real task event rewrites the projection
    // entry) plus an explicit reassert — neither may touch the body room.
    await post(`/api/tasks/${taskId}/transition`, { to: 'in-progress', author: AGENT });
    handle.projection.refresh(wsId);
    expect(resolves(handle)).toBe(true);

    // Restart on the same dataDir: the body room rehydrates from its .ydoc,
    // the seed path is gated on an empty fragment, so identity survives.
    await settle(600); // let the debounced .ydoc + sidecar writes land
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
    expect(resolves(handle)).toBe(true);
    const room = handle.rooms.get(docId);
    if (!room) throw new Error('body room missing after restart');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc))).toContain(
      'anchor me here',
    );
  });

  it('the sidecar is authoritative on hydrate: forged .ydoc state is reasserted away', async () => {
    const wsId = await makeWorkspace('crash-forgery');
    const taskId = await makeTask(wsId, { title: 'Honest task' });
    await settle(600); // persist .ydoc + sidecar
    await handle.stop();

    // Forge the persisted ws room offline — the crash-leaves-fake-state shape.
    const ydocPath = join(dataDir, `${workspaceRoomId(wsId)}.ydoc`);
    const forged = new Y.Doc();
    Y.applyUpdate(forged, new Uint8Array(readFileSync(ydocPath)));
    const before = forged.getMap('tasks').get(taskId) as ProjectedTask;
    expect(before.status).toBe('todo');
    forged.getMap('tasks').set(taskId, { ...before, status: 'done', title: 'Forged while down' });
    writeFileSync(ydocPath, Y.encodeStateAsUpdate(forged));
    // POSITIVE CONTROL: the forgery really is in the persisted bytes.
    const check = new Y.Doc();
    Y.applyUpdate(check, new Uint8Array(readFileSync(ydocPath)));
    expect((check.getMap('tasks').get(taskId) as ProjectedTask).status).toBe('done');

    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room missing after restart');
    const projected = room.ydoc.getMap('tasks').get(taskId) as ProjectedTask;
    expect(projected.status).toBe('todo');
    expect(projected.title).toBe('Honest task');
  });
});
