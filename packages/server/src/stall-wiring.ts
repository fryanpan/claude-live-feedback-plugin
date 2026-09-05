/**
 * The stall / ready-work wiring: one documented subsystem
 * (docs/architecture/stall-detection.md) lifted whole out of `createServer`.
 *
 * What is here is everything between the board and the two nudgers — the two
 * per-board snapshots (`readyWorkSnapshot`, `stallSnapshot` and the
 * `stallVerdict` under it), the held-item walk over comment-borne asks, the
 * lead-presence monitor, both `Nudger` objects, the store subscription that
 * feeds the ready clock, and the comment-queue bridge that puts a doc room's
 * comments on the board channel. They moved together because they are one
 * reading: every one of them answers "is this board moving, and who has to be
 * told", and the snapshots exist only to be handed to the nudgers.
 *
 * The context is explicit, the same shape `routes/task-routes-context.ts`
 * uses. One of its members is a FUNCTION rather than a value —
 * `reviseCallFor` — because the review gate is built further down
 * `createServer` than this wiring is, and is only ever called from a request
 * or an event. Passing it as a function is what keeps the caller's
 * declaration order free: reordering `createServer` to hoist the gate would
 * move code whose position is load-bearing (it needs `resolveWorkspaceForDoc`
 * and the projection, and says so where it is built).
 *
 * `boardsForDoc` and `backTargetFor` were thunks for the same reason until
 * they moved into `board-membership.ts`, which `createServer` now composes
 * above this wiring. They arrive as plain values.
 *
 * `createStallWiring` has one side effect beyond building objects: it installs
 * `sse.onAgentStreams`, because a lead's own stream opening is what makes the
 * board deliverable and it emits no store event. Neither nudger is STARTED
 * here — `createServer` arms them once the listener is up.
 */
import { join } from 'node:path';
import {
  type WebhookPayload,
  agentIdCandidates,
  attachmentIdOf,
  isReviewPayloadGated,
  isReviewPayloadHeld,
  pendingDeclaration,
} from '@feedback/core';
import type { AgentWatches } from './agent-watches.ts';
import type { DispatchRegistry } from './dispatch-registry.ts';
import type { DocStore } from './doc-store.ts';
import { createLeadPresenceMonitor } from './lead-presence.ts';
import { NoteAskClassifier, type NoteAskJudge } from './note-ask.ts';
import { evaluateReadyWork } from './ready-gate.ts';
import {
  READY_IDLE_DEFAULT_MS,
  READY_NUDGE_STAMP_FILENAME,
  ReadyWorkNudger,
  type ReadyWorkSnapshot,
  isBoardActivity,
} from './ready-nudge.ts';
import type { ReviewGateAddress } from './review-gate.ts';
import type { SseBus } from './sse.ts';
import { StallEscalations } from './stall-escalation.ts';
import {
  HELD_ITEM_DEFAULT_MS,
  type HeldItemInput,
  type StallVerdict,
  evaluateStalls,
  overdueHeldItems,
} from './stall-gate.ts';
import { STALL_NUDGE_STAMP_FILENAME, StallNudger, type StallSnapshot } from './stall-nudge.ts';
import { type TaskProjection, taskBodyDocId, taskIdOfBodyDoc } from './task-projection.ts';
import { buildQueue } from './task-queue.ts';
import {
  type BoardWorkspace,
  DEFAULT_PARALLELISM_CAP,
  LEGACY_REVIEW_ITEM_ID,
  type ParallelismCapChange,
  type TaskStore,
} from './tasks.ts';

/** The cap as a wake names it — `capSummary`'s answer, built in
 *  `createServer` so every reader of the number shares one spelling. */
export interface CapSummary {
  value: number;
  lastChange?: ParallelismCapChange;
}

/** The board's parallelism cap as `parallelismCapView` reports it. Only
 *  `free` and the fields `capSummary` reads are used here; the rest is passed
 *  straight through so the caller need not build a second, narrower view. */
export interface ParallelismCapRead {
  cap: number;
  isDefault: boolean;
  default: number;
  inUse: number;
  free: number;
  holders: Array<{ taskId: string; title?: string; agentName?: string }>;
  lastChange?: ParallelismCapChange;
}

/** The long-lived collaborators this subsystem reads, plus the tuning knobs
 *  `ServerOptions` carries for it. Built once per server. */
export interface StallWiringContext {
  /** The board task store — workspaces, rows, review state, the held items. */
  taskStore: TaskStore;
  /** The ydoc projection: the roster reader both snapshots ask who owns a
   *  row, and the refresh a task comment needs to move its count. */
  taskProjection: TaskProjection;
  /** Doc store — read for a row's discussion and for the docs it links. */
  docStore: DocStore;
  /** The stream board: who can be reached, and where a wake is sent. */
  sse: SseBus;
  /** Open builder dispatches — the witness that keeps the loop from waking a
   *  lead over a row whose builder is busy in a checkout the board cannot
   *  see. */
  dispatches: DispatchRegistry;
  /** Durable per-agent watch sets — the addressees of a queued comment. */
  agentWatches: AgentWatches;
  /** Where both nudgers' stamp files live. */
  dataDir: string;

  /** The board's cap, holders and free slots. `undefined` for a board that
   *  does not exist. */
  parallelismCapView: (
    workspaceId: string,
    excludeTaskId?: string,
  ) => ParallelismCapRead | undefined;
  /** The cap as a wake names it. */
  capSummary: (read: {
    cap?: number;
    value?: number;
    lastChange?: ParallelismCapChange;
  }) => CapSummary;

  /** Every board a doc's discussion actually reaches —
   *  `board-membership.ts`, composed above this wiring. */
  boardsForDoc: (docId: string) => Set<string>;
  /** The board a doc belongs back to, for the lead-presence monitor. Same
   *  module, same reason it can be a value. */
  backTargetFor: (docId: string, attachmentId?: string) => { id: string; name: string } | null;
  /** The paste-ready call that ends a hold, per surface — the review gate's
   *  own spelling, so the lead's report cannot name a different verb from
   *  the one the filer was told to call. Same reason it is a function: the
   *  gate is built below this wiring. */
  reviseCallFor: (address: ReviewGateAddress) => string;

