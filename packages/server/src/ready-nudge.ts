/**
 * The board waking its lead.
 *
 * Everything else on this server is reactive: somebody calls a tool, an
 * event fans out, an agent that happens to be listening reads it. That
 * leaves one gap the board can see and nothing acts on — **ready work
 * nobody has picked up.** The rows are there, they are `todo`, they are
 * owned by an agent, nothing enforced blocks them, and the session that
 * would do them is sitting idle waiting to be spoken to. Until now the only
 * thing that could close that gap was Bryan noticing and typing something,
 * which makes the human the scheduler for work the board already ranked.
 *
 * So: a timer reads the board and, when ready work has stood still longer
 * than the idle window, sends ONE frame addressed to the workspace's lead
 * agent. The frame rides `sendToAgent` on `ws~<workspaceId>` — the same
 * addressed delivery `triage.requested` uses, and for the same reason. It is
 * a DELIVERY, not a change, so it deliberately does not go through the
 * store's emit choke point and never reaches `events.jsonl` (§3.6's table is
 * the exhaustive audit contract and has no nudge row).
 *
 * ── Why most of this file is about NOT sending ──────────────────────────
 *
 * A wake costs a turn. A nudge that repeats every tick while nothing has
 * changed costs a turn every tick, and the lead learns — correctly — that
 * the signal carries no information. Then the one nudge that mattered
 * arrives into a session that has already been taught to skim past it. So
 * the arming rule is stated as a STAMP rather than as a cooldown:
 *
 *     stamp = <effective last activity> | <the ready set, sorted>
 *
 * A workspace is nudged at most once per stamp. That single rule covers
 * both halves of the requirement without a second timer: any activity moves
 * the activity clock, and any material change to what is ready moves the id
 * list. A cooldown would have been the obvious shape and it is the wrong
 * one — it re-fires on a schedule, which is exactly the training signal
 * above.
 *
 * Two further silences, each with a reason:
 *
 *  - **An unreachable lead is not spent.** If the lead holds no stream, the
 *    nudge is not sent AND not recorded. A wake delivered to nobody would
 *    otherwise burn the one nudge that stamp is owed, and the lead would
 *    come back to a board that had already decided it had told them. The
 *    cost is a no-op check per tick, which is free.
 *  - **A retired board is never woken**, and neither is one with an empty
 *    lead seat. There is no addressee in either case; a broadcast fallback
 *    would put a board-wide ask in front of every peer, which is the failure
 *    addressed delivery exists to end.
 *
 * The activity clock is the LATER of two sources on purpose. The snapshot
 * carries the store's own record (max `updatedAt` across the board), which
 * is durable across a restart; `noteActivity` carries what this process has
 * observed since, which covers the events that move a board without moving
 * a task row (a comment, an answer). Taking only the first would nudge over
 * a live conversation; taking only the second would nudge the instant the
 * server came up.
 *
 * ── Why the stamps are on disk ──────────────────────────────────────────
 *
 * Everything above describes a map that used to live only in this process,
 * which meant a DEPLOY undid all of it: prod restarts at every merge, and
 * each restart handed every idle board a clean slate and re-fired one wake
 * per board over facts their leads had already been told. That is the
 * "signal carries no information" training above, delivered by the release
 * process rather than by a timer.
 *
 * The stamp itself was already durable by construction — both halves are
 * read off the store, which is why a fresh nudger over the same board
 * computes a byte-identical string. So the fix is only somewhere to keep it:
 * one small json in the data dir, loaded at construction, rewritten when the
 * map changes. Best-effort in BOTH directions and deliberately so — a stamp
 * file that cannot be read or written costs at most one duplicate wake,
 * which is the cheaper failure by a wide margin.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { HoldReason, UndeterminedRow } from './ready-gate.ts';

/**
 * Fifteen minutes — a DAMPER, no longer the evidence.
 *
 * This number used to answer "is this row stalled", and measurement killed
 * that reading: the median gap between task-activity events on two real
 * boards was ~15 minutes, so the threshold flagged working agents at about
 * the rate it flagged stalled ones (see `ready-gate.ts` for the figures).
 * Whether a row is stalled is now `ready-gate.ts`'s question, decided from
 * dependency state.
 *
 * What survives here is much weaker and still worth having: don't interrupt a
 * board somebody is actively moving. A held row is suppressed whatever the
 * clock says, and an unheld one waits out this window before the wake goes
 * out — so the number now trades a little latency for not landing in the
 * middle of a conversation, and nothing depends on it being right.
 */
