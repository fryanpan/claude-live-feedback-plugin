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
  /** Who the server addressed this to. Absent when the lead seat is empty. */
  leadAgentId?: string;
}

/**
 * Render the one-line body for a `triage.requested` event as seen by
 * `selfAgentId`.
 *
 * A named lead who is NOT the reader turns the order into an addressed FYI.
 * Everything else keeps the imperative, deliberately: this guard is
 * one-directional, so its failure mode is an agent being asked to do work
 * that turns out to be someone else's, never a goal edit that reaches nobody.
 * Silence has no recovery path — the request is not replayed.
 */
export function triageRequestLine(p: TriageRequestPayload, selfAgentId: string): string {
  if (p.kind !== 'goal-retriage') {
    return `[triage.requested] place task ${p.taskId} against the goal (set_task_goal)`;
  }
  const count = p.taskIds?.length ?? '?';
  // Carried into the FYI too: if the mismatch is spurious (a lead whose id
  // moved), the reader still has everything they need to act.
  const batch = p.batchId ? `, passing batchId "${p.batchId}" on each` : '';
  const lead = p.leadAgentId;
  if (lead !== undefined && lead !== selfAgentId) {
    return `[triage.requested] FYI — goal changed; re-triaging ${count} open task(s) is addressed to lead agent ${lead}${batch}. Act only if that is you.`;
  }
  return `[triage.requested] goal changed — re-triage ${count} open task(s) with set_task_goal${batch}`;
}
