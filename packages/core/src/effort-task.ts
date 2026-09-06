/**
 * What one ticket contributes to the effort model, derived from the ticket.
 *
 * Chunks 3 and 4 — the goal rollup in `effort-calibration.ts` and the
 * projection in `goal-effort.ts` — both stand on this, so it is their shared
 * leaf and imports neither.
 *
 * **There is no stored "actual".** Both actuals are DERIVED, which is the one
 * design choice worth stating up front. Wall-clock is the ticket's own
 * transition trail — first move into `in-progress`, last move into `done` —
 * and hands-on is the reading time already folded onto the row. Nothing is
 * written at close, so nothing needs backfilling, nothing can drift out of
 * step with the trail it was copied from, and every ticket that closed
 * before this module existed is a calibration sample the moment it has an
 * estimate. A stored copy of a derivable number is a second source of truth
 * that can only ever disagree with the first.
 *
 * **Absent is not zero**, everywhere here. A ticket nobody scored returns
 * `null`, never `0`, so a caller has to decide what to do about it rather
 * than silently averaging it in. `Task.readingTime` and `Task.effortEstimate`
 * both hold the same line in their own type docs.
 */
import { EFFORT_ESTIMATE_PROMPT_VERSION } from './effort-estimate-prompt.ts';

/**
 * The FURTHEST back `pace` looks when turning closes into a finish date.
 *
 * A ceiling rather than the window itself. It used to be both, and dividing
 * every goal's closes by a flat fourteen days made the denominator a fact
 * about the calendar instead of a fact about the goal: a goal three days old
 * with two closes read as `2/14` per day and looked becalmed, while a goal
 * running since spring read fast because only its last fortnight counted.
 * Same numerator, and the one that had earned it got the smaller rate.
 *
 * So the divisor is now the goal's own ACTIVE WINDOW — see
 * `goalPaceWindowDays` — and this constant only stops that window growing
 * without limit. Fourteen days is still the horizon a pace is drawn from,
 * because a rate learned from what a goal was doing two months ago is not a
 * rate: it is history.
 */
export const EFFORT_PACE_WINDOW_DAYS = 14;

/**
 * And the floor, because an active window shrinks toward zero.
 *
 * Three tickets closed within a minute of each other span almost no time at
 * all, and dividing their estimates by that span claims a rate no work
 * produced: at a two-minute window, a goal with an afternoon of work left
 * projects "done in ten minutes". So one hour is the shortest span this
 * board is willing to call a rate. Below it a goal is reported at the pace
 * it managed in an hour, which is the most a burst of evidence can honestly
 * say, and the soonest finish any goal can be given is an hour out.
 *
 * An hour rather than a day, because a day here is not a floor but a
 * different answer. The case this window exists for is a goal that closed
 * most of itself in one afternoon; rounding that afternoon up to a day puts
 * its finish back out past tomorrow, which is the exact reading the active
 * window was introduced to stop.
 */
export const EFFORT_MIN_PACE_WINDOW_DAYS = 1 / 24;

/** Below this many OBSERVED closes inside the pace window there is no
 *  projection — a date drawn from one or two closes is a number pretending
 *  to be a forecast, and a date drawn from three rows somebody swept out of
 *  the backlog is not even that (see `isObservedClose`). */
export const EFFORT_MIN_CLOSES_FOR_PROJECTION = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The slice of a transition this module reads. Structural, so both the
 *  server's `TaskTransition` and the client's `BoardTransition` satisfy it. */
export interface EffortTransition {
  ts: number;
  to: string;
}

/**
 * What this module needs off a ticket.
 *
 * Deliberately a structural subset of both `Task` (server) and `BoardTask`
 * (client) rather than either of them — that is what lets one
 * implementation serve both callers.
 */
