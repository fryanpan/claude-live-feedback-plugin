/**
 * Triage shapes a captured row — and never at the cost of the capture.
 *
 * Quick-capture is deliberately dumb: one row per submit, the first line
 * clipped for a title, the whole utterance kept as the body, no network and no
 * judgement. That is correct and is not what this file tests. What it tests is
 * the step AFTER — the one that turns that row into work — and the two things
 * that step is not allowed to cost:
 *
 *  1. the raw row must land and survive exactly as it does today when nothing
 *     shapes it (no attached agent, or an agent that never gets round to it);
 *  2. a rewrite must never be the only record of what was said.
 *
 * Every assertion of an absence here has a peer on the same page that shows
 * the probe can see a presence — the "raw row unchanged" case is run against
 * the SAME server that then shapes the same row through the real route, so
 * "unchanged" cannot be an artefact of nothing being able to change it.
 *
 * Fixtures are synthetic — invented product names, invented agent names. The
 * repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';

import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import type { Task, TaskStoreEvent } from '../src/tasks.ts';

const AGENT: User = {
  id: 'agent-shelf-planner',
  name: 'Shelf Planner',
  kind: 'known',
  color: '#888888',
};
const PERSON: User = { id: 'known-robin', name: 'Robin', kind: 'known', color: '#2e7dd7' };

/**
 * What quick-capture actually posts for a typed paragraph: `parseQuickAdd`
 * clips the first line on a word boundary for the title and keeps the whole
 * utterance as the body. Written out rather than imported so this file states
 * the shape it is defending; the client's own parse is tested next door.
 */
const CAPTURE = {
  title: 'And also it is really hard to go from one shelf to the nex…',
  body: [
    'And also it is really hard to go from one shelf to the next one in the planner,',
    'I keep losing my place.',
    '',
    'Anyway. Make a ticket from this or multiple',
  ].join('\n'),
};

