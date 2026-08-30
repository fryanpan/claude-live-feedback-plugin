/**
 * Per-task human attention time: `TaskStore.recordReadingTime` /
 * `setReadingTime`, and the live wiring in server.ts that folds a
 * `read_session` POST onto the task it describes.
 *
 * Three contracts under test:
 *  - Only a `read_session` on a `task:<id>` doc touches a task; `doc_open`
 *    and read_sessions on ordinary docs never do.
 *  - The stored total is the SUM across visits (server-clamped), with a
 *    session count — never the last visit's number.
 *  - Quiet: recording a read never fires a store event or bumps
 *    `updatedAt` — reading a ticket must not reset its own staleness clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

describe('TaskStore.recordReadingTime', () => {
  let dataDir: string;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reading-time-store-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('launch-board');
    const created = store.createTask(ws.id, { title: 'Read this ticket' });
    if (!created.ok) throw new Error('create failed');
    taskId = created.task.id;
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an unknown task is not-found', () => {
    expect(store.recordReadingTime('no-such-task', 30).ok).toBe(false);
  });

  it('the first session starts totalSeconds and sessionCount from zero', () => {
    const res = store.recordReadingTime(taskId, 18);
    expect(res.ok).toBe(true);
    expect(store.getTask(taskId)?.readingTime).toMatchObject({ totalSeconds: 18, sessionCount: 1 });
  });

  it('a second session SUMS onto the first — never overwrites to the latest', () => {
    store.recordReadingTime(taskId, 18);
    store.recordReadingTime(taskId, 7);
    const rt = store.getTask(taskId)?.readingTime;
    expect(rt?.totalSeconds).toBe(25);
    expect(rt?.sessionCount).toBe(2);
  });

  it('a non-positive or non-finite delta is a no-op', () => {
    expect(store.getTask(taskId)?.readingTime).toBeUndefined();
    store.recordReadingTime(taskId, 0);
    store.recordReadingTime(taskId, -5);
    store.recordReadingTime(taskId, Number.NaN);
    // Still absent — "not measured yet", never nudged to a fake zero.
    expect(store.getTask(taskId)?.readingTime).toBeUndefined();
  });

  it('is quiet: fires no store event and does not bump updatedAt', () => {
    const before = store.getTask(taskId)?.updatedAt;
    const events: TaskStoreEvent[] = [];
    const unsubscribe = store.onEvent((e) => events.push(e));
    store.recordReadingTime(taskId, 12);
    unsubscribe();
    expect(events).toHaveLength(0);
    expect(store.getTask(taskId)?.updatedAt).toBe(before);
  });

  it('persists across a rehydrated store', async () => {
    store.recordReadingTime(taskId, 18);
    store.recordReadingTime(taskId, 7);
    store.stop();
    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.getTask(taskId)?.readingTime).toMatchObject({
        totalSeconds: 25,
        sessionCount: 2,
      });
    } finally {
      rehydrated.stop();
    }
  });
});

describe('TaskStore.setReadingTime', () => {
  let dataDir: string;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reading-time-set-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('launch-board');
    const created = store.createTask(ws.id, { title: 'Read this ticket' });
    if (!created.ok) throw new Error('create failed');
    taskId = created.task.id;
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an unknown task is not-found', () => {
    expect(
      store.setReadingTime('no-such-task', { totalSeconds: 1, sessionCount: 1, lastSessionAt: 1 })
        .ok,
    ).toBe(false);
  });

  it('overwrites rather than adding onto whatever was there', () => {
    store.recordReadingTime(taskId, 100);
    store.setReadingTime(taskId, { totalSeconds: 42, sessionCount: 3, lastSessionAt: 999 });
    expect(store.getTask(taskId)?.readingTime).toEqual({
      totalSeconds: 42,
      sessionCount: 3,
      lastSessionAt: 999,
    });
  });
});

describe('server wiring: a read_session on a task body room updates Task.readingTime', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reading-time-wire-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  async function until<T>(read: () => T | undefined): Promise<T> {
    for (let i = 0; i < 80; i++) {
      const v = read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition never held');
  }

  async function newTask(): Promise<string> {
    const { workspace } = await j<{ workspace: { id: string } }>(
      await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'launch-board' }),
      }),
    );
    const { task } = await j<{ task: { id: string } }>(
      await fetch(`${base}/api/workspaces/${workspace.id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: PERSON, title: 'Read this ticket' }),
      }),
    );
    // Task creation mints the body room asynchronously (projection commit);
    // wait for it before posting a read against it.
    await until(() => handle.rooms.getDoc(taskBodyDocId(task.id)));
    return task.id;
  }

  function postActivity(
    docId: string,
    type: 'read_session' | 'doc_open',
    payload: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(`${base}/api/docs/${docId}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, author: PERSON, payload }),
    });
  }

  it('a read_session on the task body room accumulates readingTime', async () => {
    const taskId = await newTask();
    const r = await postActivity(taskBodyDocId(taskId), 'read_session', {
      sessionId: 's1',
      durationMs: 18_000,
      interactionBounded: true,
    });
    expect(r.status).toBe(200);
    const rt = await until(() => handle.tasks.getTask(taskId)?.readingTime);
    expect(rt.totalSeconds).toBe(18);
    expect(rt.sessionCount).toBe(1);
  });

  it('a second visit SUMS rather than replacing', async () => {
    const taskId = await newTask();
    await postActivity(taskBodyDocId(taskId), 'read_session', {
      sessionId: 's1',
      durationMs: 18_000,
    });
    await until(() => handle.tasks.getTask(taskId)?.readingTime);
    await postActivity(taskBodyDocId(taskId), 'read_session', {
      sessionId: 's2',
      durationMs: 7_000,
    });
    const rt = await until(() => {
      const t = handle.tasks.getTask(taskId)?.readingTime;
      return t && t.sessionCount === 2 ? t : undefined;
    });
    expect(rt.totalSeconds).toBe(25);
  });

  it('the recorded total is the server-CLAMPED duration, not a spoofed one', async () => {
    const taskId = await newTask();
    await postActivity(taskBodyDocId(taskId), 'read_session', {
      sessionId: 'inflated',
      // 10 hours — must land clamped to the 20-minute cap (1200s), not raw.
      durationMs: 36_000_000,
    });
    const rt = await until(() => handle.tasks.getTask(taskId)?.readingTime);
    expect(rt.totalSeconds).toBe(20 * 60);
  });

  it('doc_open never sets readingTime', async () => {
    const taskId = await newTask();
    const r = await postActivity(taskBodyDocId(taskId), 'doc_open', { sessionId: 'open-1' });
    expect(r.status).toBe(200);
    // Give any (wrongly) async write a moment, then assert it never came.
    await new Promise((res) => setTimeout(res, 100));
    expect(handle.tasks.getTask(taskId)?.readingTime).toBeUndefined();
  });

  it('a read_session on an ordinary (non-task) doc never touches any task', async () => {
    const taskId = await newTask();
    const file = join(dataDir, 'plain.md');
    await Bun.write(file, '# Plain\n\nSome prose.\n');
    const { docId } = await j<{ docId: string }>(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'plain-doc', type: 'markdown', sourceUrl: file }),
      }),
    );
    const r = await postActivity(docId, 'read_session', { sessionId: 's1', durationMs: 9_000 });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 100));
    expect(handle.tasks.getTask(taskId)?.readingTime).toBeUndefined();
  });
});
