/**
 * The same opt-in gesture as `doc-activity-stall.test.ts`, applied to the
 * linked doc's DISCUSSION rather than to its prose.
 *
 * A row's own `task:<id>` doc is already read for both — a comment is the row
 * moving, and an open declaration on it is somebody being waited on. A linked
 * doc's doc was read for prose only, so a question asked where the work
 * actually is — a mock, a design doc, a diff — was invisible: the row read as
 * quiet with nobody waiting, and the wake fired on it every window while the
 * reader had it sitting on their queue. Measured on the live board on
 * 2026-09-04: five wakes in sixty-five minutes over two rows, one of them a
 * mock round awaiting an answer.
 *
 * Thread writes carry no transaction origin (`schema.ts` writes them with
 * `undefined`), and `lastContentChangeFor` deliberately refuses an unnamed
 * origin — see the origins pair in `doc-activity-stall.test.ts`. So the prose
 * fold could never have covered this, whatever the doc's mtime says.
 *
 * The board and stream fixtures are shared with that suite in
 * `doc-activity-stall-harness.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import {
  BUILDER,
  type Frame,
  LEAD,
  PERSON,
  QUIET_MS,
  listenFrames,
  settle,
  waitForFrames,
} from './doc-activity-stall-harness.ts';
describe("a linked doc's discussion counts too", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-threads-stall-'));
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: QUIET_MS });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(): Promise<{
    workspaceId: string;
    lead: ReturnType<typeof listenFrames>;
  }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    for (const agent of [LEAD, BUILDER]) {
      await jj(
        await post(`/workspaces/${workspace.id}/agents`, {
          agentId: agent.id,
          runtime: 'claude-code-local',
        }),
      );
    }
    const leadRes = await fetch(
      `${base}/workspaces/${workspace.id}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId: workspace.id, lead: listenFrames(leadRes) };
  }

  async function inProgressRow(
    workspaceId: string,
    title: string,
    owner: { id: string; name: string; kind: string } = LEAD,
  ): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: owner.name,
        assigneeId: owner.id,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON, workspaceId }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    return task.id;
  }

  /** A file-backed markdown doc, linked to `taskId` the way `link_refs` does. */
  async function linkedDoc(taskId: string, docId: string): Promise<string> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, '# Mock round\n\nFirst pass.\n');
    await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
    await jj(await post(`/api/tasks/${taskId}/links`, { ref: { kind: 'doc', docId } }));
    return docId;
  }

  /** Ask a question ON the doc, as `create_thread(review=…)` does. */
  async function askOnDoc(
    docId: string,
    asker: { id: string; name: string; kind: string } = LEAD,
  ): Promise<{ threadId: string; commentId: string }> {
    const { thread } = await jj<{ thread: { id: string; comments: Array<{ id: string }> } }>(
      await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        text: 'Does this round read the way you wanted?',
        author: asker,
        anchor: { kind: 'subject' },
        review: { shape: 'question', headline: 'Does this round read the way you wanted?' },
      }),
    );
    return { threadId: thread.id, commentId: thread.comments[0]?.id as string };
  }

  const stalls = (frames: Frame[]): Frame[] => frames.filter((f) => f.event === STALL_EVENT);
  const namedRows = (frame: Frame | undefined): string[] =>
    ((frame?.data?.rows ?? []) as Array<{ id: string }>).map((r) => r.id);

  it('an open question on a linked doc is somebody waiting, not a stall', async () => {
    const ctx = await boardWithLead();
    const asked = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const docId = await linkedDoc(asked, 'mock-round-one');
    await askOnDoc(docId);
    await settle(QUIET_MS + 100);

    handle.nudgeStalls();
    await settle(400);
    expect(stalls(ctx.lead.frames)).toHaveLength(0);

    // The positive control, so the silence above cannot be the harness being
    // unable to fire: a second row with no doc and no question is still named
    // by the very next pass.
    const free = await inProgressRow(ctx.workspaceId, 'Cache the facet counts');
    await settle(QUIET_MS + 100);
    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([free]);
    await ctx.lead.stop();
  });

  it('the same row is named again once the question is answered', async () => {
    const ctx = await boardWithLead();
    const asked = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const docId = await linkedDoc(asked, 'mock-round-two');
    const { threadId, commentId } = await askOnDoc(docId);
    await settle(QUIET_MS + 100);
    handle.nudgeStalls();
    await settle(400);
    expect(stalls(ctx.lead.frames)).toHaveLength(0);

    await jj(
      await post(`/api/docs/${encodeURIComponent(docId)}/threads/${threadId}/answer`, {
        author: PERSON,
        text: 'Yes — ship it.',
        commentId,
      }),
    );
    // The answer is itself activity, so the row has to out-quiet the window
    // again before the wake may name it. That is the point: an answered ask
    // excuses nothing once the row goes quiet behind it.
    await settle(QUIET_MS + 100);
    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([asked]);
    await ctx.lead.stop();
  });

  it('a WITHDRAWN question excuses nothing either — the asker took it back', async () => {
    const ctx = await boardWithLead();
    const asked = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const docId = await linkedDoc(asked, 'mock-round-three');
    const { threadId, commentId } = await askOnDoc(docId);
    await jj(
      await post(`/api/docs/${encodeURIComponent(docId)}/threads/${threadId}/withdraw`, {
        author: LEAD,
        commentId,
        reason: 'asked the wrong round',
      }),
    );
    await settle(QUIET_MS + 100);

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([asked]);
    await ctx.lead.stop();
  });

  it('a plain reply on a linked doc is the row moving', async () => {
    const ctx = await boardWithLead();
    const busy = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const quiet = await inProgressRow(ctx.workspaceId, 'Cache the facet counts');
    const docId = await linkedDoc(busy, 'mock-round-four');
    // Out-quiet the window FIRST, so only the reply can save the row — and so
    // the untouched second row proves the pass still fires.
    await settle(QUIET_MS + 100);
    await jj(
      await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        text: 'Second pass is up; the spacing question is closed.',
        author: LEAD,
        anchor: { kind: 'subject' },
      }),
    );

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toContain(quiet);
    expect(namedRows(got[0])).not.toContain(busy);
    await ctx.lead.stop();
  });

  /**
   * The other half of the scoping rule, and the case owner-matching alone got
   * wrong: a BUILDER asking on a doc that only a LEAD-owned row links.
   *
   * The row is waiting on a person either way — somebody has to answer the
   * question before the work can move — so waking the lead about it is the
   * same false wake the owner case fixed. What makes it safe to park on an
   * ask from someone who does not own the row is that nothing else links the
   * doc: there is no other row the question could have been about. The test
   * below this one holds the opposite shape, where two rows share the doc and
   * the ask is scoped back to its asker's row.
   */
  it("parks a lead-owned row on a BUILDER's ask when no other row links the doc", async () => {
    const ctx = await boardWithLead();
    const asked = await inProgressRow(ctx.workspaceId, 'Rank results by recency', LEAD);
    const bystander = await inProgressRow(ctx.workspaceId, 'Cache the facet counts', BUILDER);
    const docId = await linkedDoc(asked, 'sole-linked-design-doc');
    // The Millwright does not own the row and is not its assignee; the doc is
    // the row's alone, which is what makes the question unambiguously its own.
    await askOnDoc(docId, BUILDER);
    await settle(QUIET_MS + 100);

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    // The bystander is the positive control: the same pass that spared the
    // asked row still names one, so the park is the ask and not a silent pass.
    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([bystander]);
    await ctx.lead.stop();
  });

  it('parks only the row whose owner asked, not every row linking that doc', async () => {
    const ctx = await boardWithLead();
    // Two rows, two different owners, ONE shared design doc — the shape a
    // spec or a mock actually has on a live board.
    const asker = await inProgressRow(ctx.workspaceId, 'Rank results by recency', LEAD);
    const bystander = await inProgressRow(ctx.workspaceId, 'Cache the facet counts', BUILDER);
    const docId = await linkedDoc(asker, 'shared-design-doc');
    await jj(await post(`/api/tasks/${bystander}/links`, { ref: { kind: 'doc', docId } }));
    // The question is the LEAD's, so it says nothing about whether the
    // Millwright's row is moving.
    await askOnDoc(docId, LEAD);
    await settle(QUIET_MS + 100);

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(namedRows(got[0])).toEqual([bystander]);
    await ctx.lead.stop();
  });
});
