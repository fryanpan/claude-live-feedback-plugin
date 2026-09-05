import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubLoads } from '../src/hub/hub-data-loads.ts';
import { hubState } from './support/hub-region-harness.ts';

/**
 * The three REST reads the board keeps making after the ydoc projection.
 *
 * They share one rule that is easy to break in isolation: **a read that never
 * reached the server is not an empty answer.** During a restart every fetch
 * fails, and an unguarded refresh empties the presence row, the review strip
 * and the release notices at once — which reads as the fleet going down
 * rather than as the server coming back. The other two rules driven here are
 * the events gate (~590KB nobody is looking at) and the repaint stability the
 * touch guard needs to coalesce.
 */
function loads(over: Partial<Parameters<typeof createHubLoads>[0]> = {}) {
  const state = hubState();
  const scheduled: Array<() => void> = [];
  const renders = {
    renderBoardRegion: vi.fn(),
    renderHomeRegion: vi.fn(),
    renderDetail: vi.fn(),
    renderActivityRegion: vi.fn(),
    renderPresenceRegion: vi.fn(),
    renderLead: vi.fn(),
  };
  const api = createHubLoads({
    state,
    workspaceId: 'w-1',
    schedule: (paint) => scheduled.push(paint),
    knownAgentIds: () => state.agents.map((a) => a.agentId),
    ...renders,
    ...over,
  });
  return { state, scheduled, ...renders, ...api };
}

function serve(body: unknown, ok = true) {
  vi.stubGlobal('fetch', () =>
    ok
      ? Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        )
      : Promise.reject(new Error('server restarting')),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHubLoads', () => {
  it('keeps the last good agent list when the server is unreachable', async () => {
    const l = loads();
    serve({ attachments: [{ agentId: 'a-1', lastToolCallAt: 5 }] });
    await l.loadAgents();
    expect(l.state.agents.map((a) => a.agentId)).toEqual(['a-1']);

    serve(null, false);
    await l.loadAgents();
    expect(l.state.agents.map((a) => a.agentId)).toEqual(['a-1']);
  });

  it('repaints the pickers only when the agent SET actually changed', async () => {
    // agent.heartbeat arrives constantly; a board re-render on every one
    // would close a picker somebody is reading.
    const l = loads();
    serve({ attachments: [{ agentId: 'a-1', lastToolCallAt: 5 }] });
    await l.loadAgents();
    const afterFirst = l.scheduled.length;
    await l.loadAgents();
    expect(l.scheduled.length).toBe(afterFirst);

    serve({
      attachments: [
        { agentId: 'a-1', lastToolCallAt: 5 },
        { agentId: 'a-2', lastToolCallAt: 6 },
      ],
    });
    await l.loadAgents();
    expect(l.scheduled.length).toBe(afterFirst + 1);
  });

  it('fetches no activity log while nothing on screen reads it', async () => {
    const l = loads();
    const fetched = vi.fn(() => Promise.resolve(new Response('{"events":[]}')));
    vi.stubGlobal('fetch', fetched);
    await l.loadEvents();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('fetches it once a reader is up — the Activity view or an open panel', async () => {
    for (const open of [
      { view: 'activity' as const },
      { detailTaskId: 't-1' },
      { detailGoalId: 'g-1' },
    ]) {
      const l = loads();
      Object.assign(l.state, open);
      const fetched = vi.fn(() =>
        Promise.resolve(
          new Response('{"events":[{"id":"e-1"}],"uptime":null}', {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
      vi.stubGlobal('fetch', fetched);
      await l.loadEvents();
      expect(fetched).toHaveBeenCalledTimes(1);
      expect(l.state.events).toHaveLength(1);
    }
  });

  it('repaints the queue’s three regions through ONE stable closure', () => {
    // The touch guard coalesces a burst during a press only when the closure
    // it is handed is the same reference every time; a fresh arrow per call
    // would defeat it silently.
    const l = loads();
    l.repaintQueueRegions();
    expect(l.renderBoardRegion).toHaveBeenCalledTimes(1);
    expect(l.renderHomeRegion).toHaveBeenCalledTimes(1);
    expect(l.renderDetail).toHaveBeenCalledTimes(1);
  });

  it('schedules the same closure object for every review-items load', async () => {
    const l = loads();
    serve({ items: [] });
    await l.loadReviewItems();
    await l.loadReviewItems();
    expect(l.scheduled).toHaveLength(2);
    expect(l.scheduled[0]).toBe(l.scheduled[1]);
  });
});
