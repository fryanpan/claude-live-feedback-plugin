/**
 * The websocket fan-out of a doc room: who hears about a change, and over
 * which channel.
 *
 * The other half of `doc-store.ts`, which keeps the room LIFECYCLE — hydrate,
 * evict, tear down, persist the `.ydoc` and its index row. This half is
 * everything that happens because a room changed rather than because it
 * exists: the `ydoc.on('update')` wiring and the meta guards that ride it,
 * the thread / suggestion frames, the SSE + webhook broadcast behind them,
 * the shared presence ticker, and the socket closes a revoked share or a
 * teardown has to perform.
 *
 * The handle is the ROOM OBJECT, not a docId, and that is the whole reason
 * the seam is here rather than a line range: every path below reads
 * `room.ydoc`, `room.conns`, `room.meta` or `room.seq` on the frame it is
 * building, so a lookup-by-id version would re-resolve the room several
 * times per broadcast and could disagree with the caller about which one it
 * has. `RoomFanoutHost` carries only what a frame cannot get from the room
 * itself — the SSE bus and webhook dispatcher, the persist debounce, the
 * companion/review projections, and the resident room map the share sweeps
 * walk.
 *
 * Timings, ordering and log lines are unchanged from when this lived in
 * `doc-store.ts`: the re-anchor debounce, the one-eid-per-broadcast rule, the
 * order the SSE channels are written in and the presence tick are all
 * observable contracts, and this file moved them without touching them.
 */
import {
  type DocMeta,
  type Thread,
  type User,
  type WebhookPayload,
  attachmentIdOf,
  contentKind,
  prose,
  setThreadSummary,
  suggestOps,
} from '@feedback/core';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { DOC_STORE_TIMINGS } from './doc-store-timings.ts';
import type { DocRoom, FeedbackWs, ShareAuthorizedSocket } from './doc-store.ts';
import { newEventId } from './event-id.ts';
import { isPrivateMetaKey } from './private-meta.ts';
import type { SseBus } from './sse.ts';
import type { ThreadSummarizer } from './summarize.ts';
import type { WebhookDispatcher } from './webhooks.ts';

/** Yjs origin for the private-meta guard's own deletes, so it never
 *  re-enters on its own transaction. */
const PRIVATE_META_GUARD_ORIGIN = 'private-meta-guard';

/**
 * Does this transaction origin mean a PERSON or an AGENT changed the doc, as
 * opposed to the server writing to itself? Feeds `DocRoom.lastContentChangeAt`.
 *
 * An ALLOW-list, and the difference is the whole correctness argument. Yjs
 * stamps a bare `undefined` origin on any transaction that does not name one,
 * and a great deal of server bookkeeping does exactly that: the meta and
 * diff-meta writes in `binds.ts`, every thread create / resolve / re-anchor
 * write in `packages/core/src/schema.ts`, the `summaryPendingTs` marker in
 * this file, the `setId` backfill above. A deny-list of known-synthetic
 * origins counted all of them as somebody working — which is the same failure
 * as the `.ydoc` mtime the stall loop already had to learn not to trust
 * (landing.ts rule 1), reached by a different road. Caught in review; the
 * first version of this hook had that bug.
 *
 * Two shapes count:
 *  - the CONNECTION OBJECT of one of this room's live websockets — a person
 *    typing in the browser editor. `lastHumanEditAt` identifies them the
 *    same way, a few hundred lines below.
 *  - an `agent…` string. Every server-side writer acting FOR an agent stamps
 *    one: plain `agent` from `packages/core/src/prose.ts`, which is every
 *    prose edit tool (`find_and_replace`, `rewrite_thread_region`,
 *    `edit_at_anchor`, …), plus `agent-set-content`, `agent-queued`,
 *    `agent-meeting-assistant`.
 *
 * `agent-reanchor` is the one agent-shaped exception: it is the server's own
 * thread re-anchor sweep, which runs in REACTION to an edit, so counting it
 * would let a single real edit keep re-arming the clock by itself.
 *
 * Excluding the undefined-origin THREAD writes costs the stall loop nothing —
 * a comment already reaches the same clock as `thread.lastActivity`; see the
 * caller in server.ts. And hydration is excluded twice over: `wireEvents` is
 * wired after `loadFromDisk`, so a room's load never reaches the hook at all.
 */
const REANCHOR_ORIGIN = 'agent-reanchor';

