/**
 * The wake, end to end: a real board, a real attached lead holding a real
 * stream, and the server's own interval pass.
 *
 * The unit tests next door pin the frugality rules against a fake world.
 * What they cannot see is whether the wake is wired to anything — whether
 * the ready set the server computes is the one the board would draw, whether
 * the frame is ADDRESSED (a browser tab on the same channel must not receive
 * it), and whether `decision.answered` reaches the nudger at all. Every one
 * of those can be perfect in isolation while the feature delivers nothing,
 * which is the failure mode this file exists for.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READY_IDLE_EVENT, REVIEW_ANSWERED_EVENT } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

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

describe('the board wakes its lead over the wire', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'ready-nudge-'));
    // A zero-length idle window: every ready board is idle the moment it is
    // read. The wall-clock gap is the one input a test cannot wait out, and
    // the arming rules — which are what actually keep this quiet — are
    // unaffected by the window's size.
    handle = createServer({ port: 0, dataDir, readyNudgeIdleMs: 0 });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with one ready, agent-owned todo, led by an attached agent that
   *  is holding its stream — the shape a real session presents. */
  async function boardWithReadyWork(): Promise<{
    workspaceId: string;
    taskId: string;
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
    const lead = listenFrames(leadRes);
    const tab = listenFrames(tabRes);

    // Created AFTER both streams are open, deliberately: the broadcast
    // `task.created` is the positive control for the tab. Without one, "the
    // tab did not receive the wake" would also be satisfied by a tab that
    // was never on the channel at all.
    const { task } = await jj<{ task: { id: string; assignee: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'Rank results by recency',
        body: 'Agent can rerank the result list so that fresh pages surface.',
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await settle();
    return { workspaceId, taskId: task.id, lead, tab };
  }

  const nudges = (frames: Frame[], event: string) => frames.filter((f) => f.event === event);

  it('sends one ready-idle nudge to the lead, naming the top ready row', async () => {
    const { taskId, lead, tab } = await boardWithReadyWork();

    handle.nudgeReadyWork();
    await settle();

    const got = nudges(lead.frames, READY_IDLE_EVENT);
    expect(got).toHaveLength(1);
    expect(got[0]?.data?.taskId).toBe(taskId);
    expect(got[0]?.data?.readyCount).toBe(1);
    // Addressed, not broadcast: the tab watching the same channel saw the
    // task events and must not have seen the wake.
    expect(nudges(tab.frames, READY_IDLE_EVENT)).toHaveLength(0);
    expect(tab.frames.length).toBeGreaterThan(0);

    await lead.stop();
    await tab.stop();
  });

  it('does not repeat itself on the next pass', async () => {
    const { lead, tab } = await boardWithReadyWork();

    handle.nudgeReadyWork();
    handle.nudgeReadyWork();
    handle.nudgeReadyWork();
    await settle();

    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await lead.stop();
    await tab.stop();
  });

  it('goes quiet once the ready row is claimed', async () => {
    const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await post(`/api/tasks/${taskId}/transition`, {
      to: 'in-progress',
      author: LEAD,
      workspaceId,
    });
    await settle();
    handle.nudgeReadyWork();
    await settle();

    // Claimed work is not ready work — no second wake, whatever the clock says.
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await lead.stop();
    await tab.stop();
  });

  it('never wakes a retired board', async () => {
    const { workspaceId, lead, tab } = await boardWithReadyWork();

    const { workspace } = await jj<{ workspace: { retiredAt?: number } }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/retired`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retired: true, reason: 'search work moved', author: PERSON }),
      }),
    );
    expect(workspace.retiredAt).toBeGreaterThan(0);
    await settle();
    handle.nudgeReadyWork();
    await settle();

    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(0);

    // …and the silence above is RETIREMENT, not a board that could never
    // have been woken. Stand it back up and the same pass fires.
    await jj(
      await fetch(`${base}/api/workspaces/${workspaceId}/retired`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ retired: false, author: PERSON }),
      }),
    );
    await settle();
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await lead.stop();
    await tab.stop();
  });

  it('wakes the lead the moment a review item is answered', async () => {
    const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();

    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${taskId}/review-items`, {
        author: LEAD,
        workspaceId,
        review: {
          shape: 'decision',
          headline: 'Rank by recency or by dwell time?',
          why: 'The two orderings disagree on every stale-but-popular page.',
          options: [
            { id: 'o-recency', label: 'Recency' },
            { id: 'o-dwell', label: 'Dwell time' },
          ],
        },
      }),
    );

    // Jordan answers. The lead is a different party, so it gets woken.
    await jj(
      await post(`/api/tasks/${taskId}/review-items/${encodeURIComponent(item.id)}/answer`, {
        text: 'Recency. Dwell time is the follow-up.',
        author: PERSON,
      }),
    );
    await settle();

    expect(nudges(lead.frames, REVIEW_ANSWERED_EVENT)).toHaveLength(1);
    expect(nudges(lead.frames, REVIEW_ANSWERED_EVENT)[0]?.data?.taskId).toBe(taskId);
    // Addressed here too — an answer is the lead's to act on.
    expect(nudges(tab.frames, REVIEW_ANSWERED_EVENT)).toHaveLength(0);

    await lead.stop();
    await tab.stop();
  });
});
