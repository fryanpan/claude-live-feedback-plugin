/**
 * Parking is triage plus a comment (board ticket, 2026-08-27).
 *
 * The `parked` state duplicated triage — a row nobody is working, that nobody
 * has agreed is work yet — while costing a field on every task, a hold reason
 * in the ready gate, a bucket in the keep-moving report, a badge and a panel
 * control on the board, and a rule in two skills. The owner's call was to
 * delete the state and keep the VERB: `park_task` moves the row to triage and
 * writes a comment recording why and when to come back to it.
 *
 * `POST /api/tasks/:id/park` keeps its old payload because the shared server's
 * REST callers cannot be restarted (CLAUDE.md: narrowing a verb keeps
 * accepting the old shape). What changed is what the payload MEANS, so every
 * arm of it is asserted end-to-end here — over HTTP, reading the stored row
 * and the stored comment back, never the response echo.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, User } from '@feedback/core';

import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { type GoalIds, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

/** 2026-09-02, the date the old park fixtures used. */
const UNTIL = Date.UTC(2026, 8, 2, 19, 0, 0);

describe('park_task moves a row to triage and comments', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

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

  async function seedWorkspace(): Promise<{ wsId: string; G: GoalIds }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = await seedGoalsOverHttp(
      base,
      workspace.id,
      [{ key: 'g1', title: '1. Get the PR out' }],
      PERSON,
    );
    return { wsId: workspace.id, G };
  }

  /** A row in `todo` — the state a park actually has somewhere to move it
   *  FROM. An agent-filed row lands in triage, which would make every "it
   *  moved" assertion below pass vacuously. */
  async function seedTodoTask(workspaceId: string, goal: string): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal,
      }),
    );
    await jj(await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON }));
    return task;
  }

  async function getTask(workspaceId: string, taskId: string): Promise<Task> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const found = tasks.find((t) => t.id === taskId);
    expect(found, `no such task: ${taskId}`).toBeDefined();
    return found as Task;
  }

  /** Every comment on the task's own body doc, oldest first. */
  async function taskComments(taskId: string): Promise<string[]> {
    const { threads } = await jj<{ threads: Thread[] }>(
      await fetch(`${base}/api/docs/${encodeURIComponent(`task:${taskId}`)}/threads`),
    );
    return threads.flatMap((t) => t.comments.map((c) => c.text));
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'park-triage-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('moves a todo row to triage and records the reason and revisit date in a comment', async () => {
    const { wsId, G } = await seedWorkspace();
    const task = await seedTodoTask(wsId, G.g1);
    // Controls: the row is somewhere a park can move it from, and its
    // discussion is empty, so the comment asserted below cannot be a leftover.
    expect((await getTask(wsId, task.id)).status).toBe('todo');
    expect(await taskComments(task.id)).toEqual([]);

    const res = await jj<{ ok: true; task: Task; changed: boolean; commented: boolean }>(
      await post(`/api/tasks/${task.id}/park`, {
        parkedUntil: UNTIL,
        reason: 'waiting on the index rebuild',
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(true);
    expect(res.commented).toBe(true);

    const stored = await getTask(wsId, task.id);
    expect(stored.status).toBe('triage');
    // The state is GONE, not merely unset by this call — nothing writes it.
    expect('parkedUntil' in stored).toBe(false);
    expect('parkedReason' in stored).toBe(false);

    const comments = await taskComments(task.id);
    expect(comments.length).toBe(1);
    const note = comments[0] as string;
    // The two halves a later reader acts on: WHEN to come back, and WHY.
    expect(note).toContain('2026-09-02');
    expect(note).toContain('waiting on the index rebuild');
    // And the trail says the row moved, so "why is this in triage" is
    // answerable from the row alone.
    expect(stored.transitions.at(-1)).toMatchObject({ from: 'todo', to: 'triage' });
  });

  it('parks without a revisit date when the date is omitted entirely', async () => {
    const { wsId, G } = await seedWorkspace();
    const task = await seedTodoTask(wsId, G.g1);
    const res = await jj<{ task: Task; changed: boolean; commented: boolean }>(
      await post(`/api/tasks/${task.id}/park`, {
        reason: 'below the main flow until goal 1 closes',
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(true);
    expect((await getTask(wsId, task.id)).status).toBe('triage');
    const note = (await taskComments(task.id))[0] as string;
    expect(note).toContain('below the main flow until goal 1 closes');
    // No date, and it says so rather than printing an invented one.
    expect(note).toContain('No revisit date');
    expect(note).not.toContain('NaN');
    expect(note).not.toContain('Invalid');
  });

  it('still comments on a row already in triage, and says the status did not move', async () => {
    const { wsId, G } = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal: G.g1,
      }),
    );
    expect(task.status).toBe('triage'); // control: already where a park lands
    const res = await jj<{ changed: boolean; commented: boolean }>(
      await post(`/api/tasks/${task.id}/park`, {
        parkedUntil: UNTIL,
        reason: 'still waiting on the index rebuild',
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(false);
    // The comment is the whole point of the verb now, so it lands either way.
    expect(res.commented).toBe(true);
    expect((await taskComments(task.id))[0]).toContain('still waiting on the index rebuild');
  });

  it('accepts the retired un-park payload, and moves nothing', async () => {
    const { wsId, G } = await seedWorkspace();
    const task = await seedTodoTask(wsId, G.g1);
    const res = await jj<{ ok: true; changed: boolean; commented: boolean; message?: string }>(
      await post(`/api/tasks/${task.id}/park`, { parkedUntil: null, author: PERSON }),
    );
    expect(res.changed).toBe(false);
    expect(res.commented).toBe(false);
    // An old bundle's un-park must not push a live row back into triage.
    expect((await getTask(wsId, task.id)).status).toBe('todo');
    expect(await taskComments(task.id)).toEqual([]);
    expect(res.message ?? '').toContain('triage');
  });

  it('refuses an unparseable date, a missing author, and an unknown task', async () => {
    const { wsId, G } = await seedWorkspace();
    const task = await seedTodoTask(wsId, G.g1);
    for (const bad of ['2026-09-02', {}, true, 'null']) {
      const r = await post(`/api/tasks/${task.id}/park`, { parkedUntil: bad, author: PERSON });
      expect(r.status, `parkedUntil: ${JSON.stringify(bad)}`).toBe(400);
    }
    // Nothing was written by any of those refusals.
    expect((await getTask(wsId, task.id)).status).toBe('todo');
    expect((await post(`/api/tasks/${task.id}/park`, { parkedUntil: UNTIL })).status).toBe(400);
    expect(
      (await post('/api/tasks/t-missing/park', { parkedUntil: UNTIL, author: PERSON })).status,
    ).toBe(404);
  });
});

/**
 * The migration for rows that were already parked when the state went away.
 *
 * Written against a sidecar on disk rather than against the store's API,
 * because that is the only shape the old state still exists in: nothing can
 * write `parkedUntil` any more, so a fixture that called a setter would be
 * testing a path that cannot occur. The file below is what a real board's
 * `.tasks.json` looked like the moment before this change shipped.
 */
describe('rows still carrying the removed parked state', () => {
  let dataDir: string;

  const seedSidecar = (rows: Array<Record<string, unknown>>): void => {
    const wsDir = join(dataDir, 'workspaces');
    mkdirSync(wsDir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(wsDir, 'w-legacy.tasks.json'),
      `${JSON.stringify({
        workspace: {
          id: 'w-legacy',
          name: 'legacy',
          goal: 'Ship search v2.',
          goals: [],
          docIds: [],
          createdAt: now,
          updatedAt: now,
        },
        tasks: rows.map((r) => ({
          workspaceId: 'w-legacy',
          title: 'tune the ranking',
          body: '',
          assignee: 'agent-search-revamp',
          goal: 'chores',
          order: 1,
          after: [],
          links: [],
          transitions: [],
          createdAt: now,
          updatedAt: now,
          ...r,
        })),
        goalRows: [],
      })}\n`,
    );
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'park-migrate-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('moves them to triage, writes the date and reason into a comment, and clears the fields', async () => {
    seedSidecar([
      {
        id: 't-legacy-dated',
        status: 'todo',
        parkedUntil: Date.UTC(2026, 7, 28),
        parkedReason: 'Re-parked after un-parking prematurely — the reload path is still refused',
      },
      { id: 't-legacy-bare', status: 'todo', parkedReason: 'below the main flow' },
      { id: 't-never-parked', status: 'todo' },
    ]);
    const handle = createServer({ port: 0, dataDir });
    const at = `http://localhost:${handle.port}`;
    try {
      const res = await handle.parkMigration;
      expect(res.skipped).toEqual([]);
      // The untouched row is the control: a migration that swept every row
      // would pass a bare count assertion.
      expect(res.migrated.map((m) => m.taskId).sort()).toEqual(['t-legacy-bare', 't-legacy-dated']);

      const { tasks } = (await (await fetch(`${at}/api/workspaces/w-legacy/tasks`)).json()) as {
        tasks: Array<Record<string, unknown>>;
      };
      const byId = new Map(tasks.map((t) => [t.id as string, t]));
      expect(byId.get('t-legacy-dated')?.status).toBe('triage');
      expect(byId.get('t-legacy-bare')?.status).toBe('triage');
      expect(byId.get('t-never-parked')?.status).toBe('todo'); // control
      // The state is gone from the row — and it is gone because it moved, not
      // because it was dropped. The comment below is where it went.
      expect('parkedUntil' in (byId.get('t-legacy-dated') as object)).toBe(false);
      expect('parkedReason' in (byId.get('t-legacy-dated') as object)).toBe(false);

      const { threads } = (await (
        await fetch(`${at}/api/docs/${encodeURIComponent('task:t-legacy-dated')}/threads`)
      ).json()) as { threads: Thread[] };
      const note = threads.flatMap((t) => t.comments.map((c) => c.text)).join('\n');
      // The date this row comes back is the thing a reader must not lose.
      expect(note).toContain('2026-08-28');
      expect(note).toContain('Re-parked after un-parking prematurely');
      expect(note).toContain('Moved from todo');
    } finally {
      await handle.stop();
    }
  });

  it('does nothing on a second start — the fields it reads are the ones it cleared', async () => {
    const handle = createServer({ port: 0, dataDir });
    try {
      const res = await handle.parkMigration;
      expect(res.migrated).toEqual([]);
      expect(res.skipped).toEqual([]);
      // And it did not comment again: a migration that re-ran would double
      // every note on the board at every restart.
      const { threads } = (await (
        await fetch(
          `http://localhost:${handle.port}/api/docs/${encodeURIComponent('task:t-legacy-dated')}/threads`,
        )
      ).json()) as { threads: Thread[] };
      expect(threads.flatMap((t) => t.comments).length).toBe(1);
    } finally {
      await handle.stop();
    }
  });
});
