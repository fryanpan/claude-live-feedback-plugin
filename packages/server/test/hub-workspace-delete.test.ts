/**
 * DELETE /api/workspaces/:id, for a HUB workspace.
 *
 * The route existed and did not cover hub workspaces at all:
 * `rooms.deleteWorkspace` starts from `rooms.list().filter(m =>
 * m.workspaceId === id)`, and a hub workspace has no doc members — hub
 * workspaces live in `TaskStore`, a different store — so every call hit
 * `members.length === 0` and returned `not-found`. A workspace made for a
 * five-minute experiment was permanent.
 *
 * A hub workspace's footprint is bigger than its map entry, and every piece
 * left behind fails differently:
 *   - the tasks sidecar    → hydrate RESURRECTS the workspace on restart
 *   - the events log       → the audit trail of a board nobody can see
 *   - the `ws:<id>` room   → the board URL still loads, with stale content
 *   - `task:<id>` rooms    → one orphan Yjs room per task, forever
 *   - the taskIndex        → task ids resolve to a workspace that is gone
 *
 * The one thing deletion must NOT touch is linked docs. `attachDoc` is a
 * LINK ("the docs' own metadata is untouched"); a doc attached to a board
 * keeps working at its own URL after the board is gone.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId, workspaceRoomId } from '../src/task-projection.ts';
import { type Task, TaskStore, eventsLogPath, tasksSidecarPath } from '../src/tasks.ts';

const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

describe('DELETE /api/workspaces/:id — hub workspace', () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;
  let base = '';

  const start = async (dir: string): Promise<ServerHandle> => {
    const h = createServer({ port: 0, dataDir: dir });
    base = `http://127.0.0.1:${h.port}`;
    return h;
  };

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const del = (path: string) => fetch(`${base}${path}`, { method: 'DELETE' });

  /**
   * Both the tasks sidecar and a room's `.ydoc` are written on a debounce, so
   * "it exists" is a condition to wait for, not a fact right after the
   * create. This matters beyond timing: a test that deletes before the first
   * write would assert the absence of a file that was never there, and pass
   * with the removal gone.
   */
  const awaitFile = async (path: string): Promise<boolean> => {
    for (let i = 0; i < 100; i++) {
      if (existsSync(path)) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  /**
   * Hub boards and doc groupings are two lists in one payload, and the one
   * this file is about is `hubWorkspaces` — reading `workspaces` reports a
   * hub board as absent before anything has been deleted.
   */
  const listWorkspaceIds = async (): Promise<string[]> => {
    const r = await fetch(`${base}/api/workspaces`);
    const payload = (await r.json()) as { hubWorkspaces?: Array<{ id: string }> };
    return (payload.hubWorkspaces ?? []).map((w) => w.id);
  };

  /** A board with two tasks, one of them already closed. */
  async function seed(): Promise<{ wsId: string; open: Task; done: Task }> {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-ws-delete-'));
    handle = await start(dataDir);
    const ws = await post('/api/workspaces', { name: 'scratch', goal: 'Try one thing.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    const mk = async (title: string): Promise<Task> => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title,
        goal: 'chores',
        author: AGENT,
        body: `Agent can ${title} so that the experiment finishes.`,
      });
      expect(r.status).toBe(200);
      return ((await r.json()) as { task: Task }).task;
    };
    const open = await mk('still open');
    const done = await mk('already closed');
    const t = await post(`/api/tasks/${done.id}/transition`, { to: 'done', author: AGENT });
    expect(t.status).toBe(200);
    return { wsId, open, done };
  }

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // `stop()` flushes the task store and the body snapshots, but a room's
    // `.ydoc` write sits on its own 200ms debounce that nothing cancels — so
    // removing the data dir immediately makes that write log an ENOENT into
    // the next test's output. Let it land first. (The gap itself is real and
    // pre-existing: a restart inside the window drops the last writes.)
    await new Promise((r) => setTimeout(r, 250));
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('refuses while tasks are still open, and names how many', async () => {
    const { wsId } = await seed();
    const res = await del(`/api/workspaces/${wsId}`);
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: string; openTasks?: number };
    expect(payload.error).toBe('has-open-tasks');
    // The count is the point: "refused" without it makes the caller go
    // looking. One of the two tasks is done, so a body that says 2 would be
    // counting rows rather than open work.
    expect(payload.openTasks).toBe(1);
    // Nothing was half-deleted on the way to refusing.
    expect(await listWorkspaceIds()).toContain(wsId);
  });

  it('deletes the board, its rooms and its sidecars, with force', async () => {
    const { wsId, open, done } = await seed();
    const boardRoom = workspaceRoomId(wsId);
    const openBody = taskBodyDocId(open.id);
    const doneBody = taskBodyDocId(done.id);

    // Positive controls: every one of these exists BEFORE the delete, so the
    // absences asserted after it mean something.
    expect(await listWorkspaceIds()).toContain(wsId);
    expect(await awaitFile(tasksSidecarPath(dataDir as string, wsId))).toBe(true);
    expect(existsSync(eventsLogPath(dataDir as string, wsId))).toBe(true);
    expect(handle?.rooms.get(boardRoom)).toBeDefined();
    expect(handle?.rooms.get(openBody)).toBeDefined();
    expect(handle?.rooms.get(doneBody)).toBeDefined();

    const res = await del(`/api/workspaces/${wsId}?force=true`);
    expect(res.status).toBe(200);

    expect(await listWorkspaceIds()).not.toContain(wsId);
    expect(existsSync(tasksSidecarPath(dataDir as string, wsId))).toBe(false);
    expect(existsSync(eventsLogPath(dataDir as string, wsId))).toBe(false);
    expect(handle?.rooms.get(boardRoom)).toBeUndefined();
    expect(handle?.rooms.get(openBody)).toBeUndefined();
    expect(handle?.rooms.get(doneBody)).toBeUndefined();
    // The tasks no longer resolve either — a task id pointing at a workspace
    // that is gone is the shape that makes every later lookup throw.
    expect(handle?.tasks.getTask(open.id)).toBeUndefined();
  });

  it('stays deleted across a restart', async () => {
    // The sidecar is authoritative on hydrate, so an in-memory-only delete
    // looks completely successful until the next restart brings the board
    // back — and a restart is now routine.
    const { wsId } = await seed();
    // Wait for the board to actually reach disk first — deleting before the
    // debounced write would make this pass with the file removal deleted.
    expect(await awaitFile(tasksSidecarPath(dataDir as string, wsId))).toBe(true);
    expect((await del(`/api/workspaces/${wsId}?force=true`)).status).toBe(200);

    await handle?.stop();
    handle = await start(dataDir as string);
    expect(await listWorkspaceIds()).not.toContain(wsId);
  });

  it('refuses instead of claiming success when the sidecar survives', async () => {
    // "Deleted" and "still on disk" is the worst pair available here: the
    // caller stops asking, and the next restart hands the board back.
    const { wsId, open } = await seed();
    const sidecar = tasksSidecarPath(dataDir as string, wsId);
    expect(await awaitFile(sidecar)).toBe(true);
    // Stand in for any unlink failure (permissions, a locked file) without
    // depending on the test user's privileges: a directory where the file
    // was makes the non-recursive rmSync throw, and root can't make it
    // succeed either — a chmod fixture would silently pass as root.
    rmSync(sidecar);
    mkdirSync(sidecar);

    const res = await del(`/api/workspaces/${wsId}?force=true`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('persist-failed');
    // And the board is intact rather than half-deleted, so a retry once the
    // filesystem is fixed still has something to delete.
    expect(await listWorkspaceIds()).toContain(wsId);
    expect(handle?.tasks.getTask(open.id)).toBeDefined();
    // The rooms went first and are gone by now, which is fine: they are
    // derived, and the next touch rebuilds them from the store. So what the
    // refusal leaves is a working board, not a hollow one.
    const again = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'after the failure',
      goal: 'chores',
      author: AGENT,
      body: 'Agent can keep using the board so that a failed delete costs nothing.',
    });
    expect(again.status).toBe(200);
    expect(handle?.rooms.get(workspaceRoomId(wsId))).toBeDefined();
  });

  it('keeps the board when a room file survives, so the delete can be retried', async () => {
    // Rooms are derived state, so they come down first and the store entry
    // is the commit point. If a room's `.ydoc` can't be removed, deleting
    // the board anyway would strand an orphan that reloads on the next
    // restart behind an id that no longer resolves as a board — nothing
    // could ever come back for it.
    const { wsId, open } = await seed();
    const boardYdoc = join(dataDir as string, `${workspaceRoomId(wsId)}.ydoc`);
    expect(await awaitFile(boardYdoc)).toBe(true);
    // Same root-proof stand-in for an unlink failure as above.
    rmSync(boardYdoc);
    mkdirSync(boardYdoc);

    const res = await del(`/api/workspaces/${wsId}?force=true`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('rooms-cleanup-failed');
    // And it must keep refusing while the file is still there. The first
    // attempt took the room out of memory, so a check that asks the ROOM
    // ("not-found, nothing to do") would call the retry a success and delete
    // the board over the top of the orphan.
    const retry = await del(`/api/workspaces/${wsId}?force=true`);
    expect(retry.status).toBe(500);
    expect(((await retry.json()) as { error: string }).error).toBe('rooms-cleanup-failed');
    // The board and its tasks are still there, so the same call retries once
    // the filesystem is fixed — and the projection rebuilds the rooms it did
    // manage to drop.
    expect(await listWorkspaceIds()).toContain(wsId);
    expect(handle?.tasks.getTask(open.id)).toBeDefined();
    expect(existsSync(tasksSidecarPath(dataDir as string, wsId))).toBe(true);
  });

  it('re-arms the write it cancelled when the delete refuses', () => {
    // A delete cancels the workspace's debounced writes before touching the
    // filesystem — otherwise a save in flight recreates the sidecar just
    // after the delete reports success. That cancellation is only free when
    // the delete goes through: on a refusal the board is still live and
    // still owes those writes, and nothing re-arms them until the next
    // mutation, so the edits inside the window die at the next restart.
    //
    // Store-level, with a debounce long enough that "a write is pending" is
    // a fact rather than a race.
    const dir = mkdtempSync(join(tmpdir(), 'hub-ws-delete-store-'));
    const store = new TaskStore({ dataDir: dir, debounceMs: 5000 });
    try {
      const ws = store.createWorkspace('scratch', 'Try one thing.');
      store.createTask(ws.id, { title: 'written' });
      store.flush();
      const sidecar = tasksSidecarPath(dir, ws.id);
      expect(existsSync(sidecar)).toBe(true);

      store.createTask(ws.id, { title: 'inside the debounce window' });
      rmSync(sidecar);
      mkdirSync(sidecar);
      expect(store.deleteWorkspace(ws.id, { force: true }).ok).toBe(false);

      // Repair the filesystem and flush. `flush()` only persists workspaces
      // that have a PENDING timer, so this reaches disk only if the refusal
      // put one back.
      rmSync(sidecar, { recursive: true });
      store.flush();
      const saved = JSON.parse(readFileSync(sidecar, 'utf8')) as {
        tasks: Array<{ title: string }>;
      };
      expect(saved.tasks.map((t) => t.title)).toContain('inside the debounce window');
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an attached doc alone — attachDoc is a link, not ownership', async () => {
    const { wsId } = await seed();
    const docId = 'attached-spec';
    // Every markdown doc is file-backed, so the create needs a real path.
    const docDir = mkdtempSync(join(tmpdir(), 'hub-ws-delete-doc-'));
    const docPath = join(docDir, 'spec.md');
    writeFileSync(docPath, '# Spec\n\nStill useful after the board is gone.\n');
    const created = await post('/api/docs', {
      docId,
      title: 'Spec',
      type: 'markdown',
      sourceUrl: docPath,
    });
    expect(created.status).toBe(200);
    const attached = await post(`/api/workspaces/${wsId}/docs`, { docId });
    expect(attached.status).toBe(200);

    expect((await del(`/api/workspaces/${wsId}?force=true`)).status).toBe(200);

    // The doc keeps working at its own URL. Deleting a board that merely
    // CITED it must not take it down.
    expect(handle?.rooms.get(docId)).toBeDefined();
    expect((await fetch(`${base}/api/docs/${docId}`)).status).toBe(200);
    rmSync(docDir, { recursive: true, force: true });
  });

  it('404s on an id that is neither a hub board nor a doc grouping', async () => {
    // Non-vacuous because the same route returns 200 above on a real id.
    await seed();
    expect((await del('/api/workspaces/w-nope?force=true')).status).toBe(404);
  });

  it('still deletes a doc-grouping workspace — the pre-existing path', async () => {
    // Two different stores answer to the word "workspace", and ONE route
    // creates both: `POST /api/workspaces` mints a hub board from `name` and
    // a doc grouping from `folderPath`. So the delete has to consult both,
    // and the regression to fear is the new hub branch shadowing this one.
    dataDir = mkdtempSync(join(tmpdir(), 'hub-ws-delete-grouping-'));
    const folder = mkdtempSync(join(tmpdir(), 'hub-ws-delete-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Member\n\nOne file is enough.\n');
    handle = await start(dataDir);

    const bound = await post('/api/workspaces', { folderPath: folder, owner: '/proj/scratch' });
    expect(bound.status).toBe(200);
    const { workspaceId, files } = (await bound.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    const memberDoc = files[0]?.docId as string;
    expect(memberDoc).toBeTruthy();
    expect(handle?.rooms.get(memberDoc)).toBeDefined();

    const res = await del(`/api/workspaces/${encodeURIComponent(workspaceId)}?force=true`);
    expect(res.status).toBe(200);
    expect(handle?.rooms.get(memberDoc)).toBeUndefined();
    rmSync(folder, { recursive: true, force: true });
  });
});
