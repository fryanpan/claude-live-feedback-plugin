/**
 * The effort-estimate scorer's pure half: the default prompt, the request
 * built from it, and the parser for the model's reply.
 *
 * Pure for the same reason `review-judge-prompt.ts` is — the network half
 * lives in the server (`effort-estimator.ts`), so the wording of the ask
 * and the shape of the answer can be asserted without a key or a socket.
 *
 * Bryan wants to look at a goal on the board and see roughly when it will
 * finish, instead of asking an agent. That needs two numbers, because they
 * move independently: WALL-CLOCK time (filed to done, including whatever
 * it spends waiting on review or a decision) and HANDS-ON time (his own —
 * reading, reviewing, deciding, testing). Calibrating either against what
 * actually happened is a later chunk; this one only produces the guess and
 * says clearly when it could not.
 *
 * **The baseline is agent-executed work, and that is the whole point of
 * version 2.** Version 1 asked the question with no baseline at all, and a
 * model with no baseline answers with the one from its training data: a
 * person doing the work. It scored one ticket on the live board at 30 days
 * hands-on over 60 days of calendar time — 98% of that goal's whole
 * remainder, from a row an agent finished inside a week — and the board
 * printed the goal as 15.5 days of Bryan's own attention finishing some
 * time between October and December. The rows the board had already closed
 * said otherwise: nine of them ran at a median 0.099 of their estimated
 * calendar time and five at 0.010 of their estimated hands-on time.
 *
 * So the prompt now says who does the work, and the ceiling is fourteen
 * days rather than ninety. Both halves matter and neither is enough alone:
 * a stated baseline the model may still overshoot, and a ceiling that
 * turns an overshoot into a REFUSAL — a failed run visible on the row —
 * rather than a number nobody would stand behind being summed into a goal.
 */

/**
 * Bumped when the frame around the prompt changes, so a stored estimate can
 * be told from one made under an older ask.
 *
 * It is not a label. Two things read it: the boot pass that re-scores every
 * open ticket whose estimate predates the current ask (`server.ts`), and
 * the calibrator, which will only learn a correction factor from estimates
 * made under the CURRENT generation (`goal-effort.ts`). A ratio learned
 * against version 1's human-scaled numbers, applied to version 2's
 * agent-scaled ones, would discount the same speed-up twice.
 *
 * 2 — agent-executed baseline, 14-day ceiling (2026-08-30).
 */
export const EFFORT_ESTIMATE_PROMPT_VERSION = 2;

/**
 * What a workspace asks its effort scorer to weigh, until somebody edits
 * it — a natural-language prompt the owner tunes in workspace settings,
 * the same shape and the same reasoning as `DEFAULT_REVIEW_ITEM_CRITERIA`:
 * effort is a judgment call the owner should be able to redirect in his own
 * words, not a rule table in code.
 */
export const DEFAULT_EFFORT_ESTIMATE_PROMPT = [
  'Estimate the effort a ticket like this typically takes on this board, from its title, description and goal.',
  '- AI AGENTS DO THE WORK, not people. An agent writes the code, the tests and the docs, runs the checks and opens the PR, and it works continuously at machine speed. Estimate the ticket as an agent-executed ticket. Do NOT estimate how long a human engineer would take on it.',
  "- Hands-on time is the OWNER's own attention and NOTHING ELSE: reading the ticket, reviewing a diff or a mockup, answering a question, deciding something, trying the result. It is never the time the agent spends working alone. A typical ticket costs the owner MINUTES TO A FEW HOURS of hands-on time.",
  '- Wall-clock time is calendar time from filing to done, including any time the ticket spends waiting on review, on a decision, or on something else finishing first. A typical ticket takes HOURS TO A FEW DAYS of wall-clock time.',
  '- A ticket that carries an open decision or a design question usually costs more wall-clock time than hands-on time — most of the wait is not spent looking at it.',
  '- A small, well-scoped fix costs little of either. A vague or exploratory ticket costs more of both; say so with a larger number rather than guessing low.',
  '- A ticket that reads like weeks of work is a ticket an agent finishes in days. If a number is heading past a couple of weeks of calendar time, you are estimating human effort — halve it and check again.',
].join('\n');

