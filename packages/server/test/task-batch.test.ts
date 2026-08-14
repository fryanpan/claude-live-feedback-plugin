/**
 * Batch capture: spam a burst of ideas in ONE call and get back assigned,
 * placed, ranked tasks.
 *
 * Tested through the REAL route, because everything this feature can get
 * wrong lives in the route layer: a batch endpoint that quietly drops
 * per-item `goal`/`order` (every task piled at the bottom of Chores), one
 * that forgets the owner rule the single-create route enforces, or one that
 * rejects the whole burst over a single bad row — the failure mode that makes
 * a capture tool useless, since re-sending means finding which of eight
 * already landed.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { GENERIC_ASSIGNEE } from '../src/task-owner.ts';
import type { Task } from '../src/tasks.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

interface BatchFailure {
  index: number;
  title?: string;
  error: string;
  message?: string;
}
interface BatchResult {
  workspaceId: string;
  tasks: Task[];
  failures: BatchFailure[];
}

describe('POST /api/workspaces/<id>/tasks/batch', () => {
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

  /** A workspace with two real goals, so placement is observable. */
  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const g = await fetch(`${base}/api/workspaces/${workspace.id}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goals: [
          {
            id: 'g-ship',
            title: '1. Ship',
            subgoals: [{ id: 'g-index', title: '1.1 Index' }],
          },
        ],
        author: AGENT,
      }),
    });
    expect(g.status).toBe(200);
    return workspace.id;
  }

  async function listTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-batch-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates every row in one call and returns them in board order', async () => {
    const wsId = await seedWorkspace();
    // Deliberately sent out of order: input order must not be the answer.
    const res = await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Third', goal: 'g-index', order: 3 },
          { title: 'First', goal: 'g-index', order: 1 },
          { title: 'Second', goal: 'g-index', order: 2 },
        ],
      }),
    );
    expect(res.failures).toEqual([]);
    expect(res.tasks.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
    // …and "board order" means the board's order, not a second sort of our
    // own that happens to agree today.
    const board = (await listTasks(wsId)).filter((t) => res.tasks.some((c) => c.id === t.id));
    expect(res.tasks.map((t) => t.id)).toEqual(board.map((t) => t.id));
  });

  it('lands every task assigned — the caller by default, the named owner when given', async () => {
    const wsId = await seedWorkspace();
    const res = await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Rebuild the index' },
          { title: 'Write the launch note', assignee: 'Jordan' },
          { title: 'Decide the cutover date', assignee: 'human' },
        ],
      }),
    );
    const stored = await listTasks(wsId);
    const owner = (title: string) => stored.find((t) => t.title === title)?.assignee;
    expect(owner('Rebuild the index')).toBe('Search Revamp');
    expect(owner('Write the launch note')).toBe('Jordan');
    expect(owner('Decide the cutover date')).toBe('human');
    expect(res.tasks).toHaveLength(3);
  });

  it('refuses the rows that name nobody, and only those rows', async () => {
    const wsId = await seedWorkspace();
    const res = await jj<BatchResult>(
      // No `author`: the only owner a row can have is the one it names.
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        tasks: [
          { title: 'Nobody owns me' },
          { title: 'Jordan owns me', assignee: 'Jordan' },
          { title: 'A category owns me', assignee: GENERIC_ASSIGNEE },
        ],
      }),
    );
    expect(res.failures.map((f) => f.index)).toEqual([0, 2]);
    expect(res.failures[0]?.error).toBe('assignee-required');
    // The refusal has to say how to satisfy it, per row.
    expect(res.failures[0]?.message).toContain('FEEDBACK_AGENT_NAME');
    // Positive control: the owned row landed anyway — one bad row does not
    // reject the batch.
    const titles = (await listTasks(wsId)).map((t) => t.title);
    expect(titles).toEqual(['Jordan owns me']);
  });

  it('honours per-row placement instead of piling the batch into Chores', async () => {
    const wsId = await seedWorkspace();
    await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Placed on a goal', goal: 'g-index', order: 7 },
          { title: 'Placed on its parent', goal: 'g-ship' },
          // The other direction: an unplaced row still rests in Chores, the
          // way a single create does.
          { title: 'Unplaced' },
        ],
      }),
    );
    const stored = await listTasks(wsId);
    const at = (title: string) => stored.find((t) => t.title === title);
    expect(at('Placed on a goal')?.goal).toBe('g-index');
    expect(at('Placed on a goal')?.order).toBe(7);
    expect(at('Placed on its parent')?.goal).toBe('g-ship');
    expect(at('Unplaced')?.goal).toBe('chores');
  });

  it('reports a malformed row per item and still lands the rest', async () => {
    const wsId = await seedWorkspace();
    const res = await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Good row one' },
          { title: '   ' },
          { title: 'Bad needs', needs: 'Decision' },
          { title: 'Good row two' },
        ],
      }),
    );
    expect(res.tasks.map((t) => t.title)).toEqual(['Good row one', 'Good row two']);
    expect(res.failures.map((f) => f.index)).toEqual([1, 2]);
    expect(res.failures[1]?.title).toBe('Bad needs');
    const titles = (await listTasks(wsId)).map((t) => t.title);
    expect(titles.sort()).toEqual(['Good row one', 'Good row two']);
  });

  it('refuses an oversized batch outright rather than keeping the first N', async () => {
    const wsId = await seedWorkspace();
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `Idea ${i}`, goal: 'g-index' }));
    const over = await post(`/api/workspaces/${wsId}/tasks/batch`, {
      author: AGENT,
      tasks: rows(101),
    });
    expect(over.status).toBe(400);
    const body = (await over.json()) as { error: string; message?: string };
    expect(body.error).toBe('too-many-tasks');
    // A silent truncation would report success for rows that don't exist, so
    // the refusal has to leave the board untouched.
    expect(await listTasks(wsId)).toHaveLength(0);
    // Positive control at the boundary: the largest allowed batch lands whole.
    const at = await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, { author: AGENT, tasks: rows(100) }),
    );
    expect(at.tasks).toHaveLength(100);
    expect(at.failures).toEqual([]);
  });

  it('400s an empty or malformed batch, and 404s an unknown workspace', async () => {
    const wsId = await seedWorkspace();
    expect((await post(`/api/workspaces/${wsId}/tasks/batch`, { tasks: [] })).status).toBe(400);
    expect((await post(`/api/workspaces/${wsId}/tasks/batch`, { tasks: 'nope' })).status).toBe(400);
    const missing = await post('/api/workspaces/w-does-not-exist/tasks/batch', {
      author: AGENT,
      tasks: [{ title: 'Orphan' }],
    });
    expect(missing.status).toBe(404);
  });
});