export const READY_IDLE_DEFAULT_MS = 15 * 60_000;

/** How often the timer looks, when nobody says otherwise. A minute is far
 *  below the idle window on purpose: the tick is a cheap read, and the
 *  window is what decides when a nudge is owed. */
export const READY_TICK_DEFAULT_MS = 60_000;

/** The two things a nudge can be about. Separate EVENT NAMES rather than one
 *  name with a reason field, because the plugin renders an unrecognised hub
 *  event off the event name alone — one name would make the two
 *  indistinguishable in the lead's channel. */
export const READY_IDLE_EVENT = 'workspace.ready_idle';

/**
 * Whether a store event counts as THE BOARD MOVING — what restarts a
 * board's idle clock. Liveness does not: `agent.*` (attached / detached /
 * heartbeat) is the session being there, and `task.noted` is the session
 * ending a turn — one per turn from any agent holding a row, so counting it
 * would suppress the wake for exactly as long as a builder keeps talking
 * without moving anything, which is the state the wake exists to catch.
 */
export function isBoardActivity(type: string): boolean {
  return !type.startsWith('agent.') && type !== 'task.noted';
}
export const REVIEW_ANSWERED_EVENT = 'workspace.review_answered';

/** A ready row, reduced to what a wake needs to say. */
export interface ReadyRow {
  id: string;
  title: string;
}

/** One board, as the nudger needs to see it. */
export interface ReadyWorkSnapshot {
  workspaceId: string;
  /** The addressee. Absent means an empty seat, which is never nudged. */
  leadAgentId?: string;
  retired: boolean;
  /** Rows the dependency-state gate cleared, in the board's own priority
   *  order — unclaimed, agent-owned, unblocked, and with no open
   *  question waiting on a person. See `ready-gate.ts`. */
  ready: readonly ReadyRow[];
  /** THE DENOMINATOR: how many open rows the gate examined to produce
   *  `ready`. Carried onto the frame, because an empty ready list on a board
   *  of nine held rows and one on an empty board are different facts that
   *  reach a reader identically without it. */
  considered: number;
  /** What the gate withheld, by reason. Absent keys, never zeroes. */
  held: Partial<Record<HoldReason, number>>;
  /**
   * Rows the gate could not evaluate at all.
   *
   * Kept separate from `held` and from `ready` because it is neither: a row
   * here was not found healthy and was not found stalled, it was not READ.
   * It is the one input that can turn an otherwise-silent pass into a wake —
   * "I could not look" must not arrive as "I looked and there was nothing".
   */
  undetermined: readonly UndeterminedRow[];
  /** The store's durable record of when this board last moved (ms epoch). */
  lastActivityAt: number;
}

/** What goes on the wire. Flat, because the plugin's renderer reads these
 *  fields off the top level — see `nudge-line.ts` in packages/mcp. */
