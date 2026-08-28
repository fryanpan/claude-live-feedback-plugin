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
 *     stamp = <row id>:<bucket>:<how many repeat windows it has been quiet>, sorted
 *
 * A board is woken at most once per stamp. Any change to WHICH rows are stuck,
 * or to what kind of stuck they are, moves the stamp and re-arms the wake; a
 * board where nothing has changed moves nothing and stays silent.
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
import type { StallUndeterminedRow, StalledRow } from './stall-gate.ts';

/**
 * How long a row must stay quiet before the wake says it AGAIN.
 *
 * Four hours: coarse enough that a lead who has seen the row once is not told
 * a second time inside the span it would take them to act on it, and fine
 * enough that a row abandoned overnight is named several times rather than
 * once. It quantises the row's own silence — see the header — so nothing here
 * is a timer and nothing needs cancelling.
 */
export const STALL_REPEAT_DEFAULT_MS = 4 * 60 * 60_000;

/** How often the timer looks, when nobody says otherwise. Far below the quiet
 *  window on purpose: the tick is a cheap read over state already in memory,
 *  and the window is what decides when a wake is owed. */
export const STALL_TICK_DEFAULT_MS = 60_000;

/** Its own event name rather than a reason field on an existing one, because
 *  the plugin renders a hub event off the name alone — one name would make a
 *  stall and a ready-work wake indistinguishable in the lead's channel. */
export const STALL_EVENT = 'workspace.stalled';

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
  ts: number;
}

export interface StallNudgerOptions {
  /** Every live board, rebuilt each tick. */
  snapshot: () => readonly StallSnapshot[];
  /** Is this agent holding a stream we could actually wake? */
  canReach: (workspaceId: string, agentId: string) => boolean;
  /** Addressed delivery. Returns how many sinks it reached. */
  send: (workspaceId: string, agentId: string, frame: StallNudgeFrame) => number;
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
}

/** The stamp file's shape. Versioned so a later format change can recognise an
 *  older file rather than treating it as corrupt. */
interface StampFile {
  version: number;
  stamps: Record<string, string>;
}

const STAMP_FORMAT_VERSION = 1;

/** The distinct reasons a pass could not evaluate rows, sorted so the same
 *  condition renders the same way twice. */
function reasonsOf(undetermined: readonly StallUndeterminedRow[]): string[] {
  return Array.from(new Set(undetermined.map((u) => u.reason))).sort();
}

export class StallNudger {
  private readonly opts: StallNudgerOptions;
  private readonly now: () => number;
  private readonly repeatMs: number;
  private readonly report: (message: string) => void;
  /** The stamp each workspace was last woken for. */
  private readonly armed = new Map<string, string>();
  /** The unevaluable condition each workspace was last REPORTED for. Separate
   *  from `armed` because the two fire on different rules: a wake is owed once
   *  per board stamp, while the report is owed once per distinct condition
   *  however many stamps pass under it. Deliberately NOT persisted — a
   *  condition worth naming is worth naming again after a restart, and a
   *  duplicate log line is the cheapest failure in this file. */
  private readonly reported = new Map<string, string>();
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
    }
    // Forget boards that are gone, so neither map outlives what it describes.
    // The pruning has to reach the FILE too, or the durable copy grows for the
    // life of the install while the in-memory one stays bounded.
    for (const key of this.armed.keys()) if (!live.has(key)) this.armed.delete(key);
    for (const key of this.reported.keys()) if (!live.has(key)) this.reported.delete(key);
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

  private considerBoard(board: StallSnapshot, now: number): void {
    const key = board.workspaceId;
    const lead = board.leadAgentId;
    // Nobody to tell. Drop the arming so a board that becomes woken again
    // starts from a clean slate rather than from a stamp recorded under
    // different conditions.
    if (board.retired || lead === undefined) {
      this.armed.delete(key);
      // …but an unreadable row on a board with no lead is exactly the case
      // the reporter exists for, so it is named BEFORE returning.
      this.reportUnevaluable(board);
      return;
    }
    // "Nothing to say" takes all three being empty. A pass that examined nine
    // rows and could not evaluate one of them has not established that the
    // board is healthy, and returning on the stalled list alone is precisely
    // how "I could not look" comes to be delivered as "I looked and saw
    // nothing".
    if (
      board.stalled.length === 0 &&
      board.unfiled.length === 0 &&
      board.undetermined.length === 0
    ) {
      this.armed.delete(key);
      this.reported.delete(key);
      return;
    }
    const stamp = this.stampFor(board);
    if (this.armed.get(key) === stamp) return;
    // Named before the reachability check below, and that ordering is the
    // point: the commonest reason a wake is not delivered is a lead holding no
    // stream, which is exactly when an unevaluable board would otherwise leave
    // no trace anywhere.
    this.reportUnevaluable(board);
    // Checked LAST, and deliberately not recorded when it says no: a wake that
    // reached nobody must stay owed, or the lead returns to a board that has
    // already decided it told them.
    if (!this.reachable(key, lead)) return;
    const top = board.stalled[0] ?? board.unfiled[0];
    this.emit(key, lead, {
      event: STALL_EVENT,
      workspaceId: key,
      ...(top ? { taskId: top.id, title: top.title } : {}),
      stalledCount: board.stalled.length,
      consideredCount: board.considered,
      ...(board.stalled.length > 0 ? { rows: board.stalled } : {}),
      ...(board.unfiled.length > 0 ? { unfiled: board.unfiled } : {}),
      ...(board.undetermined.length > 0
        ? {
            undetermined: {
              count: board.undetermined.length,
              reasons: reasonsOf(board.undetermined),
            },
          }
        : {}),
      ts: now,
    });
    this.armed.set(key, stamp);
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
   * each one is. One string, so a new stall, a recovery, a row changing bucket
   * and a row escalating all arm the wake through the same door.
   *
   * The quiet time is QUANTISED rather than carried exactly, and that is the
   * whole escalation design: a raw duration changes on every tick and would
   * make the stamp a clock, waking the lead every minute over a row they have
   * already seen.
   */
  private stampFor(board: StallSnapshot): string {
    const part = (row: StalledRow) =>
      `${row.id}:${row.bucket}:${Math.floor(row.quietMs / this.repeatMs)}`;
    const rows = [...board.stalled, ...board.unfiled].map(part).sort();
    const undetermined = board.undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort();
    // The second segment is appended only when non-empty, so a board with
    // nothing unreadable — which is almost all of them — keeps computing the
    // byte-identical string a previous process wrote to disk. Adding it
    // unconditionally would mismatch every stored stamp on the first tick
    // after a deploy and bill every board one extra wake.
    return undetermined.length > 0 ? `${rows.join(',')}|${undetermined.join(',')}` : rows.join(',');
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
    const file: StampFile = { version: STAMP_FORMAT_VERSION, stamps };
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
        `[stall] wake ws=${workspaceId} lead=${agentId} ` +
          `stalled=${frame.stalledCount} unfiled=${frame.unfiled?.length ?? 0} ` +
          `undetermined=${frame.undetermined?.count ?? 0}`,
      );
    } catch {
      // A reporter that throws must not undo a wake that was already
      // delivered — the frame is out, and the arming below has to record it.
    }
  }
}
