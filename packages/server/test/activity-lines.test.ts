/**
 * The activity view (§3.9) reads events.jsonl — so its renderer has to be
 * fed the rows the SERVER actually writes, not hand-written fixtures.
 *
 * This is the "a unit test can be true and still prove nothing about the
 * caller" lesson applied to the audit log: `describeEvent`'s own suite
 * invents shapes (a `decision.answered` with no answer at all), and under
 * those the renderer silently dropped every verbatim decision answer —
 * reading `ev.answer.text` where the emitted row carries a plain string.
 * "Decisions keep the words" failed on the one surface built to review them.
 *
 * So: drive the real routes, read the real log back, and render THOSE rows
 * with the real client model. `hub-model.ts` is pure (no DOM, no fetch), so
 * a server test can import it directly.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ActivityEvent, describeEvent } from '../../markdown-app/src/hub/hub-model.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Task, eventsLogPath } from '../src/tasks.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

describe('the activity view renders the rows the server really wrote', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  let decisionId: string;

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

  /** Every audit row, as the activity view reads them. */
  const rows = (): ActivityEvent[] => {
    const path = eventsLogPath(dataDir, wsId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ActivityEvent);
  };
  const rowsOf = (event: string): ActivityEvent[] => rows().filter((r) => r.event === event);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'activity-lines-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const ws = await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship the search.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const d = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Ship Thursday or Friday?',
      assignee: 'human',
      needs: 'decision',
      body: 'Thursday or Friday? Friday buys one more review pass and misses the demo. Blocked until answered: the release note.',
      author: AGENT,
    });
    expect(d.status).toBe(200);
    decisionId = ((await d.json()) as { task: Task }).task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the words of a decision answer', async () => {
    const r = await post(`/api/tasks/${decisionId}/answer`, {
      text: 'Ship Friday, not Thursday.',
      author: PERSON,
    });
    expect(r.status).toBe(200);

    const row = rowsOf('decision.answered').at(-1);
    expect(row).toBeDefined();
    const line = describeEvent(row as ActivityEvent, () => 'Ship Thursday or Friday?');
    // Positive control: the row renders at all, with actor and title…
    expect(line).toContain('Jordan');
    expect(line).toContain('Ship Thursday or Friday?');
    // …and the verbatim answer is the point of the row.
    expect(line).toContain('Ship Friday, not Thursday.');
  });

  it('attributes task.created, so an author can be told from a stranger', async () => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Wire the index',
      author: AGENT,
    });
    expect(r.status).toBe(200);
    const row = rowsOf('task.created').at(-1);
    expect((row?.actor as { id?: string; name?: string } | undefined)?.id).toBe(
      'agent-search-revamp',
    );
    expect(describeEvent(row as ActivityEvent, () => 'Wire the index')).toContain('Search Revamp');
  });

  it('renders a description rewrite with the actor and the task, from the row the route wrote', async () => {
    // describeEvent's own suite hands it a hand-written row, so it proves
    // the switch has a case — not that the emitted row carries the keys the
    // case reads. That gap is the whole reason this file exists.
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Tune the ranking',
      author: AGENT,
      body: 'thin.',
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;

    const r = await post(`/api/tasks/${taskId}/body`, {
      markdown: 'Agent can rewrite a thin task so that the next reader knows when it is done.',
      author: AGENT,
    });
    expect(r.status).toBe(200);

    const row = rowsOf('task.body_edited').at(-1);
    expect(row).toBeDefined();
    const line = describeEvent(row as ActivityEvent, (id) =>
      id === taskId ? 'Tune the ranking' : id,
    );
    expect(line).toContain('Search Revamp');
    expect(line).toContain('Tune the ranking');
    expect(line).not.toContain('task.body_edited');
  });

  it('renders a due date from the row the /due route wrote, and names the day', async () => {
    // `task.due_set` is emitted by a route that did not exist until this
    // change, and the client case reads `from` / `to` by name. The unit test
    // proves the case exists; only this proves the emitted row carries the
    // keys it reads — and that the ROUTE forwarded the date at all, which is
    // the layer nothing type-checks.
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Cut the release note',
      author: AGENT,
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;
    // Local noon, so the rendered day is the same in every timezone.
    const due = new Date(2026, 8, 2, 12).getTime();

    expect((await post(`/api/tasks/${taskId}/due`, { dueAt: due, author: PERSON })).status).toBe(
      200,
    );
    const set = rowsOf('task.due_set').at(-1);
    expect(set).toBeDefined();
    const line = describeEvent(set as ActivityEvent, () => 'Cut the release note');
    expect(line).toContain('Jordan');
    expect(line).toContain('Cut the release note');
    expect(line).toContain(new Date(due).toLocaleDateString());
    expect(line).not.toContain('task.due_set');

    // And the clear, which is a different sentence — a row that read "set due"
    // with no date would be worse than the slug.
    expect((await post(`/api/tasks/${taskId}/due`, { dueAt: null, author: PERSON })).status).toBe(
      200,
    );
    const cleared = describeEvent(
      rowsOf('task.due_set').at(-1) as ActivityEvent,
      () => 'Cut the release note',
    );
    expect(cleared).toContain('cleared');
    expect(cleared).not.toContain(new Date(due).toLocaleDateString());
  });

  it('renders a SHAPING with both titles, from the row the route wrote', async () => {
    // Two keys are new on this event (`titleFrom` / `titleTo`) and the client
    // case reads them by name. describeEvent's own suite hands it a
    // hand-written row, which proves the case exists and nothing about
    // whether the route emits those keys — the exact gap this file is for.
    const clipped = 'And also it is really hard to go from one shel…';
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: clipped,
      author: AGENT,
      body: `${clipped}\n\nAnyway. Make a ticket from this or multiple`,
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;

    const r = await post(`/api/tasks/${taskId}/body`, {
      title: 'Moving between shelves loses your place',
      markdown: 'Person can move between shelves so that planning keeps its place.',
      author: AGENT,
    });
    expect(r.status).toBe(200);

    const row = rowsOf('task.body_edited').at(-1);
    expect(row).toBeDefined();
    const line = describeEvent(row as ActivityEvent, () => 'unused');
    expect(line).toContain('Search Revamp');
    expect(line).toContain(clipped);
    expect(line).toContain('Moving between shelves loses your place');
  });

  it('carries the rewrite REASON through the /body route into the rendered line', async () => {
    // The route layer hand-copies body fields into the store call, and the
    // route is the layer nothing type-checks — a dropped `reason` returns
    // 200 and discards it silently. So: real route, real log, real renderer.
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Index the archive',
      author: AGENT,
      body: 'thin.',
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;

    const r = await post(`/api/tasks/${taskId}/body`, {
      markdown: 'Agent can find archived rows so that history stays searchable.',
      author: AGENT,
      reason: 'the body did not say when the work is done',
    });
    expect(r.status).toBe(200);

    const row = rowsOf('task.body_edited').at(-1);
    expect(row?.reason).toBe('the body did not say when the work is done');
    const line = describeEvent(row as ActivityEvent, () => 'Index the archive');
    expect(line).toContain('the body did not say when the work is done');
  });

  it('a title-only rename writes an attributed task.retitled row that renders with BOTH names', async () => {
    // Renames used to emit nothing at all, so this event is new twice over:
    // the route must emit it and the client must have a case for it —
    // "a new emitted event reaches the surface as a bare slug" otherwise.
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'fix the thing with the search',
      author: PERSON,
      body: 'Person can find results so that search earns its keep.',
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;

    const r = await post(`/api/tasks/${taskId}/title`, {
      title: 'Person can find results by relevance so that search earns its keep',
      author: AGENT,
      reason: 'named the outcome instead of the artifact',
    });
    expect(r.status).toBe(200);

    const row = rowsOf('task.retitled').at(-1);
    expect(row).toBeDefined();
    expect((row?.actor as { id?: string } | undefined)?.id).toBe('agent-search-revamp');
    expect(row?.titleFrom).toBe('fix the thing with the search');
    expect(row?.titleTo).toBe('Person can find results by relevance so that search earns its keep');
    const line = describeEvent(row as ActivityEvent, () => 'unused');
    // The OLD name is the only one the filer would recognise.
    expect(line).toContain('fix the thing with the search');
    expect(line).toContain('Person can find results by relevance');
    expect(line).toContain('named the outcome instead of the artifact');
    expect(line).not.toContain('task.retitled');
  });

  it('a no-op rename (same title) emits no task.retitled row', async () => {
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Already well named',
      author: AGENT,
      body: 'fine.',
    });
    expect(created.status).toBe(200);
    const taskId = ((await created.json()) as { task: Task }).task.id;
    const before = rowsOf('task.retitled').length;
    const r = await post(`/api/tasks/${taskId}/title`, {
      title: 'Already well named',
      author: AGENT,
    });
    expect(r.status).toBe(200);
    expect(rowsOf('task.retitled').length).toBe(before);
  });

  it('renders an evidence correction from the row the route wrote, naming the sha it replaced', async () => {
    // Same gap as the rewrite row above: a hand-written fixture proves the
    // switch has a case, not that the EMITTED keys are the ones it reads. The
    // superseded sha is the load-bearing half here — it is the thing someone
    // may already have tried to follow.
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Fix the ranking',
      author: AGENT,
    });
    const taskId = ((await created.json()) as { task: Task }).task.id;
    await post(`/api/tasks/${taskId}/transition`, {
      to: 'done',
      author: AGENT,
      evidence: { commit: 'b2ba21edef' },
    });
    const r = await post(`/api/tasks/${taskId}/evidence`, {
      author: AGENT,
      evidence: { commit: '621f371abc' },
      note: 'wrote the sha from memory',
    });
    expect(r.status).toBe(200);

    const row = rowsOf('task.evidence_amended').at(-1);
    expect(row).toBeDefined();
    const line = describeEvent(row as ActivityEvent, (id) =>
      id === taskId ? 'Fix the ranking' : id,
    );
    expect(line).toContain('Search Revamp');
    expect(line).toContain('Fix the ranking');
    expect(line).toContain('621f371');
    expect(line).toContain('b2ba21e');
    expect(line).not.toContain('task.evidence_amended');
  });

  it('emits one batched workspace.retriaged for a goal edit, with the regroups referencing it', async () => {
    const before = rowsOf('workspace.retriaged').length;
    const g = await local(`/api/workspaces/${wsId}/goal`, {
      method: 'PUT',
      body: JSON.stringify({ goal: 'Ship the search, then measure it.', author: PERSON }),
    });
    expect(g.status).toBe(200);

    // Positive control: the same exercise put goal_updated in the log, so a
    // missing retriaged row would not be "the log stopped receiving".
    expect(rowsOf('workspace.goal_updated').length).toBeGreaterThan(0);
    const retriaged = rowsOf('workspace.retriaged');
    expect(retriaged.length).toBe(before + 1);
    const batch = retriaged.at(-1) as ActivityEvent & {
      batchId: string;
      taskIds: string[];
      oldGoal: string;
      newGoal: string;
    };
    expect(batch.oldGoal).toBe('Ship the search.');
    expect(batch.newGoal).toBe('Ship the search, then measure it.');
    expect(batch.taskIds).toContain(decisionId);
    expect(batch.batchId).toBeTruthy();

    // The agent's re-triage placements carry the batch key, so N regroupings
    // read as one goal edit rather than N unexplained moves.
    const placed = await post(`/api/tasks/${decisionId}/goal`, {
      goal: 'chores',
      author: AGENT,
      position: 5,
      batchId: batch.batchId,
    });
    expect(placed.status).toBe(200);
    const regrouped = rowsOf('task.regrouped').at(-1) as
      | (ActivityEvent & { partOf?: string })
      | undefined;
    expect(regrouped?.taskId).toBe(decisionId); // positive control
    expect(regrouped?.partOf).toBe(batch.batchId);
  });
});
