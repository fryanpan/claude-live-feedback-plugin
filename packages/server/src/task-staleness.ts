/**
 * "This description is older than the conversation about it."
 *
 * A task body is a MEASUREMENT taken on the day it was filed, and the board
 * renders it forever as a present-tense description of the world. On a
 * codebase that moves several times a day the two drift apart silently, and
 * the only thing standing between a stale premise and building the wrong
 * SIZE of fix is an agent being told to reproduce first — which costs 10-30
 * minutes per pickup and only fires for agents who were told.
 *
 * The signal this module reads is already recorded and needs no new
 * bookkeeping from anybody: when a previous reader discovered the premise had
 * moved, they SAID SO on the task. In all five known instances they did
 * exactly that, in prose, in a comment — and in none of them did it reach the
 * next reader, because the pickup path (`buildQueue` -> `next_tasks`) returns
 * `body` and drops the discussion. So the body's own correction was sitting
 * one API call away from every agent that re-derived it from scratch.
 *
 * This is deliberately NOT a claim that the body is WRONG. It is the much
 * weaker, checkable claim that the description has stood still while the
 * conversation moved on — and the remedy is to hand the reader the notes
 * rather than to make a judgement for them. Nothing here is a status, and
 * nothing here can be mistaken for one: see `decidePremiseDrift`'s first
 * silence.
 */

/** A comment on the task's body room, flattened to what a reader needs. */
export interface PremiseNote {
  ts: number;
  /** Display name of the commenter. */
  by: string;
  text: string;
}

export interface PremiseDrift {
  /** When the description was last written (falls back to the task's
   *  creation, which is when a never-edited body was written). */
  bodyWrittenAt: number;
  /** Newest note that postdates the description. */
  discussedAt: number;
  /** `discussedAt - bodyWrittenAt`. */
  agedMs: number;
  /** One sentence, about the DESCRIPTION — never about the task's state. */
  headline: string;
  /** What to do about it. */
  advice: string;
  /**
   * Every note posted since the description was last written, oldest first,
   * verbatim and uncapped.
   *
   * Uncapped on purpose. The whole failure being fixed is a reader having to
   * go and re-measure because they were handed less than the record held;
   * clipping the correction to a preview reintroduces exactly that in a
   * smaller form (the same reasoning that kept `taskIds` uncapped on the
   * live triage payload). The arming rule below is what keeps the cost
   * bounded: rows that are not drifting carry nothing at all.
   */
  notes: PremiseNote[];
}

/**
 * A day, matching `CLIENT_STALE_AFTER_MS`. The exact value is not
 * load-bearing — measured across a real 81-task board every gap was either
 * under 14h or over 60h, so any threshold in that range selects the same
 * rows. A day is the unit at which "the world moved under this" is plausible.
 */
export const PREMISE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function span(ms: number): string {
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  const h = Math.max(1, Math.floor(ms / HOUR));
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/**
 * Fires only when the description has stood still while the task was
 * discussed, and the gap is wide enough that "the world moved" beats "we
 * talked about it this afternoon".
 *
 * Four silences, each of which is a case where firing would be noise:
 *
 * 1. **A done task is always silent.** Structural, not cosmetic: it is what
 *    guarantees this reading can never be confused with marking the task
 *    complete. The signal is defined only on work somebody may still pick
 *    up, so "this premise is stale" and "this task is finished" are not
 *    merely different values — they live on disjoint sets of rows. Four of
 *    the five known instances still had real work in them after the premise
 *    was corrected, which is exactly why the two must never be conflated.
 *
 * 2. **A description newer than every note is silent.** A correction resets
 *    the clock, so the author has already accounted for what was said. This
 *    is what makes the fix additive: rewrite the body and the notice clears
 *    itself, with no separate acknowledge step to remember.
 *
 * 3. **A task nobody has said anything about is silent.** An untouched row
 *    is unstarted, not contradicted. Without this the whole backlog lights
 *    up on age alone, which is the arming failure that trains people to
 *    ignore the strip.
 *
 * 4. **A gap under `staleAfterMs` is silent.** "Filed this morning,
 *    discussed this afternoon" is a conversation.
 */
export function decidePremiseDrift(input: {
  /** Spelled out rather than imported, so this module stays free of
   *  `tasks.ts`. `triage` is listed for completeness and is unreachable in
   *  practice — `buildQueue` drops those rows before it computes a premise. */
  status: 'triage' | 'todo' | 'in-progress' | 'done';
  bodyWrittenAt: number;
  notes: readonly PremiseNote[];
  staleAfterMs?: number;
}): PremiseDrift | null {
  const { status, bodyWrittenAt, notes } = input;
  const staleAfterMs = input.staleAfterMs ?? PREMISE_STALE_AFTER_MS;

  if (status === 'done') return null;

  const since = notes.filter((n) => n.ts > bodyWrittenAt).sort((a, b) => a.ts - b.ts);
  if (since.length === 0) return null;

  const discussedAt = since[since.length - 1]!.ts;
  const agedMs = discussedAt - bodyWrittenAt;
  if (agedMs < staleAfterMs) return null;

  return {
    bodyWrittenAt,
    discussedAt,
    agedMs,
    headline: `This description has not changed in the ${span(agedMs)} since the newest note on this task.`,
    advice:
      `Read the ${since.length} note${since.length === 1 ? '' : 's'} below before you reproduce what the ` +
      'description claims — they postdate it and may already have corrected it. ' +
      'This says nothing about whether the task is done.',
    notes: since,
  };
}

/**
 * When the description was last written. `bodyWrittenAt` is stamped by the
 * two paths that can change a body; a task that predates the field, or whose
 * body has never been touched since it was filed, was written at creation.
 */
export function bodyWrittenAtOf(task: { createdAt: number; bodyWrittenAt?: number }): number {
  return task.bodyWrittenAt ?? task.createdAt;
}