describe('triage shaping', () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;
  let base = '';

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A board with one goal band and nobody attached to it. */
  async function seedWorkspace(): Promise<string> {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-task-shaping-'));
    handle = await createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'shelf-planner', goal: 'Planning feels fast.' }),
    );
    await fetch(`${base}/api/workspaces/${workspace.id}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AGENT, goals: [{ id: 'g-flow', title: 'Navigation flow' }] }),
    });
    return workspace.id;
  }

  /** File exactly what quick-capture files: no goal, so it routes to triage. */
  async function capture(
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ task: Task; placement: { placed: boolean; triageDelivered: boolean } }> {
    return jj(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        author: PERSON,
        title: CAPTURE.title,
        body: CAPTURE.body,
        ...extra,
      }),
    );
  }

  const readTask = async (workspaceId: string, taskId: string): Promise<Task> => {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const found = tasks.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    return found as Task;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('lands the raw row untouched when nothing is there to shape it, and shapes the same row when something is', async () => {
    const wsId = await seedWorkspace();

    // ── The failure path. No attachment, so no triage request goes anywhere.
    const { task, placement } = await capture(wsId);
    expect(placement.triageDelivered).toBe(false);

    const raw = await readTask(wsId, task.id);
    // Byte-identical to what capture posted — not "close enough".
    expect(raw.title).toBe(CAPTURE.title);
    expect(raw.body).toBe(CAPTURE.body);
    // And it is still in the bucket somebody has to come back to, rather than
    // having been quietly declared placed by the absence of a shaper.
    expect(raw.triagedAgainst).toBeUndefined();
    expect(handle?.tasks.listUntriaged(wsId).map((t) => t.id)).toContain(task.id);

    // ── The positive control, same server, same row, same page: the ONLY
    // difference is that the shaping step now actually runs. If "unchanged"
    // above were an artefact of nothing being able to change this row, this
    // half would fail too.
    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: 'Moving between shelves loses your place',
        markdown:
          '**Robin** can move from one shelf to the next **so that** planning does not cost a re-orientation each time.\n\nDone when: the next shelf opens with the previous scroll position intact.',
      }),
    );
    const shaped = await readTask(wsId, task.id);
    expect(shaped.title).toBe('Moving between shelves loses your place');
    expect(shaped.title).not.toBe(CAPTURE.title);
    expect(shaped.body).toContain('Done when:');
    expect(shaped.body).not.toBe(CAPTURE.body);
  });

  it('preserves the row’s original words to quote on the first rewrite', async () => {
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);
    // Positive control: nothing is holding those words yet, so the assertion
    // below is about the rewrite rather than about a field that was always set.
    expect((await readTask(wsId, task.id)).quote).toBeUndefined();

    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: 'Moving between shelves loses your place',
        markdown: 'A story-shaped body that no longer contains the utterance.',
      }),
    );

    const shaped = await readTask(wsId, task.id);
    // The whole utterance, including the aside the shaper decided was not work.
    expect(shaped.quote).toBe(CAPTURE.body);
    expect(shaped.quote).toContain('Make a ticket from this or multiple');
    expect(shaped.body).not.toContain('Make a ticket from this or multiple');
  });

  it('falls back to the title when the row had no body to preserve', async () => {
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: PERSON,
        title: 'shelf jumping is annoying',
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: 'Moving between shelves loses your place',
        markdown: 'A real body.',
      }),
    );
    expect((await readTask(wsId, task.id)).quote).toBe('shelf jumping is annoying');
  });

  it('never overwrites a quote that is already there', async () => {
    const wsId = await seedWorkspace();
    // A dictated capture: the transcript is closer to the source than the
    // box's text, so it must survive the shaping that replaces the body.
    const spoken = 'moving between shelves in the planner keeps losing my place';
    const { task } = await capture(wsId, { quote: spoken });

    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: 'Moving between shelves loses your place',
        markdown: 'A story-shaped body.',
      }),
    );
    expect((await readTask(wsId, task.id)).quote).toBe(spoken);
  });

  it('does not claim a later rewrite’s replaced text as the origin', async () => {
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);

    await jj(
      await post(`/api/tasks/${task.id}/body`, { author: AGENT, markdown: 'First shaping.' }),
    );
    expect((await readTask(wsId, task.id)).quote).toBe(CAPTURE.body);

    // A second pass corrects the shaper's own words. Those are an edit, not
    // an origin, so the preserved capture must not be replaced by them.
    await jj(
      await post(`/api/tasks/${task.id}/body`, { author: AGENT, markdown: 'Second shaping.' }),
    );
    expect((await readTask(wsId, task.id)).quote).toBe(CAPTURE.body);
  });

  it('retitles inside the SAME act, and the event carries both names', async () => {
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);
    const events: TaskStoreEvent[] = [];
    const off = handle?.tasks.onEvent((e) => events.push(e));
    try {
      await jj(
        await post(`/api/tasks/${task.id}/body`, {
          author: AGENT,
          title: 'Moving between shelves loses your place',
          markdown: 'A story-shaped body.',
        }),
      );
    } finally {
      off?.();
    }
    const rows = events.filter((e) => e.type === 'task.body_edited');
    // ONE act, not a rename plus a rewrite: a reader of the trail should see
    // a single shaping, and the rename must not be the eventless /title route.
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<TaskStoreEvent, { type: 'task.body_edited' }>;
    expect(row.titleFrom).toBe(CAPTURE.title);
    expect(row.titleTo).toBe('Moving between shelves loses your place');
    expect(row.actor.name).toBe('Shelf Planner');
  });

  it('leaves the title alone when the rewrite does not name a new one', async () => {
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);
    const events: TaskStoreEvent[] = [];
    const off = handle?.tasks.onEvent((e) => events.push(e));
    try {
      await jj(await post(`/api/tasks/${task.id}/body`, { author: AGENT, markdown: 'Body only.' }));
    } finally {
      off?.();
    }
    expect((await readTask(wsId, task.id)).title).toBe(CAPTURE.title);
    const row = events.find((e) => e.type === 'task.body_edited');
    // Absent rather than echoed: a titleFrom equal to titleTo would make the
    // activity line announce a rename that never happened.
    expect(row && 'titleFrom' in row ? row.titleFrom : undefined).toBeUndefined();
  });

  it('reads a blank title as "leave it", never as "blank it"', async () => {
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);
    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: '   ',
        markdown: 'Body only.',
      }),
    );
    expect((await readTask(wsId, task.id)).title).toBe(CAPTURE.title);
  });

  it('reaches the board room, which is the only thing the browser reads', async () => {
    // The hub renders from `ws:<id>` and nothing else, so a shaped title the
    // projection never refreshes for is one no reviewer can see — and nothing
    // goes red, because the store, the route and the REST read are all
    // correct while the board keeps showing the clipped fragment. `/title`
    // has to hand-refresh because it emits nothing; this act emits, and this
    // asserts the subscriber actually acts on it.
    const wsId = await seedWorkspace();
    const { task } = await capture(wsId);
    const room = handle?.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room was not created');
    // Positive control: the room already carries the row, with the fragment.
    expect((room.ydoc.getMap('tasks').get(task.id) as { title: string }).title).toBe(CAPTURE.title);

    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        author: AGENT,
        title: 'Moving between shelves loses your place',
        markdown: 'A story-shaped body.',
      }),
    );
    const projected = room.ydoc.getMap('tasks').get(task.id) as { title: string; quote?: string };
    expect(projected.title).toBe('Moving between shelves loses your place');
    // …and the preserved words ride along, so the detail panel can show what
    // the row came from next to what it became.
    expect(projected.quote).toBe(CAPTURE.body);
  });
});
