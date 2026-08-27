/**
 * The stall wake, end to end: a real board, a real attached lead holding a
 * real stream, and the server's own interval pass.
 *
 * The unit tests next door pin the rules against a fake world. What they
 * cannot see is whether the loop is wired to anything — whether a real row in
 * a real state reaches the gate looking the way the gate expects, whether a
 * comment posted through the API is found where the snapshot goes looking for
 * it, and whether the frame is ADDRESSED so a browser tab on the same channel
 * never receives it. Every one of those can be right in isolation while the
 * feature delivers nothing, which is what this file is for.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { STALL_EVENT } from '../src/stall-nudge.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

type Frame = { event: string; data?: Record<string, unknown> };

/** Read a workspace stream, keeping every frame's event name and payload. */
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

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until at least `n` frames of `event` have arrived, or give up.
 *
 * A fixed settle is a bet that this machine delivers an SSE frame inside a
 * window, and under a full parallel load it does not — which shows up as a
 * wake test failing on a branch that never touched the wake. Polling asserts
 * the same thing without the bet, and cannot make a SILENCE test pass by
 * accident: those still wait a fixed window and then look.
 */
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

interface StalledRowFrame {
  id: string;
  title: string;
  bucket: string;
  quietMs: number;
}

describe('the board tells its lead which rows have stopped', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  /** Fail with the server's own words rather than with `undefined` three
   *  lines later — a setup that quietly 400s is how a wake test passes by
   *  never having a board to wake. */
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stall-nudge-'));
    // A zero-length quiet window: every open row is quiet the moment it is
    // read. The wall-clock gap is the one input a test cannot wait out, and
    // the conditions that actually decide what is named — a filed question, a
    // park, a dependency — are unaffected by the window's size. One test
    // below builds its own server to prove the window is real.
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: 0 });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board led by an attached agent holding its stream, plus a browser tab
   *  on the same channel — the shape a real session presents. */
  async function boardWithLead(): Promise<{
    workspaceId: string;
    lead: ReturnType<typeof listenFrames>;
    tab: ReturnType<typeof listenFrames>;
  }> {
    const { workspace } = await jj<{ workspace: { id: string; leadAgentId?: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', leadAgentId: LEAD.id }),
    );
    const workspaceId = workspace.id;
    expect(workspace.leadAgentId).toBe(LEAD.id);
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/events/workspace/${workspaceId}?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    // A browser tab on the same channel. Nothing addressed may reach it.
    const tabRes = await fetch(`${base}/events/workspace/${workspaceId}`, {
      headers: { accept: 'text/event-stream' },
    });
    return { workspaceId, lead: listenFrames(leadRes), tab: listenFrames(tabRes) };
  }

  /**
   * One agent-owned row on the board, in `todo` or `in-progress`.
   *
   * Filed by the lead and vetted by Jordan, which is the real two-step rather
   * than a shortcut: an agent's own row starts in `triage`, and no dispatch
   * read returns those — a test that skipped the vetting would be asserting
   * over a row the loop never sees.
   */
  async function addRow(
    workspaceId: string,
    title: string,
    to: 'todo' | 'in-progress' = 'todo',
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
        ...over,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON, workspaceId }),
    );
    if (to === 'in-progress') {
      await jj(
        await post(`/api/tasks/${task.id}/transition`, {
          to: 'in-progress',
          author: LEAD,
          workspaceId,
        }),
      );
    }
    return task.id;
  }

  const stalls = (frames: Frame[]) => frames.filter((f) => f.event === STALL_EVENT);
  const rowsOf = (frame: Frame) => (frame.data?.rows ?? []) as StalledRowFrame[];

  it('names an in-progress row that has gone quiet, and names it to the LEAD alone', async () => {
    const ctx = await boardWithLead();
    const taskId = await addRow(ctx.workspaceId, 'Rank results by recency', 'in-progress');
    await settle();

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(taskId);
    expect(got[0]?.data?.title).toBe('Rank results by recency');
    expect(got[0]?.data?.stalledCount).toBe(1);
    expect(got[0]?.data?.consideredCount).toBe(1);
    expect(rowsOf(got[0] as Frame)[0]?.bucket).toBe('in-progress');

    // The tab was on the channel throughout and received the broadcast row
    // events — the positive control, without which "the tab did not get the
    // wake" would also be satisfied by a tab that was never listening.
    expect(ctx.tab.frames.length).toBeGreaterThan(0);
    expect(stalls(ctx.tab.frames)).toHaveLength(0);

    await ctx.lead.stop();
    await ctx.tab.stop();
  });

  it('says nothing while the quiet window has not passed', async () => {
    // Its own server, because this is the one assertion the zero-length
    // window above cannot make: that the threshold is consulted at all.
    const dir = mkdtempSync(join(tmpdir(), 'stall-window-'));
    const own = createServer({ port: 0, dataDir: dir, stallNudgeQuietMs: 60 * 60_000 });
    const ownBase = `http://localhost:${own.port}`;
    try {
      const { workspace } = await jj<{ workspace: { id: string } }>(
        await fetch(`${ownBase}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'quiet-window', leadAgentId: LEAD.id }),
        }),
      );
      await fetch(`${ownBase}/api/workspaces/${workspace.id}/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: LEAD.id, runtime: 'claude-code-local' }),
      });
      const res = await fetch(
        `${ownBase}/events/workspace/${workspace.id}?agentId=${encodeURIComponent(LEAD.id)}`,
        { headers: { accept: 'text/event-stream' } },
      );
      const lead = listenFrames(res);
      const { task } = await jj<{ task: { id: string } }>(
        await fetch(`${ownBase}/api/workspaces/${workspace.id}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: 'Cache the facet counts',
            body: 'Agent can cache the counts so that the panel opens fast.',
            assignee: LEAD.name,
            assigneeKind: 'agent',
            author: LEAD,
          }),
        }),
      );
      await fetch(`${ownBase}/api/tasks/${task.id}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'todo', author: PERSON, workspaceId: workspace.id }),
      });
      await settle();

      own.nudgeStalls();
      await settle(400);

      expect(stalls(lead.frames)).toHaveLength(0);
      await lead.stop();
    } finally {
      await own.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a row alone while a question about it is waiting on a person', async () => {
    const ctx = await boardWithLead();
    const askedId = await addRow(ctx.workspaceId, 'Pick a retention window');
    await jj(
      await post(`/api/tasks/${askedId}/review-items`, {
        author: LEAD,
        workspaceId: ctx.workspaceId,
        review: {
          shape: 'decision',
          headline: 'How long should search history be kept?',
          options: [
            { id: 'o-30', label: '30 days' },
            { id: 'o-forever', label: 'Forever' },
          ],
        },
      }),
    );
    await settle();

    handle.nudgeStalls();
    await settle(400);
    expect(stalls(ctx.lead.frames)).toHaveLength(0);

    // The positive control: the same pass that stayed silent still names a row
    // that has no question outstanding. Without it, a gate that suppressed
    // everything would satisfy the assertion above perfectly.
    const freeId = await addRow(ctx.workspaceId, 'Cache the facet counts');
    await settle();
    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(rowsOf(got[0] as Frame).map((r) => r.id)).toEqual([freeId]);
    // Two rows examined, one named — the denominator is what stops "1 row
    // stalled" from reading identically on two very different boards.
    expect(got[0]?.data?.consideredCount).toBe(2);

    await ctx.lead.stop();
    await ctx.tab.stop();
  });

  it('leaves a deliberately parked row alone', async () => {
    const ctx = await boardWithLead();
    const parkedId = await addRow(ctx.workspaceId, 'Redesign the empty state');
    await jj(
      await post(`/api/tasks/${parkedId}/park`, {
        parkedUntil: Date.now() + 60 * 60_000,
        reason: 'waiting on the illustration pass',
        author: PERSON,
      }),
    );
    const freeId = await addRow(ctx.workspaceId, 'Cache the facet counts');
    await settle();

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(rowsOf(got[0] as Frame).map((r) => r.id)).toEqual([freeId]);

    await ctx.lead.stop();
    await ctx.tab.stop();
  });

  /**
   * The loop, over a board that HAS goals — and specifically one band nobody
   * has agreed to yet.
   *
   * A band in triage dispatches nothing under it, so a row sitting there is
   * idle BY RULE and naming it as stalled would tell the lead to go and drive
   * work the board has not decided to do. The band's status lives on the goal
   * ROWS; the ordered goal list carries none, so this is the one path that
   * proves the snapshot goes and reads them.
   *
   * The control row is moved into the AGREED band rather than left without
   * one: on a board that has bands, a row with no goal is formal backlog and
   * would be withheld too, so a silent pass over it would prove nothing about
   * triage in particular.
   */
  it('leaves a row alone while its goal is still in triage', async () => {
    const ctx = await boardWithLead();
    const G = await seedGoalsOverHttp(
      base,
      ctx.workspaceId,
      [
        { key: 'pending', title: 'Rebuild the ranker' },
        { key: 'agreed', title: 'Fix the crawler' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    await jj(
      await post(`/api/tasks/${G.agreed}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId: ctx.workspaceId,
      }),
    );

    const pendingId = await addRow(ctx.workspaceId, 'Rank results by recency');
    await jj(await post(`/api/tasks/${pendingId}/goal`, { goal: G.pending, author: PERSON }));
    const freeId = await addRow(ctx.workspaceId, 'Cache the facet counts');
    await jj(await post(`/api/tasks/${freeId}/goal`, { goal: G.agreed, author: PERSON }));
    await settle();

    handle.nudgeStalls();
    const got = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);

    expect(got).toHaveLength(1);
    expect(rowsOf(got[0] as Frame).map((r) => r.id)).toEqual([freeId]);
    expect(got[0]?.data?.consideredCount).toBe(2);

    await ctx.lead.stop();
    await ctx.tab.stop();
  });

  it('counts a comment on the row as the row moving', async () => {
    const ctx = await boardWithLead();
    const taskId = await addRow(ctx.workspaceId, 'Rank results by recency', 'in-progress');
    // Wide enough that the reading below is unmistakably smaller than this
    // one, without the test waiting on anything a loaded machine could
    // stretch: the comparison is against a gap we created on purpose.
    await settle(1200);

    handle.nudgeStalls();
    const before = await waitForFrames(ctx.lead.frames, STALL_EVENT, 1);
    const quietBefore = rowsOf(before[0] as Frame).find((r) => r.id === taskId)?.quietMs ?? 0;
    expect(quietBefore).toBeGreaterThan(1000);

    // A comment is the row moving. It changes nothing the store records about
    // the row, so this is the one activity source the snapshot has to go and
    // look for — and the only place that lookup can be proven is here.
    await jj(
      await post(`/api/docs/${encodeURIComponent(`task:${taskId}`)}/threads`, {
        text: 'Holding this until the ranking spike lands.',
        author: LEAD,
        anchor: { kind: 'subject' },
      }),
    );
    // A second row, so the stalled SET changes and the wake is owed again —
    // the arming rule is doing its job, and without this the pass would
    // correctly stay silent and prove nothing.
    await addRow(ctx.workspaceId, 'Cache the facet counts');
    await settle();

    handle.nudgeStalls();
    const after = await waitForFrames(ctx.lead.frames, STALL_EVENT, 2);
    expect(after).toHaveLength(2);
    const quietAfter = rowsOf(after[1] as Frame).find((r) => r.id === taskId)?.quietMs ?? 0;
    expect(quietAfter).toBeLessThan(quietBefore);

    await ctx.lead.stop();
    await ctx.tab.stop();
  });
});
