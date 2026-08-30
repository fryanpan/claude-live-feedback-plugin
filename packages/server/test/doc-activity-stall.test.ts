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
 * The origin filter gets its own pair too, driven through `handle.rooms`
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

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

/** Rows must out-quiet this window before a doc edit can matter. */
const QUIET_MS = 250;

type Frame = { event: string; data?: Record<string, unknown> };

function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const settle = (ms = 60): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function waitForFrames(
  frames: Frame[],
  event: string,
  n: number,
  timeoutMs = 15_000,
): Promise<Frame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await settle(20);
  }
}

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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-activity-'));
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
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/api/workspaces/${workspace.id}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/events/workspace/${workspace.id}?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    return { workspaceId: workspace.id, lead: listenFrames(leadRes) };
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
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
    writeFileSync(file, '# Design\n\nFirst pass.\n');
    await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
    await jj(await post(`/api/tasks/${taskId}/links`, { ref: { kind: 'doc', docId } }));
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
      await post(`/api/docs/${docId}/content`, {
        markdown: '# Design\n\nSecond pass, written by the agent holding the row.\n',
        author: LEAD,
      }),
    );
    expect(handle.rooms.lastContentChangeFor(docId)).toBeGreaterThan(0);

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
      await post(`/api/docs/${docId}/content`, { markdown: '# Design\n\nEdited.\n', author: LEAD }),
    );

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
    const rows = (got[0]?.data?.rows ?? []) as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(quiet);
    expect(rows.map((r) => r.id)).not.toContain(busy);
    await ctx.lead.stop();
  });

  describe('which transaction origins count as somebody working', () => {
    /** A doc room with no stamp yet, so a single write is unambiguous. */
    async function freshRoom(docId: string): Promise<Y.Doc> {
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, '# Design\n');
      await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
      const room = handle.rooms.peek(docId);
      expect(room, `room ${docId} should exist`).toBeTruthy();
      return (room as { ydoc: Y.Doc }).ydoc;
    }

    it('an agent write stamps the doc, server bookkeeping does not', async () => {
      const ydoc = await freshRoom('origins-doc');
      // Positive control first: a plain agent-origin write must move the
      // stamp, or the negatives below would pass for the wrong reason.
      ydoc.transact(() => {
        ydoc.getMap('probe').set('k', 1);
      }, 'agent');
      const afterAgent = handle.rooms.lastContentChangeFor('origins-doc');
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
        // An object that is not one of this room's live connections — a
        // websocket from some other room must not author this one.
        { notAConnection: true },
      ];
      for (const origin of synthetic) {
        ydoc.transact(() => {
          ydoc.getMap('probe').set('k', Math.random());
        }, origin);
        expect(
          handle.rooms.lastContentChangeFor('origins-doc'),
          `origin ${String(origin)} must not read as somebody working`,
        ).toBe(afterAgent);
      }
    });
  });
});
