/**
 * The board telling its lead that work has stopped.
 *
 * The gap this closes is the one thing a board can see and nobody acts on
 * until a person notices: a row somebody claimed, or a row the queue cleared,
 * that has gone quiet. Until now the only mechanism was the lead deciding to
 * go and look — which makes the human the watchdog for a fact the board
 * already holds, and measurement of two real lead sessions found the stalls
 * ending when the owner typed, not when anybody checked.
 *
 * So: a timer reads every board, asks `stall-gate.ts` which rows have stopped,
 * and sends ONE frame addressed to that board's lead. The frame rides
 * `sendToAgent` on `ws~<workspaceId>` — the same addressed delivery the
 * ready-work wake and `triage.requested` use, and for the same reason. It is a
 * DELIVERY rather than a change, so it deliberately does not go through the
 * store's emit choke point and never reaches `events.jsonl`.
 *
 * ── Why most of this file is about NOT sending ──────────────────────────
 *
 * Identical to the argument in `ready-nudge.ts`, and worth restating because
 * it is the only thing standing between this feature and being ignored: a
 * wake costs a turn, and one that repeats every tick while nothing has changed
 * costs a turn every tick. The lead learns — correctly — that the signal
 * carries no information, and then the wake that mattered arrives into a
 * session already trained to skim it.
 *
 * The arming rule is therefore a STAMP rather than a cooldown:
 *
 *     stamp = <how many repeat windows the board's oldest row has been quiet>
 *             | <row ids, sorted> | <unreadable rows, sorted>
 *
 * A board is woken when that stamp gets WORSE — a row id that was not stuck
 * before, a higher escalation bucket, or a row the pass could not read that it
 * could read last time. A board where nothing has changed says nothing, and so
 * does a board that has got better.
 *
 * That last clause is load-bearing, and it was the first version's bug. The
 * rule was equality, so a SHRINKING set re-armed the wake exactly as a growing
 * one did: the lead was woken to file an ask, filed it, the row left the list,
 * and the next tick woke the lead again to announce its own fix. A wake that
 * re-arms on the action it asked for cannot extinguish itself — measured on a
 * live board as six wakes in one evening, none of them naming a stalled row,
 * the unfiled count walking 1→2→3→2→1. The comparison lives in `growsOn`.
 *
 * ── Why escalation is folded into the stamp ─────────────────────────────
 *
 * This is the one place the design departs from the ready-work wake. Ready
 * work that nobody picks up is a queue fact and saying it once is enough.
 * A row that was supposed to be moving and is STILL not moving an hour later
 * is a worse fact than it was an hour ago, and a wake that never repeats would
 * let it sit forever behind a stamp that was correct when it was written.
 *
 * The obvious shape — a second timer, or a cooldown after which the wake
 * re-fires — is the wrong one, for the reason the file next door gives at
 * length: a repeat keyed on the clock keeps firing over a row nobody can do
 * anything about, which is how a channel becomes unreadable. So the repeat is
 * keyed on the ROW'S OWN silence instead, quantised into windows. A row that
 * has been quiet for four hours re-enters the stamp when it reaches eight, and
 * a row that recovers stops escalating with nothing to cancel: it simply
 * leaves the list.
 *
 * ── What is NOT checked, and why not ────────────────────────────────────
 *
 * The ticket asked for a capacity condition — only wake when the lead has
 * subagent capacity free. The server cannot know that. Nothing in the store,
 * the attached-agent roster, or the event stream carries how many subagents a
 * session is running; the nearest available number counts ATTACHED SESSIONS,
 * which is a different fact that would answer the question wrongly while
 * looking like an answer. The condition is dropped rather than approximated,
 * on the ticket's own instruction. If it is wanted, the count has to be
 * reported by the sessions themselves first.
 *
 * ── Why the stamps are on disk ──────────────────────────────────────────
 *
 * Prod restarts at every merge, several times a day. A map that lived only in
 * this process would hand every board a clean slate at each restart and
 * re-fire one wake per board over facts their leads had already been told —
 * the "signal carries no information" training above, delivered by the release
 * process rather than by a timer. Best-effort in BOTH directions and
 * deliberately so: a stamp file that cannot be read or written costs at most
 * one duplicate wake, which is much the cheaper failure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ParallelismCapSummary } from './ready-nudge.ts';
import type { HeldItemRow, StallUndeterminedRow, StalledRow } from './stall-gate.ts';

/**
 * How long a row must stay quiet before the wake says it AGAIN.
 *
 * Four hours: coarse enough that a lead who has seen the row once is not told
 * a second time inside the span it would take them to act on it, and fine
 * enough that a board abandoned overnight is named several times rather than
 * once. It quantises the silence of the board's OLDEST quiet row — see the
 * header — so nothing here is a timer and nothing needs cancelling.
 *
 * `CW_STALL_REPEAT_HOURS` overrides it, because this is the number that sets
 * what a fleet pays to be told about boards where nothing is changing.
 */
export const STALL_REPEAT_DEFAULT_MS = 4 * 60 * 60_000;

/** How often the timer looks, when nobody says otherwise. Far below the quiet
 *  window on purpose: the tick is a cheap read over state already in memory,
 *  and the window is what decides when a wake is owed. */
export const STALL_TICK_DEFAULT_MS = 60_000;

/** Its own event name rather than a reason field on an existing one, because
 *  the plugin renders a board event off the name alone — one name would make a
 *  stall and a ready-work wake indistinguishable in the lead's channel. */
export const STALL_EVENT = 'workspace.stalled';

/**
 * The quality gate telling a FILER their review item is held — at filing
 * time (the route sends it) and again when the hold has stood past the
 * window (this loop sends it, `overdue: true`). Addressed to the filer,
 * never the lead: the lead learns of an overdue hold inside the stall frame,
 * where it sits beside the other things the lead drives.
 */
export const REVIEW_ITEM_HELD_EVENT = 'workspace.review_item_held';

/** The data-dir filename the server uses. Exported so a test can assert the
 *  file the server actually writes rather than a copy of its name. */
export const STALL_NUDGE_STAMP_FILENAME = 'stall-nudge-stamps.json';

/** One board, as the nudger needs to see it — `stall-gate.ts`'s verdict plus
 *  who to tell and whether to tell them at all. */
export interface StallSnapshot {
  workspaceId: string;
  /** The addressee. Absent means an empty seat, which is never woken. */
  leadAgentId?: string;
  retired: boolean;
  /** Work that should be moving and is not, quietest first. */
  stalled: readonly StalledRow[];
  /** Rows waiting on a person with no question filed where they would see it. */
  unfiled: readonly StalledRow[];
  /** THE DENOMINATOR: how many open rows the gate examined. */
  considered: number;
  /** Rows the gate could not evaluate. Neither stalled nor healthy. */
  undetermined: readonly StallUndeterminedRow[];
  /** Runnable rows past the board's parallelism cap, which the gate did not
   *  judge (`stall-gate.ts`). Absent when none — the same as zero. */
  beyondCapacity?: number;
  /** The cap itself and its last move, for the wake to name beside
   *  `beyondCapacity`. Absent from a caller that does not read it. */
  parallelismCap?: ParallelismCapSummary;
  /** Review items the quality gate is holding past the window — asks that
   *  exist on a ticket and on nobody's queue. Absent on a snapshot from a
   *  caller that does not read them, which is the same as none. */
  held?: readonly HeldItemRow[];
}