  /** Idle time before the ready-work wake fires (ms). */
  readyNudgeIdleMs?: number;
  /** Quiet time before a row is a stall finding (ms). */
  stallNudgeQuietMs?: number;
  /** How much longer a watched builder's silence may run (multiplier). */
  stallBuilderSilentMultiplier?: number;
  /** How often an unchanged bad board is re-said (ms). */
  stallNudgeRepeatMs?: number;
  /** How long a held review item may stand before it is a finding (ms). */
  heldReviewItemMs?: number;
  /** How long a row the lead was already told about may stay a finding
   *  before the board files over the lead's head (ms). */
  stallEscalateMs?: number;
  /**
   * Confirms that a note flagged by the deterministic prefilter really does
   * say the agent is waiting on a person (`note-ask-judge.ts`). **No
   * default**, the summarizer's seam rule; absent leaves the prefilter
   * running alone, which is the documented no-key state.
   */
  noteAskJudge?: NoteAskJudge;
}

/** What `createServer` keeps a handle on. The two snapshots and
 *  `stallVerdict` are deliberately NOT returned: nothing outside this module
 *  called them, and a wider surface is a wider thing to keep true. */
export interface StallWiring {
  /** The meeting doc's "is anybody listening" monitor. Stopped on shutdown. */
  leadPresence: ReturnType<typeof createLeadPresenceMonitor>;
  /** The ready-work wake. Started by `createServer`, not here. */
  readyNudger: ReadyWorkNudger;
  /** The stall wake. Started by `createServer`, not here. */
  stallNudger: StallNudger;
  /** The comment-queue bridge, for the late-bound hook `DocStore` was built
   *  with — `DocStore` is constructed before the stores this needs. */
  onDocRoomEvent: (docId: string, payload: WebhookPayload) => void;
}

