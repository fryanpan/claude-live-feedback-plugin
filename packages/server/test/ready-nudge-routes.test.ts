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

/**
 * Wait until at least `n` frames of `event` have arrived, or give up.
 *
 * A fixed `settle(60)` is a bet that this machine delivers an SSE frame inside
 * 60ms, and under a full-suite load it does not — which shows up as a wake
 * test failing on a branch that never touched the wake. Polling asserts the
 * same thing without the bet. It cannot make a silence test pass by accident:
 * the tests below that expect silence still wait a fixed window and then look.
 */
async function waitForFrames(
  frames: Frame[],
  event: string,
  n: number,
  // Generous, because a poll costs nothing when the answer is already there —
  // it returns on the first pass. The number is sized for this machine under
  // a full parallel agent load (measured load average 12–19), where an HTTP
  // round trip that normally takes 3ms has been seen to take seconds.
  timeoutMs = 15_000,
): Promise<Frame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await settle(20);
  }
}

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
    // Vetted, because the lead FILED it and an agent's own row starts in
    // `triage` — which no dispatch read returns, so an unvetted row is not
    // ready work and correctly produces no wake. This is the real flow in two
    // lines: the agent proposes, a person agrees, and only then is it queued.
    await post(`/api/tasks/${task.id}/transition`, {
      to: 'todo',
      author: PERSON,
      workspaceId,
    });
    await settle();
    return { workspaceId, taskId: task.id, lead, tab };
  }

  const nudges = (frames: Frame[], event: string) => frames.filter((f) => f.event === event);

  /**
   * A second row on the same board that IS ready — the positive control every
   * suppression test below carries with it.
   *
   * A gate that suppressed every row would satisfy "the held row was not
   * named" perfectly, so each test proves the same pass that stayed silent
   * about the held row still names an unheld one, and still reports what it
   * held. Filed by the lead and vetted by Jordan, the real two-step: an
   * agent's own row starts in `triage`, which no dispatch read returns.
   */
  async function addReadyRow(workspaceId: string, title: string): Promise<string> {
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
    return task.id;
  }

  /**
   * The gate, over real rows on a real board.
   *
   * The unit tests next door pin each condition against a fake world. What
   * they cannot see is whether a REAL row in that state reaches the gate
   * looking the way the gate expects — whether an `assignee: 'human'` row
   * resolves to a person through the roster, whether a `needs: 'decision'`
   * ticket arrives carrying an open review item, whether a corrupt `reviews`
   * entry is a state the store can actually be in. Every one of those can be
   * right in isolation while the wake still names a row waiting on Bryan.
   */
  describe('a held row is not a stalled row', () => {
    /** Assert the pass stayed silent about the board, then that the SAME rule
     *  still fires for a row that is genuinely free. */
    async function expectHeldThenReady(
      ctx: { workspaceId: string; lead: ReturnType<typeof listenFrames> },
      expectHeld: Record<string, number>,
    ): Promise<Frame> {
      handle.nudgeReadyWork();
      await settle(400);
      expect(nudges(ctx.lead.frames, READY_IDLE_EVENT)).toHaveLength(0);

      const freeId = await addReadyRow(ctx.workspaceId, 'Cache the facet counts');
      await settle();
      handle.nudgeReadyWork();
      const got = await waitForFrames(ctx.lead.frames, READY_IDLE_EVENT, 1);

      expect(got).toHaveLength(1);
      expect(got[0]?.data?.taskId).toBe(freeId);
      expect(got[0]?.data?.readyCount).toBe(1);
      // The denominator: two rows examined, one named, one held — and the
      // frame says which. Without it "1 task is ready" reads identically on a
      // board with one row and on a board whose other rows all want Bryan.
      expect(got[0]?.data?.consideredCount).toBe(2);
      expect(got[0]?.data?.held).toEqual(expectHeld);
      return got[0] as Frame;
    }

    it('leaves a row owned by a person alone, and still names an agent-owned one', async () => {
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      await jj(
        await post(`/api/tasks/${taskId}/assignee`, {
          assignee: 'human',
          author: PERSON,
          workspaceId,
        }),
      );
      await settle();

      await expectHeldThenReady({ workspaceId, lead }, { 'awaiting-person': 1 });

      await lead.stop();
      await tab.stop();
    });

    it('leaves a row with an unanswered decision on it alone', async () => {
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      // The false alarm this whole change exists to remove, in three lines:
      // the agent raised a question, is waiting on Bryan for it, and the row
      // is still `todo`, still agent-owned, still unblocked — so every signal
      // the old wake read said "nobody has picked this up".
      await jj(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: LEAD,
          workspaceId,
          review: {
            shape: 'decision',
            headline: 'Rank by recency or by dwell time?',
            options: [
              { id: 'o-recency', label: 'Recency' },
              { id: 'o-dwell', label: 'Dwell time' },
            ],
          },
        }),
      );
      await settle();

      await expectHeldThenReady({ workspaceId, lead }, { 'awaiting-answer': 1 });

      await lead.stop();
      await tab.stop();
    });

    it('takes the row back once the question has an answer', async () => {
      // The other direction, which is what makes the suppression a HOLD rather
      // than a disappearance: the row returns to the queue on its own when the
      // thing it was waiting for arrives, with nothing to remember to clear.
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      const { item } = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: LEAD,
          workspaceId,
          review: {
            shape: 'decision',
            headline: 'Rank by recency or by dwell time?',
            options: [
              { id: 'o-recency', label: 'Recency' },
              { id: 'o-dwell', label: 'Dwell time' },
            ],
          },
        }),
      );
      await settle();
      handle.nudgeReadyWork();
      await settle(400);
      expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(0);

      await jj(
        await post(`/api/tasks/${taskId}/review-items/${encodeURIComponent(item.id)}/answer`, {
          text: 'Recency. Dwell time is the follow-up.',
          author: PERSON,
        }),
      );
      await settle();

      // The answer does NOT produce an idle nudge of its own, and that is the
      // existing frugality rule rather than the gate still holding the row:
      // `reviewAnswered` woke the lead about this very row a moment ago and
      // spends the board's arming so a second frame cannot follow it over the
      // same fact. So the row rejoining the queue is proven on the next pass
      // the board earns — here, when a sibling row arrives.
      const freeId = await addReadyRow(workspaceId, 'Cache the facet counts');
      await settle();
      handle.nudgeReadyWork();
      const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

      expect(got).toHaveLength(1);
      // Two ready rows, nothing held: the answered row is back in the queue
      // alongside the new one, and it leads because it is older.
      expect(got[0]?.data?.readyCount).toBe(2);
      expect(got[0]?.data?.consideredCount).toBe(2);
      expect(got[0]?.data?.taskId).toBe(taskId);
      expect(got[0]?.data?.held).toBeUndefined();
      expect(freeId).not.toBe(taskId);

      await lead.stop();
      await tab.stop();
    });

    it('leaves a row behind an open enforced dependency alone', async () => {
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      const blockerId = await addReadyRow(workspaceId, 'Rebuild the index');
      await jj(
        await post(`/api/tasks/${taskId}/after`, {
          after: [blockerId],
          afterEnforce: [blockerId],
          author: PERSON,
        }),
      );
      await settle();

      handle.nudgeReadyWork();
      const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

      // The blocker itself is free work, so the pass is not silent — it names
      // the row that can actually be started and reports the one it held.
      expect(got).toHaveLength(1);
      expect(got[0]?.data?.taskId).toBe(blockerId);
      expect(got[0]?.data?.readyCount).toBe(1);
      expect(got[0]?.data?.consideredCount).toBe(2);
      expect(got[0]?.data?.held).toEqual({ blocked: 1 });

      await lead.stop();
      await tab.stop();
    });
  });

  /**
   * "I could not read this row" must not arrive as "there was nothing here".
   *
   * A corrupt entry in a task's `reviews` array is a real state — the store
   * reads rows through `readTaskReviewItem`, which DROPS one that does not
   * parse rather than throwing, so a ticket whose questions are unreadable
   * answers "no open questions" byte-identically to a ticket that has none.
   * Every other reader is right to prefer a short list to an exception inside
   * a card. This one acts on the answer, and would wake somebody about a row
   * that may well be blocked on Bryan.
   */
  describe('a row it could not evaluate is reported, not swallowed', () => {
    it('withholds the row, says so on the frame, and still names a readable one', async () => {
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      const freeId = await addReadyRow(workspaceId, 'Cache the facet counts');
      // Written straight onto the stored row: this is the shape a half-written
      // sidecar leaves behind, and there is no route that produces it on
      // purpose — which is exactly why nothing downstream had ever seen it.
      const corrupt = handle.tasks.getTask(taskId) as { reviews?: unknown[] };
      corrupt.reviews = [{ id: 42, review: { shape: 'decision' } }];
      await settle();

      handle.nudgeReadyWork();
      const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

      expect(got).toHaveLength(1);
      // The readable row is still named — one unreadable row must not turn the
      // whole board into silence, which would trade a wrong answer for an
      // absent one.
      expect(got[0]?.data?.taskId).toBe(freeId);
      expect(got[0]?.data?.readyCount).toBe(1);
      expect(got[0]?.data?.consideredCount).toBe(2);
      // NOT in `held`: a hold is a state the gate read. This is the absence of
      // a reading, and counting it as healthy is the whole failure mode.
      expect(got[0]?.data?.held).toBeUndefined();
      expect(got[0]?.data?.undetermined).toEqual({
        count: 1,
        reasons: ['review-items-unreadable'],
      });

      await lead.stop();
      await tab.stop();
    });

    it('wakes the lead about a board where NOTHING could be evaluated', async () => {
      // The dangerous silence: no ready rows at all. Before this, that was
      // indistinguishable from a quiet, healthy board — the pass returned
      // early on `ready.length === 0` whether it had read every row or none.
      const { taskId, lead, tab } = await boardWithReadyWork();
      const corrupt = handle.tasks.getTask(taskId) as { reviews?: unknown[] };
      corrupt.reviews = [{ id: 42 }];
      await settle();

      handle.nudgeReadyWork();
      const got = await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

      expect(got).toHaveLength(1);
      expect(got[0]?.data?.readyCount).toBe(0);
      expect(got[0]?.data?.consideredCount).toBe(1);
      expect(got[0]?.data?.undetermined).toEqual({
        count: 1,
        reasons: ['review-items-unreadable'],
      });
      // No subject to start with, and the frame does not invent one.
      expect(got[0]?.data?.taskId).toBeUndefined();

      // …and the wake is the CORRUPTION, not a board that would have been
      // woken anyway. Repair the row and the same pass goes back to naming it.
      corrupt.reviews = [];
      handle.nudgeReadyWork();
      const after = await waitForFrames(lead.frames, READY_IDLE_EVENT, 2);
      expect(after).toHaveLength(2);
      expect(after[1]?.data?.taskId).toBe(taskId);
      expect(after[1]?.data?.undetermined).toBeUndefined();

      await lead.stop();
      await tab.stop();
    });

    it('stays silent on a board it read completely and found nothing ready', async () => {
      // The positive control for the clause above: silence must remain the
      // answer on a fully-evaluated quiet board, or the new rule turns every
      // one of them into a wake.
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      await jj(
        await post(`/api/tasks/${taskId}/transition`, {
          to: 'in-progress',
          author: LEAD,
          workspaceId,
        }),
      );
      await settle();

      handle.nudgeReadyWork();
      await settle(400);

      expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(0);

      await lead.stop();
      await tab.stop();
    });
  });

  /**
   * The instrument that can retire this feature, over a real board.
   *
   * The gate ships as a suppressor whose value is unproven, so what settles it
   * is a count of both outcomes. The unit tests pin the arithmetic; what they
   * cannot see is whether the real server's own pass feeds it — a counter
   * wired to nothing reads as a clean bill of health forever, which is the
   * exact shape of failure this whole change was built out of.
   */
  describe('the wake counts what it suppressed against what it delivered', () => {
    it('records a real suppression and a real delivery from the same board', async () => {
      const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();
      await jj(
        await post(`/api/tasks/${taskId}/assignee`, {
          assignee: 'human',
          author: PERSON,
          workspaceId,
        }),
      );
      await settle();

      handle.nudgeReadyWork();
      await settle(400);
      expect(handle.readyNudgeTally().suppressed).toEqual({ 'awaiting-person': 1 });
      expect(handle.readyNudgeTally().passed).toBe(0);

      // Positive control: the same counter has to move the other way, or
      // "passed: 0" is a statement about the wiring rather than about the gate.
      await addReadyRow(workspaceId, 'Cache the facet counts');
      await settle();
      handle.nudgeReadyWork();
      await waitForFrames(lead.frames, READY_IDLE_EVENT, 1);

      expect(handle.readyNudgeTally().passed).toBe(1);
      expect(handle.readyNudgeTally().since).toBeGreaterThan(0);

      await lead.stop();
      await tab.stop();
    });
  });

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

  /**
   * The reason parking exists. A lead who defers an unblocked row had, before
   * this, no way to say so that the board understood — so this pass kept
   * finding the row ready and kept spending a wake turn on it. One measured
   * board fired four identical nudges at one deferred row.
   *
   * How it says so changed on 2026-08-27: the row moves to `triage` and the
   * deferral is written as a comment, rather than a `parkedUntil` field the
   * gate had to learn about. The guarantee this fixture protects is the same
   * one, and it now rides on a rule the queue already had.
   */
  it('stops surfacing a row that has been parked', async () => {
    const { workspaceId, taskId, lead, tab } = await boardWithReadyWork();

    // Control: before the park, this board wakes its lead about this row.
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);
    lead.frames.length = 0;

    await jj(
      await post(`/api/tasks/${taskId}/park`, {
        parkedUntil: Date.now() + 7 * 86_400_000,
        reason: 'waiting on the index rebuild',
        author: PERSON,
      }),
    );
    await settle();
    handle.nudgeReadyWork();
    await settle();

    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(0);

    // And it is silent for the stated reason — the row is in triage — rather
    // than because the wake broke. `next` drops triage rows entirely.
    const { tasks } = await jj<{ tasks: Array<{ id: string }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/next`),
    );
    expect(tasks.find((t) => t.id === taskId)).toBeUndefined();
    const { tasks: all } = await jj<{ tasks: Array<{ id: string; status: string }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    expect(all.find((t) => t.id === taskId)?.status).toBe('triage');

    await lead.stop();
    await tab.stop();
  });

  /**
   * A liveness ping is not board activity, and reading it as activity made the
   * wake self-cancelling: the only lead a nudge can be DELIVERED to is one
   * holding a live stream, and a session holding a live stream is exactly the
   * one attaching and heartbeating — so the clock those pings reset was the
   * clock that decides whether that same lead is owed a wake.
   *
   * It also defeated the persisted stamp below, which is how it was found: a
   * lead reattaching after a deploy moved its board's clock past the stamp,
   * and the wake the stamp existed to suppress fired anyway.
   */
  it('does not treat an agent attach or heartbeat as the board moving', async () => {
    const { workspaceId, lead, tab } = await boardWithReadyWork();
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    // The lead pings. Nothing on the board changed, so nothing re-arms —
    // the stamp is still the one that was already spent.
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments/${LEAD.id}/heartbeat`, {
        toolCallAt: Date.now(),
      }),
    );
    await settle();
    handle.nudgeReadyWork();
    await settle();

    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await lead.stop();
    await tab.stop();
  });

  /**
   * The deploy case, which no unit test can reach: prod restarts at every
   * merge, and the armed map used to be process memory — so each release
   * handed every idle board a clean slate and billed its lead one wake turn
   * over a board that had not moved.
   */
  it('does not re-fire an identical wake after the server restarts', async () => {
    const { workspaceId, lead, tab } = await boardWithReadyWork();
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(lead.frames, READY_IDLE_EVENT)).toHaveLength(1);
    await lead.stop();
    await tab.stop();

    // A deploy: same data dir, new process.
    await handle.stop();
    handle = createServer({ port: 0, dataDir, readyNudgeIdleMs: 0 });
    base = `http://localhost:${handle.port}`;
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const revived = listenFrames(
      await fetch(
        `${base}/events/workspace/${workspaceId}?agentId=${encodeURIComponent(LEAD.id)}`,
        { headers: { accept: 'text/event-stream' } },
      ),
    );
    await settle();
    handle.nudgeReadyWork();
    await settle();

    expect(nudges(revived.frames, READY_IDLE_EVENT)).toHaveLength(0);

    // The silence is the STAMP, not a wake that could no longer be delivered.
    // Move the board and the same pass fires down the same stream.
    await jj(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'Cache the facet counts',
        body: 'Agent can serve facet counts from cache so that the sidebar stops blocking.',
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await settle();
    handle.nudgeReadyWork();
    await settle();
    expect(nudges(revived.frames, READY_IDLE_EVENT)).toHaveLength(1);

    await revived.stop();
  });
});