/** Yjs origin for the server's own `contentRevision` / plan-state meta
 *  writes. Deliberately NOT agent-shaped: these land in the room's update
 *  hook, and an authoring origin would re-arm the debounce that fired them. */
export const CONTENT_REVISION_ORIGIN = 'content-revision';

/**
 * Meta keys ONLY the server may write, though they live in the synced CRDT
 * map (they must: planState is what the doc page renders, and contentRevision
 * has to survive a restart). The map is writable by any connected editor —
 * share visitors included — so without a guard a peer could set
 * `planState: 'approved'` and file rows past the hold, or move
 * `contentRevision` and suppress or fabricate stale flags. `guardServerMeta`
 * reverts any write to these keys whose transaction origin is not the
 * server's own.
 */
const SERVER_META_KEYS = [
  'planState',
  'planApprovedBy',
  'planApprovedAt',
  'planRequestedAt',
  'planRequestedBy',
  'reviewRequestedAt',
  'reviewRequestedBy',
  'reviewThreadId',
  'contentRevision',
] as const;

function isAuthoringOrigin(room: DocRoom, origin: unknown): boolean {
  if (typeof origin === 'string') return origin.startsWith('agent') && origin !== REANCHOR_ORIGIN;
  if (typeof origin !== 'object' || origin === null) return false;
  return room.conns.has(origin as FeedbackWs);
}

/** How long after a content change the thread re-anchor sweep runs. */
const REANCHOR_MS = DOC_STORE_TIMINGS.reanchorMs;

/** y-protocols' own presence constants, restated because its per-instance
 *  interval is replaced by one shared ticker (see `maintainAwareness`).
 *  `outdatedTimeout` is not exported from the package's typings. */
const AWARENESS_OUTDATED_MS = 30_000;
const AWARENESS_TICK_MS = AWARENESS_OUTDATED_MS / 10;

/**
 * The maintenance y-protocols' `Awareness` constructor would run on its own
 * 3s interval: renew the local clock before it goes outdated, and evict
 * remote clients that have stopped reporting.
 *
 * Reimplemented over the public surface (`getLocalState` / `setLocalState` /
 * `meta` / `states` / `removeAwarenessStates`) so ONE ticker can drive every
 * room. The library's version is per instance and never unref'd; on a server
 * that hydrates every persisted doc that was thousands of timers firing
 * forever for rooms with no sockets on them.
 *
 * Exported so the equivalence is testable rather than asserted.
 */
export function maintainAwareness(aw: awarenessProtocol.Awareness, now = Date.now()): void {
  const local = aw.getLocalState();
  const localMeta = aw.meta.get(aw.clientID);
  if (local !== null && localMeta && AWARENESS_OUTDATED_MS / 2 <= now - localMeta.lastUpdated) {
    aw.setLocalState(local);
  }
  const remove: number[] = [];
  aw.meta.forEach((meta, clientId) => {
    if (
      clientId !== aw.clientID &&
      AWARENESS_OUTDATED_MS <= now - meta.lastUpdated &&
      aw.states.has(clientId)
    ) {
      remove.push(clientId);
    }
  });
  if (remove.length > 0) awarenessProtocol.removeAwarenessStates(aw, remove, 'timeout');
}

/**
 * What the fan-out needs from the room lifecycle, as thunks onto the live
 * thing rather than copies of it. Nothing here owns state this file owns
 * (the presence ticker and its room set), and nothing this file does reaches
 * the lifecycle any other way.
 */
export interface RoomFanoutHost {
  /** Every RESIDENT room — the set the share-socket sweeps walk. */
  residentRooms(): Iterable<DocRoom>;
  sse(): SseBus;
  webhooks(): WebhookDispatcher;
  /** `DocStoreConfig.decorateDocMeta`, already defaulted to identity. */
  decorate(meta: DocMeta): DocMeta;
  /** `DocStoreConfig.onRoomEvent`, already defaulted to a no-op. */
  emitRoomEvent(docId: string, payload: WebhookPayload): void;
  summarizer(): ThreadSummarizer | undefined;
  thread(docId: string, threadId: string): Thread | null;
  memberOfCompanion(docId: string): string | undefined;
  /** The `.ydoc` persist debounce. */
  schedulePersist(room: DocRoom): void;
  scheduleRevisionBump(room: DocRoom): void;
  maybeRebindHome(room: DocRoom): void;
}