export interface NudgeFrame {
  event: typeof READY_IDLE_EVENT | typeof REVIEW_ANSWERED_EVENT;
  workspaceId: string;
  /** The row the lead should look at first (idle), or the row the answer was
   *  about (answered). A bare `[workspace.ready_idle]` is a wake with no
   *  subject, which costs a turn and says nothing. */
  taskId?: string;
  /** That row's name — what the recipient actually recognises. Sent on BOTH
   *  events: the id alone makes the reader call `get_task` before it can tell
   *  whether the wake was worth the turn. */
  title?: string;
  readyCount?: number;
  /** How many open rows the pass EXAMINED to arrive at `readyCount`. Idle
   *  nudges only. Sent even when it equals `readyCount`, because a reader
   *  cannot tell a stated denominator from an omitted one after the fact. */
  consideredCount?: number;
  /** What the pass withheld and why — `{ 'awaiting-person': 2, backlog: 1 }`.
   *  Absent rather than empty when nothing was held. Idle nudges only. */
  held?: Readonly<Record<string, number>>;
  /**
   * Rows the pass could not evaluate. Absent when there were none, which is
   * the ordinary case — its PRESENCE is the whole signal.
   *
   * This is the field that makes a wake with `readyCount: 0` meaningful: such
   * a frame is sent only when the pass has something it could not read, so
   * "nothing is ready" and "I could not tell what is ready" stop being the
   * same silence.
   */
  undetermined?: { count: number; reasons: readonly string[] };
  /** How long the board had stood still. Idle nudges only. */
  idleMs?: number;
  /** The answered row's own links — the propagation checklist the answered
   *  line offers. Answer nudges only, and routinely EMPTY: most rows annotate
   *  nothing. ABSENT is a third state and not the same as empty — the
   *  comment-review route records an answer against no task row at all, so
   *  there is nothing whose links these could be. The renderer must be able
   *  to tell all three apart, which is why the field exists at all: without
   *  it `reviewAnsweredLine` sent every reader off to walk a checklist it
   *  could not check for. */
  links?: readonly unknown[];
  ts: number;
}

export interface ReadyWorkNudgerOptions {
  /** Every live board, rebuilt each tick. */
  snapshot: () => readonly ReadyWorkSnapshot[];
  /** One board by id — the immediate (answer) path, which must not pay for
   *  a whole-fleet queue computation to send one frame. */
  lookup: (workspaceId: string) => ReadyWorkSnapshot | undefined;
  /** Is this agent holding a stream we could actually wake? */
  canReach: (workspaceId: string, agentId: string) => boolean;
  /** Addressed delivery. Returns how many sinks it reached. */
  send: (workspaceId: string, agentId: string, frame: NudgeFrame) => number;
  idleMs?: number;
  now?: () => number;
  /**
   * Where a condition the wake could not evaluate is written when there is no
   * lead to tell. Defaults to `console.error`.
   *
   * It exists because the frame is not a guaranteed reader: the commonest
   * reason a wake is not delivered is that the lead holds no stream, and that
   * is exactly when an unevaluable board would otherwise vanish. Called once
   * per distinct condition per board, never once per tick — a checker that
   * emitted 116 unread RED lines and an archiver that logged 395 identical
   * hourly failures both had readers, and both taught them there was nothing
   * to read.
   */
  report?: (message: string) => void;
  /**
   * Where the armed stamps are kept between runs. Omitted → memory only,
   * which is what every unit test that is not about persistence wants.
   */
  stampFile?: string;
}

/**
 * Both outcomes of the gate, so the feature can be proven wrong.
 *
 * This ships as a SUPPRESSOR whose value is unproven. The firing that
 * originally justified it turned out not to be a true positive on inspection
 * — the board carried `ownerSession` and no `claimedBy`, so there was no state
 * contradiction and the old wake fired on elapsed time and was coincidentally
 * right. What remains is that the gate demonstrably silences a class of false
 * alarm. That is worth shipping and it is not worth trusting, so it ships with
 * the instrument that will eventually settle it.
 *
 * `suppressed` is per-condition on purpose: "40 suppressed, all `backlog`" and
 * "40 suppressed across five conditions" are different findings, and a single
 * total cannot tell them apart.
 */
export interface NudgeTally {
  /** When this measurement window opened (ms epoch). PERSISTED, and that is
   *  load-bearing rather than tidy: prod restarts at every merge, several
   *  times a day, so a window that began again at each start would never
   *  close and the stopping rule below would be unreachable by construction. */
  since: number;
  /** Nudges actually DELIVERED — the numerator the stopping rule reads. */
  passed: number;
  /** Row-evaluations withheld, by the condition that withheld them. Counted
   *  once per distinct board state rather than once per tick: the tick runs
   *  every 60 seconds forever, so a per-tick count would measure the clock. */
  suppressed: Record<string, number>;
}