/** What the filer's own wake carries. Flat, like every other frame. */
export interface ReviewItemHeldFrame {
  event: typeof REVIEW_ITEM_HELD_EVENT;
  workspaceId: string;
  /** The ticket the item hangs on. Absent for an item filed as a `review`
   *  payload on a plain doc thread, which hangs on a comment instead. */
  taskId?: string;
  title: string;
  /** The item's id on whichever surface holds it — the review item's id on a
   *  ticket, the COMMENT's id on a doc thread. */
  reviewItemId: string;
  /** The doc-thread address, when that is where the item lives. */
  docId?: string;
  threadId?: string;
  commentId?: string;
  /**
   * The paste-ready `revise_review_item(…)` call that ends this hold.
   *
   * Sent rather than left for the reader to assemble, because the two
   * surfaces take different arguments and a filer who guesses gets a
   * refusal. A hold whose wake cannot say how to lift it is the dead end
   * that kept the thread path ungated in the first place.
   */
  revise?: string;
  headline: string;
  reason: string;
  /** Present, and true, only on the loop's complaint — the filing-time wake
   *  is the ask, this one is the ask repeated after the window. */
  overdue?: true;
  heldMs?: number;
  ts: number;
}

/** What goes on the wire. Flat, because the plugin's renderer reads these
 *  fields off the top level — see `nudge-line.ts` in packages/mcp. */
export interface StallNudgeFrame {
  event: typeof STALL_EVENT;
  workspaceId: string;
  /** The row to start with — the quietest stalled one, or the top unfiled row
   *  when nothing is stalled. A wake with no subject costs a turn and says
   *  nothing. */
  taskId?: string;
  /** That row's name. Sent because the id alone makes the reader call
   *  `get_task` before they can tell whether the wake was worth the turn. */
  title?: string;
  stalledCount: number;
  /** How many open rows the pass EXAMINED. Sent even when it equals
   *  `stalledCount`, because a reader cannot tell a stated denominator from an
   *  omitted one after the fact. */
  consideredCount: number;
  /**
   * Every stalled row, uncapped.
   *
   * Uncapped on purpose: the lead's job with this frame is to drive each row,
   * and a list clipped to a preview sends them to look up the rest — which is
   * the lookup the frame exists to save. A stalled set large enough to be a
   * wall of text is itself the finding. The RENDERED line is what shortens;
   * see `nudge-line.ts`.
   */
  rows?: readonly StalledRow[];
  /** Rows waiting on a person with nothing filed. Absent rather than empty,
   *  so a frame that carries none says so by omission. */
  unfiled?: readonly StalledRow[];
  /**
   * Rows the pass could not evaluate. Absent when there were none, which is
   * the ordinary case — its PRESENCE is the whole signal. A frame carrying
   * this with `stalledCount: 0` is the one case where the board wakes its lead
   * with no stuck work to hand over: the pass could not establish that the
   * board is healthy, which is a different message from a healthy board —
   * and that one it does not send at all.
   */
  undetermined?: { count: number; reasons: readonly string[] };
  /**
   * Runnable rows the board's parallelism cap kept out of this pass — ranked
   * past the top `cap` of the queue, so not judged. Absent when none. Sent so
   * the reader can tell "nine rows checked, two stalled" from "nine rows,
   * five judged, two stalled": the unjudged rows are idle by rule, not
   * healthy.
   */
  beyondCapacity?: number;
  /**
   * The cap that kept those rows out, with who moved it and when. Sent ONLY
   * beside `beyondCapacity`, so a wake that never mentions the cap does not
   * grow a field about it; the line names the setter in the same sentence.
   */
  parallelismCap?: ParallelismCapSummary;
  /**
   * Review items held by the quality gate past the window, oldest first.
   * Absent when there are none. A frame carrying ONLY this is a real wake:
   * a question the filer wrote and the reader cannot see is work stopped,
   * even though no row is quiet. `heldItems`, not `held`: the ready_idle
   * frame already spends `held` on its withheld-row counts, and the plugin
   * reads both frames into one payload type.
   */
  heldItems?: readonly HeldItemRow[];
  /**
   * What is new since the last wake this board was sent — the reason the
   * lead is being woken again rather than the whole state of the board.
   *
   * Beside `rows` rather than instead of it. Driving every finding is the
   * frame's job, so the list stays uncapped; but a repeat that re-lists four
   * rows when one of them moved makes the reader diff two frames in their
   * head to find out why they were woken, which is the lookup this frame
   * exists to save.
   *
   * Absent on a board's FIRST wake, where everything in it is new and a
   * second copy of the same list would be noise.
   */
  changed?: {
    /** Rows named here that this board's lead has not been told about, or
     *  that came back under a different bucket. */
    rows?: readonly StalledRow[];
    /** Ids of rows the pass could not read that it could read last time. */
    undetermined?: readonly string[];
    /** Holds placed since the last wake. */
    heldItems?: readonly HeldItemRow[];
    /** The board's worst row crossed another repeat window. Present only when
     *  true, so its absence is "nothing got older", not "false". */
    escalated?: true;
  };
  /**
   * The lead this wake was ADDRESSED to, when it was delivered to somebody
   * else because the lead could not be reached. Absent on the ordinary wake,
   * so its presence is the whole signal: the reader is a stand-in, and the
   * board's lead seat is held by a session that is not there.
   *
   * Carried on the frame rather than left in the log, because the person who
   * needs it is the one who just got woken about a board they may not own —
   * "why am I being told this" is answerable only here.
   */
  escalatedFrom?: string;
  ts: number;
}