export interface EffortTaskInput {
  status: string;
  /** When the ticket was filed. Read by `goalPaceWindowDays` only, to date
   *  the goal it sits under: a goal is as old as its oldest live ticket,
   *  because the goal record itself never reaches this module. Optional so a
   *  caller holding a row without one still gets a pace — the window then
   *  falls back to the ticket's first transition, and to the full
   *  `EFFORT_PACE_WINDOW_DAYS` when a band carries no timestamp at all. */
  createdAt?: number;
  /** Soft-deleted. Archived rows are excluded from every sum: a goal is not
   *  more finished because somebody archived the rest of it. */
  archivedAt?: number;
  /** Chunk 2's stored run. Only `status: 'ok'` carries numbers; a `failed`
   *  run is an attempt that produced nothing, and absent is a ticket never
   *  scored. Three states, and none of them is zero. */
  effortEstimate?: {
    status: string;
    handsOnSeconds?: number;
    wallClockSeconds?: number;
    /** Which generation of the ask produced this — see
     *  `EFFORT_ESTIMATE_PROMPT_VERSION`. Read by the CALIBRATOR only, never
     *  by the rollup: an estimate made under an older prompt is still the
     *  best number this ticket has, and dropping it from the forecast would
     *  make a scored goal read "not scored" for as long as re-scoring takes.
     *  What it must not do is teach a correction factor — see
     *  `isCurrentGenerationEstimate`. Absent on every row written before the
     *  field existed. */
    promptVersion?: number;
  };
  /** The append-only trail. Wall-clock actuals are read from it. */
  transitions?: EffortTransition[];
  /** Folded-up human attention on the ticket's body doc. Hands-on actuals
   *  are read from it, and its ABSENCE means not measured — never zero. */
  readingTime?: { totalSeconds?: number };
}

/** A usable estimate, narrowed off the stored union. */
export interface EffortEstimateNumbers {
  handsOnSeconds: number;
  wallClockSeconds: number;
}

export function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Read a ticket's estimate as numbers, or `null`.
 *
 * `null` covers all three not-a-number cases on purpose — never scored, a
 * recorded failure, and a stored run whose fields did not survive whatever
 * wrote them. A caller that needs to tell those apart asks the row directly
 * (see `effortEstimateState`); a caller that wants to SUM wants exactly
 * this.
 */
export function estimateNumbers(task: EffortTaskInput): EffortEstimateNumbers | null {
  const e = task.effortEstimate;
  if (!e || e.status !== 'ok') return null;
  const { handsOnSeconds, wallClockSeconds } = e;
  if (!isPositiveFinite(handsOnSeconds) || !isPositiveFinite(wallClockSeconds)) return null;
  return { handsOnSeconds, wallClockSeconds };
}

/**
 * Was this estimate made under the CURRENT ask?
 *
 * Only calibration asks. A correction factor is `actual / estimate`, and
 * the estimate in that fraction was produced by one particular prompt — so
 * a factor learned from version 1's human-scaled numbers describes version
 * 1's bias and nothing else. Applied to version 2's agent-scaled numbers it
 * would discount the same speed-up twice: once because the prompt now says
 * an agent does the work, and again because the old estimates were wrong
 * about that. On the board this was measured on, that is a factor of 0.02
 * on top of an estimate already ten times smaller, which renders a goal
 * with real work left in it as "<1m".
 *
 * So a prompt bump deliberately empties the sample set, and the priors are
 * what a board forecasts with until it has closed tickets scored under the
 * new ask. That is the cost of changing the question, paid where it is
 * visible, rather than a stale answer to the old one carried forward
 * silently.
 *
 * A row with no `promptVersion` at all predates the field and is treated as
 * an older generation — the safe direction, and the same one
 * `recordEffortEstimate` takes with a missing revision.
 */
export function isCurrentGenerationEstimate(task: EffortTaskInput): boolean {
  return task.effortEstimate?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION;
}

/** The three states named, for a surface that has to say which one it is. */
export function effortEstimateState(task: EffortTaskInput): 'ok' | 'failed' | 'none' {
  const e = task.effortEstimate;
  if (!e) return 'none';
  if (e.status === 'failed') return 'failed';
  return estimateNumbers(task) ? 'ok' : 'failed';
}

