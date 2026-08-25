/**
 * Which rows a wake may name — decided by DEPENDENCY STATE, never by a clock.
 *
 * ── Why the clock had to go ─────────────────────────────────────────────
 *
 * The wake used to ask one question: has this row been quiet for longer than
 * the idle window? A three-session review measured that against real work on
 * two boards and it did not survive. The MEDIAN gap between task-activity
 * events was 16.7 and 14.8 minutes — so 72% and 84% of intervals that ended
 * in done/review/blocked contained a 20-minute silence, and ~100% contained a
 * 10-minute one. It is not a tuning problem: at 30 minutes one board still
 * read 68%. The indicting measurement is a transcript cross-check restricted
 * to spans where the agent was PROVABLY typing throughout — 15 of 21 such
 * runs contain a 20+ minute board silence, and 40% of provably-active minutes
 * read as dead. One 587-minute run emitted 102 board events and still went 98
 * minutes quiet, because board events cluster at milestone boundaries. Being
 * chatty does not save you.
 *
 * So the clock measures how talkative a session is, and a wake built on it
 * interrupts working agents at roughly the rate it finds stalled ones. What
 * it should ask instead is whether the row is HELD: a task waiting on a
 * person's decision, or behind an enforced edge, is working correctly and
 * nobody needs waking. The idle window survives one rung up (`ready-nudge.ts`)
 * as a "don't interrupt a board mid-conversation" damper — never as the
 * evidence that a row is stalled.
 *
 * ── Why the verdict carries counts it does not strictly need ────────────
 *
 * Because "I looked and found nothing held up" and "I could not look" reach a
 * reader as the same empty list. That is not a hypothetical: the review this
 * replaces produced a confident zero, twice, from a `find` whose arguments
 * were parsed as flags with stderr suppressed — over a directory holding a
 * live 127MB file. So a verdict here states its DENOMINATOR (`considered`),
 * what it withheld and why (`held`), and — kept deliberately out of `held` —
 * the rows it could not evaluate at all (`undetermined`).
 *
 * `undetermined` is the load-bearing one. A row whose state cannot be read is
 * not nudged, and it is not counted healthy either; it is named, so the
 * silence about it is somebody's to answer. Folding it into `held` would make
 * an unreadable ticket indistinguishable from a correctly-deferred one, which
 * is the same failure in a smaller box.
 */

/** What the gate can conclude about a row it withheld. Each one is a state it
 *  READ — never the absence of a reading, which is `undetermined`. */
export type HoldReason =
  /** Somebody is already on it (`in-progress`). */
  | 'claimed'
  /** An open ENFORCED dependency. Advisory `after` edges do not appear here,
   *  matching the transition gate rather than inventing a second notion. */
  | 'blocked'
  /** Deliberately deferred, with a date. Not a status — the row is still
   *  `todo`, still unblocked, still owned. */
  | 'parked'
  /** Owned by a person. An agent wake unblocks nothing there. */
  | 'awaiting-person'
  /** Owned by nobody the board can name. There is no session to wake. */
  | 'unowned'
  /** An open review item — a question put to a person that nobody has
   *  answered. Covers `needs: 'decision'` too: the store derives a review row
   *  from the legacy decision fields at read time, so both spellings arrive
   *  here as one fact and cannot drift apart. */
  | 'awaiting-answer';

/** Why a row could not be evaluated. Kept as a small closed vocabulary so the
 *  rendered line can say something specific rather than "an error occurred". */
export type UndeterminedReason = 'owner-kind-unreadable' | 'review-items-unreadable';

/** One row as the gate reads it — the subset of `QueueRow` it actually uses.
 *  Narrow on purpose: a gate that took the whole row could start keying on
 *  fields nothing here has reasoned about. */
export interface GateRow {
  id: string;
  title: string;
  status: string;
  /** False when an open ENFORCED dependency holds the row (`QueueRow.ready`). */
  ready: boolean;
  /** Present only while the row is deferred, computed against `now` by the
   *  caller — an expired park simply arrives absent. */
  parked?: { until: number; reason?: string };
}

