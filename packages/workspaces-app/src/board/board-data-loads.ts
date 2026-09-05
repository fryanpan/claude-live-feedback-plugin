/**
 * The three REST reads the board keeps making, and the repaints they arm.
 *
 * One responsibility: everything the board learns from the server AFTER the
 * ydoc projection — the review-items list, the attachment/presence/release
 * read, and the audit log. They belong together because they share one rule
 * that is easy to break in isolation: **a read that never reached the server
 * is not an empty answer.** All three go through `applyRefresh`, so a restart
 * leaves the last good list on screen instead of emptying the presence row,
 * the review strip and the activity feed at once.
 *
 * The second shared rule is the repaint. Each load ends in
 * `schedule(<a stable closure>)` rather than calling the renders directly:
 * these fire constantly (SSE `agent.heartbeat` alone arrives every few
 * seconds) and iOS Safari drops a synthetic click when the element under the
 * finger is replaced mid-press. The three closures below are module-level
 * consts precisely so the guard can coalesce a burst during one press into a
 * single repaint — a fresh arrow per call would defeat that, which is why they
 * are not inlined.
 *
 * `eventsConsumerActive` is the third rule and the reason `loadEvents` lives
 * here rather than beside the Activity view: the log is ~1000 rows (~590KB on
 * the live board) and only two surfaces read it, so the gate belongs at the
 * fetch, where every SSE caller passes through it, not at each call site.
 *
 * `BoardLoadDeps` is the whole list of what these reads may reach.
 */
import type { BoardState } from './board-actions.ts';
import { fetchJson } from './board-actions.ts';
import {
  type ActivityEvent,
  type ClientRelease,
  type LeadSeatView,
  type PluginRelease,
  type PresenceAgent,
  type UptimeReport,
} from './board-presence-model.ts';
import { type ReviewThreadItem, applyRefresh, refreshReviewItems } from './board-review-model.ts';

/** Everything the loads need from `bootBoard`, and nothing else. */
export interface BoardLoadDeps {
  /** The board's one projection — every load writes into it. LIVE. */
  state: BoardState;
  /** The board these reads are addressed to. */
  workspaceId: string;
  /** Repaint behind the reader's finger — `repaintGuard.schedule`. A thunk
   *  because the guard is built after this module, and because the closures
   *  handed to it must stay stable for it to coalesce. */
  schedule(paint: () => void): void;
  renderBoardRegion(): void;
  renderHomeRegion(): void;
  renderDetail(): void;
  renderActivityRegion(): void;
  renderPresenceRegion(): void;
  renderLead(): void;
  /** Everyone a task can be handed to besides a person — read before and
   *  after the attachment load, so the pickers repaint on a CHANGE. */
  knownAgentIds(): string[];
}

/** What `bootBoard` keeps: the three loads, plus the one repaint closure the
 *  live wiring schedules on its own. */
export interface BoardLoads {
  loadReviewItems(): Promise<void>;
  loadAgents(): Promise<void>;
  loadEvents(): Promise<void>;
  /** The three regions the tasks projection and the review-items list feed.
   *  Handed to `wireBoardLive`, which schedules it on every ydoc move. */
  repaintQueueRegions: () => void;
}