export function createStallWiring(ctx: StallWiringContext): StallWiring {
  const {
    taskStore,
    taskProjection,
    docStore,
    sse,
    dispatches,
    agentWatches,
    dataDir,
    parallelismCapView,
    capSummary,
    boardsForDoc,
    backTargetFor,
    reviseCallFor,
  } = ctx;

  /**
   * One board as the nudger reads it: who to wake, whether to wake them at
   * all, what is ready, WHAT THE PASS EXAMINED TO SAY SO, and when the board
   * last moved.
   *
   * The candidate set is the SAME computation `next_tasks` serves —
   * `buildQueue` — rather than a second reading of the same rules, and it is
   * now asked with `includeBlocked` so the gate sees every open row it is
   * deciding about. That is what makes `considered` a real denominator: a
   * pre-filtered list can only ever report the rows that survived it, so an
   * empty `ready` would read as an empty board rather than as a board whose
   * rows are all waiting on somebody.
   *
   * Which rows survive is `evaluateReadyWork`'s call — see `ready-gate.ts` for
   * why every one of those conditions is dependency state and none of them is
   * a clock. Two things stay here because they need the store:
   *
   *  - `ownerKind`, from the projection's roster reader, so the answer is the
   *    one the board draws rather than a guess from the assignee's name.
   *  - `reviewState`, which reports open questions AND unparseable ones
   *    separately. `listReviewItems` drops a corrupt row rather than throwing,
   *    so without the second number a ticket nobody can read is indistinguish-
   *    able from a ticket with nothing outstanding — and this is the one
   *    caller that ACTS on the difference.
   *
   * Nothing here has to filter out deliberately-deferred rows. Parking moves
   * a row to `triage` and `buildQueue` never lists triage, so a park is
   * invisible to this wake by construction rather than by a second rule that
   * could drift from the one `next_tasks` follows.
   */
  const readyWorkSnapshot = (workspace: BoardWorkspace): ReadyWorkSnapshot => {
    const tasks = taskStore.listTasks(workspace.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ownerKindOf = taskProjection.ownerKindReader(workspace.id);
    const verdict = evaluateReadyWork(
      // `goalRows` is what tells the gate which BANDS have been agreed to; a
      // row under a band still in triage is held (`goal-triage`) rather than
      // dropped, so the pass can report it instead of going quiet about it.
      buildQueue(tasks, workspace.goals, {
        includeBlocked: true,
        goalRows: taskStore.listGoalRows(workspace.id),
      }),
      {
        ownerKind: (id) => {
          const task = byId.get(id);
          // Impossible as long as the rows come from the list above, and it
          // throws rather than defaulting anyway: a default here would be a
          // guess about who owns a row, which is the one thing the gate must
          // never make up. The gate turns the throw into an undetermined row.
          if (!task) throw new Error(`no such task: ${id}`);
          return ownerKindOf(task);
        },
        reviewState: (id) => {
          const state = taskStore.reviewState(id);
          if (!state) throw new Error(`no such task: ${id}`);
          return state;
        },
      },
    );
    // The parallelism cap trims the READY set on top of the dependency
    // gate's own verdict, never inside it: `evaluateReadyWork` reasons about
    // one row at a time, and how many builders the board may run at once is
    // a fact about the WHOLE BOARD, not something any row carries (see the
    // module doc on `HoldReason` in ready-gate.ts). Priority order is
    // `verdict.ready`'s own, so trimming to `available` slots keeps exactly
    // the top-ranked rows a lead would actually be told to dispatch.
    const capView = parallelismCapView(workspace.id);
    const available = capView?.free ?? DEFAULT_PARALLELISM_CAP;
    const ready = verdict.ready.slice(0, available);
    const capacityHeld = verdict.ready.length - ready.length;
    return {
      workspaceId: workspace.id,
      ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
      retired: workspace.retiredAt !== undefined,
      ready,
      considered: verdict.considered,
      held: verdict.held,
      ...(capacityHeld > 0 ? { capacityHeld } : {}),
      ...(capView ? { parallelismCap: capSummary(capView) } : {}),
      undetermined: verdict.undetermined,
      // The store's durable half of the idle clock. Survives a restart, which
      // the in-process observations cannot — see ready-nudge.ts.
      lastActivityAt: tasks.reduce((max, t) => Math.max(max, t.updatedAt, t.createdAt), 0),
    };
  };
  /**
   * The meeting doc's "is anybody listening" — see lead-presence.ts. Reads
   * the same seat health the board's presence strip reads, scoped to the
   * board holding the doc, and pushes a change to the doc's open pages as a
   * transient (no replay: a page that reconnects asks again).
   */
  const leadPresence = createLeadPresenceMonitor({
    source: {
      boardOf: (docId) => backTargetFor(docId)?.id,
      seat: (workspaceId) => taskStore.leadSeatHealth(workspaceId),
    },
    broadcast: (docId, presence) => {
      sse.broadcastTransient(docId, presence);
    },
    onEvent: (listener) => taskStore.onEvent(listener),
    hasListeners: (docId) => sse.count(docId) > 0,
  });
  // The lead's own stream opening is what makes it deliverable, and it
  // emits no store event — so the board says so directly.
  sse.onAgentStreams = (channel) => {
    if (channel.startsWith('ws~')) leadPresence.notify(channel.slice('ws~'.length));
  };

  const readyNudger = new ReadyWorkNudger({
    snapshot: () => taskStore.listWorkspaces().map(readyWorkSnapshot),
    lookup: (workspaceId) => {
      const ws = taskStore.getWorkspace(workspaceId);
      return ws ? readyWorkSnapshot(ws) : undefined;
    },
    // Addressed, never broadcast: a board-wide wake fanned out to every peer
    // is the cost `sendToAgent` exists to remove. `agentsOn` is the stronger
    // probe — it can tell an agent from a browser tab, which `count` cannot.
    canReach: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    send: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    idleMs: ctx.readyNudgeIdleMs ?? READY_IDLE_DEFAULT_MS,
    // Prod restarts at every merge, so without this each deploy re-fired one
    // wake per idle board over facts their leads had already been told.
    stampFile: join(dataDir, READY_NUDGE_STAMP_FILENAME),
  });

  /**
   * One board as the stall loop reads it: which rows have stopped moving, which
   * are waiting on a person nobody has actually asked, and which could not be
   * read at all.
   *
   * The classification is `evaluateStalls` → `classifyOpenTasks`, the same
   * function the keep-moving report runs. That sharing is the point rather
   * than a convenience: the report is how this project decides whether the
   * keep-moving protocol is working, and a loop that judged "stalled"
   * differently would be measured by an instrument that disagreed with it.
   *
   * Four things have to be assembled here because they need the store:
   *
   *  - **Activity per row.** The classifier takes an event list and derives
   *    each row's last movement from it. The board's own `/events` feed has
   *    measurably MISSED row edits, so what is fed in is the rows' own
   *    timestamps — `updatedAt`, `bodyWrittenAt`, `titleWrittenAt` — which are
   *    written by every path that changes a row. That is a superset of what
   *    the feed would have carried, and it needs no file read per tick.
   *  - **Open questions.** `reviewState` reports open items AND unparseable
   *    ones separately, and this is a caller that ACTS on the difference: a
   *    ticket whose questions cannot be read is exactly the ticket whose
   *    unreadable question might have explained its silence, so it goes to the
   *    gate as unreadable rather than as clear.
   *  - **Who owns the row**, from the projection's roster reader, so the
   *    answer is the one the board draws rather than a guess from a name.
   *  - **Which goals dispatch.** The decisions band is the owner's own queue
   *    by its own description; everything else in the ranked list dispatches,
   *    and a goal outside the list is formal backlog that the dispatch rule
   *    would never start.
   *
   * Comments are resolved in a SECOND pass, and only over rows the first pass
   * called stuck. A comment is the row moving — a ticket whose whole decision
   * conversation is live on its thread is not quiet — but reading every board's
   * every thread once a minute would be the one expensive thing in this loop,
   * and the rows that would benefit are precisely the handful about to be
   * reported.
   */
  /**
   * Reads a row's own notes for an ask to a person nobody filed — the third
   * way a row can be waiting on somebody, and the only one the board's own
   * fields cannot show (`note-ask.ts` opens with the incident).
   *
   * Built ONCE, outside the per-board function, because the thing it holds is
   * a cache: a note is confirmed by the judge once in its life, and a board
   * whose notes have all been read schedules nothing on any later tick. Its
   * person names are swapped per board below.
   */
  const noteAsk = new NoteAskClassifier(
    ctx.noteAskJudge !== undefined ? { judge: ctx.noteAskJudge } : {},
  );

  const stallVerdict = (workspace: BoardWorkspace): StallVerdict => {
    const tasks = taskStore.listTasks(workspace.id);
    const ownerKindOf = taskProjection.ownerKindReader(workspace.id);
    const goals = workspace.goals;
    // Matching on the owner's NAME would be wrong — it appears in ordinary
    // goal titles. Only the decisions band is his queue.
    const ownerBand = new Set(
      goals.filter((g) => /decision/i.test(`${g.id} ${g.title}`)).map((g) => g.id),
    );
    // A band nobody has agreed to yet dispatches nothing under it — the
    // verdict the ready gate reads as `goal-triage` — so a row sitting there
    // is not judged by this loop at all: it is handed to the classifier as its
    // own set (`bands.triage`) and skipped before any bucket, and it is also
    // kept out of `dispatchable` below so a caller that never learned the
    // set still reads the row as backlog rather than as ready. The status
    // lives on the goal ROWS; the ordered goal list does not carry one.
    const triageGoals = new Set(
      taskStore
        .listGoalRows(workspace.id)
        .filter((g) => g.status === 'triage')
        .map((g) => g.id),
    );
    // A board that declares NO goals has no bands, so nothing on it is
    // backlog — `inGoalBand` in task-queue.ts states the same rule, and the
    // never-dispatch rule ranks rows against the goal list, so with no list
    // there is nothing to be outside of. Without this every row on a
    // goal-less board reads as unranked backlog and the loop goes silent over
    // exactly the boards that have no ranking to hide behind.
    const dispatchable =
      goals.length === 0
        ? new Set(tasks.map((t) => t.goal))
        : new Set(
            goals.map((g) => g.id).filter((id) => !ownerBand.has(id) && !triageGoals.has(id)),
          );

    // Who on this board is a PERSON, by name — the prefilter's other half:
    // a waiting phrase is only an ask when it names somebody. Derived from the
    // rows rather than from a roster call, because the owner-kind reader is
    // already open here and there is no cheaper list of a board's people. The
    // first token counts too, since a note says "Bryan" where the row says
    // "Bryan Chan"; two characters or fewer is dropped as too common a word
    // to mean a person.
    //
    // TWO sources, and the second is the fix for the hole the first has (PR
    // 691 review): an assignee is only a name on a board where the person
    // OWNS a row, and on a board where every row is an agent's the set came
    // out empty and the prefilter could not read any note as an ask. So the
    // people the board has RECORDED ACTING also count — every transition
    // actor whose kind is `person`, which is how a board knows the human who
    // moved a row without ever being given one. There is no board-owner
    // field to read; this is the nearest true thing.
    const personNames = new Set<string>();
    const addPerson = (raw: string | undefined) => {
      const name = (raw ?? '').trim();
      if (name.length < 3) return;
      personNames.add(name);
      const first = name.split(/\s+/)[0] ?? '';
      if (first.length >= 3) personNames.add(first);
    };
    for (const t of tasks) {
      if (ownerKindOf(t) === 'person') addPerson(t.assignee);
      for (const transition of t.transitions) {
        if (transition.by.kind === 'person') addPerson(transition.by.name);
      }
    }
    noteAsk.setPersonNames([...personNames]);

    const rows = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status as string,
      goal: t.goal,
      after: t.after,
      createdAt: t.createdAt,
      transitions: t.transitions,
      ownerKind: ownerKindOf(t) as string,
      updatedAt: t.updatedAt,
      ...(t.bodyWrittenAt !== undefined ? { bodyWrittenAt: t.bodyWrittenAt } : {}),
      ...(t.titleWrittenAt !== undefined ? { titleWrittenAt: t.titleWrittenAt } : {}),
      // A note's own clock, not just the `updatedAt` bump it causes: the
      // hook's `at` is the turn's end, which can sit minutes before the
      // server's receipt on a slow flush, and the classifier reads notes
      // directly so the CLI report and this loop agree.
      ...(t.notes !== undefined ? { notes: t.notes } : {}),
    }));
    // Every row timestamp as an activity tick. Deliberately unfiltered by
    // actor: the question this feeds is "did anything touch this row", and an
    // unattributed tick beats a false silence.
    const events: Array<{ taskId: string; ts: number }> = [];
    for (const t of tasks) {
      for (const ts of [t.updatedAt, t.bodyWrittenAt, t.titleWrittenAt]) {
        if (typeof ts === 'number' && ts > 0) events.push({ taskId: t.id, ts });
      }
    }
    const reviewItems: Array<{ taskId: string; askedAt?: number }> = [];
    const unreadableReviewTaskIds = new Set<string>();
    for (const t of tasks) {
      const state = taskStore.reviewState(t.id);
      // Absent means the row vanished between the list and this read. Treated
      // as unreadable rather than as clear, for the same reason a throw is:
      // the one thing that could exonerate the row is the thing we do not have.
      if (!state) {
        unreadableReviewTaskIds.add(t.id);
        continue;
      }
      if (state.unreadable > 0) unreadableReviewTaskIds.add(t.id);
      if (state.open > 0) reviewItems.push({ taskId: t.id });
    }

    const now = Date.now();
    // Which rows have a builder whose worktree is actually being WATCHED —
    // those the gate judges on the builder-silence clock (stall-gate.ts). A
    // dispatch whose watcher failed to arm or died is deliberately left out:
    // its activity cannot be seen, so its row keeps the ordinary clock — a
    // degraded signal must not loosen detection. The registry is fleet-wide
    // rather than per-board; task ids are opaque and unique, so a foreign
    // board's ids simply never match.
    const watchingDispatchTaskIds = new Set(
      dispatches
        .list()
        .filter((d) => d.watching)
        .map((d) => d.taskId),
    );
    // The cap and the board's own priority order, so the gate judges only
    // the rows the board may have in flight (stall-gate.ts, `parallelismCap`).
    // The order is `buildQueue`'s — the SAME computation `next_tasks` and the
    // ready-work nudge rank by — asked with `includeBlocked` so a blocked row
    // keeps its place in the order rather than vanishing and promoting the
    // row behind it; the gate itself decides which rows spend a slot.
    const parallelismCap = taskStore.parallelismCap(workspace.id)?.value ?? DEFAULT_PARALLELISM_CAP;
    const priorityOrder = buildQueue(tasks, goals, {
      includeBlocked: true,
      goalRows: taskStore.listGoalRows(workspace.id),
    }).map((row) => row.id);
    const input = {
      tasks: rows,
      events,
      reviewItems,
      bands: { dispatchable, ownerBand, triage: triageGoals },
      unreadableReviewTaskIds,
      now,
      parallelismCap,
      priorityOrder,
      ...(ctx.stallNudgeQuietMs !== undefined ? { quietMs: ctx.stallNudgeQuietMs } : {}),
      ...(watchingDispatchTaskIds.size > 0 ? { watchingDispatchTaskIds } : {}),
      ...(ctx.stallBuilderSilentMultiplier !== undefined
        ? { builderSilentMultiplier: ctx.stallBuilderSilentMultiplier }
        : {}),
      noteAsk,
    };
    const first = evaluateStalls(input);
    const suspect = [...first.stalled, ...first.unfiled];
    if (suspect.length === 0) return first;
    // Second pass over the handful the first pass named. A room that was never
    // opened holds no threads and answers nothing, which is the right answer:
    // a row with no discussion has no comment activity to find.
    //
    // The same walk also collects the asks `reviewState` cannot see: a review
    // item filed as a payload ON A COMMENT lives in the room, not on the
    // ticket, yet it sits on the reader's Home queue exactly like a
    // ticket-borne one — so a row behind one is legitimately waiting, and the
    // loop woke a live lead over exactly this shape. Openness is
    // `pendingDeclaration`, the rule the queue itself reads: an answered
    // declaration or a resolved thread is nobody being waited on, and excuses
    // nothing.
    const threadActivity = new Map<string, number>();
    const commentAsks: Array<{ taskId: string; askedAt: number }> = [];
    // How many rows link each doc — the fact that decides whether an ask on a
    // doc is unambiguously about ONE row. Counted over every row on the board,
    // not just the suspects: a doc shared with a row that is moving fine is
    // still a shared doc. Done and archived rows count too, deliberately, and
    // that is the safe direction — a higher count parks fewer rows, which
    // leaves the watchdog noisier rather than switched off.
    const linkingRowCount = new Map<string, number>();
    for (const t of tasks) {
      const seen = new Set<string>();
      for (const ref of t.links ?? []) {
        if (ref.kind !== 'doc' && ref.kind !== 'thread') continue;
        if (seen.has(ref.docId)) continue;
        seen.add(ref.docId);
        linkingRowCount.set(ref.docId, (linkingRowCount.get(ref.docId) ?? 0) + 1);
      }
    }
    /**
     * One room's discussion, read for both things a discussion can say about
     * a row: that somebody is talking on it, and that somebody is waiting on
     * an answer. Returns the newest comment time it saw.
     *
     * Factored out because the row's own `task:<id>` room and each doc the
     * row LINKS are read by exactly the same rules — and were not, which is
     * the bug. Two copies of "is this ask still open" is how one of them
     * comes to disagree with the Home queue.
     */
    const readDiscussion = (
      docId: string,
      taskId: string,
      askCounts?: (askedBy: string | undefined) => boolean,
    ): number => {
      let newest = 0;
      for (const thread of docStore.listThreads(docId)) {
        if (thread.lastActivity > newest) newest = thread.lastActivity;
        const declaring = pendingDeclaration(thread);
        // A HELD ask exonerates nothing. The whole point of a hold is that
        // the reader cannot see the item, so a row sitting behind one is not
        // legitimately waiting on a person — it is waiting on its own filer
        // to revise, which is exactly what the loop should keep saying.
        if (declaring?.review && !isReviewPayloadGated(declaring.review)) {
          if (askCounts === undefined || askCounts(declaring.author?.id)) {
            commentAsks.push({ taskId, askedAt: declaring.ts });
          }
        }
      }
      return newest;
    };
    for (const row of suspect) {
      let newest = readDiscussion(taskBodyDocId(row.id), row.id);
      // A registered builder's worktree churn is the row moving, exactly as
      // a comment is — the builder works in a checkout the board cannot see,
      // and without this the loop woke leads over its silence (8 of 9 wakes
      // one night). Merged as max into the same exoneration seam; a closed,
      // dead, or silent dispatch contributes nothing here, and which clock
      // then stands is `watchingDispatchTaskIds` above: the builder-silence
      // one for a dispatch still watching, the ordinary one otherwise.
      const dispatchTs = dispatches.activityFor(row.id);
      if (dispatchTs !== undefined && dispatchTs > newest) newest = dispatchTs;
      // Somebody rewriting the doc the row is ABOUT is the row moving, for
      // the same reason a comment and a builder's worktree churn are: the
      // work is happening somewhere the board's own timestamps cannot see.
      // Measured on the live board — a row whose agent edited its linked doc
      // continuously woke the lead three times in one hour.
      //
      // Merged into `threadActivity` rather than passed as a fifth argument,
      // because that map is already this loop's ONE exoneration seam:
      // stall-gate.ts says so where it defines `watchingDispatchTaskIds`
      // ("worktree activity itself arrives merged into `threadActivity` by
      // the caller; this set only says whose silence is a builder's"). A
      // third parallel notion of activity would have to be taught to
      // `evaluateStalls`, the CLI report, and every future caller.
      //
      // Scope is the row's OWN links — a doc it cites and any doc it holds a
      // thread ref into. Deliberately not the row's `task:<id>` body room:
      // that room is written by the projection on any row change, so
      // counting it would exonerate a row for changing its own status.
      //
      // KNOWN LIMIT, and the reason a row can still wake falsely while
      // somebody edits its doc: linking the doc is the OPT-IN GESTURE. A row
      // with empty `links` gets nothing from this — the row that filed this
      // very fix had none, so its own false wake was the worktree shape
      // (`watchingDispatchTaskIds` above), not this one. There is no
      // automatic association to fall back on: the only candidate is matching
      // the editing agent against the row's assignee, and that over-exonerates
      // the moment one agent holds two rows, which is the direction that
      // turns the watchdog off rather than merely making it noisy. Removing
      // the link requirement is a ranked decision, not a cleanup.
      const task = taskStore.getTask(row.id);
      const ownerId = task === undefined ? undefined : taskStore.ownerIdOf(task);
      for (const ref of task?.links ?? []) {
        if (ref.kind !== 'doc' && ref.kind !== 'thread') continue;
        const editedAt = docStore.lastContentChangeFor(ref.docId);
        if (editedAt !== undefined && editedAt > newest) newest = editedAt;
        // …and that doc's DISCUSSION, on the same opt-in gesture and by the
        // same rules as the row's own room. The prose fold above could never
        // have covered it: `schema.ts` writes threads with no transaction
        // origin, and `lastContentChangeFor` refuses an unnamed origin on
        // purpose (see doc-activity-stall.test.ts's origins pair), so a
        // question asked where the work actually is — on a mock, a design
        // doc, a diff — left the row reading as quiet with nobody waiting.
        // Measured 2026-09-04: five wakes in sixty-five minutes over two
        // rows, one of them a mock round sitting on the reader's queue.
        //
        // The ask half is SCOPED, because a doc is a shared surface: a design
        // doc linked by four rows must not park all four, indefinitely, on one
        // unanswered question that only one of them is actually waiting on.
        // The row's own `task:<id>` room needs no such scoping — a task-body
        // thread belongs to exactly one row by construction.
        //
        // Two ways an ask can be about THIS row, and the first is why the
        // owner test is not enough on its own:
        //
        //  - Nothing else links the doc. Then the ask cannot be about another
        //    row, whoever typed it, so a builder's question on a lead-owned
        //    row parks it. Scoping on the owner alone missed exactly this and
        //    left the row waking while a person owed it an answer.
        //  - Otherwise the asker must be the row's owner, which is the only
        //    signal that separates the four-row design doc's rows from each
        //    other. Matching the row's ASSIGNEE instead was considered and
        //    rejected — see the known limit above; it over-exonerates the
        //    moment one agent holds two rows.
        //
        // An ask by a person, or by an agent the roster cannot place, counts
        // for nobody on a shared doc; it is still MOVEMENT on the doc, which
        // is the `newest` half below and stays unscoped, because that
        // exoneration expires with the quiet window rather than lasting as
        // long as the question does.
        const discussed = readDiscussion(ref.docId, row.id, (askedBy) => {
          if ((linkingRowCount.get(ref.docId) ?? 0) <= 1) return true;
          if (ownerId === undefined || askedBy === undefined) return false;
          return (taskStore.resolveAgentId(askedBy) ?? askedBy) === ownerId;
        });
        if (discussed > newest) newest = discussed;
      }
      if (newest > 0) threadActivity.set(row.id, newest);
    }
    if (threadActivity.size === 0 && commentAsks.length === 0) return first;
    return evaluateStalls({
      ...input,
      reviewItems: [...input.reviewItems, ...commentAsks],
      ...(threadActivity.size > 0 ? { threadActivity } : {}),
    });
  };
  const heldReviewItemMs = ctx.heldReviewItemMs ?? HELD_ITEM_DEFAULT_MS;
  /**
   * Every COMMENT-borne review item the gate is holding on a board, in the
   * shape the stall monitor reads.
   *
   * The ticket-borne twin (`taskStore.heldReviewItems`) reads one array off
   * each row; there is no such array here — a comment-borne item lives in its
   * doc's CRDT — so this walks the same three doc families the queue itself
   * walks: task bodies, goal bodies, and the workspace's own docs. Bounded by
   * the board's size and run on the stall tick, the same cadence
   * `stallVerdict` already pays for.
   *
   * Without it a hold on this surface would be silent to the lead: the filer
   * gets its wake at filing time and nothing would ever complain again, which
   * is the "held for hours, nobody told" shape the five-minute window exists
   * to prevent.
   */
  function heldThreadReviewItems(workspace: BoardWorkspace): HeldItemInput[] {
    const out: HeldItemInput[] = [];
    const scan = (docId: string, title: string, taskId?: string) => {
      for (const thread of docStore.listThreads(docId, { status: 'open' })) {
        for (const comment of thread.comments) {
          const review = comment.review;
          // `held`, not `gated`: a verdict still out is seconds old, and a
          // complaint about it would fire on every fresh filing.
          if (!review || !isReviewPayloadHeld(review) || review.judge === undefined) continue;
          out.push({
            title,
            ...(taskId !== undefined ? { taskId } : {}),
            docId,
            threadId: thread.id,
            commentId: comment.id,
            // The comment IS the item on this surface — see `HeldItemRow`.
            reviewItemId: comment.id,
            headline: review.headline,
            reason: review.judge.reason,
            heldAt: review.judge.at,
            filedBy: comment.author.name,
            ...(comment.author.id ? { filerAgentId: comment.author.id } : {}),
            revise: reviseCallFor({
              kind: 'thread',
              docId,
              threadId: thread.id,
              commentId: comment.id,
            }),
          });
        }
      }
    };
    for (const task of taskStore.listTasks(workspace.id)) {
      if (task.status === 'done') continue;
      scan(taskBodyDocId(task.id), task.title, task.id);
    }
    for (const goal of taskStore.listGoalRows(workspace.id)) {
      if (goal.status === 'done') continue;
      scan(taskBodyDocId(goal.id), goal.title);
    }
    for (const docId of workspace.docIds) {
      const meta = docStore.peekMeta(docId);
      scan(docId, meta?.title || meta?.relPath?.split('/').pop() || docId);
    }
    return out;
  }
  const stallSnapshot = (workspace: BoardWorkspace): StallSnapshot => {
    const verdict = stallVerdict(workspace);
    const capRead = taskStore.parallelismCap(workspace.id);
    // Review items the quality gate is holding past the window — a fourth
    // finding beside the three the gate computes. Read off the store rather
    // than through the classifier, because a held item is not a row's state:
    // it is an ask that exists on a ticket and on nobody's queue, and the
    // remedy (get the filer to revise) is the filer's, not the row's owner's.
    //
    // BOTH surfaces, one list. A hold the lead never hears about is the same
    // silence whichever verb filed it.
    const held = overdueHeldItems(
      [
        // The ticket-borne holds, each carrying the call that ends it —
        // spelled by `reviseCallFor`, the same function the filer's wake and
        // the tool result use, so the lead's report cannot name a different
        // verb from the one the filer was told to call. A ticket's OWN
        // decision is reported under the derived id and addressed at the
        // ticket alone, because that row has no item id.
        ...taskStore.heldReviewItems(workspace.id).map((item) => ({
          ...item,
          revise: reviseCallFor(
            item.reviewItemId === LEGACY_REVIEW_ITEM_ID
              ? { kind: 'decision', taskId: item.taskId }
              : { kind: 'task', taskId: item.taskId, reviewItemId: item.reviewItemId },
          ),
        })),
        ...heldThreadReviewItems(workspace),
      ],
      Date.now(),
      heldReviewItemMs,
    );
    return {
      workspaceId: workspace.id,
      ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
      retired: workspace.retiredAt !== undefined,
      stalled: verdict.stalled,
      unfiled: verdict.unfiled,
      considered: verdict.considered,
      undetermined: verdict.undetermined,
      ...(verdict.beyondCapacity > 0 ? { beyondCapacity: verdict.beyondCapacity } : {}),
      ...(capRead ? { parallelismCap: capSummary(capRead) } : {}),
      ...(held.length > 0 ? { held } : {}),
    };
  };
  /**
   * The second addressee: when a row the lead was told about is still stuck
   * an hour later, the board files a review item on the reader's own queue
   * (`stall-escalation.ts`). Built here, driven by the nudger's tick, because
   * the told-times it runs on are the nudger's memory and nothing else's.
   */
  const escalations = new StallEscalations({
    store: taskStore,
    dataDir,
    ...(ctx.stallEscalateMs !== undefined ? { escalateMs: ctx.stallEscalateMs } : {}),
  });
  const stallNudger = new StallNudger({
    snapshot: () => taskStore.listWorkspaces().map(stallSnapshot),
    // Addressed, never broadcast, and `agentsOn` rather than `count` for the
    // same reason the ready-work wake uses it: `count` cannot tell an agent
    // from an open browser tab, and a wake fanned out to every peer is the
    // cost addressed delivery exists to remove.
    canReach: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    // The fallback addressees, read off the SAME set `canReach` answers from
    // — so the monitor cannot enumerate a session it would then decline to
    // send to. A board whose lead has stopped listening still reaches whoever
    // is actually on it.
    attachedAgents: (workspaceId) => [...sse.agentsOn(`ws~${workspaceId}`)],
    send: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    // The held item's FILER, addressed the same way. The lead learns of it in
    // the stall frame; the filer is the one who can end it in a call.
    sendToFiler: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    ...(ctx.stallNudgeRepeatMs !== undefined ? { repeatMs: ctx.stallNudgeRepeatMs } : {}),
    escalate: (board, toldAt, now) => escalations.onBoard(board, toldAt, now),
    // Prod restarts at every merge; without this each deploy would re-fire one
    // wake per board over rows their leads had already been told about.
    stampFile: join(dataDir, STALL_NUDGE_STAMP_FILENAME),
  });
  // Its own subscription rather than a branch inside the SSE bridge above,
  // and the ordering is the reason: the bridge is installed before this
  // object exists, so reaching back at it from there would be a reference
  // into a variable that is not initialized yet on any event the store
  // manages to emit in between.
  taskStore.onEvent((ev) => {
    // The board moved, so its idle clock restarts. Read from the SAME choke
    // point every other subscriber reads, rather than from a second list of
    // "events that count as activity" — one that would silently fall behind
    // the store the first time a mutator is added.
    //
    // The exclusions live in `isBoardActivity`, for the same reason: `agent.*`
    // is liveness (attached / detached / heartbeat), and liveness is not the
    // board moving. Counting it made the wake self-cancelling, because the
    // only lead a nudge can be DELIVERED to is one holding a live stream —
    // which is precisely the session attaching and heartbeating. So the
    // pings that proved the lead was there also proved, to this clock, that
    // the board did not need it. `task.noted` — a turn ending — is the same
    // class.
    if (isBoardActivity(ev.type)) readyNudger.noteActivity(ev.workspaceId, ev.ts);
    // …and an answer is not merely activity. The lead is the party who acts
    // on answers, and making it wait out an idle window would deliver the
    // point of the feature fifteen minutes late.
    if (ev.type === 'decision.answered') {
      // Resolved HERE rather than inside the nudger: the nudger's snapshot
      // carries the ready set, and an answered row is usually not in it —
      // being blocked on that very answer is why it was asked. The title is
      // what makes the wake readable without a lookup on the far end, and the
      // links are what decide whether the line may offer a propagation
      // checklist — sent as they stand, empty included, because the renderer
      // has to tell an empty list from a frame that carries no row at all.
      const answered = ev.taskId ? taskStore.getTask(ev.taskId) : undefined;
      readyNudger.reviewAnswered({
        workspaceId: ev.workspaceId,
        taskId: ev.taskId,
        ...(answered?.title !== undefined ? { taskTitle: answered.title } : {}),
        ...(answered?.links !== undefined ? { taskLinks: answered.links } : {}),
        actorId: ev.actor?.id,
      });
    }
  });
  // A task's discussion lives in its body room, but an agent working a board
  // watches the WORKSPACE channel, not each task's doc — so a comment that
  // only fans out on the doc's own stream reaches nobody who is working. The
  // same event also moves the row's comment count, which nothing else would
  // refresh (the store never changes, so no task.* event fires).
  //
  // EVERY other doc room needs the same bridge, for the same reason and with
  // one extra hop. `docStore.broadcastToRoom` fans out on `ws~<meta.workspaceId>`
  // — the GROUPING tag a diff review or folder bind sets — and a board link is
  // not that tag, so a plain attachment filed on a board reached that board's
  // agent never. Measured: a session with six docs under `watch_doc` and a
  // seat on the board heard nothing from any of them on the board channel, and
  // silence from a subscription you never made is indistinguishable from
  // nobody having commented.
  //
  // Resolution happens HERE, at BROADCAST time, against `workspace.docIds` —
  // nothing is registered when a doc is created. That is what makes "and
  // anything created later" true with no new call, no new field and no
  // migration: `fileUnderBoardWorkspace` already files every doc onto some
  // board, defaulting to Unfiled, so a doc that exists is a doc some board
  // holds.
  /** Does this comment author name this agent? Candidate-matched both ways,
   *  because the event's actor id and the attachment key demonstrably
   *  disagree in the field (see noteObservedWork in tasks.ts). */
  const commentAuthorIs = (agentId: string, author?: { id?: string; name?: string }): boolean => {
    if (!author) return false;
    const candidates = new Set<string>();
    for (const raw of [author.id, author.name]) {
      if (typeof raw !== 'string') continue;
      candidates.add(raw.trim().toLowerCase());
      for (const c of agentIdCandidates(raw)) candidates.add(c);
    }
    return candidates.has(agentId.trim().toLowerCase());
  };

  /**
   * The durable half of a comment's delivery (§ comment queue, mirrored from
   * voice): write one ADDRESSED row per owning agent before any frame goes
   * out, so a stream being down costs latency rather than the comment.
   *
   * Who owns a comment — the addressing decision, made here in one place:
   * the board's LEAD (declare-lead's contract is "everything on this board
   * reaches you") plus every agent whose DURABLE watch set holds
   * `ws:<workspaceId>` (the standing subscription that survives the stream
   * carrying it). Deliberately NOT per-doc watchers or "whoever attaches
   * first": attach and heartbeat — the only per-agent drains — are
   * board-scoped, and queuedVoice's missing lead-guard is the measured cost
   * of leaving a queue unaddressed. The author is excluded: an agent is not
   * owed a receipt for its own words.
   *
   * Only events that ARE a comment queue (thread.created / thread.replied,
   * which carry `comment`); resolve/reopen/suggestion verdicts are state
   * changes, not asks waiting on somebody.
   */
  const queueCommentRows = (
    workspaceId: string,
    docId: string,
    payload: WebhookPayload,
  ): Map<string, string> => {
    const rows = new Map<string, string>();
    if (payload.event !== 'thread.created' && payload.event !== 'thread.replied') return rows;
    // thread.replied carries the comment on the payload; thread.created fires
    // with `comment: undefined` and the opening comment inside the thread
    // (doc-store.ts fireEvent call sites), so fall back to the newest one there.
    const comment =
      payload.comment ??
      (payload.event === 'thread.created'
        ? payload.thread?.comments?.[payload.thread.comments.length - 1]
        : undefined);
    if (!comment) return rows;
    const addressees = new Set<string>(agentWatches.agentsWatching(`ws:${workspaceId}`));
    const lead = taskStore.getWorkspace(workspaceId)?.leadAgentId;
    if (lead) addressees.add(lead);
    for (const agentId of addressees) {
      if (commentAuthorIs(agentId, comment.author)) continue;
      const id = taskStore.queueComment(workspaceId, {
        agentId,
        docId,
        threadId: payload.threadId,
        event: payload.event,
        author: { id: comment.author.id, name: comment.author.name },
        text: comment.text,
        payload,
      });
      if (id !== false) rows.set(agentId, id);
    }
    return rows;
  };

  /** An addressee holding the board stream just received (or is receiving)
   *  the live frame: start its ack grace, so the next heartbeat does not
   *  immediately re-send what is already in flight. */
  const markCommentRowsEmitted = (workspaceId: string, rows: Map<string, string>): void => {
    if (rows.size === 0) return;
    const on = sse.agentsOn(`ws~${workspaceId}`);
    for (const [agentId, rowId] of rows) {
      if (on.has(agentId)) taskStore.markCommentEmitted(workspaceId, rowId);
    }
  };

  const onDocRoomEvent = (docId: string, payload: WebhookPayload): void => {
    const rowId = taskIdOfBodyDoc(docId);
    if (rowId) {
      // A `task:` room belongs to a task OR to a goal — one prefix, two kinds
      // of row (see `ensureGoalBody`). Asking only `getTask` returned
      // undefined for every goal and took the early return, so a comment on a
      // goal reached nobody: no board broadcast, no agent watching the
      // workspace, no projection refresh to update the count.
      const workspaceId =
        taskStore.getTask(rowId)?.workspaceId ?? taskStore.getGoalRow(rowId)?.workspaceId;
      if (!workspaceId) return;
      const rows = queueCommentRows(workspaceId, docId, payload);
      sse.broadcast(`ws~${workspaceId}`, payload, (who) => {
        const rowId = who.agentId ? rows.get(who.agentId) : undefined;
        return rowId ? { ...payload, workspaceId, commentQueueId: rowId } : undefined;
      });
      markCommentRowsEmitted(workspaceId, rows);
      // Task path only: a plain doc thread moves no row, so refreshing the
      // projection for it would be a board-wide rewrite that changes nothing.
      taskProjection.refresh(workspaceId);
      return;
    }
    // Exactly one hop from review to board — the same non-transitive rule
    // `shareWorkspacesOf` spells out, so what an agent HEARS about a review
    // and what a share visitor may OPEN in it cannot drift apart.
    const attachmentId = attachmentIdOf(docStore.peekMeta(docId) ?? {});
    for (const board of boardsForDoc(docId)) {
      const rows = queueCommentRows(board, docId, payload);
      // doc-store.ts already broadcast on the review's own channel; a second
      // send here would deliver the same comment twice to one listener. The
      // review frames carried no row id, so those rows are acked off the
      // grace-window redelivery instead — late receipt beats double frame.
      if (board !== attachmentId) {
        sse.broadcast(`ws~${board}`, payload, (who) => {
          const rowId = who.agentId ? rows.get(who.agentId) : undefined;
          return rowId ? { ...payload, workspaceId: board, commentQueueId: rowId } : undefined;
        });
      }
      markCommentRowsEmitted(board, rows);
    }
  };

  return { leadPresence, readyNudger, stallNudger, onDocRoomEvent };
}