/** The row as a wake needs to name it. */
export interface GateReadyRow {
  id: string;
  title: string;
}

/** A row the gate withheld because it could not read it. */
export interface UndeterminedRow {
  id: string;
  reason: UndeterminedReason;
}

/**
 * The two per-row lookups the gate cannot do itself, because both need the
 * store. Either may THROW — a store mid-hydrate, a roster read during
 * shutdown — and a throw is an undetermined row rather than a healthy one.
 */
export interface ReadyGateProbes {
  /** Person, agent, or nobody-the-board-can-name. */
  ownerKind: (taskId: string) => 'agent' | 'person' | 'unknown';
  /**
   * How many review items on this row are still waiting on a person, and how
   * many stored rows could not be PARSED.
   *
   * The second number is the whole reason this is not a boolean.
   * `listReviewItems` drops a corrupted row rather than throwing, so a ticket
   * whose questions are unreadable answers "no open questions" — identical to
   * a ticket that genuinely has none. A count of what it could not read is
   * what lets those two be told apart.
   */
  reviewState: (taskId: string) => { open: number; unreadable: number };
}

export interface ReadyGateVerdict {
  /** Rows a wake may name, in the board's own priority order. */
  ready: GateReadyRow[];
  /** THE DENOMINATOR: how many rows were examined. Open, non-triage rows —
   *  `done` and `triage` never reach this gate, because no dispatch read
   *  returns them. Stated so an empty `ready` reads as "nine rows, all held"
   *  rather than as an all-clear. */
  considered: number;
  /** Withheld rows by reason, absent keys rather than zeroes. */
  held: Partial<Record<HoldReason, number>>;
  /** Rows the gate could not evaluate. NOT nudged, and NOT healthy. */
  undetermined: UndeterminedRow[];
}

/**
 * Sort every open row into ready / held / unevaluable.
 *
 * Checks run cheapest-and-most-certain first, and a row stops at its first
 * verdict. That ordering is why a parked row with a corrupt review array is
 * reported as PARKED rather than as unevaluable: the gate read a state that
 * settles the question on its own, and raising an alarm about a row nobody
 * was going to be woken for is noise that trains a reader to skip alarms.
 */
export function evaluateReadyWork(
  rows: readonly GateRow[],
  probes: ReadyGateProbes,
): ReadyGateVerdict {
  const ready: GateReadyRow[] = [];
  const held: Partial<Record<HoldReason, number>> = {};
  const undetermined: UndeterminedRow[] = [];
  const hold = (reason: HoldReason) => {
    held[reason] = (held[reason] ?? 0) + 1;
  };

  for (const row of rows) {
    // Claimed, deferred, or behind an enforced edge — all three are facts the
    // row carries itself, so none of them can fail to be readable.
    if (row.status !== 'todo') {
      hold('claimed');
      continue;
    }
    if (row.parked !== undefined) {
      hold('parked');
      continue;
    }
    if (!row.ready) {
      hold('blocked');
      continue;
    }

    let owner: 'agent' | 'person' | 'unknown';
    try {
      owner = probes.ownerKind(row.id);
    } catch {
      undetermined.push({ id: row.id, reason: 'owner-kind-unreadable' });
      continue;
    }
    if (owner === 'person') {
      hold('awaiting-person');
      continue;
    }
    if (owner !== 'agent') {
      hold('unowned');
      continue;
    }

    let reviews: { open: number; unreadable: number };
    try {
      reviews = probes.reviewState(row.id);
    } catch {
      undetermined.push({ id: row.id, reason: 'review-items-unreadable' });
      continue;
    }
    // Unreadable BEFORE open: a ticket with one open question and one
    // unparseable row is a ticket whose state is partly unknown, and the
    // honest report of a partly-unknown state is that it is unknown.
    if (reviews.unreadable > 0) {
      undetermined.push({ id: row.id, reason: 'review-items-unreadable' });
      continue;
    }
    if (reviews.open > 0) {
      hold('awaiting-answer');
      continue;
    }

    ready.push({ id: row.id, title: row.title });
  }

  return { ready, considered: rows.length, held, undetermined };
}
