/**
 * The board's Plan / Review controls, server side.
 *
 * A ticket's comments live in its body doc (`task:<id>`), so the task panel's
 * two controls press the SAME routes the meeting floats press —
 * `POST /api/docs/task:<id>/plan-request` and `.../review-request`. That is
 * the whole point: the ask is an ordinary subject thread from the presser on
 * the ticket's own doc, so the seated lead hears it on the board
 * subscription it already holds, with no new event type and no new route.
 *
 * What this pins is the two halves the panel depends on:
 *   - the ask lands as a thread on the TICKET, from the presser; and
 *   - the doc is stamped with who asked and when, which is the only place
 *     the receipt ("Plan requested by Jordan") can come from after a reload.
 *
 * Plus the words: a ticket's ask must not tell the agent to append a plan to
 * "this doc" and file the first tickets from it — that text is the huddle
 * doc's, and on a ticket it names the ticket's own description and asks for
 * tickets from a ticket.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import {
  PLAN_REQUEST_COMMENT,
  REVIEW_REQUEST_COMMENT,
  TASK_PLAN_REQUEST_COMMENT,
  TASK_REVIEW_REQUEST_COMMENT,
} from '../src/huddle.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const OTHER: User = { id: 'known-sam', name: 'Sam', kind: 'known', color: '#2f9e63' };

interface ThreadRow {
  id: string;
  anchor?: { kind?: string };
  createdBy?: { name?: string };
  comments?: Array<{ text: string; author?: { name?: string } }>;
}
interface AskResponse {
  docId: string;
  threadId: string;
  requestedAt: number;
}
interface DocResponse {
  meta: {
    planRequestedAt?: number;
    planRequestedBy?: string;
    reviewRequestedAt?: number;
    reviewRequestedBy?: string;
    reviewThreadId?: string;
  };
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the task panel’s Plan / Review controls press the doc ask routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  /** A ticket, and the doc id its comments live in. */
  const newTask = async (title: string): Promise<string> => {
    const res = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, { title, author: PERSON }),
    );
    return `task:${res.task.id}`;
  };
  const threadsOf = async (docId: string): Promise<ThreadRow[]> =>
    (
      await jj<{ threads: ThreadRow[] }>(
        await local(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}/threads`),
      )
    ).threads;
  const docOf = async (docId: string): Promise<DocResponse> =>
    jj<DocResponse>(await local(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`));
  const press = (docId: string, kind: 'plan' | 'review', author: User = PERSON) =>
    post(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}/${kind}-request`, { author });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-ask-request-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    workspaceId = (
      await jj<{ workspace: { id: string } }>(await post('/workspaces', { name: 'ask-board' }))
    ).workspace.id;
    WS = workspaceId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files a Plan ask as a subject thread on the ticket, from the presser', async () => {
    const docId = await newTask('Wire the Plan control');
    // Positive control: a fresh ticket carries no threads, so the one found
    // below is this press and not the create's doing.
    expect(await threadsOf(docId)).toHaveLength(0);

    const r = await jj<AskResponse>(await press(docId, 'plan'));
    expect(r.threadId).toBeTruthy();

    const threads = await threadsOf(docId);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.id).toBe(r.threadId);
    expect(thread.anchor?.kind).toBe('subject');
    expect(thread.createdBy?.name).toBe('Jordan');
    expect(thread.comments?.[0]?.author?.name).toBe('Jordan');
  });

  it('files a Review ask the same way, on the ticket’s own doc', async () => {
    const docId = await newTask('Wire the Review control');
    const r = await jj<AskResponse>(await press(docId, 'review'));
    const threads = await threadsOf(docId);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(r.threadId);
    expect(threads[0]?.createdBy?.name).toBe('Jordan');
  });

  it('asks a ticket’s question, not a huddle doc’s', async () => {
    const docId = await newTask('Words of the ask');
    await jj<AskResponse>(await press(docId, 'plan'));
    const planText = (await threadsOf(docId))[0]?.comments?.[0]?.text;
    expect(planText).toBe(TASK_PLAN_REQUEST_COMMENT);
    // The huddle doc's words would tell the agent to append a Plan section to
    // "this doc" and file the FIRST tickets from it — asked of a ticket, that
    // is a plan written into the ticket's own description and tickets from a
    // ticket. Different words is the whole reason `askCommentFor` exists.
    expect(planText).not.toBe(PLAN_REQUEST_COMMENT);

    const reviewDoc = await newTask('Words of the review ask');
    await jj<AskResponse>(await press(reviewDoc, 'review'));
    const reviewText = (await threadsOf(reviewDoc))[0]?.comments?.[0]?.text;
    expect(reviewText).toBe(TASK_REVIEW_REQUEST_COMMENT);
    expect(reviewText).not.toBe(REVIEW_REQUEST_COMMENT);
  });

  it('keeps the one-question-per-thread instruction in the ticket wording', () => {
    // The huddle plan ask carries this and its own test (plan-request-route);
    // the ticket ask is a second copy of the words and would drift on its own.
    // The root cause it fixes is the same: "a plan came back as one comment
    // holding twelve questions" — the agent had the tools and lacked the line.
    expect(TASK_PLAN_REQUEST_COMMENT).toMatch(/create_thread/);
    expect(TASK_PLAN_REQUEST_COMMENT).toMatch(/`review` payload/);
    expect(TASK_PLAN_REQUEST_COMMENT).toMatch(/never a list of questions in one comment/);
    // And the review ask says where an answer that is a CHOICE should go,
    // which is what makes a clarifying question answerable in one tap.
    expect(TASK_REVIEW_REQUEST_COMMENT).toMatch(/review or decision item/);
  });

  it('points both ticket asks at the ticket, never at "this doc"', () => {
    // The shape control that matters most here. Both texts are reworded
    // copies of a huddle doc's, and the phrase the huddle version turns on —
    // "this doc" — names the ticket's own description when it is read on a
    // ticket. Either text drifting back to it sends the agent to the wrong
    // place while every other assertion still passes.
    for (const text of [TASK_PLAN_REQUEST_COMMENT, TASK_REVIEW_REQUEST_COMMENT]) {
      expect(text).not.toMatch(/this doc/i);
      expect(text).toMatch(/this ticket/);
    }
    // Positive control: the phrase IS what the huddle wording says, so the
    // check above can fail rather than being vacuously true of any sentence.
    expect(PLAN_REQUEST_COMMENT).toMatch(/this doc/i);
  });

  it('stamps who asked and when, so a reopened panel can render the receipt', async () => {
    const docId = await newTask('Receipt after a reload');
    const before = await docOf(docId);
    expect(before.meta.planRequestedAt).toBeUndefined();
    expect(before.meta.reviewRequestedAt).toBeUndefined();

    const plan = await jj<AskResponse>(await press(docId, 'plan'));
    const afterPlan = await docOf(docId);
    expect(afterPlan.meta.planRequestedAt).toBe(plan.requestedAt);
    expect(afterPlan.meta.planRequestedBy).toBe('Jordan');
    // One control at a time: pressing Plan must not put Review into its
    // receipt state, which is what a shared stamp would do.
    expect(afterPlan.meta.reviewRequestedAt).toBeUndefined();

    const review = await jj<AskResponse>(await press(docId, 'review', OTHER));
    const afterReview = await docOf(docId);
    expect(afterReview.meta.reviewRequestedBy).toBe('Sam');
    expect(afterReview.meta.reviewThreadId).toBe(review.threadId);
    // And the Plan receipt still names Jordan, not whoever pressed last.
    expect(afterReview.meta.planRequestedBy).toBe('Jordan');
  });

  it('refuses an ask whose author is the bare category "agent"', async () => {
    // The same door every comment route holds: an ask names a person for the
    // agent to answer, and "agent" names nobody. Pinned on the ticket routes
    // too, because a board control posts on somebody's behalf and a missing
    // identity there would file an ask no agent can address.
    const docId = await newTask('Category author');
    const refused = await press(docId, 'plan', {
      id: 'agent',
      name: 'agent',
      kind: 'agent',
    } as unknown as User);
    expect(refused.status).toBe(400);
    // Nothing filed — the refusal is before the write, not after it.
    expect(await threadsOf(docId)).toHaveLength(0);
  });
});
