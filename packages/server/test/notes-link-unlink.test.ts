/**
 * Undoing a spoken link — the recovery half.
 *
 * A matcher that answers "link that to the existing task" from a loose
 * description will sometimes answer wrong, and the room will not notice until
 * somebody rereads the notes. So the link has to be removable from the note,
 * and removing it has to take the ROW'S SIDE with it: a doc that no longer
 * cites a task while the task still lists the doc is the drift that made
 * backlinks computed rather than stored in the first place.
 *
 * WHAT THIS TEST IS ACTUALLY PINNING, and why it is worth its runtime when
 * `cross-refs.test.ts` already covers the two routes: that the ref a MEETING
 * writes and the ref the note's unlink affordance DELETES are the same ref.
 * They are produced by one exported function (`spokenLinkRef`) for exactly
 * this reason, and a test that hand-wrote `{ kind: 'doc', docId }` on both
 * sides would pass while the two drifted apart.
 *
 * Real server, real routes. Fixtures are invented; the repo is public.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spokenLinkRef } from '../src/notes-link-intent.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Ref, Task } from '../src/tasks.ts';

describe('unlinking a spoken link from the note', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let wsId: string;
  let docId: string;

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host: 'localhost', ...((init.headers as Record<string, string>) ?? {}) },
    });

  const send =
    (method: string) =>
    (path: string, body: unknown): Promise<Response> =>
      call(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
  const post = send('POST');
  const del = send('DELETE');

  /** The tasks this doc can be reached from — the doc's own backlink surface. */
  const docBacklinks = async (): Promise<string[]> => {
    const r = await call(`/api/docs/${docId}/tasks`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tasks: Array<{ id: string }> };
    return body.tasks.map((t) => t.id);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'notes-unlink-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const ws = await post('/api/workspaces', { name: 'recorder', goal: 'Ship the recorder.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const mdPath = join(dataDir, 'standup.md');
    writeFileSync(mdPath, '# Standup\n\n## Meeting notes\n\n- A point.\n');
    const doc = await post('/api/docs', {
      docId: 'recorder-standup',
      type: 'markdown',
      sourceUrl: mdPath,
    });
    docId = ((await doc.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mkTask = async (title: string): Promise<Task> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { title, assignee: 'human' });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: Task }).task;
  };

  it('takes the ref and the row’s backlink away together', async () => {
    const task = await mkTask('Card write failures');

    // The link, written exactly as a heard "link that to the existing task"
    // writes it.
    const linked = await post(`/api/tasks/${task.id}/links`, { ref: spokenLinkRef(docId) });
    expect(linked.status).toBe(200);

    // Positive control: both sides really are there before anything is
    // removed, so the assertions below cannot pass on a link that never
    // landed.
    const stored = (await (await call(`/api/tasks/${task.id}/links`)).json()) as { links: Ref[] };
    expect(stored.links).toEqual([{ kind: 'doc', docId }]);
    expect(await docBacklinks()).toContain(task.id);

    const unlinked = await del(`/api/tasks/${task.id}/links`, { ref: spokenLinkRef(docId) });
    expect(unlinked.status).toBe(200);
    expect(((await unlinked.json()) as { changed: boolean }).changed).toBe(true);

    const after = (await (await call(`/api/tasks/${task.id}/links`)).json()) as { links: Ref[] };
    expect(after.links).toEqual([]);
    // The row's own side is gone too — which it is because backlinks are
    // computed from `links` and never stored beside them.
    expect(await docBacklinks()).not.toContain(task.id);
  });

  it('is safe to undo twice — the end state is what was asked for', async () => {
    const task = await mkTask('Belt clip moulding');
    await post(`/api/tasks/${task.id}/links`, { ref: spokenLinkRef(docId) });
    await del(`/api/tasks/${task.id}/links`, { ref: spokenLinkRef(docId) });

    const again = await del(`/api/tasks/${task.id}/links`, { ref: spokenLinkRef(docId) });
    expect(again.status).toBe(200);
    // `changed: false` rather than an error: a note whose link the reader
    // removed twice, or two open browsers removing it at once, is not a
    // failure — the link is gone either way.
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);
  });

  it('leaves every other row’s link to the same doc alone', async () => {
    const removed = await mkTask('Charging port ingress');
    const kept = await mkTask('Input gain knob');
    await post(`/api/tasks/${removed.id}/links`, { ref: spokenLinkRef(docId) });
    await post(`/api/tasks/${kept.id}/links`, { ref: spokenLinkRef(docId) });
    expect(await docBacklinks()).toEqual(expect.arrayContaining([removed.id, kept.id]));

    await del(`/api/tasks/${removed.id}/links`, { ref: spokenLinkRef(docId) });

    const back = await docBacklinks();
    expect(back).not.toContain(removed.id);
    expect(back).toContain(kept.id);
  });
});