/**
 * The fan-out for every room this server holds. One instance per `DocStore`,
 * holding the one presence ticker that serves all of them.
 */
export class RoomFanout {
  /** DocStore that have a live Awareness instance, i.e. the ones the shared
   *  presence ticker has to visit. */
  private awarenessRooms = new Set<DocRoom>();

  private awarenessTicker: ReturnType<typeof setInterval> | null = null;

  constructor(private host: RoomFanoutHost) {}

  /** DocStore holding presence, and the ticker count `DocStore.stats` folds in. */
  stats(): { awareness: number; timers: number } {
    return { awareness: this.awarenessRooms.size, timers: this.awarenessTicker ? 1 : 0 };
  }

  /**
   * Forget a room that is leaving memory. The Awareness itself is destroyed
   * by the caller (which peeks rather than constructs); this only drops the
   * sweep entry, so the ticker stops when the last one goes.
   */
  forgetRoom(room: DocRoom): void {
    this.awarenessRooms.delete(room);
  }

  /**
   * Close every socket on one room, because the room is going away. 1000 is
   * a normal close: nothing was violated, the doc simply no longer exists.
   */
  closeSockets(room: DocRoom, reason: string): void {
    for (const ws of room.conns) {
      try {
        ws.close(1000, reason);
      } catch {}
    }
  }

  /**
   * Stop the shared presence ticker. It stops itself when the last Awareness
   * goes, but a shutdown does not wait for that: leaving it running holds
   * callbacks into a DocStore nobody is using any more.
   */
  stop(): void {
    if (this.awarenessTicker) clearInterval(this.awarenessTicker);
    this.awarenessTicker = null;
  }