export function isEffortDone(task: EffortTaskInput): boolean {
  return task.status === 'done';
}

/** Archived rows are out of every sum — see `EffortTaskInput.archivedAt`. */
export function countsTowardEffort(task: EffortTaskInput): boolean {
  return task.archivedAt === undefined;
}

/**
 * When a ticket closed: the timestamp of its LAST move into `done`.
 *
 * Last rather than first, because a reopened-and-reclosed ticket finished
 * when it finished. `null` on a row with no done transition — including a
 * row whose status says done but whose trail predates the status gate,
 * which is a row we decline to date rather than one we date at zero.
 */
export function effortClosedAt(task: EffortTaskInput): number | null {
  const trail = task.transitions;
  if (!trail) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const t = trail[i];
    if (t && t.to === 'done' && Number.isFinite(t.ts)) return t.ts;
  }
  return null;
}

/**
 * The earliest moment this module can prove the ticket existed.
 *
 * `createdAt` when the caller has one, and the first transition otherwise —
 * a row that moved must have existed by the time it moved. `null` when
 * neither is there, which is a row we decline to date rather than one we
 * date at the epoch: `Math.min` over a stray `0` would make every goal
 * containing that row fifty-six years old.
 */
export function effortFirstSeenAt(task: EffortTaskInput): number | null {
  if (isPositiveFinite(task.createdAt)) return task.createdAt;
  let earliest: number | null = null;
  for (const t of task.transitions ?? []) {
    if (!Number.isFinite(t.ts) || t.ts <= 0) continue;
    if (earliest === null || t.ts < earliest) earliest = t.ts;
  }
  return earliest;
}

/**
 * How many days of history a goal's pace is divided by.
 *
 * The span its counted closes actually happened in — the earliest one to
 * now — clamped into `[EFFORT_MIN_PACE_WINDOW_DAYS, EFFORT_PACE_WINDOW_DAYS]`.
 *
 * This began as the goal's AGE, first ticket filed to now. That fixed the
 * flat fortnight and then failed the case it was written for. Measured on
 * the live board: a goal three and a half days old closed most of itself in
 * a single four-hour run, and dividing that run by the goal's age still read
 * as a trickle and still put the finish a day and a half out. Age is how
 * long a goal has EXISTED; a pace is a fact about the stretch in which it
 * moved. A goal that sat for three days and then ran for four hours has a
 * four-hour window, and the three quiet days are not evidence about its rate.
 *
 * "Counted" is the same predicate the numerator uses — an observed close
 * (`isObservedClose`) carrying an estimate, inside the fourteen-day ceiling —
 * so this is exactly the span of the closes it will be divided into, and no
 * counted close can fall outside a window derived from it. Deriving the two
 * halves separately is how a rate ends up measured over one period and
 * divided by another.
 *
 * Closes are summed, never serialized: two tickets worked in parallel and
 * closed the same hour are two closes in that hour, not one after the other.
 * Throughput is what a goal got through, not what one worker could have.
 *
 * The window ends at `now` rather than at the last close, so it decays on its
 * own: an afternoon's burst is a four-hour window that afternoon and a
 * twenty-eight-hour window a day later. No goal keeps claiming a sprint's
 * rate for having sprinted once.
 *
 * When nothing has closed there is no span to measure, and the fallback is
 * the goal's age — its oldest live ticket's `createdAt`, or that ticket's
 * earliest transition. No date is drawn from it (that needs
 * `EFFORT_MIN_CLOSES_FOR_PROJECTION` closes); it only answers "how long has
 * this been going" for the sentence that names the window.
 *
 * Archived rows are already out of the list the caller passes (see
 * `countsTowardEffort`); nothing here re-filters them.
 */
