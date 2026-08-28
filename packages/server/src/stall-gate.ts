/**
 * Which rows the stall loop may name — work that was supposed to be moving
 * and has stopped.
 *
 * ── How this differs from `ready-gate.ts`, which sits next to it ─────────
 *
 * That gate answers "is there work nobody has picked up", and it deliberately
 * refuses to use a clock: a measurement across two real boards found the
 * median gap between task events at about fifteen minutes, so an elapsed-time
 * test flagged working agents at roughly the rate it flagged stalled ones.
 * Read its header before changing anything here — the numbers are all there.
 *
 * This gate asks the opposite question. A row that is `in-progress` has an
 * owner who said they were on it, and the only evidence available that they
 * stopped IS the silence. So the clock is unavoidable here, and the honest
 * thing is to state where it is weak rather than to pretend otherwise:
 *
 *  - **The recipient is the lead, not the worker.** A false positive costs
 *    one check-in by somebody whose job is already to know the board's state.
 *    The measurement that killed the clock next door was about interrupting
 *    the agent mid-flow, which is a much more expensive mistake.
 *  - **Every state that EXPLAINS the silence is checked first**, and each one
 *    is dependency state rather than a second clock: a filed question waiting
 *    on a person, a deliberate park with a date, an unfinished dependency, a
 *    goal outside every ranked band. A row only reaches the clock once none of
 *    those can account for it.
 *  - **The threshold is configurable and the default is somebody's decision,
 *    not a measurement.** Twenty minutes is Bryan's, and the reasoning is in
 *    the constant below.
 *
 * ── Why the verdict carries three lists ─────────────────────────────────
 *
 * `stalled` is work that should be moving and is not — the lead drives it.
 * `unfiled` is a different failure wearing similar clothes: a row waiting on
 * a person with no question filed anywhere they read. Nobody is failing to
 * work it, so it is not a stall, and the remedy is to file the ask rather
 * than to chase the owner. Merging the two would hand the lead one list with
 * two incompatible actions in it. It runs on the same clock as `stalled`,
 * for the reason given where the gate is applied below: an ask that was
 * created a minute ago is one the lead may well be in the middle of filing.
 *
 * `undetermined` is the load-bearing one, and it is the same argument
 * `ready-gate.ts` makes: a row whose review items cannot be parsed answers
 * "no open questions" identically to a row that genuinely has none — and an
 * open question is precisely what would have exonerated it. Such a row is not
 * named as stalled and is not counted healthy either. It is named as unread,
 * so the silence about it belongs to somebody.
 */
import {
  type EventRow,
  type ReviewItemRow,
  type TaskRow,
  classifyOpenTasks,
} from './keep-moving.ts';

/**
 * Twenty minutes (Bryan, 2026-08-27: "Detect at 20 minutes").
 *
 * The ticket defined a stall as thirty minutes of silence AND asked that
 * stalls surface within thirty minutes. Those cannot both hold — detection
 * cannot precede the definition — so shipping the ticket's own number would
 * have surfaced a stall at about thirty-one minutes and missed the goal by
 * construction. Twenty is what makes the goal reachable: the wake fires
 * roughly a minute after the threshold, so a row that goes quiet is named
 * inside thirty minutes of going quiet.
 *
 * It buys that with false positives, and the trade was made knowing so. This
 * is a decision rather than a finding — see the header for what is and is not
 * known about elapsed time as a signal — so it is exported, overridable via
 * `CW_STALL_NUDGE_MINUTES`, and the one number to reach for first if the wake
 * turns out to be noisy.
 */
export const STALL_QUIET_DEFAULT_MS = 20 * 60_000;

/** Why a row could not be evaluated. A closed vocabulary, matching
 *  `ready-gate.ts`, so the rendered line can name the condition rather than
 *  saying that something went wrong. */
export type StallUndeterminedReason = 'review-items-unreadable';

/** One row the lead is being asked to look at. */
export interface StalledRow {
  id: string;
  title: string;
  /** Which keep-moving bucket put it here — `in-progress` (claimed and gone
   *  quiet), `ready-unpicked` (nothing blocking it and nobody on it), or
   *  `blocked-on-owner-unfiled` on the `unfiled` list. The lead's next move
   *  differs per bucket, so the frame must not flatten them into one word. */
  bucket: string;
  /** How long since anything touched the row — a transition, an edit, or a
   *  comment on its discussion. */
  quietMs: number;
}

