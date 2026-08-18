/**
 * The task-review routing loop: every attributed write to a PLACED row —
 * create, rename, body edit — is routed to the workspace's LEAD agent for a
 * shape review. The server does not judge the title or the body any more
 * (Bryan, 2026-08-18: "Remove the format check that's all written in code.
 * Instead, I want that to be in an LLM prompt going forward"); it only
 * ROUTES, and the lead's prompt (the `live-feedback:reviewing-task-shape`
 * skill) decides fine-as-is / rewrite / ask the filer. Capture always wins —
 * nothing here can refuse or delay a write.
 *
 * Delivery contract mirrors `triage.requested` for goal-retriage: a request
 * is a DELIVERY, not a change, so it never reaches events.jsonl (§3.6's
 * table is exhaustive), it is addressed to the lead in the payload, and when
 * no lead is live it queues in a per-workspace sidecar drained on the lead's
 * next `attach_agent`.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath, pendingTaskReviewsPath } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const LEAD_ID = 'lead-agent';
const LEAD_AUTHOR = { id: LEAD_ID, name: 'Lead Agent' };

const TITLE = 'Reviewers can scan the board fast by clearer titles';
const BODY =
  'Reviewers can scan the board fast so that prioritising thirty rows takes a minute.\n\nDone when titles read as stories.';

function readAudit(dataDir: string, workspaceId: string): Array<Record<string, unknown>> {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function listen(res: Response): { events: string[]; data: string[]; stop: () => void } {
  const events: string[] = [];
  const data: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || stopped) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
          if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
        }
      }
    } catch {
      // torn down — fine
    }
  })();
  return {
    events,
    data,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

interface ReviewFrame {
  event: string;
  kind: string;
  taskId: string;
  title: string;
  trigger: string;
  leadAgentId?: string;
  actor?: { id: string; name?: string; kind?: string };
  ts: number;
}

interface PendingReviewRow {
  taskId: string;
  trigger: string;
  actor?: { id: string };
  ts: number;
}

describe('task shape review requests (the routing loop)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, ...(init.headers ?? {}) },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });

  const makeWorkspace = async (name: string): Promise<string> => {
    const res = await post('/api/workspaces', { name, goal: 'Ship it.' });
    return ((await res.json()) as { workspace: { id: string } }).workspace.id;
  };
  const attach = async (workspaceId: string, agentId: string) => {
    const res = await post(`/api/workspaces/${workspaceId}/attachments`, {
      agentId,
      runtime: 'claude-code-local',
    });
    return (await res.json()) as {
      lead?: boolean;
      untriaged?: string[];
      taskReviews?: PendingReviewRow[];
    };
  };
  /** The task-review data frames on a stream, parsed. */
  const reviewFrames = (data: string[]): ReviewFrame[] =>
    data.filter((d) => d.includes('"task-review"')).map((d) => JSON.parse(d) as ReviewFrame);

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-shape-review-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a PLACED create asks the live lead for a review — and the write itself still lands', async () => {
    const ws = await makeWorkspace('hot-board');
    await attach(ws, LEAD_ID);
    const sse = listen(await local(`/events/workspace/${ws}`));
    const res = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    // Capture always wins: routing a review can never make a write fail.
    expect(res.status).toBe(200);
    const task = ((await res.json()) as { task: { id: string } }).task;
    await settle();
    sse.stop();

    const frames = reviewFrames(sse.data);
    expect(frames.length).toBe(1);
    const frame = frames[0] as ReviewFrame;
    // Rides the existing triage transport — no new event name to teach every
    // listener.
    expect(frame.event).toBe('triage.requested');
    expect(frame.kind).toBe('task-review');
    expect(frame.taskId).toBe(task.id);
    expect(frame.title).toBe(TITLE);
    expect(frame.trigger).toBe('created');
    // Addressed: the lead judges, everyone else reads someone else's mail.
    expect(frame.leadAgentId).toBe(LEAD_ID);
    // The writer travels too — it is who the MCP suppresses the echo for,
    // and who a follow-up question is addressed to.
    expect(frame.actor?.id).toBe(PERSON.id);

    // A request is a delivery, not a change: nothing in the audit log…
    expect(readAudit(dataDir, ws).filter((l) => l.event === 'triage.requested')).toHaveLength(0);
    // …and the positive control: the same log DID record the create.
    expect(readAudit(dataDir, ws).filter((l) => l.event === 'task.created')).toHaveLength(1);
  });

  it('a decision row routes too — the prompt owns the story-shape exemption, not the server', async () => {
    const ws = await makeWorkspace('decision-board');
    await attach(ws, LEAD_ID);
    const sse = listen(await local(`/events/workspace/${ws}`));
    const res = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      needs: 'decision',
      title: 'Ship the export now, or wait for',
      body: '**Should the export ship now, or wait for the cursor rewrite?**',
      goal: 'chores',
    });
    expect(res.status).toBe(200);
    await settle();
    sse.stop();
    // A muddy question is exactly what a reviewer with context can sharpen.
    const frames = reviewFrames(sse.data);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.trigger).toBe('created');
  });

  it('an UNPLACED create routes through shape-and-place triage, not a second review ask', async () => {
    const ws = await makeWorkspace('unplaced-board');
    await attach(ws, LEAD_ID);
    const sse = listen(await local(`/events/workspace/${ws}`));
    await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      // no goal: placement triage owns this row, and its ask already says
      // "shape, then place" — a review request would say the same thing twice.
    });
    await settle();
    sse.stop();
    expect(reviewFrames(sse.data)).toHaveLength(0);
    // Positive control: the placement request went out instead.
    const placement = sse.data.find((d) => d.includes('"kind":"task"'));
    expect(placement).toBeDefined();
  });

  it('a rename asks with trigger=renamed and the NEW title in the payload', async () => {
    const ws = await makeWorkspace('rename-board');
    await attach(ws, LEAD_ID);
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const task = ((await created.json()) as { task: { id: string } }).task;
    const sse = listen(await local(`/events/workspace/${ws}`));

    await post(`/api/tasks/${task.id}/title`, {
      author: PERSON,
      title: 'Needs a rethink about the',
    });
    await settle();
    sse.stop();
    const frames = reviewFrames(sse.data);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.trigger).toBe('renamed');
    expect(frames[0]?.title).toBe('Needs a rethink about the');
  });

  it('an attributed body rewrite asks with trigger=edited', async () => {
    const ws = await makeWorkspace('edit-board');
    await attach(ws, LEAD_ID);
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const task = ((await created.json()) as { task: { id: string } }).task;
    const sse = listen(await local(`/events/workspace/${ws}`));
    await post(`/api/tasks/${task.id}/body`, {
      author: PERSON,
      markdown:
        'Completely different work now: the export pipeline drops every third row and the fix is a cursor rewrite.',
    });
    await settle();
    sse.stop();
    const frames = reviewFrames(sse.data);
    expect(frames.length).toBe(1);
    expect(frames[0]?.trigger).toBe('edited');
    expect(frames[0]?.taskId).toBe(task.id);
  });

  it("the lead's own write is never re-addressed to the lead (no self-review loop)", async () => {
    const ws = await makeWorkspace('lead-writes');
    await attach(ws, LEAD_ID);
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const task = ((await created.json()) as { task: { id: string } }).task;
    const sse = listen(await local(`/events/workspace/${ws}`));
    await post(`/api/tasks/${task.id}/title`, {
      author: LEAD_AUTHOR,
      title: 'The lead renames its own row',
    });
    await settle();
    expect(reviewFrames(sse.data)).toHaveLength(0);
    // Positive control on the same task and stream: the same rename from a
    // person DOES ask.
    await post(`/api/tasks/${task.id}/title`, {
      author: PERSON,
      title: 'A person renames the row back',
    });
    await settle();
    sse.stop();
    expect(reviewFrames(sse.data)).toHaveLength(1);
  });

  it('nobody live: the ask queues in a sidecar, and the LEAD (only) drains it on next attach', async () => {
    const ws = await makeWorkspace('cold-board');
    const sse = listen(await local(`/events/workspace/${ws}`));
    // Placed, written while no agent is attached.
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const placed = ((await created.json()) as { task: { id: string } }).task;
    // Unplaced: owned by the untriaged sweep, NOT double-reported.
    const unplacedRes = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: 'Another capture about the',
      body: BODY,
    });
    const unplaced = ((await unplacedRes.json()) as { task: { id: string } }).task;
    await settle();
    sse.stop();
    expect(reviewFrames(sse.data)).toHaveLength(0);

    // The queue is on DISK before anyone attaches — a synchronous write,
    // because a promise grounded in a debounce a crash can drop is a lie.
    const sidecar = pendingTaskReviewsPath(dataDir, ws);
    expect(existsSync(sidecar)).toBe(true);
    const stored = JSON.parse(readFileSync(sidecar, 'utf8')) as { pending: PendingReviewRow[] };
    expect(stored.pending.map((r) => r.taskId)).toEqual([placed.id]);

    // First attach claims the empty lead seat and receives the queue.
    const attachRes = await attach(ws, LEAD_ID);
    expect(attachRes.lead).toBe(true);
    const reviews = attachRes.taskReviews ?? [];
    expect(reviews.map((r) => r.taskId)).toEqual([placed.id]);
    expect(reviews[0]?.trigger).toBe('created');
    expect(reviews[0]?.actor?.id).toBe(PERSON.id);
    // The unplaced row is in the untriaged sweep instead — one ask per row.
    expect(attachRes.untriaged ?? []).toContain(unplaced.id);
    // Drained means drained: the sidecar is gone…
    expect(existsSync(sidecar)).toBe(false);

    // …and a bystander attaching afterwards is not handed the lead's queue.
    const bystander = await attach(ws, 'second-agent');
    expect(bystander.lead).toBe(false);
    expect(bystander.taskReviews).toBeUndefined();
  });

  it('several offline writes to one row coalesce: one pending ask, FIRST ts, LATEST trigger', async () => {
    const ws = await makeWorkspace('coalesce-board');
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const task = ((await created.json()) as { task: { id: string } }).task;
    const sidecar = pendingTaskReviewsPath(dataDir, ws);
    const afterCreate = JSON.parse(readFileSync(sidecar, 'utf8')) as {
      pending: PendingReviewRow[];
    };
    expect(afterCreate.pending).toHaveLength(1);
    const firstTs = afterCreate.pending[0]?.ts as number;

    await post(`/api/tasks/${task.id}/title`, { author: PERSON, title: 'Renamed while cold' });
    const afterRename = JSON.parse(readFileSync(sidecar, 'utf8')) as {
      pending: PendingReviewRow[];
    };
    // Still one row: the review pass reads the task once, not once per write.
    expect(afterRename.pending).toHaveLength(1);
    expect(afterRename.pending[0]?.trigger).toBe('renamed');
    // Honest aging: the row has been waiting since the FIRST undelivered write.
    expect(afterRename.pending[0]?.ts).toBe(firstTs);
  });

  it('a row finished before the lead comes home is pruned from the drain — reviewing it would be noise', async () => {
    const ws = await makeWorkspace('prune-board');
    const created = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: TITLE,
      body: BODY,
      goal: 'chores',
    });
    const task = ((await created.json()) as { task: { id: string } }).task;
    // A second row that stays open, as the positive control for the drain.
    const kept = await post(`/api/workspaces/${ws}/tasks`, {
      author: PERSON,
      title: 'Jordan can keep this row open by not touching it',
      body: BODY,
      goal: 'chores',
    });
    const keptTask = ((await kept.json()) as { task: { id: string } }).task;
    await post(`/api/tasks/${task.id}/transition`, { to: 'done', author: PERSON });
    const attachRes = await attach(ws, LEAD_ID);
    const reviews = attachRes.taskReviews ?? [];
    expect(reviews.map((r) => r.taskId)).toEqual([keptTask.id]);
  });
});
