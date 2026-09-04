/**
 * The task panel's two one-tap asks: Plan and Review.
 *
 * A huddle doc has these as floating buttons (`plan-gate.ts`,
 * `review-float.ts`) and a ticket had only the receipts — "Plan requested"
 * rendered as a dead, disabled button for an ask somebody had made
 * somewhere else. This is the live half: on a ticket, Plan asks the board's
 * agent to plan the work, Review asks it to read the ticket back and
 * question what is thin.
 *
 * The ask IS a comment, exactly as it is on a doc. A ticket's comments live
 * in its body doc (`task:<id>`), so a press posts to the same routes the
 * floats press — `POST /api/docs/task:<id>/plan-request` and
 * `.../review-request` — which file a subject thread from the presser and
 * stamp the doc with who asked and when. Nothing new for the seated lead to
 * learn: it already hears the board's threads.
 *
 * This module is the decision layer and nothing else — no fetches, no DOM —
 * so the face, the receipt words and the address are each testable on their
 * own. The panel renders what `taskAskFace` says; `hub-app.ts` performs the
 * write.
 */

import { timeAgo } from './hub-presence-model.ts';

export type TaskAskKind = 'plan' | 'review';

/** Both asks, in the order the panel shows them: plan the work, then read it
 *  back. Ordered here rather than at the call site so the panel and its test
 *  cannot disagree about which control comes first. */
export const TASK_ASK_KINDS: readonly TaskAskKind[] = ['plan', 'review'] as const;

/** What the control says. One word each: the button's own shape and place
 *  says it is a request, so the label does not have to (owner's rule —
 *  affordances over explanatory text, no captions under a button). */
export const TASK_ASK_LABEL: Record<TaskAskKind, string> = {
  plan: 'Plan',
  review: 'Review',
};

/** The hover / screen-reader line — the one place the ask is spelled out,
 *  because a title is asked for rather than shown. */
export const TASK_ASK_TITLE: Record<TaskAskKind, string> = {
  plan: 'Ask the board’s agent to plan this ticket',
  review: 'Ask the board’s agent to review this ticket',
};

/**
 * What the ticket's own doc says about the two asks — the `meta` of
 * `GET /api/docs/task:<id>`, narrowed to the four fields that decide a face.
 *
 * Undefined is "nobody has asked", which is also what a doc that has not
 * loaded yet looks like. The panel therefore renders the offer while it
 * loads, which is the right way round: the receipt is the state that must be
 * EARNED, and showing an offer for a moment costs one extra press at worst,
 * where a wrong receipt hides the control entirely.
 */
export interface TaskAskState {
  planRequestedAt?: number;
  planRequestedBy?: string;
  reviewRequestedAt?: number;
  reviewRequestedBy?: string;
}

export type TaskAskFace = 'ask' | 'requested';

/** When the ask was made, and by whom — the pair a receipt is built from. */
function stampOf(kind: TaskAskKind, state: TaskAskState | undefined): { at?: number; by?: string } {
  if (!state) return {};
  return kind === 'plan'
    ? { at: state.planRequestedAt, by: state.planRequestedBy }
    : { at: state.reviewRequestedAt, by: state.reviewRequestedBy };
}

/**
 * Which face this control wears. `'requested'` the moment the doc carries a
 * stamp for it, `'ask'` otherwise — the two are independent, so asking for a
 * plan leaves Review offering.
 */
export function taskAskFace(kind: TaskAskKind, state: TaskAskState | undefined): TaskAskFace {
  return stampOf(kind, state).at === undefined ? 'ask' : 'requested';
}

/**
 * The receipt line, or `null` while the control is still an offer.
 *
 * "Plan requested by Jordan, 4m ago" — who and when, because the reader who
 * opens a ticket and finds the control gone needs to know whether that was
 * them a minute ago or somebody else on Tuesday. A stamp with no name (an
 * older server wrote the time alone) drops the clause rather than inventing
 * an asker.
 */
export function taskAskReceipt(
  kind: TaskAskKind,
  state: TaskAskState | undefined,
  now: number,
): string | null {
  const { at, by } = stampOf(kind, state);
  if (at === undefined) return null;
  const what = kind === 'plan' ? 'Plan requested' : 'Review requested';
  const who = by ? ` by ${by}` : '';
  return `${what}${who}, ${timeAgo(at, now)}`;
}

/**
 * Where a press goes. `task:<id>` is the ticket's body-doc id — the same
 * room its comments already post to — and it is encoded as ONE path segment,
 * colon and all, because the route matches `/api/docs/([^/]+)` and an
 * unescaped id would still resolve while a slash in a future id would not.
 */
export function taskAskRequestPath(taskId: string, kind: TaskAskKind): string {
  return `/api/docs/${encodeURIComponent(`task:${taskId}`)}/${kind}-request`;
}

/** Where the panel reads the two stamps back from after a press or a reopen. */
export function taskAskStatePath(taskId: string): string {
  return `/api/docs/${encodeURIComponent(`task:${taskId}`)}`;
}
