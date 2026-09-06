/**
 * A row's linked doc as activity: an agent rewriting the document a task is
 * about keeps that task out of the stall wake.
 *
 * The pair is the point. `an untouched linked doc lets the row stall` is the
 * positive control — same board, same window, same nudge, doc never written,
 * frame observed — so the exoneration test that follows it cannot pass
 * vacuously by the harness simply being unable to fire. Verified by removing
 * the fold in server.ts and re-running: the control and the origin test still
 * passed, both exoneration tests failed. That is what makes them tests of
 * this change rather than of the harness.
 *
 * The origin filter gets its own pair too, driven through `handle.docStore`
 * rather than a route, because the thing being pinned is which TRANSACTION
 * ORIGINS count — a `file-watch` reparse, and above all an unnamed
 * (`undefined`) server write, must not read as somebody working.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import {
  type Frame,
  LEAD,
  PERSON,
  QUIET_MS,
  listenFrames,
  settle,
  waitForFrames,
} from './doc-activity-stall-harness.ts';
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe("a task's linked doc counts as the task moving", () => {
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

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-activity-'));
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: QUIET_MS });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
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
    WS = workspace.id;
    await jj(
      await post(`/workspaces/${workspace.id}/agents`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/workspaces/${workspace.id}/events:stream?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId: workspace.id, lead: listenFrames(leadRes) };
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId,
      }),
    );
    await jj(
      await post(`/workspaces/${workspaceId}/tasks/${task.id}/transition`, {
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
    writeFileSync(file, '# Design\n\nFirst pass.\n');
    await jj(await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file }));
    await jj(
      await post(`/workspaces/${WS}/tasks/${taskId}/links`, { ref: { kind: 'doc', docId } }),
    );
    return docId;
  }

  const stalls = (frames: Frame[]): Frame[] => frames.filter((f) => f.event === STALL_EVENT);

  it('an untouched linked doc lets the row stall', async () => {
    const ctx = await boardWithLead();
    const taskId = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    await linkedDoc(taskId, 'design-quiet');
    // Nobody writes the doc. The row must out-quiet the window and be named,
    // exactly as it would with no doc at all — this change removes false
    // wakes, it does not make the loop unable to fire.
    await settle(QUIET_MS + 100);

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(taskId);
    await ctx.lead.stop();
  });

  it('a freshly-rewritten linked doc keeps the row out of the wake', async () => {
    const ctx = await boardWithLead();
    const taskId = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const docId = await linkedDoc(taskId, 'design-live');
    // Out-quiet the window first, so the row is one the first pass reports and
    // only the doc edit can save. Then the agent writes the doc — the exact
    // shape measured on the live board, where a row whose whole current work
    // was an agent rewriting its doc woke the lead three times in one hour.
    await settle(QUIET_MS + 100);
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/content`, {
        markdown: '# Design\n\nSecond pass, written by the agent holding the row.\n',
        author: LEAD,
      }),
    );
    expect(handle.docStore.lastContentChangeFor(docId)).toBeGreaterThan(0);

    handle.nudgeStalls();
    // The control above is what proves this harness fires on this board with
    // this window; here the same wait must produce nothing.
    await settle(300);
    expect(stalls(ctx.lead.frames)).toHaveLength(0);
    await ctx.lead.stop();
  });

  it("another row's doc does not exonerate an unlinked row", async () => {
    const ctx = await boardWithLead();
    const busy = await inProgressRow(ctx.workspaceId, 'Rank results by recency');
    const quiet = await inProgressRow(ctx.workspaceId, 'Cache the facet counts');
    const docId = await linkedDoc(busy, 'design-shared');
    await settle(QUIET_MS + 100);
    await jj(
      await post(`/workspaces/${WS}/docs/${docId}/content`, {
        markdown: '# Design\n\nEdited.\n',
        author: LEAD,
      }),
    );

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
    const rows = (got[0]?.data?.rows ?? []) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(quiet);
    expect(rows.map((r) => r.id)).not.toContain(busy);
    await ctx.lead.stop();
  });

  describe('which transaction origins count as somebody working', () => {
    /** A live doc with no stamp yet, so a single write is unambiguous. */
    async function freshDoc(docId: string): Promise<Y.Doc> {
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, '# Design\n');
      await jj(await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file }));
      const doc = handle.docStore.peek(docId);
      expect(doc, `doc ${docId} should exist`).toBeTruthy();
      return (doc as { ydoc: Y.Doc }).ydoc;
    }

    it('an agent write stamps the doc, server bookkeeping does not', async () => {
      const ydoc = await freshDoc('origins-doc');
      // Positive control first: a plain agent-origin write must move the
      // stamp, or the negatives below would pass for the wrong reason.
      ydoc.transact(() => {
        ydoc.getMap('probe').set('k', 1);
      }, 'agent');
      const afterAgent = handle.docStore.lastContentChangeFor('origins-doc');
      expect(afterAgent).toBeGreaterThan(0);

      await settle(5);
      // `undefined` is the one that matters most and is easiest to miss: Yjs
      // stamps it on any transaction that names no origin, which is what
      // binds.ts meta writes and every schema.ts thread write do. A
      // deny-list of the named synthetic origins let all of those through.
      const synthetic: unknown[] = [
        undefined,
        'file-seed',
        'file-watch',
        'agent-reanchor',
        'task-projection',
        'private-meta-guard',
        // An object that is not one of this doc's live connections — a
        // websocket from some other doc must not author this one.
        { notAConnection: true },
      ];
      for (const origin of synthetic) {
        ydoc.transact(() => {
          ydoc.getMap('probe').set('k', Math.random());
        }, origin);
        expect(
          handle.docStore.lastContentChangeFor('origins-doc'),
          `origin ${String(origin)} must not read as somebody working`,
        ).toBe(afterAgent);
      }
    });
  });
});