export function goalPaceWindowDays(tasks: EffortTaskInput[], now: number): number {
  const ceiling = now - EFFORT_PACE_WINDOW_DAYS * DAY_MS;
  let earliestClose: number | null = null;
  for (const task of tasks) {
    if (!isObservedClose(task)) continue;
    if (!estimateNumbers(task)) continue;
    const closedAt = effortClosedAt(task);
    if (closedAt === null || closedAt > now || closedAt < ceiling) continue;
    if (earliestClose === null || closedAt < earliestClose) earliestClose = closedAt;
  }
  if (earliestClose !== null) return clampPaceWindowDays((now - earliestClose) / DAY_MS);
  let earliestSeen: number | null = null;
  for (const task of tasks) {
    const seen = effortFirstSeenAt(task);
    if (seen === null) continue;
    if (earliestSeen === null || seen < earliestSeen) earliestSeen = seen;
  }
  // A band with no timestamp anywhere gets the full window rather than the
  // floor: nothing is known about its age, and an hour is a CLAIM about a
  // young goal, not a neutral answer.
  if (earliestSeen === null) return EFFORT_PACE_WINDOW_DAYS;
  return clampPaceWindowDays((now - earliestSeen) / DAY_MS);
}

function clampPaceWindowDays(days: number): number {
  if (!Number.isFinite(days)) return EFFORT_PACE_WINDOW_DAYS;
  return Math.min(EFFORT_PACE_WINDOW_DAYS, Math.max(EFFORT_MIN_PACE_WINDOW_DAYS, days));
}

/**
 * Measured wall-clock: first move into `in-progress` to last move into
 * `done`, in seconds.
 *
 * `null` when the ticket never entered `in-progress` — a row that went
 * straight from `todo` to `done` was never observed being worked, and the
 * honest answer to "how long did it take" is that nobody knows. Filling
 * that in from `createdAt` would report the length of the QUEUE as the
 * length of the work, and it would do it on exactly the small tickets that
 * skip `in-progress`, biasing the whole calibration upward.
 */
export function effortActualWallClockSeconds(task: EffortTaskInput): number | null {
  const trail = task.transitions;
  if (!trail) return null;
  let startedAt: number | null = null;
  for (const t of trail) {
    if (t.to === 'in-progress' && Number.isFinite(t.ts)) {
      startedAt = t.ts;
      break;
    }
  }
  if (startedAt === null) return null;
  const closedAt = effortClosedAt(task);
  if (closedAt === null || closedAt <= startedAt) return null;
  return Math.round((closedAt - startedAt) / 1000);
}

/**
 * Measured hands-on: the reading time already folded onto the row.
 *
 * `null` when nothing was measured. This is the field whose type doc says
 * in as many words that no reader may default it to zero, and a calibration
 * sample built from an assumed zero would drive every future hands-on
 * estimate to the floor.
 */
export function effortActualHandsOnSeconds(task: EffortTaskInput): number | null {
  const total = task.readingTime?.totalSeconds;
  return isPositiveFinite(total) ? Math.round(total) : null;
}

/**
 * Did anybody watch this ticket being worked?
 *
 * A close with a measured wall-clock actual behind it — which is to say a
 * ticket that entered `in-progress` and later closed. A row moved STRAIGHT
 * to `done` fails it, and that is the whole point: nobody observed the work,
 * so the close is bookkeeping rather than throughput.
 *
 * Calibration already refused those rows, because `actual / estimate` needs
 * an actual. Pace and the projection floor did not, and that was the bug:
 * sweeping five stale rows in one afternoon added five closes and their
 * whole estimate to the numerator of a rate that is supposed to describe how
 * fast the goal moves, and the projected finish jumped forward on an
 * afternoon of tidying. One rule now covers all three — an unobserved close
 * teaches nothing.
 *
 * What it does NOT touch is the arithmetic where a close is a plain fact
 * rather than evidence: the percentage bar still moves, the remainder still
 * drops, and a goal all of whose rows were bulk-closed still reads
 * `complete`. Those say the ticket is finished, which it is. Only the claims
 * about SPEED are withheld.
 */
export function isObservedClose(task: EffortTaskInput): boolean {
  return isEffortDone(task) && effortActualWallClockSeconds(task) !== null;
}
