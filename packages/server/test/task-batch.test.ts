/**
 * Batch capture: spam a burst of ideas in ONE call and get back assigned,
 * placed, ranked tasks.
 *
 * Tested through the REAL route, because everything this feature can get
 * wrong lives in the route layer: a batch endpoint that quietly drops
 * per-item `goal`/`order` (every task piled at the bottom of Backlog), one
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
import { type GoalIds, seedGoalsOverHttp } from './goal-seed.ts';

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

  /** A workspace with two real goals, so placement is observable. The ids are
   *  minted by the server; `G.ship` / `G.index` are what this file used to
   *  hard-code as `g-ship` / `g-index`. */
  async function seedWorkspace(): Promise<{ wsId: string; G: GoalIds }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = await seedGoalsOverHttp(
      base,
      workspace.id,
      [
        { key: 'ship', title: '1. Ship' },
        { key: 'index', title: '2. Index' },
      ],
      AGENT,
    );
    return { wsId: workspace.id, G };
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
    const { wsId, G } = await seedWorkspace();
    // Deliberately sent out of order: input order must not be the answer.
    const res = await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Third', goal: G.index, order: 3 },
          { title: 'First', goal: G.index, order: 1 },
          { title: 'Second', goal: G.index, order: 2 },
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
    const { wsId } = await seedWorkspace();
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
    const { wsId } = await seedWorkspace();
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
    expect(res.failures[0]?.message).toContain('CW_AGENT_NAME');
    // Positive control: the owned row landed anyway — one bad row does not
    // reject the batch.
    const titles = (await listTasks(wsId)).map((t) => t.title);
    expect(titles).toEqual(['Jordan owns me']);
  });

  it('honours per-row placement instead of piling the batch into Backlog', async () => {
    const { wsId, G } = await seedWorkspace();
    await jj<BatchResult>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Placed on a goal', goal: G.index, order: 7 },
          { title: 'Placed on its parent', goal: G.ship },
          // The other direction: an unplaced row still rests in Backlog, the
          // way a single create does.
          { title: 'Unplaced' },
        ],
      }),
    );
    const stored = await listTasks(wsId);
    const at = (title: string) => stored.find((t) => t.title === title);
    expect(at('Placed on a goal')?.goal).toBe(G.index);
    expect(at('Placed on a goal')?.order).toBe(7);
    expect(at('Placed on its parent')?.goal).toBe(G.ship);
    expect(at('Unplaced')?.goal).toBe('chores');
  });

  it('reports a malformed row per item and still lands the rest', async () => {
    const { wsId } = await seedWorkspace();
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
    const { wsId, G } = await seedWorkspace();
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ title: `Idea ${i}`, goal: G.index }));
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

  /**
   * Dependencies between rows of one batch, through the REAL route.
   *
   * The pure decisions are covered in task-batch-refs.test.ts. What only the
   * route can prove is that the resolved ids reach the STORE — the layer
   * nothing type-checks, and the one where a param has twice been accepted
   * and discarded in this repo.
   */
  describe('a row can depend on another row of the same batch', () => {
    it('wires an edge by key and by index, and the store agrees it is an edge', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            { title: 'Rebuild the index', goal: G.index, key: 'reindex' },
            { title: 'Flip the read path', goal: G.index, after: ['#reindex'] },
            { title: 'Delete the old path', goal: G.index, after: [0, 1] },
          ],
        }),
      );
      expect(res.failures).toEqual([]);
      const stored = await listTasks(wsId);
      const at = (title: string) => stored.find((t) => t.title === title);
      const seed = at('Rebuild the index');
      const flip = at('Flip the read path');
      expect(seed?.id).toBeTruthy();
      // The whole point: a real id, not the reference the caller sent.
      expect(flip?.after).toEqual([seed?.id as string]);
      expect(at('Delete the old path')?.after).toEqual([seed?.id as string, flip?.id as string]);
    });

    // Batch-local refs give one edge two spellings — `"#seed"` and the index
    // of the row that declared it are the same row — so a caller can now write
    // the same dependency twice WITHOUT repeating themselves, which is not
    // true of a hand-written id list. Undeduped, it reaches `openBlockers` as
    // two visits to one task and the reader is told twice that it is blocked
    // by the same thing. `setTaskDependencies` has always deduped; creation
    // did not, and this feature is what makes the gap reachable by accident.
    it('collapses two spellings of ONE edge, rather than blocking twice on it', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            { title: 'Warm the cache', goal: G.index, key: 'warm' },
            {
              title: 'Serve from cache',
              goal: G.index,
              after: ['#warm', 0],
              afterEnforce: [0, '#warm'],
            },
          ],
        }),
      );
      expect(res.failures).toEqual([]);
      const stored = await listTasks(wsId);
      const warm = stored.find((t) => t.title === 'Warm the cache');
      const serve = stored.find((t) => t.title === 'Serve from cache');
      expect(serve?.after).toEqual([warm?.id as string]);
      expect(serve?.afterEnforce).toEqual([warm?.id as string]);
      // The surface a person reads: one blocker, named once.
      const blocked = await post(`/api/tasks/${serve?.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(blocked.status).toBe(409);
      const body = (await blocked.json()) as { blockers: Array<{ taskId: string }> };
      expect(body.blockers.map((b) => b.taskId)).toEqual([warm?.id as string]);
    });

    it('carries afterEnforce through the same resolution, so the subset rule holds', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            { title: 'Decide the cutover', goal: G.index, key: 'cutover' },
            {
              title: 'Run the cutover',
              goal: G.index,
              after: ['#cutover'],
              afterEnforce: ['#cutover'],
            },
          ],
        }),
      );
      // Resolved apart, these two spellings would come out as different
      // strings and the store would answer unknown-after-enforce.
      expect(res.failures).toEqual([]);
      const stored = await listTasks(wsId);
      const decide = stored.find((t) => t.title === 'Decide the cutover');
      const run = stored.find((t) => t.title === 'Run the cutover');
      expect(run?.afterEnforce).toEqual([decide?.id as string]);
    });

    it('still accepts a task id the caller already holds', async () => {
      // Positive control for the negative cases below: an entry with no sigil
      // is an id, and that path is untouched.
      const { wsId, G } = await seedWorkspace();
      const first = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [{ title: 'Earlier work', goal: G.index }],
        }),
      );
      const held = first.tasks[0]?.id as string;
      const second = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [{ title: 'Later work', goal: G.index, after: [held] }],
        }),
      );
      expect(second.failures).toEqual([]);
      expect(second.tasks[0]?.after).toEqual([held]);
    });

    it('fails the dependent row when the row it depends on failed', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            { title: '   ', goal: G.index, key: 'seed' }, // refused: no title
            { title: 'Depends on the row that failed', goal: G.index, after: ['#seed'] },
            { title: 'Independent', goal: G.index },
          ],
        }),
      );
      expect(res.failures.map((f) => f.index)).toEqual([0, 1]);
      expect(res.failures[1]?.error).toBe('batch-dep-row-failed');
      // Creating it with the edge dropped is the failure this prevents: the
      // task would look blocked-free and nothing would ever say otherwise.
      const titles = (await listTasks(wsId)).map((t) => t.title);
      expect(titles).toEqual(['Independent']);
    });

    it('refuses a forward reference, a bad key, and an unknown key — by row', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await jj<BatchResult>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            { title: 'Points at a later row', goal: G.index, after: [2] },
            { title: 'Key is all digits', goal: G.index, key: '12' },
            { title: 'Names a key nobody declared', goal: G.index, after: ['#ghost'] },
            { title: 'Fine', goal: G.index },
          ],
        }),
      );
      expect(res.failures.map((f) => f.error)).toEqual([
        'forward-batch-ref',
        'bad-batch-key',
        'unknown-batch-ref',
      ]);
      expect(res.failures.map((f) => f.index)).toEqual([0, 1, 2]);
      // Every refusal carries a message the caller can act on without
      // reading the source.
      for (const f of res.failures) expect(f.message?.length ?? 0).toBeGreaterThan(0);
      expect((await listTasks(wsId)).map((t) => t.title)).toEqual(['Fine']);
    });

    it('refuses a batch-local reference on the SINGLE-create route, by name', async () => {
      // There is no batch here, so `#seed` can never resolve. Passing it
      // through as a task id answers `unknown-after`, which sends the caller
      // looking for a task that was never the problem.
      const { wsId } = await seedWorkspace();
      const res = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Lone task',
        after: ['#seed'],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message?: string };
      expect(body.error).toBe('batch-ref-outside-batch');
      expect(body.message).toContain('create_tasks');
      expect(await listTasks(wsId)).toHaveLength(0);
    });
  });

  it('400s an empty or malformed batch, and 404s an unknown workspace', async () => {
    const { wsId } = await seedWorkspace();
    expect((await post(`/api/workspaces/${wsId}/tasks/batch`, { tasks: [] })).status).toBe(400);
    expect((await post(`/api/workspaces/${wsId}/tasks/batch`, { tasks: 'nope' })).status).toBe(400);
    const missing = await post('/api/workspaces/w-does-not-exist/tasks/batch', {
      author: AGENT,
      tasks: [{ title: 'Orphan' }],
    });
    expect(missing.status).toBe(404);
  });
});