export interface StallNudgerOptions {
  /** Every live board, rebuilt each tick. */
  snapshot: () => readonly StallSnapshot[];
  /** Is this agent holding a stream we could actually wake? */
  canReach: (workspaceId: string, agentId: string) => boolean;
  /**
   * Everyone else holding a stream on this board — the fallback addressees
   * when the lead cannot be woken.
   *
   * Same source as `canReach`, deliberately: an enumeration drawn from one
   * place and a predicate from another will disagree eventually, and the
   * disagreement shows up as a wake sent to a session that is not there.
   * Omitted → no escalation, which is the behaviour this option replaced.
   */
  attachedAgents?: (workspaceId: string) => readonly string[];
  /** Addressed delivery. Returns how many sinks it reached. */
  send: (workspaceId: string, agentId: string, frame: StallNudgeFrame) => number;
  /**
   * The same addressed delivery, aimed at a held item's FILER. Optional: a
   * caller that never reads held items never nudges filers. Sent once per
   * item per process — the lead's frame is the durable complaint; this one is
   * the tap on the shoulder that costs the cheaper turn.
   */
  sendToFiler?: (workspaceId: string, agentId: string, frame: ReviewItemHeldFrame) => number;
  repeatMs?: number;
  now?: () => number;
  /**
   * Where a condition the wake could not evaluate is written when there is no
   * lead to tell. Defaults to `console.error`.
   *
   * It exists because the frame is not a guaranteed reader: the commonest
   * reason a wake is not delivered is that the lead holds no stream, and that
   * is exactly when an unevaluable board would otherwise vanish. Called once
   * per distinct condition per board, never once per tick.
   */
  report?: (message: string) => void;
  /** Where the armed stamps are kept between runs. Omitted → memory only,
   *  which is what every test that is not about persistence wants. */
  stampFile?: string;
  /**
   * The second addressee, run once per board per tick after the wake
   * decision: the board going over the lead's head when a row it was already
   * told about has still not moved (`stall-escalation.ts`).
   *
   * It hangs here rather than on a timer of its own because the thing it
   * needs — WHEN each row was told — is this object's memory and nobody
   * else's, and because a second loop over every board would read the same
   * snapshot twice a minute to answer one more question about it.
   *
   * Called for every live board, including one with nothing wrong: a board
   * that recovered is exactly when a filed item has to be taken back.
   * Omitted → nothing escalates, which is the behaviour this option
   * replaced.
   */
  escalate?: (board: StallSnapshot, told: ReadonlyMap<string, ToldTime>, now: number) => void;
}

/**
 * When a board's lead learned about a row — or, when there was nobody to
 * learn it, when the board first COULD NOT tell anyone.
 *
 * The second case is the one the escalation was built for. A lead session
 * that has died with nothing else attached is exactly the board that most
 * needs a person told, and keying the escalation on delivery alone would make
 * that board the one board that never escalates: no addressee, no delivered
 * wake, no told-time, no clock. So an undeliverable finding stamps its own
 * moment and the window runs from there — and `delivered` travels with it,
 * because "the lead was told two hours ago" and "nobody could be reached for
 * two hours" are different sentences to put in front of a person.
 *
 * It does NOT make the row told: the `told` memory is untouched, so the wake
 * stays owed and fires in full when a session finally attaches.
 */
export interface ToldTime {
  at: number;
  delivered: boolean;
}

/** The stamp file's shape. Versioned so a later format change can recognise an
 *  older file rather than treating it as corrupt. `told` is additive: a file
 *  written before it existed simply has none, and `loadStamps` seeds it from
 *  the stamp so the upgrade costs no board a wake. */
interface StampFile {
  version: number;
  stamps: Record<string, string>;
  /** workspaceId → rowId → the bucket the row was last named under. */
  told?: Record<string, Record<string, string>>;
  /**
   * workspaceId → rowId → when the lead was told. A SECOND map rather than a
   * richer value in `told`, so a build that predates it reads the file it
   * always read instead of skipping every row as the wrong type — the cost of
   * that would be one wake per board on a rollback, and this feature is not
   * worth billing anybody for going backwards.
   */
  toldAt?: Record<string, Record<string, number>>;
  /** workspaceId → rowId → when the board first held a finding it could tell
   *  nobody about. Its own map for the same reason `toldAt` is: an older
   *  build reads the file it always read. */
  undeliverable?: Record<string, Record<string, number>>;
}

const STAMP_FORMAT_VERSION = 1;

/**
 * The bucket recorded for a row remembered from a stamp written before this
 * memory existed. It compares equal to every bucket, so such a row is not
 * news until it leaves and stays gone — the alternative is one wake per board
 * on the first tick after this deploys, over rows their leads had been told
 * about already.
 */
const UNKNOWN_BUCKET = '?';

/**
 * How many rows a board may remember. The memory exists so a row that laps
 * its quiet window is not re-said; it must not become a list of every row
 * ever named on a long-lived board. Rows fall out by age first (a whole
 * repeat window without being a finding), and this is the backstop for a
 * board churning faster than that.
 */
const TOLD_ROWS_PER_BOARD = 200;

/** One row this board's lead has already been told about. */
interface ToldRow {
  /** The bucket it was named under. A row coming back under a DIFFERENT one
   *  is news: the lead's next move differs per bucket. */
  bucket: string;
  /** When it was last SEEN as a finding — refreshed every tick it is on the
   *  list, wake or no wake, because the question this answers is how long the
   *  row has been off the list, not how long since anyone was told. */
  seenAt: number;
  /**
   * When the lead was first told about this stretch of stuckness — set on a
   * DELIVERED wake and never refreshed while the row stays remembered, which
   * is the whole difference between it and `seenAt` above.
   *
   * It exists for the escalation (`stall-escalation.ts`), whose question is
   * the one nothing here could answer: how long ago was somebody told. A row
   * that leaves the list for a whole repeat window is forgotten with its
   * stamp, so a row that recovers and stalls again starts the clock afresh —
   * which is right: that is a new stretch, and nobody has been told about it
   * yet.
   */
  toldAt?: number;
}

/** The distinct reasons a pass could not evaluate rows, sorted so the same
 *  condition renders the same way twice. */
function reasonsOf(undetermined: readonly StallUndeterminedRow[]): string[] {
  return Array.from(new Set(undetermined.map((u) => u.reason))).sort();
}

/** One armed stamp, read back apart. A stamp written by an older build simply
 *  parses into tokens the current one never produces, which reads as all-new
 *  and costs the board a single wake — see `stampFor`. */
function parseStamp(stamp: string): {
  bucket: number;
  ids: Set<string>;
  undetermined: Set<string>;
} {
  const [bucket = '', ids = '', undetermined = ''] = stamp.split('|');
  const parsed = Number.parseInt(bucket, 10);
  return {
    // A bucket that will not parse must not read as an escalation, so it
    // floors rather than becoming NaN — every comparison against NaN is false,
    // which would silently disable the escalation half of the rule.
    bucket: Number.isFinite(parsed) ? parsed : 0,
    ids: new Set(ids.split(',').filter((token) => token.length > 0)),
    undetermined: new Set(undetermined.split(',').filter((token) => token.length > 0)),
  };
}

/**
 * One HOLD, not one item: the same review item revised, passed and held
 * again is a new hold with a new `heldAt`, and its filer is owed a fresh
 * nudge even when no tick happened to see the item pass in between.
 */
function filerKey(workspaceId: string, item: HeldItemRow): string {
  return `${workspaceId}|${item.reviewItemId}|${item.heldAt}`;
}