/**
 * How long the tally runs before it is allowed to reach a verdict.
 *
 * **THE STOPPING RULE, written here so it is not decided by inertia: if a
 * window closes with `passed === 0` and `suppressed` non-empty, this nudge
 * caught nothing across seven days of real operation while silencing rows,
 * and it should be DELETED rather than tuned.** Both halves are required — a
 * window with no suppressions either is an idle install, which proves nothing
 * in either direction and must not be read as a verdict.
 *
 * **Who reads it: the Live Feedback lead session.** That seat owns this
 * repo's merge/deploy lane, so it is the one that can act on the verdict, and
 * it is named here because a watcher with no named reader is decoration.
 *
 * The verdict is PUSHED rather than parked somewhere to be looked up, and
 * that is the whole point: a counter nobody remembers to read reproduces the
 * failure it was added to prevent. It fires itself through `report` when the
 * window closes, and only then — a passing window says nothing, so the
 * channel stays worth reading.
 */
export const NUDGE_TALLY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** The stamp file's shape. Versioned so a later format change can recognise
 *  an older file rather than treating it as corrupt. */
interface StampFile {
  version: number;
  stamps: Record<string, string>;
  /** Absent in a v1 file, which is not corruption — the window simply starts
   *  fresh, and the stamps still load. */
  tally?: NudgeTally;
}

const STAMP_FORMAT_VERSION = 2;

/** The data-dir filename the server uses. Exported so a test can assert the
 *  file the server actually writes rather than a copy of its name. */
export const READY_NUDGE_STAMP_FILENAME = 'ready-nudge-stamps.json';

/** The held counts as a plain object, or null when nothing was held — so the
 *  frame carries an absent field rather than an empty one. `{}` on the wire
 *  reads as "held nothing" only if you already know the field is always sent;
 *  absent says it plainly. */
