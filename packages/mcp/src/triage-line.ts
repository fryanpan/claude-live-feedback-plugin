/**
 * How a `triage.requested` event reads to the agent that receives it.
 *
 * The request rides a per-workspace channel that EVERY attached agent hears,
 * so the addressee travels in the payload (`leadAgentId`). Rendering it as a
 * bare imperative — "re-triage 5 open task(s)" — hands the same order to
 * every listener, and the two non-lead agents on a board will each re-place
 * the same tasks against a goal edit that was never theirs to act on.
 *
 * Kept out of mcp.ts (which exports nothing — it is a bundle entry point) so
 * the decision is testable on its own.
 */

export interface TriageRequestPayload {
  kind?: string;
  taskId?: string;
  taskIds?: string[];
  batchId?: string;
  /** The north-star text every current placement was judged against. On the
   *  wire since the request existed; it was simply never rendered, which is
   *  how it got written down as "unrecoverable on the live path". */
  oldGoal?: string;
  /** Who the server addressed this to. Absent when the lead seat is empty. */
  leadAgentId?: string;
}

/**
 * The contract a goal-change re-triage asks the reader to follow: re-read the
 * goal, re-place every open task, reorder, flag what the edit made obsolete
 * WITHOUT closing it, report on the board. Named in the request itself because
 * delivery without instructions is what the request kept producing — the
 * addressee knew N tasks needed re-placing and had to invent the rest.
 *
 * Exported so the same name reaches the OTHER delivery path (a queued edit
 * handed over on `attach_agent`), which is the one a lead who was away gets.
 */
export const RETRIAGE_SKILL = 'live-feedback:handling-a-goal-change';

/**
 * The part of the request that is the WORK — the exact ids to re-place, and
 * the sentence they were last judged against.
 *
 * Both have always been on the wire (`server.ts` broadcasts the whole
 * `TriageRequest`); neither was ever rendered. So a lead sitting at their
 * desk got a count, while a lead who was away got the full payload as
 * `pendingRetriage` on their next attach. The present addressee getting less
 * than the absent one is backwards, and the shipped skill had to work around
 * it — rebuilding the set with `list_tasks` and telling the reader that
 * `oldGoal` was gone on this path.
 *
 * Two deliberate choices:
 *
 *  - **No cap on the list.** A cap is "the present lead gets less" in a
 *    smaller form. The replayed payload has no cap, so neither does this.
 *  - **`oldGoal` verbatim, never clipped.** The skill's own step 4 says
 *    re-triaging against the first 120 characters of a goal is how the second
 *    half of an edit gets ignored — a clipped baseline would deliver the
 *    field and keep the defect.
 *
 * A missing field drops its whole line rather than rendering as the word
 * "undefined" beside an instruction to act on it.
 */
function retriageDetail(p: TriageRequestPayload): string {
  const ids = p.taskIds ?? [];
  const tasks = ids.length > 0 ? `\ntasks: ${ids.join(', ')}` : '';
  const baseline = p.oldGoal
    ? `\nprevious goal (what those placements were judged against): ${p.oldGoal}`
    : '';
  return `${tasks}${baseline}`;
}

/**
 * Render the body for a `triage.requested` event as seen by `selfAgentId`.
 *
 * A named lead who is NOT the reader turns the order into an addressed FYI.
 * Everything else keeps the imperative, deliberately: this guard is
 * one-directional, so its failure mode is an agent being asked to do work
 * that turns out to be someone else's, never a goal edit that reaches nobody.
 * Silence has no recovery path — the live request is not replayed.
 */
export function triageRequestLine(p: TriageRequestPayload, selfAgentId: string): string {
  if (p.kind !== 'goal-retriage') {
    return `[triage.requested] place task ${p.taskId} against the goal (set_task_goal)`;
  }
  const count = p.taskIds?.length ?? '?';
  // Carried into the FYI too: if the mismatch is spurious (a lead whose id
  // moved), the reader still has everything they need to act. The task list
  // and the baseline ride along for exactly the same reason.
  const batch = p.batchId ? `, passing batchId "${p.batchId}" on each` : '';
  const detail = retriageDetail(p);
  const lead = p.leadAgentId;
  if (lead !== undefined && lead !== selfAgentId) {
    return `[triage.requested] FYI — goal changed; re-triaging ${count} open task(s) is addressed to lead agent ${lead}${batch}. Act only if that is you (${RETRIAGE_SKILL}).${detail}`;
  }
  return `[triage.requested] goal changed — re-triage ${count} open task(s) with set_task_goal${batch}. What you owe on a goal change: ${RETRIAGE_SKILL}${detail}`;
}