export class StallNudger {
  private readonly opts: StallNudgerOptions;
  private readonly now: () => number;
  private readonly repeatMs: number;
  private readonly report: (message: string) => void;
  /** The stamp each workspace was last woken for. */
  private readonly armed = new Map<string, string>();
  /**
   * The board's escalation high-water mark, and the ROW that set it — see
   * `priorFor`. Held so a finding flickering off the list for a pass cannot
   * lower the bucket and make its own return read as an escalation; scoped to
   * the row so the hold cannot outlive it and swallow the next row's repeat.
   */
  private readonly held = new Map<string, { rowId: string; bucket: number }>();
  /**
   * Which rows each board's lead has already been told about, and when each
   * was last seen on the list.
   *
   * Separate from `armed`, and the reason this exists: the stamp is the
   * board's CURRENT set, so a row leaving it was forgotten, and the row
   * lapping its quiet window again read as a brand-new stall. On a board
   * whose owner posts a status every turn that is one wake per window
   * forever — measured 2026-09-04 as five wakes in sixty-five minutes over
   * two rows that were being actively worked, one of them with an open
   * question sitting on the reader's queue the whole time.
   *
   * Deliberately NOT cleared when a board goes wholly clean, which is where
   * the obvious version puts it: on a one-row board every wake is followed by
   * a clean board the moment the owner posts anything, and forgetting there
   * would restore the exact loop this removes.
   */
  private readonly told = new Map<string, Map<string, ToldRow>>();
  /**
   * Rows this board has a finding about and NOBODY to tell — by row, from the
   * first tick that was true.
   *
   * Separate from `told` on purpose, and the separation is the whole point: an
   * entry here must not make a row stop being news, or a board whose lead
   * comes back would be handed silence about the rows it was away for. This
   * only gives the escalation a clock to run from (`ToldTime`), and it is
   * cleared the moment a wake about that row is actually delivered.
   */
  private readonly undeliverable = new Map<string, Map<string, number>>();
  /** The unevaluable condition each workspace was last REPORTED for. Separate
   *  from `armed` because the two fire on different rules: a wake is owed once
   *  per board stamp, while the report is owed once per distinct condition
   *  however many stamps pass under it. Deliberately NOT persisted — a
   *  condition worth naming is worth naming again after a restart, and a
   *  duplicate log line is the cheapest failure in this file. */
  private readonly reported = new Map<string, string>();
  /**
   * Held items whose filer has been nudged, by `<workspaceId>|<reviewItemId>`.
   * Once per item per process, and deliberately NOT persisted: a filer's
   * nudge is the cheap turn (the filer is the party who can end it in one
   * call), and a duplicate after a deploy is worth less than the code to
   * avoid it. Pruned when the item leaves the held list.
   */
  private readonly filersTold = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stampFile: string | null;
  /** What the file already holds, so an unchanged map costs no write. `tick`
   *  runs once a minute forever; rewriting a byte-identical file each time
   *  would be the one part of this feature with an ongoing cost. */
  private lastPersisted = '';

  constructor(opts: StallNudgerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.repeatMs = opts.repeatMs ?? STALL_REPEAT_DEFAULT_MS;
    this.report = opts.report ?? ((message) => console.error(message));
    this.stampFile = opts.stampFile ?? null;
    this.loadStamps();
  }