function describeHeld(
  held: Partial<Record<HoldReason, number>> | undefined,
): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const [reason, n] of Object.entries(held ?? {})) {
    if ((n ?? 0) > 0) out[reason] = n as number;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The distinct reasons a pass could not evaluate rows, sorted so the same
 *  condition renders the same way twice. */
function reasonsOf(undetermined: readonly UndeterminedRow[]): string[] {
  return Array.from(new Set(undetermined.map((u) => u.reason))).sort();
}

export class ReadyWorkNudger {
  private readonly opts: ReadyWorkNudgerOptions;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly report: (message: string) => void;
  /** Activity this process has observed, by workspace. Floored by the
   *  snapshot's own clock, never replacing it. */
  private readonly observed = new Map<string, number>();
  /** The stamp each workspace was last nudged for. */
  private readonly armed = new Map<string, string>();
  /** The unevaluable condition each workspace was last REPORTED for. Separate
   *  from `armed` because the two fire on different rules: a wake is owed once
   *  per board stamp, while the report is owed once per distinct condition
   *  however many stamps pass under it. Deliberately NOT persisted — a
   *  condition worth naming is worth naming again after a restart, and a
   *  duplicate log line is the cheapest failure in this file. */
  private readonly reported = new Map<string, string>();
  /** The board state each workspace was last COUNTED for. A third map rather
   *  than a reuse of `armed`, because the two answer different questions: a
   *  wake is owed once per state the lead can be reached in, while an
   *  evaluation happened once per state whether anyone was there or not. */
  private readonly counted = new Map<string, string>();
  /** See `NudgeTally` — the instrument that can retire this feature. */
  private tallyState: NudgeTally;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stampFile: string | null;
  /** What the file already holds, so an unchanged map costs no write. `tick`
   *  runs once a minute forever; rewriting a byte-identical file each time
   *  would be the one part of this feature with an ongoing cost. */
  private lastPersisted = '';

  constructor(opts: ReadyWorkNudgerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? READY_IDLE_DEFAULT_MS;
    this.report = opts.report ?? ((message) => console.error(message));
    this.stampFile = opts.stampFile ?? null;
    // Opened before the load so a file with no tally (v1, or none at all)
    // starts its window NOW rather than at the epoch — which would close it on
    // the first tick and reach a verdict from no evidence.
    this.tallyState = { since: this.now(), passed: 0, suppressed: {} };
    this.loadStamps();
  }

  /** The measurement window as it stands. Exposed so the number has somewhere
   *  to be read from besides the file — see `NUDGE_TALLY_WINDOW_MS` for the
   *  rule it feeds and who reads it. */
  tally(): NudgeTally {
    return {
      since: this.tallyState.since,
      passed: this.tallyState.passed,
      suppressed: { ...this.tallyState.suppressed },
    };
  }

  /** Something happened on this board. Resets its idle clock, which is also
   *  what re-arms its nudge. */
  noteActivity(workspaceId: string, ts: number = this.now()): void {
    const prev = this.observed.get(workspaceId) ?? 0;
    if (ts > prev) this.observed.set(workspaceId, ts);
  }

  /**
   * A review item was answered. The lead acts on answers immediately, so
   * this does not wait for the idle window — and it is activity, so it also
   * disarms the idle nudge rather than being followed by one.
   *
   * An answer the LEAD wrote wakes nobody: the same author-suppression rule
   * every other addressed delivery applies.
   */
  reviewAnswered(input: {
    workspaceId: string;
    taskId?: string;
    /** The row's name, resolved by the caller. The nudger cannot look it up
     *  itself: its snapshot carries the READY set, and an answered row is
     *  typically not in it — it is blocked or in progress, which is why
     *  somebody was asked in the first place. */
    taskTitle?: string;
    /** The row's links, resolved by the caller for exactly the reason the
     *  title is — the snapshot this object holds carries the READY set, and
     *  an answered row is usually not in it. Pass the array as it stands,
     *  empty included: "no links" and "no row" are different frames and the
     *  line reads differently for each. */
    taskLinks?: readonly unknown[];
    actorId?: string;
  }): void {
    const ts = this.now();
    this.noteActivity(input.workspaceId, ts);
    let board: ReadyWorkSnapshot | undefined;
    try {
      board = this.opts.lookup(input.workspaceId);
    } catch {
      return;
    }
    if (!board || board.retired) return;
    const lead = board.leadAgentId;
    if (lead === undefined || lead === input.actorId) return;
    // The answer itself has re-armed the idle nudge via `noteActivity`; the
    // lead is being woken right now, so drop the arming rather than let a
    // second frame follow this one fifteen minutes from now over the same
    // fact. It re-arms on the next real activity.
    this.armed.set(input.workspaceId, this.stampFor(board, ts));
    this.saveStamps();
    if (!this.reachable(board.workspaceId, lead)) return;
    this.emit(board.workspaceId, lead, {
      event: REVIEW_ANSWERED_EVENT,
      workspaceId: board.workspaceId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.taskTitle !== undefined ? { title: input.taskTitle } : {}),
      ...(input.taskLinks !== undefined ? { links: input.taskLinks } : {}),
      ts,
    });
  }

  /**
   * A row just became ready by an act the board itself performed — today,
   * a task captured from meeting speech and judged clear enough to start.
   * Same immediacy contract as `reviewAnswered`, and for the same reason:
   * the person asked for this out loud seconds ago, so a wake that waits
   * out the idle window answers a different question than the one asked.
   * Rides the `ready_idle` event name because that is what it is — ready
   * work awaiting dispatch — and the frame names the row so the lead can
   * tell whether the wake was worth the turn.
   */
  taskReady(input: { workspaceId: string; taskId: string; taskTitle: string }): void {
    const ts = this.now();
    this.noteActivity(input.workspaceId, ts);
    let board: ReadyWorkSnapshot | undefined;
    try {
      board = this.opts.lookup(input.workspaceId);
    } catch {
      return;
    }
    if (!board || board.retired) return;
    const lead = board.leadAgentId;
    if (lead === undefined) return;
    // This wake IS the stamp's nudge: spend it so the timer does not follow
    // with a second frame over the same fact. It re-arms on real activity.
    this.armed.set(input.workspaceId, this.stampFor(board, ts));
    this.saveStamps();
    if (!this.reachable(board.workspaceId, lead)) return;
    this.emit(board.workspaceId, lead, {
      event: READY_IDLE_EVENT,
      workspaceId: board.workspaceId,
      taskId: input.taskId,
      title: input.taskTitle,
      ts,
    });
  }

  /** One pass over every board. Never throws — this runs on a timer. */
  tick(): void {
    let boards: readonly ReadyWorkSnapshot[];
    try {
      boards = this.opts.snapshot();
    } catch {
      // A snapshot can fail mid-hydrate or mid-shutdown. A wake must never
      // take the server down with it.
      return;
    }
    const now = this.now();
    const live = new Set<string>();
    for (const board of boards) {
      live.add(board.workspaceId);
      this.considerBoard(board, now);
    }
    // Forget boards that are gone, so neither map outlives what it describes.
    // The pruning has to reach the FILE too, or the durable copy grows for the
    // life of the install while the in-memory one stays bounded.
    for (const key of this.armed.keys()) if (!live.has(key)) this.armed.delete(key);
    for (const key of this.observed.keys()) if (!live.has(key)) this.observed.delete(key);
    for (const key of this.reported.keys()) if (!live.has(key)) this.reported.delete(key);
    for (const key of this.counted.keys()) if (!live.has(key)) this.counted.delete(key);
    // AFTER every board has been considered, so a window closing on this tick
    // reaches its verdict over the counts this tick produced rather than over
    // last tick's.
    this.closeTallyWindow(now);
    this.saveStamps();
  }

  /** Arm the timer. Unref'd, so it can never hold a dying process open. */
  start(tickMs: number = READY_TICK_DEFAULT_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  /** Idempotent: a shutdown path that already stopped must not throw. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return this.timer !== null;
  }

  /** How many boards are currently holding a spent nudge. Test surface for
   *  the pruning above — a map that grows forever is invisible otherwise. */
  armedCount(): number {
    return this.armed.size;
  }

  private considerBoard(board: ReadyWorkSnapshot, now: number): void {
    const key = board.workspaceId;
    const lead = board.leadAgentId;
    const undetermined = board.undetermined ?? [];
    // Nothing to say, or nobody to say it to. Drop the arming so a board that
    // becomes nudgeable again starts from a clean slate rather than from a
    // stamp recorded under different conditions.
    //
    // "Nothing to say" now takes TWO things being true: no ready row AND no
    // row the gate failed to read. A pass that examined nine rows and could
    // not evaluate one of them has not established that the board is quiet,
    // and returning here on `ready.length === 0` alone is precisely how "I
    // could not look" came to be delivered as "I looked and saw nothing".
    if (board.retired || lead === undefined) {
      this.armed.delete(key);
      this.counted.delete(key);
      return;
    }
    const lastActivityAt = this.lastActivity(board);
    const idleMs = now - lastActivityAt;
    if (idleMs < this.idleMs) return;
    const stamp = this.stampFor(board, lastActivityAt);
    // Counted BEFORE the early return below, and that ordering is the whole
    // instrument: a board whose every row is held produces no wake at all, so
    // counting only where a frame is decided would record the suppressions
    // that happen to sit beside ready work and miss the ones that are the
    // entire point. Once per board STATE, never once per tick.
    if (this.counted.get(key) !== stamp) {
      this.counted.set(key, stamp);
      this.tallySuppressed(board);
    }
    if (board.ready.length === 0 && undetermined.length === 0) {
      this.armed.delete(key);
      return;
    }
    if (this.armed.get(key) === stamp) return;
    // Named before the reachability check below, and that ordering is the
    // point: the commonest reason a wake is not delivered is a lead holding no
    // stream, which is exactly when an unevaluable board would otherwise leave
    // no trace anywhere.
    this.reportUnevaluable(board, undetermined);
    // Checked LAST, and deliberately not recorded when it says no: a nudge
    // that reached nobody must stay owed, or the lead returns to a board
    // that has already decided it told them.
    if (!this.reachable(key, lead)) return;
    const top = board.ready[0];
    const held = describeHeld(board.held);
    this.emit(key, lead, {
      event: READY_IDLE_EVENT,
      workspaceId: key,
      ...(top ? { taskId: top.id, title: top.title } : {}),
      readyCount: board.ready.length,
      consideredCount: board.considered,
      ...(held ? { held } : {}),
      ...(undetermined.length > 0
        ? { undetermined: { count: undetermined.length, reasons: reasonsOf(undetermined) } }
        : {}),
      idleMs,
      ts: now,
    });
    this.armed.set(key, stamp);
    // A DELIVERED nudge — the numerator the stopping rule reads. Counted here
    // rather than beside the suppressions above so it can never be inflated by
    // a frame that was decided but never sent.
    this.tallyState.passed += 1;
  }

  /** Fold one board state's withheld rows into the window. */
  private tallySuppressed(board: ReadyWorkSnapshot): void {
    for (const [reason, n] of Object.entries(board.held ?? {})) {
      if ((n ?? 0) > 0) {
        this.tallyState.suppressed[reason] = (this.tallyState.suppressed[reason] ?? 0) + (n ?? 0);
      }
    }
    const unread = (board.undetermined ?? []).length;
    // Its own condition, never folded in with the holds. A row nobody could
    // read is not a row the gate decided about, and merging the two would hide
    // exactly the number that says the gate is broken rather than working.
    if (unread > 0) {
      this.tallyState.suppressed.undetermined =
        (this.tallyState.suppressed.undetermined ?? 0) + unread;
    }
  }

  /**
   * Close the window when its seven days are up, and say so only when the
   * answer is actionable.
   *
   * Silence on a passing window is deliberate: a verdict emitted every seven
   * days regardless would be the 395-identical-hourly-failures pattern with a
   * longer period, and its reader would learn the same lesson. The window
   * rolls either way, so a feature that fires this month and stops next month
   * is still caught.
   */
  private closeTallyWindow(now: number): void {
    if (now - this.tallyState.since < NUDGE_TALLY_WINDOW_MS) return;
    const suppressed = Object.entries(this.tallyState.suppressed)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const total = suppressed.reduce((sum, [, n]) => sum + n, 0);
    // BOTH halves required. A window with no suppressions either is an idle
    // install, and reading a verdict off no evidence is the reasoning this
    // instrument replaces rather than an application of it.
    if (this.tallyState.passed === 0 && total > 0) {
      const days = Math.round((now - this.tallyState.since) / (24 * 60 * 60_000));
      try {
        this.report(
          `[nudge] ready-work wake never fired in ${days} day(s) while it suppressed ` +
            `${total} row-evaluation(s) — ${suppressed.map(([r, n]) => `${n} ${r}`).join(', ')}. ` +
            'Per the stopping rule in ready-nudge.ts, delete the nudge rather than tune it.',
        );
      } catch {
        // A reporter that throws must not stop the window from rolling.
      }
    }
    this.tallyState = { since: now, passed: 0, suppressed: {} };
  }

  /**
   * Say — once per distinct condition — that this board holds rows the gate
   * could not read.
   *
   * Once per CONDITION rather than once per tick, and not persisted across a
   * restart. Both choices point the same way: a line nobody can act on twice
   * is worse than no line, and a condition that outlives a deploy is worth
   * stating again to whoever is watching now.
   */
  private reportUnevaluable(
    board: ReadyWorkSnapshot,
    undetermined: readonly UndeterminedRow[],
  ): void {
    if (undetermined.length === 0) {
      this.reported.delete(board.workspaceId);
      return;
    }
    const condition = undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort()
      .join(',');
    if (this.reported.get(board.workspaceId) === condition) return;
    this.reported.set(board.workspaceId, condition);
    try {
      this.report(
        `[nudge] ${board.workspaceId}: ${undetermined.length} of ${board.considered} row(s) ` +
          `could not be evaluated and were NOT counted ready — ${condition}`,
      );
    } catch {
      // A reporter that throws must not take the pass down with it. The whole
      // point of this method is that a board is not left unmentioned; losing
      // the mention is bad, losing every other board's wake is worse.
    }
  }

  /** The later of the store's record and what this process has seen. */
  private lastActivity(board: ReadyWorkSnapshot): number {
    return Math.max(board.lastActivityAt, this.observed.get(board.workspaceId) ?? 0);
  }

  /**
   * Activity clock, the ready set, and — when there is one — the set of rows
   * the gate could not read. One string, so "the board moved", "what is ready
   * changed" and "what I cannot see changed" all arm the nudge through the
   * same door.
   *
   * The third segment is APPENDED ONLY WHEN NON-EMPTY, which is not tidiness:
   * a stamp is compared against one a previous process wrote to disk, so
   * unconditionally adding a segment would make every stored stamp mismatch on
   * the first tick after a deploy and bill every idle board one extra wake.
   * Boards with nothing unreadable — which is all of them, almost always —
   * keep computing the byte-identical string they did before.
   */
  private stampFor(board: ReadyWorkSnapshot, lastActivityAt: number): string {
    const ids = board.ready
      .map((r) => r.id)
      .slice()
      .sort()
      .join(',');
    const undetermined = (board.undetermined ?? [])
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort()
      .join(',');
    return undetermined.length > 0
      ? `${lastActivityAt}|${ids}|${undetermined}`
      : `${lastActivityAt}|${ids}`;
  }

  private reachable(workspaceId: string, agentId: string): boolean {
    try {
      return this.opts.canReach(workspaceId, agentId);
    } catch {
      return false;
    }
  }

  /**
   * Read the stamps a previous run left. A file that cannot be read starts
   * this run empty — never throws, and deliberately does NOT move the file
   * aside the way `PushStore` does with a corrupt subscription list. The two
   * are not comparable losses: a lost subscription is a device that stops
   * being notified until somebody re-registers it, while a lost stamp is one
   * extra wake that the next tick re-arms on its own.
   */
  private loadStamps(): void {
    if (!this.stampFile || !existsSync(this.stampFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.stampFile, 'utf8')) as Partial<StampFile>;
      if (!parsed || typeof parsed.stamps !== 'object' || parsed.stamps === null) return;
      for (const [workspaceId, stamp] of Object.entries(parsed.stamps)) {
        // Row-level tolerance, matching the store next door: one hand-edited
        // entry must not cost every other board its arming.
        if (typeof stamp === 'string') this.armed.set(workspaceId, stamp);
      }
      // Same tolerance one level up: a v1 file has no tally and an edited one
      // may have a broken tally, and neither may cost the stamps their load —
      // that would bill every lead a duplicate wake to protect a counter.
      const tally = parsed.tally;
      if (tally && typeof tally.since === 'number' && typeof tally.passed === 'number') {
        const suppressed: Record<string, number> = {};
        for (const [reason, n] of Object.entries(tally.suppressed ?? {})) {
          if (typeof n === 'number' && n > 0) suppressed[reason] = n;
        }
        this.tallyState = { since: tally.since, passed: tally.passed, suppressed };
      }
      this.lastPersisted = this.serializeStamps();
    } catch {
      this.armed.clear();
    }
  }

  private serializeStamps(): string {
    // Key order is the map's insertion order, which differs between a fresh
    // load and a run that has re-armed boards — sorted, so the content compare
    // above answers "did anything change" rather than "did anything move".
    const stamps: Record<string, string> = {};
    for (const key of Array.from(this.armed.keys()).sort()) {
      stamps[key] = this.armed.get(key) as string;
    }
    // Sorted here too, for the same reason: the tally is compared as text to
    // decide whether a write is owed, and key order that moved without any
    // count changing would rewrite the file on a tick that measured nothing.
    const suppressed: Record<string, number> = {};
    for (const reason of Object.keys(this.tallyState.suppressed).sort()) {
      suppressed[reason] = this.tallyState.suppressed[reason] as number;
    }
    const file: StampFile = {
      version: STAMP_FORMAT_VERSION,
      stamps,
      tally: { ...this.tallyState, suppressed },
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  /** Write the map back, when it has actually moved. Never throws: this runs
   *  inside a timer tick, and a full disk must not stop the wakes. */
  private saveStamps(): void {
    if (!this.stampFile) return;
    const next = this.serializeStamps();
    if (next === this.lastPersisted) return;
    try {
      writeFileSync(this.stampFile, next);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[nudge] could not persist stamps:', err);
    }
  }

  private emit(workspaceId: string, agentId: string, frame: NudgeFrame): void {
    try {
      this.opts.send(workspaceId, agentId, frame);
    } catch (err) {
      console.error('[nudge] send failed:', err);
    }
  }
}
