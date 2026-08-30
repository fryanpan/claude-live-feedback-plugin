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
 */

/** Bumped when the frame around the prompt changes, so a stored estimate
 *  can be told from one made under an older ask. */
export const EFFORT_ESTIMATE_PROMPT_VERSION = 1;

/**
 * What a workspace asks its effort scorer to weigh, until somebody edits
 * it — a natural-language prompt the owner tunes in workspace settings,
 * the same shape and the same reasoning as `DEFAULT_REVIEW_ITEM_CRITERIA`:
 * effort is a judgment call the owner should be able to redirect in his own
 * words, not a rule table in code.
 */
export const DEFAULT_EFFORT_ESTIMATE_PROMPT = [
  'Estimate the effort a ticket like this typically takes on this board, from its title, description and goal.',
  "- Hands-on time is the OWNER's own attention: reading the ticket, reviewing a diff or a doc, deciding something, testing a result. It is not the time an agent spends working alone.",
  '- Wall-clock time is calendar time from filing to done, including any time the ticket spends waiting on review, on a decision, or on something else finishing first.',
  '- A ticket that carries an open decision or a design question usually costs more wall-clock time than hands-on time — most of the wait is not spent looking at it.',
  '- A small, well-scoped fix costs little of either. A vague or exploratory ticket costs more of both; say so with a larger number rather than guessing low.',
].join('\n');

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

/** The longest either number may be — 90 days in seconds. A reply outside
 *  this range is exactly the "bad prompt" case the positive control is
 *  for: no estimate stored, not a number nobody would stand behind. */
export const EFFORT_ESTIMATE_MAX_SECONDS = 90 * 24 * 60 * 60;

function isUsableSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= EFFORT_ESTIMATE_MAX_SECONDS
  );
}

/**
 * Read the model's reply. `null` when it is not a usable estimate — no
 * JSON, a missing or non-numeric field, a non-positive or absurd number —
 * which the caller treats as a FAILED run: the row says so, rather than
 * storing a guess nobody could stand behind.
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
  const handsOn = (parsed as { handsOnSeconds?: unknown }).handsOnSeconds;
  const wallClock = (parsed as { wallClockSeconds?: unknown }).wallClockSeconds;
  if (!isUsableSeconds(handsOn) || !isUsableSeconds(wallClock)) return null;
  return { handsOnSeconds: Math.round(handsOn), wallClockSeconds: Math.round(wallClock) };
}