/** A row the gate could not evaluate. */
export interface StallUndeterminedRow {
  id: string;
  reason: StallUndeterminedReason;
}

export interface StallVerdict {
  /** Work that should be moving and is not, quietest first. */
  stalled: StalledRow[];
  /** Rows waiting on a person with no question filed where they would see it. */
  unfiled: StalledRow[];
  /** THE DENOMINATOR: how many open rows were examined. Stated so an empty
   *  `stalled` reads as "nine rows, all accounted for" rather than as an
   *  empty board. */
  considered: number;
  /** Rows whose state could not be read. Not stalled, and not healthy. */
  undetermined: StallUndeterminedRow[];
}

export interface EvaluateStallsInput {
  /** Every task on the board. Rows that are neither `todo` nor `in-progress`
   *  are dropped by the classifier and never reach the denominator. */
  tasks: readonly TaskRow[];
  /** Activity per row. The caller supplies these; on the server they are the
   *  row's own edit timestamps, which the board's event feed has measurably
   *  missed. */
  events: readonly EventRow[];
  /** Open questions waiting on a person, by row. Presence is what "an ask is
   *  filed" means. */
  reviewItems: readonly ReviewItemRow[];
  /** Which goals dispatch and which are the owner's own queue. */
  bands: { dispatchable: Set<string>; ownerBand: Set<string> };
  /**
   * Rows whose stored review items could not be PARSED. Passed in rather than
   * derived, because only the caller holds the store that failed to read them
   * — and a row that arrives here is excluded from every other list.
   */
  unreadableReviewTaskIds?: ReadonlySet<string>;
  now: number;
  quietMs?: number;
  /** Newest comment per row, for the rows worth the lookup. A comment IS the
   *  row moving; without this a ticket whose whole conversation is live on its
   *  thread reads as abandoned. */
  threadActivity?: Map<string, number>;
}

/**
 * Sort every open row into stalled / waiting-on-an-unfiled-ask / unreadable.
 *
 * The classification itself is `classifyOpenTasks`'s, unchanged and shared
 * with the keep-moving report — which is the point of importing it rather
 * than restating its rules. What this function adds is the split into the
 * three lists above and the removal of rows nothing could read.
 */
export function evaluateStalls(input: EvaluateStallsInput): StallVerdict {
  const quietMs = input.quietMs ?? STALL_QUIET_DEFAULT_MS;
  const unreadable = input.unreadableReviewTaskIds ?? new Set<string>();
  const rows = classifyOpenTasks(
    [...input.tasks],
    [...input.events],
    [...input.reviewItems],
    input.now,
    quietMs,
    input.bands,
    input.threadActivity,
  );

  const stalled: StalledRow[] = [];
  const unfiled: StalledRow[] = [];
  const undetermined: StallUndeterminedRow[] = [];
  for (const row of rows) {
    // Before every other verdict, deliberately: an unreadable review array is
    // the one thing that could have explained this row's silence, so a
    // reading taken without it is not a reading.
    if (unreadable.has(row.id)) {
      undetermined.push({ id: row.id, reason: 'review-items-unreadable' });
      continue;
    }
    const named: StalledRow = {
      id: row.id,
      title: row.title,
      bucket: row.bucket,
      quietMs: row.sinceActivityMs,
    };
    if (row.stalled) stalled.push(named);
    // Restricted to the row that actually needs the ask filed. `unfiledAsk` is
    // also set on rows BEHIND such a row, whose chain bottoms out in it —
    // listing those would hand the lead the same single action several times
    // over, attached to rows where it cannot be performed.
    //
    // And gated on the SAME silence the stalled list runs on. Without the
    // clock a row counted the moment it was created: an agent files a ticket
    // for a person, and the wake fires while the turn that filed it is still
    // running — telling the lead about a gap it is in the middle of closing.
    // Measured on a live board, that produced six wakes in an evening with
    // nothing stalled in any of them, its unfiled count walking 1→2→3→2→1.
    //
    // This clock belongs to the WAKE and to nothing else. `classifyOpenTasks`
    // is unchanged, so the keep-moving report still counts every unfiled ask
    // however fresh — there the question is whether the protocol is being
    // followed right now, and a young violation is still a violation.
    else if (row.bucket === 'blocked-on-owner-unfiled' && row.sinceActivityMs > quietMs)
      unfiled.push(named);
  }
  // `classifyOpenTasks` already sorts by silence, longest first, and both
  // lists inherit that order — the row at the top is the one to start with.
  return { stalled, unfiled, considered: rows.length, undetermined };
}
