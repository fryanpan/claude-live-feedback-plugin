/**
 * What counts as proof that a task moved, and when a move is UNPROVEN.
 *
 * A forward transition carries `evidence` — a commit, a thread ref, or both.
 * A forward move with none is allowed and flagged `unproven`, which the board
 * shades: a visible, permanent mark that the work is unverified.
 *
 * Two failure modes made that mark misleading, and both were observed in the
 * field rather than imagined:
 *
 * 1. The evidence was **dropped** on the caller's side and never reached the
 *    server. The move landed `unproven`, and the shading described a slip in
 *    the metadata rather than anything about the work.
 * 2. The evidence **arrived and was wrong** — a commit sha written from
 *    memory that resolves to nothing. That one is strictly worse: it reads as
 *    proof, `unproven` is false, and nothing looks wrong until someone tries
 *    to follow the sha.
 *
 * Both are repaired by APPENDING an amendment to the transition rather than
 * rewriting it. The original row keeps saying exactly what it said — it went
 * in with no proof, or with the wrong proof — and the correction is a new
 * attributed, timestamped fact layered on top, in the same shape as the rest
 * of the audit trail.
 *
 * This module holds the ONE spelling of "does this row have proof". The
 * server decides the flag, the board decides the shading, and a second
 * spelling of the predicate would drift the moment either moved.
 */

/** A commit and/or a ref. Structurally typed so the server's `TaskEvidence`
 *  and the client's projected copy both satisfy it without a shared import
 *  of either. */
export interface EvidenceLike {
  commit?: string;
  threadRef?: unknown;
}

/** One after-the-fact correction, as the predicate needs to see it. */
export interface AmendmentLike {
  evidence?: EvidenceLike;
}

/** A transition, as the predicate needs to see it. */
export interface TransitionLike {
  to: string;
  evidence?: EvidenceLike;
  amendments?: AmendmentLike[];
}

/**
 * Does this evidence object actually claim anything?
 *
 * Load-bearing beyond tidiness: it is what stops an amendment from EMPTYING
 * the proof it was sent to fix. An amend carrying `{}` — or `{commit: '  '}`
 * — costs nothing to send and would satisfy any check phrased as "the caller
 * supplied an evidence object", exactly the way a word-capped retry was once
 * satisfied by a blank answer. So the question asked everywhere is "is there
 * a claim here", never "is the field present".
 */
export function hasEvidence(evidence: EvidenceLike | undefined | null): boolean {
  if (!evidence || typeof evidence !== 'object') return false;
  const commit = typeof evidence.commit === 'string' ? evidence.commit.trim() : '';
  if (commit.length > 0) return true;
  return evidence.threadRef !== undefined && evidence.threadRef !== null;
}

/** Forward moves are the ones a claim of proof is about. Moving BACK to todo
 *  is undoing work, and asking it for evidence never made sense. */
export function isForwardTransition(to: string): boolean {
  return to === 'in-progress' || to === 'done';
}

/**
 * The board's shading predicate: a forward move with no proof attached, then
 * or since.
 *
 * Note what this deliberately does NOT distinguish: proof attached at the
 * time versus proof attached an hour later. The shading answers "is there
 * proof at all", and once an amendment lands the answer is yes, so it clears.
 * Keeping a permanent mark on a move that IS proven would reintroduce the
 * exact harm the amend path exists to remove — a durable visual alarm caused
 * by a metadata slip. The narrower question, "was the proof contemporaneous",
 * is still answerable and still visible, but it belongs in the history row
 * (which says when the amendment landed and who made it), not in a
 * board-level alarm.
 */
export function transitionUnproven(t: TransitionLike): boolean {
  if (!isForwardTransition(t.to)) return false;
  if (hasEvidence(t.evidence)) return false;
  return !(t.amendments ?? []).some((a) => hasEvidence(a.evidence));
}

/**
 * Was this transition's ORIGINAL evidence superseded by a later correction?
 *
 * The wrong-sha case. `transitionUnproven` is false for it both before and
 * after the amend — there was always *something* there — so a surface that
 * only reads the shading has no way to know the sha printed next to the row
 * is one nobody should follow. This is what a renderer marks it with.
 */
export function evidenceSuperseded(t: TransitionLike): boolean {
  return hasEvidence(t.evidence) && (t.amendments ?? []).some((a) => hasEvidence(a.evidence));
}

/** The proof that stands NOW: the newest amendment's, else the row's own.
 *  Undefined when there has never been any. */
export function effectiveEvidence(t: TransitionLike): EvidenceLike | undefined {
  const amendments = t.amendments ?? [];
  for (let i = amendments.length - 1; i >= 0; i--) {
    const a = amendments[i];
    if (a && hasEvidence(a.evidence)) return a.evidence;
  }
  return hasEvidence(t.evidence) ? t.evidence : undefined;
}
