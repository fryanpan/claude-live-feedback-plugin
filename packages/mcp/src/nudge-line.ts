/**
 * How the board's two WAKE events read to the lead agent that receives them.
 *
 * Everything else on the hub channel reports something a person or an agent
 * just did, and arrives while the recipient is already in the loop. These two
 * are the opposite: the board woke a session that was not thinking about this
 * board, at the cost of a turn, to say that work is waiting. That makes the
 * line the entire message — there is no surrounding context to fall back on.
 *
 * Both landed in the renderer's `default:` case, which renders an unknown hub
 * event as `[<event>] task <id>`. For a task transition among a stream of them
 * that is thin but survivable; for a wake it is the failure the nudger's
 * arming rules were written to prevent, reintroduced at the last hop. A lead
 * that must call `get_task` before it can tell whether the interruption was
 * worth answering learns to skim wakes, and then the one that mattered is
 * skimmed too.
 *
 * Kept out of mcp.ts — a bundle entry point that exports nothing — for the
 * same reason `triage-line.ts` and `voice-line.ts` are: the wording is a
 * decision, and inline in a 3,000-line switch it cannot be asserted.
 */

export interface NudgePayload {
  /** The row to start with (idle) or the row the answer was about
   *  (answered). Absent on an answer recorded against a comment rather than
   *  a task row — that route moves no task and has no id to carry. */
  taskId?: string;
  /** The row's title, which the server stamps onto both frames. Absent from a
   *  server older than that; the id is then all there is to name it by. */
  title?: string;
  /** How many rows were ready when the wake fired. Idle nudges only. */
  readyCount?: number;
  /** How long the board had stood still. Idle nudges only. */
  idleMs?: number;
}

/** Mirrors mcp.ts's helper of the same name. Duplicated rather than shared
 *  because mcp.ts exports nothing; the copy is what lets the rendered line be
 *  asserted from a test. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A duration as a person reads one. Coarse on purpose: the recipient is
 * deciding whether the wait is unusual, not measuring it, and "1h 35m" makes
 * that call at a glance where "95m" makes it after arithmetic.
 */
function humanDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The row, named by whatever the frame actually carries. A title with its id
 *  in tow when both are there, because the title is what the reader
 *  recognises and the id is what the tools take. */
function namedTask(p: NudgePayload): string | null {
  const title = p.title ? `"${truncate(p.title, 60)}"` : null;
  if (title && p.taskId) return `${title} (${p.taskId})`;
  return title ?? p.taskId ?? null;
}

/**
 * Render `workspace.ready_idle` — ready work nobody has picked up.
 *
 * Ordered so the two facts that decide whether to act come first (how much is
 * waiting, how long it has waited), the row to start with second, and the
 * tool to start with last. The count is spelled out even at one, because a
 * lone row and a queue are different asks and a bare title says neither.
 */
export function readyIdleLine(p: NudgePayload): string {
  const count = p.readyCount;
  const one = count === 1;
  const subject =
    count === undefined ? 'ready work has' : `${count} ${one ? 'task has' : 'tasks have'}`;
  const stood = p.idleMs === undefined ? '' : ` for ${humanDuration(p.idleMs)}`;
  const nobody = count !== undefined && !one ? 'them' : 'it';
  const top = namedTask(p);
  const start = top ? ` Start with ${top}.` : '';
  return `[workspace.ready_idle] ${subject} been ready${stood} with nobody on ${nobody}.${start} Take the top of the queue with next_tasks / task_transition.`;
}

/**
 * Render `workspace.review_answered` — an ask the lead raised has an answer.
 *
 * No duration and no count: this frame is sent the moment the answer lands,
 * and it is about one thing. What it must carry is which ask was answered and
 * that the answer is now the input to something — an answered item nobody
 * reads is the same dead end as an unasked question.
 */
export function reviewAnsweredLine(p: NudgePayload): string {
  const about = namedTask(p);
  const subject = about ? `your review item on ${about}` : 'a review item you raised';
  return `[workspace.review_answered] ${subject} has an answer — read it and act on it now; walk its links as the propagation checklist.`;
}