  /**
   * Build this room's Awareness and enrol it in the shared presence ticker.
   *
   * The library instance's own interval is stopped immediately: it is the
   * per-room timer this whole change exists to remove, and `maintainAwareness`
   * does its work from one place instead.
   */
  createAwareness(room: DocRoom): awarenessProtocol.Awareness {
    const aw = new awarenessProtocol.Awareness(room.ydoc);
    clearInterval(
      (aw as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval,
    );
    this.awarenessRooms.add(room);
    if (!this.awarenessTicker) {
      const timer = setInterval(() => this.sweepAwareness(), AWARENESS_TICK_MS);
      timer.unref?.();
      this.awarenessTicker = timer;
    }
    return aw;
  }

  /**
   * Presence maintenance for every room that HAS an Awareness — including the
   * ones with no sockets left on them.
   *
   * Skipping socketless rooms looked free and was not (codex, P2): a peer
   * whose socket went away without its cleanup running leaves its state
   * behind, and `onOpen` hands `getStates()` to the next joiner before any
   * sweep can fire. That joiner would see a ghost. The library's timer
   * expired those states whether or not anyone was connected, and this must
   * too — the count of rooms holding an Awareness is the count that have ever
   * been opened, tens rather than thousands, so there was nothing to save.
   *
   * A room whose last socket has gone keeps its Awareness rather than
   * destroying it: `yjs-protocol.ts` registers the room's broadcast handler
   * against that instance once, in a WeakMap keyed by room, so a replacement
   * instance would never get an `update` listener and presence would stop
   * working silently on the next connection.
   */
  private sweepAwareness(): void {
    const now = Date.now();
    let live = 0;
    for (const room of this.awarenessRooms) {
      const aw = room.peekAwareness();
      if (!aw) {
        this.awarenessRooms.delete(room);
        continue;
      }
      live++;
      maintainAwareness(aw, now);
    }
    if (live === 0 && this.awarenessTicker) {
      clearInterval(this.awarenessTicker);
      this.awarenessTicker = null;
    }
  }

  /**
   * Share-authorized sockets that no room's `conns` holds.
   *
   * The three sweeps below used to walk `conns` alone, which is the yjs
   * editing sockets and nothing else. A meeting's `/audio/<docId>` socket is
   * authorized by the same share at its own upgrade, opens a microphone and
   * a billed transcription session, and lives in `MeetingRelay`'s WeakMap —
   * which cannot be enumerated. So revoking a share, removing a member or
   * throwing the sharing master switch closed the editor and left the
   * microphone running against a doc the person may no longer read.
   *
   * Registered from the websocket `open` handler and dropped from `close`
   * (server.ts, via `DocStore`), so this holds exactly the live ones.
   */
  private readonly trackedShareSockets = new Set<ShareAuthorizedSocket>();

  /**
   * Put a non-room socket in front of the sweeps below.
   *
   * Sockets carrying NO share and NO membership are not tracked at all: the
   * owner's own audio socket is never offered to a matcher, which is the
   * same guarantee `conns` gives by carrying an absent `shareId`.
   *
   * A third long-lived transport authorized by a share belongs here too —
   * nothing else will catch it, because a sweep can only close what it can
   * enumerate.
   */
  trackShareSocket(ws: ShareAuthorizedSocket): void {
    if (!ws.data?.shareId && !ws.data?.shareMember) return;
    this.trackedShareSockets.add(ws);
  }

  /** Drop a tracked socket — its `close` handler, whatever closed it. */
  untrackShareSocket(ws: ShareAuthorizedSocket): void {
    this.trackedShareSockets.delete(ws);
  }

  /**
   * Every socket a share authorized: the rooms' editing sockets, then the
   * tracked ones beside them.
   *
   * Straight over the room map. `list()` + `get()` walked the same rooms but
   * built a fresh DocMeta for every one of them and then looked each back up
   * by id — and `get` marks a doc ACCESSED, which is what put the whole
   * corpus in the file poll's fast lane. See `closeSocketsForDeadShares`.
   */
  private *shareAuthorizedSockets(): Generator<ShareAuthorizedSocket> {
    for (const room of this.host.residentRooms()) {
      for (const ws of room.conns) yield ws;
    }
    for (const ws of this.trackedShareSockets) yield ws;
  }

  /**
   * Close every websocket a given share opened. Revocation and expiry are
   * enforced per HTTP request, but a websocket is authorized ONCE at its
   * upgrade — so an already-connected visitor kept reading and writing the
   * doc after the share was revoked. Verified: the socket stayed open and
   * writable while HTTP returned 401.
   *
   * 1008 is the "policy violation" close code, which is what this is.
   */
  closeSocketsForShare(shareId: string): number {
    let closed = 0;
    for (const ws of this.shareAuthorizedSockets()) {
      if (ws.data?.shareId !== shareId) continue;
      try {
        ws.close(1008, 'share revoked');
      } catch {
        // Already gone — the close handler does the bookkeeping.
      }
      closed += 1;
    }
    return closed;
  }

  /**
   * Close every socket whose authorizing MEMBERSHIP the predicate names.
   *
   * A predicate rather than a key, because the two callers ask different
   * questions with it: ejecting one member matches one key, and turning the
   * external-access switch off matches every one of them. Sockets carrying no
   * membership — the owner's, an agent's, the retired per-share mode's — are
   * never offered to it, so neither caller can reach them by mistake.
   */
  closeSocketsForShareMembers(match: (memberKey: string) => boolean): number {
    let closed = 0;
    for (const ws of this.shareAuthorizedSockets()) {
      const key = ws.data?.shareMember;
      if (!key || !match(key)) continue;
      try {
        ws.close(1008, 'share access ended');
      } catch {
        // Already gone — the close handler does the bookkeeping.
      }
      closed += 1;
    }
    return closed;
  }

  /** Close sockets whose authorizing share is no longer live (revoked or
   *  expired). Returns the shareIds that were swept. */
  closeSocketsForDeadShares(isLive: (shareId: string) => boolean): string[] {
    const dead = new Set<string>();
    // This runs every 60s for the life of the server, over every room, and it
    // only ever reads `conns`. Two things were wrong with reaching them via
    // `list()` + `get()`:
    //
    //  - `get` counts as an ACCESS. On a 5,624-room server the sweep marked
    //    every bound doc accessed once a minute, and the file poll's active
    //    window is also 60s — so from the first sweep onward the fast lane
    //    never emptied and every bound file was stat'd every 500ms. Measured
    //    on a copy of the production data directory: one sweep took
    //    activeBindings from 0 to 4,196, and production sat pinned at 2,549
    //    from ~90s of uptime onward.
    //  - `list()` allocates a spread DocMeta per room, so the sweep also
    //    produced several MB of garbage a minute for a pass that reads one
    //    field of one Set.
    //
    // The room map is the same set `list()` maps over, so coverage is
    // unchanged.
    for (const ws of this.shareAuthorizedSockets()) {
      const id = ws.data?.shareId;
      if (!id || isLive(id)) continue;
      dead.add(id);
    }
    for (const id of dead) this.closeSocketsForShare(id);
    return Array.from(dead);
  }

  fireEvent(
    room: DocRoom,
    event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened',
    thread: Thread,
    comment?: { id: string; author: User; text: string; ts: number },
    opts?: { generate?: boolean },
    // Who performed a resolve/reopen. The comment param can't carry it —
    // there is no comment on a status change, and a frame without an actor
    // sent channel renderers to comments[0].author, i.e. the CREATOR.
    actor?: User,
  ): void {
    room.seq++;
    // Every thread change funnels through here, which is exactly why the
    // summary trigger lives here and not at the four call sites: a fifth
    // event added later gets summarization for free rather than silently
    // going without it.
    if (opts?.generate !== false) this.scheduleSummary(room, thread.id);
    const decorate = (m: DocMeta) => this.host.decorate(m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      threadId: thread.id,
      thread,
      doc: decorate(room.meta),
      comment,
      ...(actor ? { actor } : {}),
      // A comment ON a review item names the item at the top level, so the
      // owner's channel line can say which item to revise without walking
      // the thread's anchor.
      ...(thread.anchor.kind === 'review-item' ? { reviewItemId: thread.anchor.reviewItemId } : {}),
      seq: room.seq,
    });
  }

