/**
 * The description advisory, through the REAL routes.
 *
 * Same reasoning as `task-title-gate.test.ts` one field over: `task.body` has
 * exactly one assignment site (`tasks.ts`, inside `updateBodySnapshot`) but
 * several doors above it, and the door a route-level guard would miss is
 * `POST /api/docs/task:<id>/content`. So the rewrite cases drive that one
 * deliberately.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const GOOD_TITLE = 'Agents can rank a backlog by reading the goal order first';

const STORY_BODY = [
  'Agents can rank a backlog by reading the goal order first so that the top of',
  'the queue is the work that matters most.',
  '',
  'Done when: next_tasks returns rows in goal order.',
].join('\n');

/** A status report. Says what happened, never who it is for. */
const REPORT_BODY = [
  'Round 5 delivered: 133 candidates ranked and appended to the doc with a',
  'thread reply. The shortlist collapses to two options.',
].join('\n');

/**
 * A decision task. Measured on a real board 2026-08-17: four open rows are
 * shaped exactly like this, and a story-only rule flags every one of them.
 */
const DECISION_BODY = [
  '**Should the API refuse a task that names no goal, or file it under chores?**',
  '',
  'Refusing is honest and blocks capture. Filing is silent and loses intent.',
].join('\n');

describe('task description advisory', () => {
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

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'bodies', goal: 'Make the board scannable.' }),
    );
    return workspace.id;
  }
  async function createTask(
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ task: Task; bodyGaps?: string[]; bodyMessage?: string }> {
    return jj(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: GOOD_TITLE,
        assignee: 'Jordan',
        author: PERSON,
        goal: 'chores',
        body: STORY_BODY,
        ...extra,
      }),
    );
  }
  async function readTask(
    workspaceId: string,
    taskId: string,
  ): Promise<Task & { bodyGaps?: string[] }> {
    const { tasks } = await jj<{ tasks: Array<Task & { bodyGaps?: string[] }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const row = tasks.find((t) => t.id === taskId);
    expect(row, `task ${taskId} missing from the list route`).toBeDefined();
    return row as Task & { bodyGaps?: string[] };
  }
  /** The door that skips `update_task_body` entirely. */
  const rewriteViaDocRoute = (taskId: string, markdown: string) =>
    post(`/api/docs/task:${taskId}/content`, { markdown, author: PERSON });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-body-gate-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('create is advised, never refused', () => {
    it('creates the task anyway and names the description gap', async () => {
      const wsId = await seedWorkspace();
      const res = await createTask(wsId, { body: REPORT_BODY });
      expect(res.task.id.length).toBeGreaterThan(0);
      expect(res.bodyGaps).toContain('no-story');
      expect(res.bodyMessage).toBeTruthy();
      // The write really landed — the advisory did not cost the capture.
      expect((await readTask(wsId, res.task.id)).body).toContain('Round 5 delivered');
    });

    it('a description that meets the standard carries no advisory at all', async () => {
      // Positive control for every absence in this file: the same route, the
      // same shape, must be capable of returning a clean answer.
      const wsId = await seedWorkspace();
      const res = await createTask(wsId);
      expect(res.bodyGaps).toBeUndefined();
      expect(res.bodyMessage).toBeUndefined();
    });

    it('a decision task that opens with its question is NOT flagged', async () => {
      // The measured false-positive class, asserted at the route rather than
      // only in the unit test, because the route is what a caller sees.
      const wsId = await seedWorkspace();
      const res = await createTask(wsId, { body: DECISION_BODY });
      expect(res.bodyGaps).toBeUndefined();
      // Non-vacuity: this fixture really did reach the store, so the silence
      // above is the genre being recognised rather than the body never
      // arriving.
      expect((await readTask(wsId, res.task.id)).body).toContain('names no goal');
    });
  });

  describe('the advisory follows the body through every door', () => {
    it('clears once a rewrite through the doc route adds the story', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId, { body: REPORT_BODY });
      expect((await readTask(wsId, task.id)).bodyGaps).toContain('no-story');

      expect((await rewriteViaDocRoute(task.id, STORY_BODY)).ok).toBe(true);
      const after = await readTask(wsId, task.id);
      expect(after.bodyGaps).toBeUndefined();
      expect(after.body).toContain('so that');
    });

    it('appears when a rewrite REMOVES the story, on the same door', async () => {
      // The other direction. A gap that can only ever clear would pass a
      // one-way test while being computed from nothing at all.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      expect((await readTask(wsId, task.id)).bodyGaps).toBeUndefined();

      expect((await rewriteViaDocRoute(task.id, REPORT_BODY)).ok).toBe(true);
      expect((await readTask(wsId, task.id)).bodyGaps).toContain('no-story');
    });

    it('the batch route reports description gaps per row, by id', async () => {
      const wsId = await seedWorkspace();
      const res = await jj<{
        tasks: Task[];
        bodyGaps?: Array<{ taskId: string; gaps: string[] }>;
      }>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: PERSON,
          tasks: [
            { title: GOOD_TITLE, assignee: 'Jordan', goal: 'chores', body: STORY_BODY },
            { title: GOOD_TITLE, assignee: 'Jordan', goal: 'chores', body: REPORT_BODY },
          ],
        }),
      );
      expect(res.tasks.length).toBe(2);
      const rows = res.bodyGaps ?? [];
      // Exactly the second row — a total would leave the caller diffing to
      // find which of the batch needs work.
      expect(rows.length).toBe(1);
      expect(rows[0]?.taskId).toBe(res.tasks[1]?.id);
      expect(rows[0]?.gaps).toContain('no-story');
    });
  });
});