export function createBoardLoads(deps: BoardLoadDeps): BoardLoads {
  const {
    state,
    workspaceId,
    schedule,
    renderBoardRegion,
    renderHomeRegion,
    renderDetail,
    renderActivityRegion,
    renderPresenceRegion,
    renderLead,
    knownAgentIds,
  } = deps;

  /** The three regions the tasks projection and the review-items list feed —
   *  every closure here is a STABLE reference, which is what lets the guard
   *  coalesce a burst of events during one press into one repaint. */
  const repaintQueueRegions = (): void => {
    renderBoardRegion();
    renderHomeRegion();
    renderDetail();
  };

  async function loadReviewItems(): Promise<void> {
    await refreshReviewItems(state, () =>
      fetchJson<{ items: ReviewThreadItem[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/review-items`,
      ),
    );
    // The task panel's review queue is handed down from this same list, so it
    // is stale until this repaint runs — which is why answering a card in the
    // panel repainted nothing at all before it was here.
    schedule(repaintQueueRegions);
  }

  async function loadAgents(): Promise<void> {
    const res = await fetchJson<{
      attachments: Array<{
        agentId: string;
        state?: PresenceAgent['state'];
        stateLabel?: string;
        lastToolCallAt: number;
      }>;
      seat?: LeadSeatView;
      pluginRelease?: PluginRelease;
      clientRelease?: ClientRelease;
    }>(`/workspaces/${encodeURIComponent(workspaceId)}/agents`);
    const before = knownAgentIds().join('\n');
    // Which sessions can't run what was merged. Rides the read the board
    // already makes, so nobody has to think to check.
    // Same guard as the review strip: a refresh that never reached the server
    // must not empty the presence row. During a restart every session looks
    // detached for as long as the fetch keeps failing, which reads as the
    // fleet going down rather than the server coming back.
    state.pluginRelease = applyRefresh(state.pluginRelease, res, (r) => r.pluginRelease ?? null);
    // …and which client every browser here is running. A failed build keeps
    // the previous release live, which is right — but it announced itself
    // only on the supervisor's stderr, so the split widened unread. Guarded
    // the same way: an unreachable server must not read as "no release".
    state.clientRelease = applyRefresh(state.clientRelease, res, (r) => r.clientRelease ?? null);
    // Guarded like the releases above: a read that never reached the server
    // must not read as a healthy seat. `?? null` keeps an older server's
    // silence as "no claim", which the strip renders as it always did.
    state.seat = applyRefresh(state.seat, res, (r) => r.seat ?? null);
    state.agents = applyRefresh(state.agents, res, (r) =>
      (r.attachments ?? []).map((a) => ({
        agentId: a.agentId,
        state: a.state ?? 'away',
        stateLabel: a.stateLabel ?? a.state ?? 'away',
        lastToolCallAt: a.lastToolCallAt,
      })),
    );
    renderPresenceRegion();
    // The picker's options come from the attachment list, so a fresh list is
    // also a fresh set of agents to hand the board to.
    renderLead();
    // …and the board and the open task render their pickers from a snapshot
    // taken when they last painted. This load is the ONLY thing that changes
    // that list: the first one lands after the first paint, so without this
    // the very first board offers nobody but 'human' until an unrelated task
    // update happens to repaint it. Guarded on the SET rather than fired on
    // every load, because `agent.heartbeat` arrives constantly and a board
    // re-render would close a picker somebody is reading.
    if (knownAgentIds().join('\n') !== before) {
      schedule(repaintBoardAndDetail);
    }
  }

  /** The agent-set repaint, held off the reader's finger like every other
   *  background repaint (stable reference — see `repaintQueueRegions`). */
  const repaintBoardAndDetail = (): void => {
    renderBoardRegion();
    renderDetail();
  };

  /** The activity log has a reader on screen. Only the Activity view and an
   *  open detail panel render `state.events` — everything else on the board
   *  lives off the projection — so with neither up, fetching ~1000 audit
   *  rows (~590KB on the live board) buys nothing. The SSE listeners
   *  keep calling in; this gate is what makes those calls free until one of
   *  the two readers opens, whose open paths already load on their own. */
  const eventsConsumerActive = (): boolean =>
    state.view === 'activity' || state.detailTaskId !== null || state.detailGoalId !== null;

  async function loadEvents(): Promise<void> {
    if (!eventsConsumerActive()) return;
    const res = await fetchJson<{ events: ActivityEvent[]; uptime: UptimeReport | null }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events`,
    );
    state.events = applyRefresh(state.events, res, (r) => r.events ?? []);
    state.uptime = applyRefresh(state.uptime, res, (r) => r.uptime ?? null);
    schedule(repaintActivityRegions);
  }

  /** Activity arrives on every board event, and the open panel re-reads the
   *  same rows — so this repaint fires constantly and must queue behind an
   *  in-flight tap. The conditions run at paint time, deliberately: what is
   *  showing when the repaint lands is what decides what it touches. */
  const repaintActivityRegions = (): void => {
    if (state.view === 'activity') renderActivityRegion();
    // The ticket's own Activity tab reads the same rows, so a refresh that
    // repainted only the workspace view left an open panel showing the
    // history as it stood when it opened.
    if (state.detailTaskId || state.detailGoalId) renderDetail();
  };

  return { loadReviewItems, loadAgents, loadEvents, repaintQueueRegions };
}