  /** One pass over every board. Never throws — this runs on a timer. */
  tick(): void {
    let boards: readonly StallSnapshot[];
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
      // After the wake, so a row told for the first time on this very tick is
      // measured from now and cannot escalate in the same pass. Isolated: a
      // filer that throws must cost its own board, never the boards behind it.
      this.escalate(board, now);
    }
    // Forget boards that are gone, so neither map outlives what it describes.
    // The pruning has to reach the FILE too, or the durable copy grows for the
    // life of the install while the in-memory one stays bounded.
    for (const key of this.armed.keys()) if (!live.has(key)) this.armed.delete(key);
    for (const key of this.held.keys()) if (!live.has(key)) this.held.delete(key);
    for (const key of this.told.keys()) if (!live.has(key)) this.told.delete(key);
    for (const key of this.undeliverable.keys()) if (!live.has(key)) this.undeliverable.delete(key);
    for (const key of this.reported.keys()) if (!live.has(key)) this.reported.delete(key);
    for (const key of this.filersTold) {
      if (!live.has(key.slice(0, key.indexOf('|')))) this.filersTold.delete(key);
    }
    this.saveStamps();
  }

  /** Arm the timer. Unref'd, so it can never hold a dying process open. */
  start(tickMs: number = STALL_TICK_DEFAULT_MS): void {
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

  /** How many boards are currently holding a spent wake. Test surface for the
   *  pruning above — a map that grows forever is invisible otherwise. */
  armedCount(): number {
    return this.armed.size;
  }

  /**
   * When this board's lead was told about each row it still remembers.
   *
   * Rows with no recorded time are omitted rather than defaulted: "we do not
   * know when you were told" and "you were told just now" lead to opposite
   * escalations, and only one of them is a guess.
   */
  toldTimesFor(workspaceId: string): ReadonlyMap<string, ToldTime> {
    const out = new Map<string, ToldTime>();
    // Undeliverable first, so a row that was later actually told overwrites
    // it: a delivered wake is the stronger fact and the better sentence.
    for (const [id, at] of this.undeliverable.get(workspaceId) ?? [])
      out.set(id, { at, delivered: false });
    for (const [id, row] of this.told.get(workspaceId) ?? []) {
      if (row.toldAt !== undefined) out.set(id, { at: row.toldAt, delivered: true });
    }
    return out;
  }

  private escalate(board: StallSnapshot, now: number): void {
    const hook = this.opts.escalate;
    if (!hook) return;
    try {
      hook(board, this.toldTimesFor(board.workspaceId), now);
    } catch (err) {
      console.error('[stall] escalation failed:', err);
    }
  }

  private considerBoard(board: StallSnapshot, now: number): void {
    const key = board.workspaceId;
    const lead = board.leadAgentId;
    const held = board.retired ? [] : (board.held ?? []);
    this.pruneFilersTold(key, held);
    // The filer first, before the lead's seat is even looked at: the filer
    // can end a hold in one call, their nudge is per item rather than per
    // board stamp, and a board with an empty lead seat still has filers.
    this.nudgeFilers(key, held, now);
    // Nobody to tell. Drop the arming so a board that becomes woken again
    // starts from a clean slate rather than from a stamp recorded under
    // different conditions.
    if (board.retired || lead === undefined) {
      this.armed.delete(key);
      this.held.delete(key);
      // …but an unreadable row on a board with no lead is exactly the case
      // the reporter exists for, so it is named BEFORE returning.
      this.reportUnevaluable(board);
      // An EMPTY SEAT is nobody told, which is the escalation's other clock.
      // A retired board is not: nobody is working it, and it is not a stall.
      if (board.retired) this.undeliverable.delete(key);
      else this.rememberUndeliverable(board, now);
      return;
    }
    // "Nothing to say" takes all four being empty. A pass that examined nine
    // rows and could not evaluate one of them has not established that the
    // board is healthy, and returning on the stalled list alone is precisely
    // how "I could not look" comes to be delivered as "I looked and saw
    // nothing".
    if (
      board.stalled.length === 0 &&
      board.unfiled.length === 0 &&
      board.undetermined.length === 0 &&
      held.length === 0
    ) {
      this.armed.delete(key);
      this.held.delete(key);
      this.reported.delete(key);
      this.undeliverable.delete(key);
      return;
    }
    const stamp = this.stampFor(board);
    // Named before both the wake decision and the reachability check below,
    // and that ordering is the point: the commonest reason a wake is not
    // delivered is a lead holding no stream, which is exactly when an
    // unevaluable board would otherwise leave no trace anywhere. It dedupes on
    // the condition itself, so a tick that says nothing costs no line.
    this.reportUnevaluable(board);
    const memory = this.rememberSeen(key, board, now);
    const change = this.changeOn(this.priorFor(key, memory.rows), stamp, board, memory.before);
    if (!change) {
      // Silent, but RECORDED. A shrink that left the old stamp standing would
      // keep naming rows that are no longer on the list, so the board's
      // escalation bucket would be read against a set it no longer has.
      this.armed.set(key, stamp);
      this.rememberHighWater(key, board, memory.rows);
      return;
    }
    // Checked LAST, and deliberately not recorded when it says no: a wake that
    // reached nobody must stay owed, or the lead returns to a board that has
    // already decided it told them.
    const to = this.addressee(key, lead);
    if (to === undefined) {
      // The wake stays owed — nothing is recorded in `told` — but the board
      // now knows how long it has been unable to tell anyone, which is what
      // the escalation runs on when a lead seat has gone dark.
      this.rememberUndeliverable(board, now);
      return;
    }
    const top = board.stalled[0] ?? board.unfiled[0] ?? held[0];
    this.emit(key, to.agentId, {
      event: STALL_EVENT,
      workspaceId: key,
      ...(top ? { taskId: top.id, title: top.title } : {}),
      stalledCount: board.stalled.length,
      consideredCount: board.considered,
      ...(board.stalled.length > 0 ? { rows: board.stalled } : {}),
      ...(board.unfiled.length > 0 ? { unfiled: board.unfiled } : {}),
      ...(board.beyondCapacity !== undefined && board.beyondCapacity > 0
        ? {
            beyondCapacity: board.beyondCapacity,
            ...(board.parallelismCap ? { parallelismCap: board.parallelismCap } : {}),
          }
        : {}),
      // `heldItems`, not `held`: the ready_idle frame already spends `held` on
      // its withheld-row counts, and the plugin reads both frames into one type.
      ...(held.length > 0 ? { heldItems: held } : {}),
      ...(board.undetermined.length > 0
        ? {
            undetermined: {
              count: board.undetermined.length,
              reasons: reasonsOf(board.undetermined),
            },
          }
        : {}),
      // Omitted on a board this process has never woken: there everything is
      // new, and a second copy of the same list says nothing.
      ...(memory.firstWake ? {} : { changed: change }),
      ...(to.escalatedFrom !== undefined ? { escalatedFrom: to.escalatedFrom } : {}),
      ts: now,
    });
    this.armed.set(key, stamp);
    // Recorded only now, after a delivered wake — a row named while the lead
    // held no stream must stay news, or the lead comes back to a board that
    // has decided it told them.
    for (const row of [...board.stalled, ...board.unfiled]) {
      // `toldAt` carries over from the row's existing memory: this is when
      // the lead was told about THIS stretch, and a second wake naming the
      // same row does not restart the escalation clock.
      const toldAt = memory.rows.get(row.id)?.toldAt ?? now;
      memory.rows.set(row.id, { bucket: row.bucket, seenAt: now, toldAt });
    }
    // A held item's TICKET counts as told, under no bucket in particular:
    // the lead has been handed that ticket, so the same ticket later going
    // quiet or reading as unfiled over the same held ask is not a second
    // wake. That was the stamp's job when held ids lived in it beside the
    // row ids; it is this memory's now, and it must not be dropped in the
    // move.
    for (const item of held) {
      if (!memory.rows.has(item.id))
        memory.rows.set(item.id, { bucket: UNKNOWN_BUCKET, seenAt: now, toldAt: now });
    }
    this.rememberHighWater(key, board, memory.rows);
    this.capTold(memory.rows);
    // Delivered beats undeliverable: these rows have a real told-time now.
    const dark = this.undeliverable.get(key);
    if (dark) {
      for (const row of [...board.stalled, ...board.unfiled]) dark.delete(row.id);
      if (dark.size === 0) this.undeliverable.delete(key);
    }
  }

  /**
   * The armed stamp, with the board's escalation bucket held UP while the row
   * that earned it is still remembered.
   *
   * The bucket is read off the findings a tick can see, and every tick re-arms
   * the board with it — so a remembered row that drops off the list for a
   * single pass took the bucket down with it, and the tick that saw the row
   * again read `after.bucket > before.bucket` as another repeat window
   * crossed. A wake naming a row the lead was already told about, repeatable
   * as often as the row flickers: two wakes three minutes apart in prod over
   * one row quiet for twelve hours.
   *
   * The flicker is not the row moving. An escalation item masks its anchor row
   * from the gate for as long as it is open (`stall-escalation.ts`), and a row
   * on the parallelism cap's boundary leaves the judged set whenever another
   * row starts or stops being runnable (`stall-gate.ts`).
   *
   * ── Why the hold is SCOPED to one row ───────────────────────────────────
   *
   * A hold that only ever dropped on a wholly clean board would be a ratchet:
   * on a board that always has at least one finding the high-water mark would
   * stand forever, and every later row's escalation would be swallowed until
   * it passed a number some other row set hours ago — which is the repeat
   * window, the thing that says a bad board again, silently switched off
   * (found in review of this fix). So the hold is remembered WITH the row it
   * came from and lasts exactly as long as that row does: `told` forgets a row
   * that has been off the list for a whole repeat window, and the hold goes
   * with it. The next row escalates on its own clock.
   *
   * Memory only, never persisted: after a restart a board falls back to the
   * stamp on disk and pays at most the one wake this file has always been
   * willing to pay for a lost stamp.
   */
  private priorFor(key: string, told: Map<string, ToldRow>): string | undefined {
    const prior = this.armed.get(key);
    if (prior === undefined) return undefined;
    const held = this.held.get(key);
    if (held === undefined || !told.has(held.rowId)) return prior;
    const parsed = parseStamp(prior);
    if (held.bucket <= parsed.bucket) return prior;
    return `${held.bucket}${prior.slice(prior.indexOf('|'))}`;
  }

  /**
   * Record which row is speaking for the board's bucket, so the hold above can
   * expire with it. Keeps the standing hold while the row that set it is still
   * remembered and still the worse fact; otherwise the board's current oldest
   * row takes over.
   */
  private rememberHighWater(key: string, board: StallSnapshot, told: Map<string, ToldRow>): void {
    const rows = [...board.stalled, ...board.unfiled];
    let oldest = rows[0];
    for (const row of rows) if (row.quietMs > (oldest?.quietMs ?? -1)) oldest = row;
    if (oldest === undefined) {
      this.held.delete(key);
      return;
    }
    const bucket = Math.floor(oldest.quietMs / this.repeatMs);
    const held = this.held.get(key);
    if (held !== undefined && held.bucket > bucket && told.has(held.rowId)) return;
    this.held.set(key, { rowId: oldest.id, bucket });
  }

  /**
   * Stamp — once — when each of this board's findings first had nobody to be
   * told to, and forget the rows that have left the list.
   *
   * Once, not per tick: the question is how long the board has been unable to
   * reach anybody about this row, so the first moment is the answer and every
   * later one would restart the clock a lead's absence is supposed to run.
   */
  private rememberUndeliverable(board: StallSnapshot, now: number): void {
    const rows = [...board.stalled, ...board.unfiled];
    if (rows.length === 0) {
      this.undeliverable.delete(board.workspaceId);
      return;
    }
    let dark = this.undeliverable.get(board.workspaceId);
    if (!dark) {
      dark = new Map<string, number>();
      this.undeliverable.set(board.workspaceId, dark);
    }
    const live = new Set(rows.map((row) => row.id));
    for (const id of dark.keys()) if (!live.has(id)) dark.delete(id);
    for (const id of live) if (!dark.has(id)) dark.set(id, now);
  }

  /**
   * Refresh how recently each finding row was SEEN, drop rows that have been
   * off the list for a whole repeat window, and hand back what the board
   * remembered BEFORE this tick — which is what the news is measured against.
   *
   * The age is measured from last seen rather than from last told on purpose:
   * a row that sits on the list untouched would otherwise be forgotten one
   * repeat window after its wake and re-fire, which is a repeat keyed on the
   * clock — the shape this whole file refuses. Escalation is the only clock
   * that may re-say a row, and it is the board's, not the row's.
   */
  private rememberSeen(
    key: string,
    board: StallSnapshot,
    now: number,
  ): { rows: Map<string, ToldRow>; before: Map<string, ToldRow>; firstWake: boolean } {
    let rows = this.told.get(key);
    if (!rows) {
      rows = new Map<string, ToldRow>();
      this.told.set(key, rows);
    }
    // Refresh BEFORE pruning, and the order is the whole point: pruning first
    // would drop a row that is a finding on this very tick the moment its
    // window elapsed, and the next tick would then read it as brand new. That
    // is a repeat keyed on the clock — one wake per row per window, which is
    // the amortisation `stampFor` refuses on the escalation bucket for exactly
    // the same reason.
    for (const id of [
      ...board.stalled.map((r) => r.id),
      ...board.unfiled.map((r) => r.id),
      ...(board.held ?? []).map((r) => r.id),
    ]) {
      const seen = rows.get(id);
      if (seen) seen.seenAt = now;
    }
    for (const [id, seen] of rows) {
      if (now - seen.seenAt > this.repeatMs) rows.delete(id);
    }
    // Snapshot AFTER both, so what the news is measured against is what the
    // board still remembers rather than what it remembered a moment ago.
    const before = new Map(rows);
    return { rows, before, firstWake: before.size === 0 };
  }

  /** Keep the newest `TOLD_ROWS_PER_BOARD` — see the constant. */
  private capTold(rows: Map<string, ToldRow>): void {
    if (rows.size <= TOLD_ROWS_PER_BOARD) return;
    const oldestFirst = [...rows.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [id] of oldestFirst.slice(0, rows.size - TOLD_ROWS_PER_BOARD)) rows.delete(id);
  }

  /**
   * Who actually gets this wake.
   *
   * The lead when the lead is there. Otherwise ANY attached session, because
   * the alternative — the current behaviour — is a monitor whose whole output
   * is addressed to one identity it cannot verify: a board whose lead seat is
   * held by a session that has stopped listening goes quiet, and the silence
   * is indistinguishable from a healthy board. That is the shape of the
   * failure this exists to end.
   *
   * The lead is still tried FIRST and the ordinary frame is unchanged, so a
   * healthy board keeps waking exactly the session it always woke.
   *
   * Sorted, and the lead excluded: the stand-in must be the same session on
   * every tick, or a board with three attached agents wakes a different one
   * each time and none of them can tell that the others were told.
   */
  private addressee(
    workspaceId: string,
    lead: string,
  ): { agentId: string; escalatedFrom?: string } | undefined {
    if (this.reachable(workspaceId, lead)) return { agentId: lead };
    let attached: readonly string[] = [];
    try {
      attached = this.opts.attachedAgents?.(workspaceId) ?? [];
    } catch {
      attached = [];
    }
    const standIn = attached
      .filter((id) => id !== lead && this.reachable(workspaceId, id))
      .slice()
      .sort()[0];
    if (standIn === undefined) return undefined;
    return { agentId: standIn, escalatedFrom: lead };
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
  private reportUnevaluable(board: StallSnapshot): void {
    if (board.undetermined.length === 0) {
      this.reported.delete(board.workspaceId);
      return;
    }
    const condition = board.undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort()
      .join(',');
    if (this.reported.get(board.workspaceId) === condition) return;
    this.reported.set(board.workspaceId, condition);
    try {
      this.report(
        `[stall] ${board.workspaceId}: ${board.undetermined.length} of ${board.considered} ` +
          `row(s) could not be evaluated and were NOT counted healthy — ${condition}`,
      );
    } catch {
      // A reporter that throws must not take the pass down with it. The whole
      // point of this method is that a board is not left unmentioned; losing
      // the mention is bad, losing every other board's wake is worse.
    }
  }

  /**
   * Which rows are stuck, what kind of stuck, and how many repeat windows deep
   * THE BOARD is. One string, so a new stall, a recovery, a row changing
   * bucket and the board escalating all arm the wake through the same door.
   *
   * The quiet time is QUANTISED rather than carried exactly, and that is the
   * whole escalation design: a raw duration changes on every tick and would
   * make the stamp a clock, waking the lead every minute over a row they have
   * already seen.
   *
   * ── Why the window is the board's and not each row's ──────────────────
   *
   * It was per-row first, and that amortises catastrophically. Every stalled
   * row crosses its own boundary at its own wall-clock moment, each crossing
   * moves the stamp, and the ceiling becomes one wake per row per window
   * rather than one per board. On the boards this shipped against — 32
   * eligible rows on one, 24 on another — that is seven or eight wakes an hour
   * forever, with nothing about the board having changed. The frugality rules
   * at the top of this file were doing their job on the SET and being
   * completely defeated on the clock.
   *
   * So the bucket is computed once, from the OLDEST row: one re-wake per board
   * per window. Escalation survives intact — the board still gets louder the
   * longer its worst row sits — and the row ids stay in the stamp, so a
   * genuinely new stall still fires immediately rather than waiting out
   * somebody else's window.
   */
  private stampFor(board: StallSnapshot): string {
    const rows = [...board.stalled, ...board.unfiled];
    // Ids alone, without the bucket they used to carry. A row changing bucket
    // is most often the lead's OWN action landing — dispatching a worker moves
    // a row from `ready-unpicked` to `in-progress` — and a token that changed
    // would read as a new row under the growth rule below, waking the lead to
    // announce what it just did. The frame still carries every row's bucket;
    // it is the ARMING that must not turn on it.
    // A held item enters the stamp twice: under its TICKET's id, deduped
    // with the stalled and unfiled rows — so the same ticket later going
    // quiet or reading as unfiled over the same held ask is not a second
    // wake; the lead was already told to get that item revised — and under
    // its OWN id and hold time, so a second item held on a ticket the lead
    // already heard about is news, and so is the same item held AGAIN after
    // a revision (codex review: ticket-only stamping swallowed the first;
    // an id-only key needed a tick to see the gap between two holds). It
    // stays OUT of the escalation bucket below: a hold is the filer's to
    // end, and re-saying it every repeat window would bill the lead for
    // the filer's silence.
    const held = board.held ?? [];
    const ids = Array.from(
      new Set([
        ...rows.map((row) => row.id),
        ...held.map((row) => row.id),
        ...held.map((row) => `held:${row.reviewItemId}@${row.heldAt}`),
      ]),
    ).sort();
    // The oldest row speaks for the board. `0` on a board whose only finding
    // is unreadable rows, which is right: there is no silence to escalate.
    const oldestQuietMs = rows.reduce((max, row) => Math.max(max, row.quietMs), 0);
    const bucket = Math.floor(oldestQuietMs / this.repeatMs);
    const undetermined = board.undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort();
    // Still appended only when non-empty, so a board with nothing unreadable —
    // which is almost all of them — keeps computing a stable string from one
    // process to the next. (Dropping the per-row bucket is a format change, so
    // every stored stamp reads as all-new on the first tick after this deploys
    // and each board is billed one extra wake — the same one-time cost the
    // move of the escalation bucket to the front paid, against a standing one.)
    return undetermined.length > 0
      ? `${bucket}|${ids.join(',')}|${undetermined.join(',')}`
      : `${bucket}|${ids.join(',')}`;
  }

  /**
   * Is the new stamp WORSE than the armed one? The only question that may
   * spend a lead's turn.
   *
   * The rule used to be equality — any different stamp re-armed the wake — and
   * that made the loop self-sustaining rather than self-extinguishing. A
   * shrinking set moves the stamp exactly as a growing one does, so the lead
   * was woken to file an ask, filed it, the row left the unfiled list, and the
   * next tick woke the lead again over its own remedy. Six wakes in one
   * evening on a live board, `stalled=0` in all six, the unfiled count walking
   * 1→2→3→2→1.
   *
   * So three things, and only these three, are news:
   *
   *  - a row id on the list that was not on it before — a NEW thing stuck;
   *  - the board's escalation bucket higher than it was — its worst row has
   *    crossed another repeat window;
   *  - a row the pass could not read that it could read before.
   *
   * Everything else is a board getting better, and a recovery is never
   * announced: rows leaving lowers the count, and rows leaving also lowers the
   * oldest quiet time, which is why the bucket is compared for GREATER rather
   * than for difference.
   *
   * An absent stamp is a board this process has never woken, which is news by
   * definition.
   *
   * ── What "a NEW thing stuck" means, and why it is not the stamp ────────
   *
   * It used to be a row id absent from the previous stamp, and the previous
   * stamp is the board's CURRENT set — so a row that left the list was
   * forgotten and its next quiet window read as a brand-new stall. See
   * `told`: that is one wake per window, forever, on any board whose owner
   * keeps reporting. A row is news now when the board has never been woken
   * about it, or when it comes back under a different BUCKET — which is the
   * case the id-only rule was protecting, a dispatched row whose builder then
   * died coming back as `builder-silent` rather than as the same row.
   *
   * The bucket is compared out here rather than being folded back into the
   * stamp, and that distinction is load-bearing: a row changing bucket while
   * it stays on the list is most often the lead's OWN action landing, and a
   * stamp token that moved would wake them to announce it.
   *
   * Returns what changed, or `undefined` for "say nothing" — one value, so
   * the decision to wake and the account of why cannot disagree.
   */
  private changeOn(
    prior: string | undefined,
    next: string,
    board: StallSnapshot,
    told: Map<string, ToldRow>,
  ): StallNudgeFrame['changed'] | undefined {
    const before = prior === undefined ? undefined : parseStamp(prior);
    const after = parseStamp(next);
    const escalated = before !== undefined && after.bucket > before.bucket;
    const rows = [...board.stalled, ...board.unfiled].filter((row) => {
      const seen = told.get(row.id);
      if (seen === undefined) return true;
      // A row remembered from a stamp written before this memory existed
      // carries no bucket to compare — see UNKNOWN_BUCKET.
      return seen.bucket !== UNKNOWN_BUCKET && seen.bucket !== row.bucket;
    });
    // The token is only ever the LOOKUP; the id comes off the row it came
    // from. Building the token and then cutting the reason back off it made
    // the id depend on neither reason nor id containing the separator, which
    // is a promise about two unrelated vocabularies rather than a fact.
    const undetermined = board.undetermined
      .filter((u) => before === undefined || !before.undetermined.has(`${u.id}:${u.reason}`))
      .map((u) => u.id);
    const heldItems = (board.held ?? []).filter(
      (item) => before === undefined || !before.ids.has(`held:${item.reviewItemId}@${item.heldAt}`),
    );
    if (!escalated && rows.length === 0 && undetermined.length === 0 && heldItems.length === 0)
      return undefined;
    return {
      ...(rows.length > 0 ? { rows } : {}),
      ...(undetermined.length > 0 ? { undetermined } : {}),
      ...(heldItems.length > 0 ? { heldItems } : {}),
      ...(escalated ? { escalated: true as const } : {}),
    };
  }

  /**
   * Tell each overdue item's filer, once per item, that the hold has stood
   * past the window. Silent — and NOT recorded — when the filer holds no
   * stream: a nudge delivered to nobody would spend the one this item is
   * owed, and the filer would return to an item the loop had decided it told
   * them about. An item with no known filer is left to the lead's frame.
   */
  private nudgeFilers(workspaceId: string, held: readonly HeldItemRow[], now: number): void {
    const send = this.opts.sendToFiler;
    if (!send) return;
    for (const item of held) {
      if (item.filerAgentId === undefined) continue;
      const key = filerKey(workspaceId, item);
      if (this.filersTold.has(key)) continue;
      if (!this.reachable(workspaceId, item.filerAgentId)) continue;
      let delivered = 0;
      try {
        delivered = send(workspaceId, item.filerAgentId, {
          event: REVIEW_ITEM_HELD_EVENT,
          workspaceId,
          // The ROW's own address, not `item.id` alone: on a doc thread `id`
          // is the DOC, and a filer handed a docId under the name `taskId`
          // would spend a call finding out it is not one. A row with no doc
          // address is a ticket row by construction (`overdueHeldItems`), so
          // there `id` IS the ticket — and reading it that way keeps every
          // caller that predates the doc surface sending what it always did.
          ...(item.docId === undefined
            ? { taskId: item.taskId ?? item.id }
            : item.taskId !== undefined
              ? { taskId: item.taskId }
              : {}),
          ...(item.docId !== undefined ? { docId: item.docId } : {}),
          ...(item.threadId !== undefined ? { threadId: item.threadId } : {}),
          ...(item.commentId !== undefined ? { commentId: item.commentId } : {}),
          ...(item.revise !== undefined ? { revise: item.revise } : {}),
          title: item.title,
          reviewItemId: item.reviewItemId,
          headline: item.headline,
          reason: item.reason,
          overdue: true,
          heldMs: item.heldMs,
          ts: now,
        });
      } catch (err) {
        console.error('[stall] filer nudge failed:', err);
        continue;
      }
      // Told means DELIVERED. A filer that dropped between `reachable` and
      // the send got nothing, and marking the item told would silence every
      // later pass for a nudge nobody heard (codex review).
      if (delivered > 0) this.filersTold.add(key);
    }
  }

  /** Forget filers told about items no longer held, so a fresh hold on the
   *  same item (revised, judged, held again) is nudged afresh. */
  private pruneFilersTold(workspaceId: string, held: readonly HeldItemRow[]): void {
    const live = new Set(held.map((item) => filerKey(workspaceId, item)));
    const prefix = `${workspaceId}|`;
    for (const key of this.filersTold) {
      if (key.startsWith(prefix) && !live.has(key)) this.filersTold.delete(key);
    }
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
   * aside: a lost stamp is one extra wake that the next tick re-arms on its
   * own, which is not a loss worth a recovery path.
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
      // The rows each board has been told about. Seen-times are NOT stored —
      // every remembered row is given a fresh window at boot, so a restart can
      // extend a row's memory but never cut it short. That keeps the file
      // byte-stable between ticks, which is what lets `saveStamps` write only
      // when something actually changed rather than once a minute forever.
      const now = this.now();
      const told = parsed.told;
      if (told && typeof told === 'object') {
        for (const [workspaceId, rows] of Object.entries(told)) {
          if (!rows || typeof rows !== 'object') continue;
          const stamps = parsed.toldAt?.[workspaceId];
          const map = new Map<string, ToldRow>();
          for (const [id, bucket] of Object.entries(rows)) {
            if (typeof bucket !== 'string') continue;
            // A row stored before told-times existed is given this moment,
            // not left blank: an escalation that can never fire for a row
            // the lead was told about is the worse failure, and the cost is
            // that such a row escalates one window after the restart rather
            // than from when it was really told.
            const at = stamps?.[id];
            map.set(id, { bucket, seenAt: now, toldAt: typeof at === 'number' ? at : now });
          }
          if (map.size > 0) this.told.set(workspaceId, map);
        }
      }
      const dark = parsed.undeliverable;
      if (dark && typeof dark === 'object') {
        for (const [workspaceId, rows] of Object.entries(dark)) {
          if (!rows || typeof rows !== 'object') continue;
          const map = new Map<string, number>();
          for (const [id, at] of Object.entries(rows)) {
            if (typeof at === 'number') map.set(id, at);
          }
          if (map.size > 0) this.undeliverable.set(workspaceId, map);
        }
      }
      // A file written before this memory existed: seed it from the stamp, so
      // the upgrade costs no board the one wake it would otherwise re-fire
      // over rows their leads had already been told about.
      for (const [workspaceId, stamp] of this.armed) {
        if (this.told.has(workspaceId)) continue;
        const map = new Map<string, ToldRow>();
        for (const id of parseStamp(stamp).ids)
          map.set(id, { bucket: UNKNOWN_BUCKET, seenAt: now, toldAt: now });
        if (map.size > 0) this.told.set(workspaceId, map);
      }
      this.lastPersisted = this.serializeStamps();
    } catch {
      this.armed.clear();
    }
  }

  private serializeStamps(): string {
    // Key order is the map's insertion order, which differs between a fresh
    // load and a run that has re-armed boards — sorted, so the content compare
    // below answers "did anything change" rather than "did anything move".
    const stamps: Record<string, string> = {};
    for (const key of Array.from(this.armed.keys()).sort()) {
      stamps[key] = this.armed.get(key) as string;
    }
    const told: Record<string, Record<string, string>> = {};
    const toldAt: Record<string, Record<string, number>> = {};
    for (const key of Array.from(this.told.keys()).sort()) {
      const rows = this.told.get(key);
      if (!rows || rows.size === 0) continue;
      const out: Record<string, string> = {};
      const at: Record<string, number> = {};
      for (const id of Array.from(rows.keys()).sort()) {
        const row = rows.get(id) as ToldRow;
        out[id] = row.bucket;
        // Written only where it is known, and it only ever CHANGES when a
        // row is first told — so this stays byte-stable between ticks and
        // the unchanged-file check above still saves the write.
        if (row.toldAt !== undefined) at[id] = row.toldAt;
      }
      told[key] = out;
      if (Object.keys(at).length > 0) toldAt[key] = at;
    }
    const undeliverable: Record<string, Record<string, number>> = {};
    for (const key of Array.from(this.undeliverable.keys()).sort()) {
      const rows = this.undeliverable.get(key);
      if (!rows || rows.size === 0) continue;
      const out: Record<string, number> = {};
      for (const id of Array.from(rows.keys()).sort()) out[id] = rows.get(id) as number;
      undeliverable[key] = out;
    }
    const file: StampFile = {
      version: STAMP_FORMAT_VERSION,
      stamps,
      told,
      toldAt,
      undeliverable,
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
      console.error('[stall] could not persist stamps:', err);
    }
  }

  private emit(workspaceId: string, agentId: string, frame: StallNudgeFrame): void {
    try {
      this.opts.send(workspaceId, agentId, frame);
    } catch (err) {
      console.error('[stall] send failed:', err);
      // No line: a send that threw spent nobody's turn, and the count below
      // is meant to be countable.
      return;
    }
    this.noteWake(workspaceId, agentId, frame);
  }

  /**
   * One line per DELIVERED wake, so what this feature costs can be counted.
   *
   * The unit of spend here is a lead's turn, and the number worth watching is
   * wakes per board per hour — a loop that fires more often than anyone
   * realises is precisely the failure the arming rules exist to prevent, and a
   * claim nobody can check is how that failure survives. So the line is
   * emitted at the one point a turn is actually billed: after `send` returned,
   * never beside the decision to send.
   *
   * The three counts stay SEPARATE rather than summed. They are three
   * different asks — drive it, file the question, go and read it — and a board
   * waking its lead nine times about unreadable rows is a different finding
   * from one waking it nine times about stalled work. A total cannot tell them
   * apart.
   *
   * It rides the injectable `report`, not `console.error`, for the same reason
   * the unevaluable notice does: a line only a human tailing a log can see is
   * one no test can assert, and this has to stay true as the arming rules move
   * around it.
   */
  private noteWake(workspaceId: string, agentId: string, frame: StallNudgeFrame): void {
    try {
      this.report(
        `[stall] wake ws=${workspaceId} lead=${frame.escalatedFrom ?? agentId} ` +
          // `lead=` keeps naming the SEAT HOLDER in both cases, so a log
          // grepped for one board reads as one story; `to=` appears only when
          // those two are different people.
          (frame.escalatedFrom !== undefined ? `to=${agentId} ` : '') +
          `stalled=${frame.stalledCount} unfiled=${frame.unfiled?.length ?? 0} ` +
          `undetermined=${frame.undetermined?.count ?? 0} held=${frame.heldItems?.length ?? 0}`,
      );
    } catch {
      // A reporter that throws must not undo a wake that was already
      // delivered — the frame is out, and the arming below has to record it.
    }
  }
}
