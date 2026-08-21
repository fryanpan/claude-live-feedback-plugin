/**
 * How a `triage.requested` event reads to the agent that receives it.
 *
 * The request rides a per-workspace channel that EVERY attached agent hears,
 * so the addressee travels in the payload (`leadAgentId`). Rendering it as a
 * bare imperative — "re-look at 5 unplaced task(s)" — hands the same order to
 * every listener, and the two non-lead agents on a board will each act on a
 * request that was never theirs.
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
  /** `bucket-review` only: the bands that just appeared in the goal list —
   *  the reason the unplaced pile is worth another look. */
  newBands?: Array<{ id?: string; title?: string }>;
  /** `task-review` only: the name the row has NOW, what just happened to it
   *  (created / renamed / edited), and who did it. */
  title?: string;
  trigger?: string;
  actor?: { id?: string; name?: string; kind?: string };
}

/**
 * What triaging ONE task asks for, spelled out in the request itself.
 *
 * The line used to read "place task X against the goal (set_task_goal)", and
 * the board did exactly that: a paragraph typed into quick-capture got a goal
 * and kept its machine-clipped fragment of a title and its unshaped body
 * forever, while every component reported success. Capture is deliberately
 * dumb — it must never lose a word or wait on a network — so the only place
 * a raw row can become work is here, and nothing here said so.
 *
 * Three verbs, in this order, because each one needs the last:
 *
 *  - READ the row's own words. `next_tasks` carries the full body; `quote`
 *    carries what was said when any of it was dictated.
 *  - DECIDE how many tasks it is. Zero is a real answer — "anyway, make a
 *    ticket from this" is an instruction ABOUT neighbouring text, not work —
 *    and so is several. This is a judgement, never a delimiter: capture makes
 *    exactly one row per submit and cannot tell the difference.
 *  - REWRITE, then place. A title someone would recognise, a body in the
 *    story shape this board asks for, then `set_task_goal` at a position.
 *
 * `rewrite_task` takes the title alongside the body so a shaping is one
 * attributed act; the row's original words are preserved to `quote`
 * automatically on that first rewrite, so a rewrite can never be the only
 * record of what was said.
 */
const SHAPE_THEN_PLACE =
  'read its own words, decide whether it is zero / one / several tasks (an instruction about neighbouring text is zero), rewrite each into a title and a story-shaped body with rewrite_task, then place with set_task_goal';

/**
 * The judgment half of a task-review — when to rewrite versus ask the filer,
 * and why a human's deliberate words are never silently replaced. Named in the
 * Named in the request itself, and exported so the OTHER delivery path — the
 * queued rows an away lead gets on `attach_agent` — names the same contract.
 *
 * This used to name a skill of its own (`reviewing-task-shape`). It was
 * retired: the ask is the lead seat's, §2 of the lead skill claims it outright,
 * the STANDARD it judged against is stated once in the general skill, and
 * `rewrite_task`'s own description carries the mechanics. What was left was
 * judgment that belongs beside the rest of the seat's judgment.
 */
export const TASK_REVIEW_SKILL = 'claude-workspaces:leading-a-workspace';

/**
 * Render the body for a `triage.requested` event as seen by `selfAgentId`.
 *
 * A named lead who is NOT the reader turns the order into an addressed FYI.
 * Everything else keeps the imperative, deliberately: this guard is
 * one-directional, so its failure mode is an agent being asked to do work
 * that turns out to be someone else's, never a request that reaches nobody.
 * Silence has no recovery path — the live request is not replayed.
 */
/**
 * The body of a `bucket-review` — "a band appeared, re-look at the pile".
 *
 * Rendered on its own branch rather than through the re-triage one, because
 * the north-star text did NOT move: borrowing that branch would tell the lead
 * their placements were judged against a goal that never changed, which is
 * the same lie that kept this request out of the re-triage sidecar.
 *
 * Two things the line must say and one it must not. It names the bands and
 * every task id, for the same parity reason the re-triage line does — the
 * present lead must not get less than the away one, who receives the whole
 * `pendingBucketReview` on attach. And it says that leaving a task unplaced
 * is a valid answer, because the server deliberately places nothing: an
 * auto-assign would stamp a ranking decision no human made, and a line read
 * as "empty this bucket" is that same decision made of words.
 */
function bucketReviewDetail(p: TriageRequestPayload): string {
  const bands = (p.newBands ?? [])
    .map((b) => (b.title && b.id ? `"${b.title}" (${b.id})` : (b.title ?? b.id)))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const banded = bands.length > 0 ? `\nnew band(s): ${bands.join(', ')}` : '';
  const ids = p.taskIds ?? [];
  const tasks = ids.length > 0 ? `\nunplaced tasks: ${ids.join(', ')}` : '';
  return `${banded}${tasks}`;
}

export function triageRequestLine(p: TriageRequestPayload, selfAgentId: string): string {
  if (p.kind === 'bucket-review') {
    const count = p.taskIds?.length ?? '?';
    const batch = p.batchId ? `, passing batchId "${p.batchId}" on each` : '';
    const detail = bucketReviewDetail(p);
    const ask =
      `re-look at ${count} unplaced task(s) — a new goal band appeared, so some of them may ` +
      `have a home now. Place the ones that do with set_task_goal${batch}; leaving the rest ` +
      'unplaced is fine, that is what the bucket is for.';
    const lead = p.leadAgentId;
    if (lead !== undefined && lead !== selfAgentId) {
      return `[triage.requested] FYI — ${ask} Addressed to lead agent ${lead}. Act only if that is you.${detail}`;
    }
    return `[triage.requested] ${ask}${detail}`;
  }
  if (p.kind === 'task-review') {
    // Addressed to the lead, like a re-triage: every attached agent hears
    // the channel, and two agents reviewing one row would rewrite it twice.
    const what = p.trigger ?? 'written';
    const named = p.title ? ` ("${p.title}")` : '';
    const who = p.actor?.name ? ` by ${p.actor.name}` : '';
    const ask =
      `task ${p.taskId}${named} was ${what}${who} — review its title and body against the ` +
      `standard (${TASK_REVIEW_SKILL}): fine as-is is a real answer; otherwise rewrite with ` +
      'rewrite_task (with a reason), or ask the filer in a comment on the task.';
    const lead = p.leadAgentId;
    if (lead !== undefined && lead !== selfAgentId) {
      return `[triage.requested] FYI — ${ask} Addressed to lead agent ${lead}. Act only if that is you.`;
    }
    return `[triage.requested] ${ask}`;
  }
  return `[triage.requested] shape and place task ${p.taskId}: ${SHAPE_THEN_PLACE}`;
}
