/**
 * Everything that makes the board move without anybody touching it: the two
 * ydoc observers, the awareness feed the presence strip reads, the SSE
 * listeners that nudge the REST-backed regions, and the catch-up that refetches
 * after the stream was down.
 *
 * One call, run at the point in `main()` where these statements used to sit, so
 * subscription order is unchanged. `BoardLiveDeps` is the list of what the block
 * reached for out of that closure — and the list is the point: a reader can see
 * that the live path touches every region and four loaders without reading 180
 * lines of listener bodies.
 *
 * Why a push is refetched rather than applied: board changes arrive over the
 * ydoc and repaint from the projection, and SSE only says "that REST-fed list
 * is stale now". Crossing the two would paint a peer's transition twice, from
 * two sources.
 */
import { connect } from '@feedback/core';
import type { BootLocation } from '../boot-env.ts';
import { renderLiveStaleNotice, watchConnection, watchLiveSync } from '../connection-state.ts';
import { staleTaskLinkStatuses } from '../link-titles.ts';
import type { BoardState } from './board-actions.ts';
import { discussionIsBusy } from './board-discussion-render.ts';
import {
  ACTIVITY_REFRESH_EVENTS,
  type PresencePerson,
  presenceIdentity,
} from './board-presence-model.ts';
import { startHomeClock } from './home-clock.ts';

/** The row shape `loadDiscussion` accepts — a task or a goal, both of which
 *  keep their comments in a body doc, so the id is always resolvable. */
export interface LiveDiscussionRow {
  id: string;
  bodyDocId: string;
}

/** What the live path reaches for. Every entry is something the block below
 *  used to capture from `main()`'s closure; everything it imports outright is
 *  above, not here. */
export interface BoardLiveDeps {
  workspaceId: string;
  /** This browser's identity — the awareness row's `user`. */
  user: { id: string; name: string; color?: string };
  /** The board's working state. The listeners read it to decide what a push is
   *  worth repainting, and never write it. */
  state: BoardState;
  client: ReturnType<typeof connect>;
  tasksMap: { observeDeep: (cb: () => void) => void };
  wsMap: { observeDeep: (cb: () => void) => void };
  /** Pull the ydoc into `state`. Runs synchronously on every observer tick —
   *  state must be current the moment the ydoc moves, even though the paint
   *  that follows is deferred. */
  readProjection: () => void;
  /** The tap-safe repaint door. A background-triggered paint parks here during
   *  a press and flushes, coalesced, once the tap completes. */
  repaintGuard: { schedule: (fn: () => void) => void };
  repaintQueueRegions: () => void;
  /** The armed `?walk=1` handoff's tick, when one is armed. A thunk, because
   *  the variable it reads is assigned after this wiring runs. */
  autoWalkTick: () => void;
  renderLead: () => void;
  renderBoardRegion: () => void;
  renderHomeRegion: () => void;
  renderDetail: () => void;
  renderPresenceRegion: () => void;
  /** Awareness rows as the presence strip reads them. */
  peopleFromAwareness: () => PresencePerson[];
  loadAgents: () => Promise<void>;
  loadEvents: () => Promise<void>;
  loadHome: () => Promise<void>;
  loadReviewItems: () => Promise<void>;
  loadDiscussion: (row: LiveDiscussionRow, quiet?: boolean) => Promise<void>;
  /** The address bar the boot was handed. Following a person off this board
   *  leaves through it, so a test can read where the follow sent us. */
  location: Pick<BootLocation, 'assign'>;
}