/**
 * The longest either number may be — 14 days in seconds. A reply outside
 * this range is exactly the "bad prompt" case the positive control is for:
 * no estimate stored, not a number nobody would stand behind.
 *
 * It was 90 days, which is a ceiling that refuses nothing: the reply this
 * ceiling exists for was 30 days of hands-on time over 60 days of calendar
 * time, and 90 days let it through and into a goal total, where it was 98%
 * of the remainder. Fourteen days is the largest agent-executed ticket this
 * board has any evidence of, so past it the honest reading is that the
 * scorer answered a different question — and a failed run says that on the
 * row, where a stored 30 days silently does not.
 */
export const EFFORT_ESTIMATE_MAX_SECONDS = 14 * 24 * 60 * 60;

export interface EffortEstimateTicket {
  title: string;
  body?: string;
  /** The goal's own title, already resolved from its id — the CALLER's
   *  job, not this module's: only the caller holds the workspace's goal
   *  list, and this module stays pure. */
  goal?: string;
}

export interface EffortEstimateVerdict {
  /** The owner's own attention, in seconds. */
  handsOnSeconds: number;
  /** Filed-to-done calendar time, in seconds. */
  wallClockSeconds: number;
}

/**
 * The two halves of the call. `prompt` goes in the SYSTEM turn verbatim, so
 * what the owner wrote is what the scorer reads; the ticket is laid out as
 * labelled fields so a missing description reads as missing rather than as
 * a short paragraph.
 */
export function buildEffortEstimatePrompt(
  prompt: string,
  ticket: EffortEstimateTicket,
): { system: string; user: string } {
  const system = [
    'You estimate how long a ticket will take, for the board it is filed on.',
    'Weigh it against the prompt below, then answer in SECONDS for both fields.',
    'Reply with JSON only, on one line: {"handsOnSeconds": <number>, "wallClockSeconds": <number>}.',
    'Both numbers must be positive. wallClockSeconds is normally the larger of the two — hands-on time is a slice of the calendar time a ticket takes, never more than it.',
    `Neither number may exceed ${EFFORT_ESTIMATE_MAX_SECONDS} seconds (14 days). A ticket on this board that seems to need more than that is a ticket you are sizing for a human rather than for an agent.`,
    'When the title and description give you nothing to go on, still answer with your best guess for a ticket that vague — never refuse and never answer with zero.',
    '',
    'Prompt:',
    prompt.trim(),
  ].join('\n');
  const lines = [`Title: ${ticket.title}`];
  lines.push(`Goal: ${ticket.goal?.trim() ? ticket.goal.trim() : '(none)'}`);
  lines.push(`Description: ${ticket.body?.trim() ? ticket.body.trim() : '(none)'}`);
  return { system, user: lines.join('\n') };
}

/** Checked AFTER rounding, deliberately — a raw reply like `0.4` passes a
 *  pre-round positivity check yet rounds to zero, which would then violate
 *  the very invariant the check exists to enforce. */
function isUsableSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= EFFORT_ESTIMATE_MAX_SECONDS
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Read the model's reply. `null` when it is not a usable estimate — no
 * JSON, a missing or non-numeric field, a non-positive or absurd number, or
 * hands-on time reported as MORE than wall-clock time (the one relationship
 * the system prompt tells the model to hold: hands-on is a slice of the
 * calendar time, never more of it) — which the caller treats as a FAILED
 * run: the row says so, rather than storing a guess nobody could stand
 * behind.
 */
export function parseEffortEstimateResponse(text: string): EffortEstimateVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const handsOnRaw = (parsed as { handsOnSeconds?: unknown }).handsOnSeconds;
  const wallClockRaw = (parsed as { wallClockSeconds?: unknown }).wallClockSeconds;
  if (!isFiniteNumber(handsOnRaw) || !isFiniteNumber(wallClockRaw)) return null;
  const handsOnSeconds = Math.round(handsOnRaw);
  const wallClockSeconds = Math.round(wallClockRaw);
  if (!isUsableSeconds(handsOnSeconds) || !isUsableSeconds(wallClockSeconds)) return null;
  if (handsOnSeconds > wallClockSeconds) return null;
  return { handsOnSeconds, wallClockSeconds };
}