  /**
   * Suggestion verdict events (redline-suggestions phase 2, commit 3):
   * `suggestion.created` / `suggestion.accepted` / `suggestion.rejected` on
   * the same doc/workspace channel thread events use, so a suggesting agent
   * hears the outcome via `watch_doc` without polling `list_suggestions`.
   * `summary` is the SuggestionSummary captured BEFORE the mutation for
   * accept/reject (the marks are gone afterward, so there's nothing left to
   * scan) — undefined only if the sid vanished between scan and fire, which
   * shouldn't happen since callers scan and mutate in the same call.
   */
  fireSuggestionEvent(
    room: DocRoom,
    event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected',
    sid: string,
    summary: suggestOps.SuggestionSummary | undefined,
  ): void {
    room.seq++;
    const decorate = (m: DocMeta) => this.host.decorate(m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      sid,
      suggestion: summary,
      doc: decorate(room.meta),
      seq: room.seq,
    });
  }

  /**
   * Ask for a generated summary for one thread, if generation is configured.
   *
   * Reads the thread fresh at call time rather than capturing it: three
   * seconds of debounce is long enough for two more replies to land, and the
   * summary must describe the thread as it will be, not as it was.
   */
  private scheduleSummary(room: DocRoom, threadId: string): void {
    const summarizer = this.host.summarizer();
    if (!summarizer) return;
    // Tell the clients a generation was QUEUED — the synced marker is what
    // lets a card truthfully say "Generating summary…" for exactly the
    // activity that scheduled one. Written per schedule, not per doc,
    // because not all activity generates: share-visitor writes are gated
    // (`generate: false` never reaches this method) and must not pend.
    // Written only when enabled, so a key-less server promises nothing.
    if (summarizer.enabled) {
      const threadMap = (room.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).get(threadId);
      if (threadMap) {
        room.ydoc.transact(() => threadMap.set('summaryPendingTs', Date.now()));
      }
    }
    summarizer.schedule({
      docId: room.docId,
      threadId,
      getThread: () => this.host.thread(room.docId, threadId),
      apply: (summary) => {
        // Writes into the SAME ydoc the browsers are synced to, so the new
        // lines appear on every open card without a reload.
        setThreadSummary(room.ydoc, threadId, summary);
        this.host.schedulePersist(room);
      },
    });
  }

  /** Shared SSE + workspace + webhook fan-out behind fireEvent /
   *  fireSuggestionEvent. Caller stamps `event`/`seq`/`doc` into payload. */
  broadcastToRoom(room: DocRoom, payload: WebhookPayload): void {
    // ONE id per broadcast, stamped before the fan-out so every channel below
    // carries the same string. That is what lets a subscriber holding two of
    // these channels collapse the copies without having to guess from `seq`,
    // which is per-room AND per-server-epoch and therefore repeats after any
    // restart — a guess whose wrong answer is a comment silently swallowed.
    // See event-id.ts.
    payload.eid = newEventId();
    this.host.sse().broadcast(room.docId, payload);
    // A companion editor doc (openEditableFile) is the same FILE as its diff
    // member, opened for prose; the reviewer comments in whichever view they
    // are reading, and the agent watching the member never learned the
    // companion's id — nothing hands it back. So a companion's events ride
    // the member's own channel too. Same eid on every copy, so a watcher
    // holding both collapses them.
    const memberId = this.host.memberOfCompanion(room.docId);
    if (memberId) this.host.sse().broadcast(memberId, payload);
    // Double-broadcast on the REVIEW's channel — the `setId` a diff review or
    // folder bind stamps on each member — so an agent can watch ONE stream per
    // review instead of one per file.
    //
    // The REVIEW, and only the review. A doc filed on a workspace but
    // belonging to no review reaches the workspace's channel from here NEVER,
    // and an agent watching `ws:<workspaceId>` has no way to notice — silence
    // from a subscription you never made is indistinguishable from nobody
    // having commented. The workspace fan-out lives in server.ts's
    // `onDocRoomEvent`, which resolves `workspace.docIds` at broadcast time;
    // doc-store.ts has no view of workspaces.
    const attachmentId = attachmentIdOf(room.meta);
    if (attachmentId) {
      this.host.sse().broadcast(`ws~${attachmentId}`, payload);
    }
    if (room.webhookUrl) {
      void this.host.webhooks().send(room.webhookUrl, payload);
    }
    this.host.emitRoomEvent(room.docId, payload);
  }

  /**
   * Delete any private meta key a CONNECTED PEER writes into the doc.
   *
   * `initDocMeta` deliberately never puts sourceUrl / owner / workspaceRoot
   * / producedBy in the CRDT (they describe the host machine, and Yjs sync
   * is all-or-nothing), so a private key appearing in this map arrived over
   * a websocket — from a share visitor as easily as from Bryan's browser.
   * Left standing it is not merely noise: `getOrCreate` lifts private keys
   * out of a loaded `.ydoc` as LEGACY state, and a room with no sidecar —
   * every `ws:<id>` board room, every `task:<id>` body room, any doc never
   * bound to a file — has nothing to outvote it. On the next load
   * `hydrateFromDisk` would bind the room to the injected path, seed the
   * fragment with that file's bytes, and wire the debounced write-back.
   *
   * One-directional by construction: it can only remove keys the server
   * never writes, so its worst failure is a genuinely legacy doc that needs
   * an explicit re-bind — never a lost edit.
   */
  private guardPrivateMeta(room: DocRoom): void {
    const meta = room.ydoc.getMap('meta');
    meta.observe((event, tr) => {
      if (tr.origin === PRIVATE_META_GUARD_ORIGIN) return;
      const injected = Array.from(event.keysChanged).filter(
        (key) => isPrivateMetaKey(key) && meta.has(key),
      );
      if (injected.length === 0) return;
      room.ydoc.transact(() => {
        for (const key of injected) meta.delete(key);
      }, PRIVATE_META_GUARD_ORIGIN);
      console.error(
        `[doc-store] ${room.docId}: dropped peer-written private meta key(s): ${injected.join(', ')}`,
      );
    });
  }

  /**
   * Revert any write to a SERVER_META_KEY that did not come from the server.
   *
   * Different repair from `guardPrivateMeta`, because the server DOES write
   * these keys into the CRDT: a bare delete would erase legitimate state, so
   * the guard restores each touched key from the in-memory mirror — which is
   * authoritative here by construction: it is populated from the loaded doc
   * before this observer attaches (`wireEvents` runs after `loadFromDisk`),
   * and every server write to these keys updates it in the same call.
   */
  private guardServerMeta(room: DocRoom): void {
    const meta = room.ydoc.getMap('meta');
    meta.observe((event, tr) => {
      if (tr.origin === CONTENT_REVISION_ORIGIN || tr.origin === PRIVATE_META_GUARD_ORIGIN) return;
      const touched = SERVER_META_KEYS.filter((key) => event.keysChanged.has(key));
      if (touched.length === 0) return;
      room.ydoc.transact(() => {
        for (const key of touched) {
          const want = room.meta[key];
          if (want === undefined) meta.delete(key);
          else meta.set(key, want);
        }
      }, PRIVATE_META_GUARD_ORIGIN);
      console.error(
        `[doc-store] ${room.docId}: reverted peer write to server meta key(s): ${touched.join(', ')}`,
      );
    });
  }

  wireEvents(room: DocRoom): void {
    room.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      // One hook, every writer. See `DocRoom.lastContentChangeAt` for why the
      // three pre-existing timestamps could not be used, and
      // `isAuthoringOrigin` for what counts as somebody working and why.
      if (isAuthoringOrigin(room, origin)) {
        room.lastContentChangeAt = Date.now();
        this.host.scheduleRevisionBump(room);
        // "The next edit resumes syncing" — see maybeRebindHome. No-op for
        // every doc that has a binding (or no pin), which is all of them
        // outside the hydration-parked state.
        this.host.maybeRebindHome(room);
      }
      this.host.schedulePersist(room);
    });
    this.guardPrivateMeta(room);
    this.guardServerMeta(room);
    // Code and diff docs have no prose fragment — the prose-fragment
    // auto-reanchor sweep below would find nothing and orphan every thread.
    // Run the flat-text twin instead: observe the raw `content` Y.Text and
    // re-anchor threads by snippet match. (Diff content is pinned to a
    // commit and normally never changes, but a reparse after data loss
    // re-seeds it, and the sweep re-anchors threads then.)
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      let codeReanchorTimer: ReturnType<typeof setTimeout> | null = null;
      content.observe((_event, tr) => {
        if (tr.origin === 'agent-reanchor') return;
        if (codeReanchorTimer) clearTimeout(codeReanchorTimer);
        codeReanchorTimer = setTimeout(() => {
          const res = prose.autoReanchorCodeDoc(room.ydoc);
          if (res.reanchored > 0 || res.stillOrphan > 0) {
            console.log(
              `[doc-store] ${room.docId}: code re-anchor — ${res.reanchored} fixed, ${res.stillOrphan} orphaned`,
            );
          }
        }, REANCHOR_MS);
      });
      const initialCode = prose.autoReanchorCodeDoc(room.ydoc);
      if (initialCode.reanchored > 0) {
        console.log(
          `[doc-store] ${room.docId}: on-load code re-anchored ${initialCode.reanchored} thread(s)`,
        );
      }
      return;
    }
    // Every prose change triggers a best-effort sweep that rebuilds
    // Y.RelativePositions for threads whose anchors no longer resolve
    // (e.g. the user split a block or re-typed the anchored text —
    // prosemirror can destroy the original Y.XmlText during those).
    // Debounced so a burst of keystrokes only does one sweep.
    const fragment = prose.getProseFragment(room.ydoc);
    let reanchorTimer: ReturnType<typeof setTimeout> | null = null;
    fragment.observeDeep((_events, tr) => {
      // A prose transaction whose origin is one of this room's live
      // websockets is a person typing in the browser editor — every
      // server-side writer stamps a string origin instead. That marker is
      // what stops set_doc_content from silently rewriting over them.
      if (
        typeof tr.origin === 'object' &&
        tr.origin !== null &&
        room.conns.has(tr.origin as FeedbackWs)
      ) {
        room.lastHumanEditAt = Date.now();
      }
      // Don't re-enter on our own re-anchor writes. NOTE: 'file-watch' must
      // NOT be skipped here — a disk reparse is exactly when anchors inside a
      // rewritten block break, and this sweep is what recovers them. Adding
      // 'file-watch' to this guard (to match the write-back observer's) would
      // silently break reparse recovery.
      if (tr.origin === 'agent-reanchor') return;
      if (reanchorTimer) clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(() => {
        const res = prose.autoReanchorDoc(room.ydoc);
        if (res.reanchored > 0) {
          console.log(`[doc-store] ${room.docId}: auto-reanchored ${res.reanchored} thread(s)`);
        }
      }, REANCHOR_MS);
    });
    // Docs seeded from disk before the heading-level fix persisted `level` as
    // a string, which makes Tiptap render every heading as <h1>. Repair them
    // on load so an existing doc doesn't need a reparse to render correctly.
    const fixed = prose.normalizeHeadingLevels(room.ydoc);
    if (fixed > 0) {
      console.log(`[doc-store] ${room.docId}: normalized ${fixed} legacy string heading level(s)`);
    }
    // Also sweep once on room load so threads recover after server
    // restart even if no new edits happen.
    const initial = prose.autoReanchorDoc(room.ydoc);
    if (initial.reanchored > 0) {
      console.log(
        `[doc-store] ${room.docId}: on-load auto-reanchored ${initial.reanchored} thread(s)`,
      );
    }
  }
}
