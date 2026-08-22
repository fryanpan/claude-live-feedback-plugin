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

/** Fifteen minutes. Long enough that a lead mid-task is not interrupted,
 *  short enough that ready work does not sit overnight. */
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
  /** Ready, unclaimed, agent-owned rows in the board's own priority order. */
  ready: readonly ReadyRow[];
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
   * Where the armed stamps are kept between runs. Omitted → memory only,
   * which is what every unit test that is not about persistence wants.
   */
  stampFile?: string;
}

/** The stamp file's shape. Versioned so a later format change can recognise
 *  an older file rather than treating it as corrupt. */
interface StampFile {
  version: number;
  stamps: Record<string, string>;
}

const STAMP_FORMAT_VERSION = 1;

/** The data-dir filename the server uses. Exported so a test can assert the
 *  file the server actually writes rather than a copy of its name. */
export const READY_NUDGE_STAMP_FILENAME = 'ready-nudge-stamps.json';

export class ReadyWorkNudger {
  private readonly opts: ReadyWorkNudgerOptions;
  private readonly now: () => number;
  private readonly idleMs: number;
  /** Activity this process has observed, by workspace. Floored by the
   *  snapshot's own clock, never replacing it. */
  private readonly observed = new Map<string, number>();
  /** The stamp each workspace was last nudged for. */
  private readonly armed = new Map<string, string>();
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
    this.stampFile = opts.stampFile ?? null;
    this.loadStamps();
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
    // Nothing to wake, or nobody to wake. Drop the arming so a board that
    // becomes nudgeable again starts from a clean slate rather than from a
    // stamp recorded under different conditions.
    if (board.retired || lead === undefined || board.ready.length === 0) {
      this.armed.delete(key);
      return;
    }
    const lastActivityAt = this.lastActivity(board);
    const idleMs = now - lastActivityAt;
    if (idleMs < this.idleMs) return;
    const stamp = this.stampFor(board, lastActivityAt);
    if (this.armed.get(key) === stamp) return;
    // Checked LAST, and deliberately not recorded when it says no: a nudge
    // that reached nobody must stay owed, or the lead returns to a board
    // that has already decided it told them.
    if (!this.reachable(key, lead)) return;
    const top = board.ready[0];
    this.emit(key, lead, {
      event: READY_IDLE_EVENT,
      workspaceId: key,
      ...(top ? { taskId: top.id, title: top.title } : {}),
      readyCount: board.ready.length,
      idleMs,
      ts: now,
    });
    this.armed.set(key, stamp);
  }

  /** The later of the store's record and what this process has seen. */
  private lastActivity(board: ReadyWorkSnapshot): number {
    return Math.max(board.lastActivityAt, this.observed.get(board.workspaceId) ?? 0);
  }

  /** Activity clock plus the ready set. One string, so "the board moved" and
   *  "what is ready changed" arm the nudge through the same door. */
  private stampFor(board: ReadyWorkSnapshot, lastActivityAt: number): string {
    const ids = board.ready
      .map((r) => r.id)
      .slice()
      .sort()
      .join(',');
    return `${lastActivityAt}|${ids}`;
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