export function wireBoardLive(deps: BoardLiveDeps): void {
  const {
    workspaceId,
    user,
    state,
    client,
    tasksMap,
    wsMap,
    readProjection,
    repaintGuard,
    repaintQueueRegions,
    autoWalkTick,
    renderLead,
    renderBoardRegion,
    renderHomeRegion,
    renderDetail,
    renderPresenceRegion,
    peopleFromAwareness,
    loadAgents,
    loadEvents,
    loadHome,
    loadReviewItems,
    loadDiscussion,
    location,
  } = deps;

  // ── Wiring ──────────────────────────────────────────────────────────────
  // Both observers read the projection at once (state must be current the
  // moment the ydoc moves) but paint through the guard: a peer's transition
  // arriving over the ydoc rebuilds the same regions the SSE path does, and
  // was eating taps the same way.
  tasksMap.observeDeep(() => {
    readProjection();
    // Home rides along with the board — without it the first projection lands
    // after Home's first paint and the queue stays empty while the board
    // banner (painted by renderBoardRegion) counts it.
    repaintGuard.schedule(repaintQueueRegions);
    autoWalkTick();
  });
  const repaintWorkspaceRegions = (): void => {
    renderLead();
    renderBoardRegion();
    renderHomeRegion();
    // Goal facts (title, status, owner, due) travel on the WORKSPACE map,
    // not the tasks map — an open goal panel repaints here or shows a peer's
    // rename never.
    if (state.detailGoalId) renderDetail();
  };
  wsMap.observeDeep(() => {
    readProjection();
    repaintGuard.schedule(repaintWorkspaceRegions);
  });

  client.awareness.setLocalState({
    // `id` rides along because the presence strip has to know WHO, and a
    // display name cannot answer that — two people called Alex would be one
    // chip, and following either would sometimes land on the other. `User.id`
    // is the stable per-browser id (localStorage, or a known user's own), so
    // it is the same across this person's tabs and different for anybody else:
    // exactly the two things the strip's row key must get right.
    user: { id: user.id, name: user.name, color: user.color },
    surface: 'board',
    lastActive: Date.now(),
  });
  client.awareness.on('update', () => {
    renderPresenceRegion();
    // Follow (§2.7): when the followed person's surface moves, ours does too.
    // The key names the PERSON now, not one of their connections, so the
    // follow is resolved back through awareness by identity and lands on
    // whichever of their tabs moved most recently. That also means a follow
    // survives the followed person reloading — under the old `p-<clientId>`
    // key their new connection was a stranger, and the follow went quiet
    // without ever saying so.
    if (state.followedKey?.startsWith('p-')) {
      const identity = state.followedKey.slice(2);
      const [moved] = peopleFromAwareness()
        .filter((p) => presenceIdentity(p) === identity && p.docId)
        .sort((a, b) => b.lastActive - a.lastActive);
      if (moved?.docId) location.assign(`/review/${encodeURIComponent(moved.docId)}`);
    }
  });
  let lastActivePush = 0;
  const touch = () => {
    const now = Date.now();
    if (now - lastActivePush < 30_000) return;
    lastActivePush = now;
    const cur = client.awareness.getLocalState() ?? {};
    client.awareness.setLocalState({ ...cur, lastActive: now });
  };
  window.addEventListener('pointerdown', touch, { passive: true });
  window.addEventListener('keydown', touch, { passive: true });
  const presenceTick = setInterval(() => renderPresenceRegion(), 30_000);
  // Home's ages and time-keyed flags advance without a board event: a minute
  // tick, only while Home is showing (home-clock.ts).
  const stopHomeClock = startHomeClock(() => state.pane === 'home', renderHomeRegion);
  window.addEventListener('beforeunload', () => {
    clearInterval(presenceTick);
    stopHomeClock();
    client.close();
  });

  // SSE: agent presence + activity refresh. Board changes arrive via the
  // ydoc; SSE only nudges the REST-backed regions.
  const es = new EventSource(`/workspaces/${encodeURIComponent(workspaceId)}/events:stream`);
  for (const name of ['agent.attached', 'agent.detached', 'agent.heartbeat']) {
    es.addEventListener(name, () => void loadAgents());
  }
  // The list lives beside `describeEvent` in board-presence-model, because the two must
  // move together — an event the trail renders but this loop never hears is
  // an Activity tab that silently misses it, on the writer's own screen as
  // much as a peer's (the server echoes local writes back over SSE, which is
  // what puts a row under the due date you just set).
  for (const name of ACTIVITY_REFRESH_EVENTS) {
    es.addEventListener(name, () => {
      void loadEvents();
      // The same board changes stale the Home brief. Refreshing only while
      // Home is showing keeps a background board tab from queueing model
      // calls nobody is reading.
      if (state.pane === 'home') void loadHome();
    });
  }
  // A reply to the question you just asked is the case this whole surface is
  // for, so it lands in the open panel without a reload. These events reach
  // the workspace channel only because a task body room fans out to it — the
  // board is not subscribed to each task's own doc stream.
  for (const name of ['thread.created', 'thread.replied', 'thread.resolved', 'thread.reopened']) {
    es.addEventListener(name, () => {
      // Every one of these can change what is waiting on a person — a new
      // question arrives, someone answers one, a thread is closed. The strip
      // is the surface that has to be right when Bryan comes back, so it
      // refreshes whether or not a task panel happens to be open.
      void loadReviewItems();
      // Whichever panel is open — a goal's discussion goes as stale as a
      // task's, and it is reached through the same room, so leaving it out
      // would mean a comment landing on a goal was invisible until the reader
      // closed and reopened the panel.
      const open: LiveDiscussionRow | undefined = state.detailTaskId
        ? state.tasks.get(state.detailTaskId)
        : state.detailGoalId
          ? { id: state.detailGoalId, bodyDocId: `task:${state.detailGoalId}` }
          : undefined;
      if (!open || discussionIsBusy(document)) return;
      void loadDiscussion(open, true);
    });
  }
  // A task going done takes its discussion out of the queue.
  es.addEventListener('task.transitioned', () => void loadReviewItems());
  // …and stales every status chip a pasted task/goal link is wearing, so the
  // chips re-ask on the same push instead of showing the old status forever.
  es.addEventListener('task.transitioned', () => staleTaskLinkStatuses());

  // ── Catching up after the stream could not reach us ────────────────────
  //
  // Reported 2026-08-19: a new Home queue item did not appear until the page
  // was reloaded. Everything above is correct WHILE the stream is up — an
  // item posted against a healthy staging build paints in about a second.
  // The gap was the window where the stream is down: the server replays
  // nothing (there is no `Last-Event-ID` handling anywhere), and until now
  // every refetch after boot hung off one of these listeners — no error
  // handler, no reopen handler, no visibility handler, no poll. `EventSource`
  // reconnects by itself, so the page came back looking healthy and silently
  // missing whatever was created while it was away. That window is a server
  // restart (so, every deploy), a slept laptop, or a backgrounded phone.
  const streamStatus = (cb: (s: 'open' | 'closed') => void) => {
    es.addEventListener('open', () => cb('open'));
    // EventSource reports both a retriable drop and a fatal one here; the
    // difference does not change what the reader needs, which is a refetch
    // when it comes back and the truth on screen while it has not.
    es.addEventListener('error', () => cb('closed'));
  };
  const onVisible = (cb: () => void) => {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) cb();
    });
    // A network that comes back without the tab ever being hidden — the
    // phone that changed cells while its owner was reading.
    window.addEventListener('online', () => cb());
  };
  watchLiveSync({
    onStatus: streamStatus,
    onVisible,
    // Everything the listeners above keep fresh, refetched as one batch. The
    // brief is included only while Home is showing, for the same reason the
    // per-event path does it: a background tab must not queue model calls.
    resync: () => {
      void loadAgents();
      void loadEvents();
      void loadReviewItems();
      if (state.pane === 'home') void loadHome();
    },
  });
  // Its own line, under the reconnect banner rather than sharing it: that one
  // is about the editing socket and tells you to keep the tab open, this one
  // is about the queue being a stale read. A reader who is not told acts on
  // the stale list — silence that looks like calm.
  const staleNotice = document.createElement('div');
  staleNotice.className = 'conn-banner conn-banner--stale hidden';
  staleNotice.setAttribute('role', 'status');
  staleNotice.setAttribute('aria-live', 'polite');
  document.getElementById('board-connection')?.after(staleNotice);
  watchConnection({
    onStatus: streamStatus,
    onView: (view) => renderLiveStaleNotice(staleNotice, view),
  });
}
