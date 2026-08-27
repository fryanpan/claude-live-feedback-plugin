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
 * same reason `voice-line.ts` is: the wording is a
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
  /**
   * How many OPEN ROWS the pass examined to arrive at `readyCount` — the
   * denominator. Idle nudges only, and absent from a server older than the
   * dependency-state gate, in which case the line simply does not claim one.
   */
  consideredCount?: number;
  /** What the pass withheld and why — `{ 'awaiting-person': 2, backlog: 1 }`.
   *  Absent rather than empty when nothing was held. */
  held?: Record<string, number>;
  /**
   * Rows the pass could NOT evaluate. Its presence is the whole signal, so it
   * is absent on the ordinary wake rather than sent as a zero.
   *
   * A frame carrying this with `readyCount: 0` is the one case where the
   * board wakes its lead with no work to hand over: the pass could not
   * establish that the board is quiet, and that is a different message from
   * a quiet board — which is a message it does not send at all.
   */
  undetermined?: { count?: number; reasons?: string[] };
  /** How long the board had stood still. Idle nudges only. */
  idleMs?: number;
  /** The answered row's own links. Answer nudges only, and routinely EMPTY —
   *  most rows annotate nothing. Absent from a server older than the field,
   *  and absent by construction on an answer recorded against a comment,
   *  which moves no row and so has no links to send. */
  links?: unknown[];
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

/** How many rows the pass could not read, or 0 — tolerant of a `count` a
 *  server omitted while sending reasons, which would otherwise render as a
 *  present-but-silent field. */
function undeterminedCount(p: NudgePayload): number {
  const u = p.undetermined;
  if (!u) return 0;
  if (typeof u.count === 'number' && u.count > 0) return u.count;
  return u.reasons && u.reasons.length > 0 ? u.reasons.length : 0;
}

/** The reasons as one clause, or a placeholder — never an empty parenthesis. */
function reasonsClause(p: NudgePayload): string {
  const reasons = p.undetermined?.reasons ?? [];
  return reasons.length > 0 ? reasons.join(', ') : 'reason not reported';
}

/**
 * The parenthetical that stops "1 task is ready" from meaning two different
 * boards.
 *
 * Absent entirely when the server sent no denominator — a line that invented
 * one, or wrote "unknown", would be worse than one that does not claim to
 * know. Present whenever it was sent, even when it equals `readyCount`,
 * because a stated denominator that agrees and an omitted one are exactly
 * what a reader must be able to tell apart.
 */
function denominatorClause(p: NudgePayload): string {
  if (p.consideredCount === undefined) return '';
  const parts = [`${p.consideredCount} open ${p.consideredCount === 1 ? 'row' : 'rows'} checked`];
  const held = Object.entries(p.held ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${n} ${reason}`);
  if (held.length > 0) parts.push(`held: ${held.join(', ')}`);
  const unread = undeterminedCount(p);
  // Spelled loudly, and with which way the uncertainty falls. A row nobody
  // could read that reads as "already handled" is the exact swap this clause
  // exists to prevent.
  if (unread > 0) {
    parts.push(`${unread} could NOT be evaluated (${reasonsClause(p)}) and is not counted ready`);
  }
  return ` (${parts.join('; ')})`;
}

/**
 * Render `workspace.ready_idle` — ready work nobody has picked up, or the one
 * case where the board could not tell whether there is any.
 *
 * Ordered so the two facts that decide whether to act come first (how much is
 * waiting, how long it has waited), the denominator that says what those
 * numbers are OUT OF next, the row to start with after that, and the tool to
 * start with last. The count is spelled out even at one, because a lone row
 * and a queue are different asks and a bare title says neither.
 *
 * The zero-ready branch is a different sentence rather than the same one with
 * a zero in it. The server sends that frame ONLY when rows could not be
 * evaluated — a genuinely quiet board is silence — so telling its reader to
 * "take the top of the queue" would send them to an empty queue and teach
 * them, correctly, that the wake carries no information.
 */
export function readyIdleLine(p: NudgePayload): string {
  const count = p.readyCount;
  const unread = undeterminedCount(p);
  if (count === 0 && unread > 0) {
    const of = p.consideredCount === undefined ? `${unread}` : `${unread} of ${p.consideredCount}`;
    return `[workspace.ready_idle] nothing is ready to hand over, and this pass could not establish that the board is quiet: ${of} open row(s) could not be evaluated (${reasonsClause(p)}). Read them with list_tasks before treating this board as clear.`;
  }
  const one = count === 1;
  const subject =
    count === undefined ? 'ready work has' : `${count} ${one ? 'task has' : 'tasks have'}`;
  const stood = p.idleMs === undefined ? '' : ` for ${humanDuration(p.idleMs)}`;
  const nobody = count !== undefined && !one ? 'them' : 'it';
  const top = namedTask(p);
  const start = top ? ` Start with ${top}.` : '';
  return `[workspace.ready_idle] ${subject} been ready${stood} with nobody on ${nobody}${denominatorClause(p)}.${start} Take the top of the queue with next_tasks / task_transition.`;
}

/**
 * Render `workspace.review_answered` — an ask the lead raised has an answer.
 *
 * No duration and no count: this frame is sent the moment the answer lands,
 * and it is about one thing. What it must carry is which ask was answered and
 * that the answer is now the input to something — an answered item nobody
 * reads is the same dead end as an unasked question.
 *
 * The propagation clause follows that ONLY when the row actually has links.
 * It used to be unconditional, on a frame that carried no links field at all
 * — so the commonest wake on this board told its reader to walk a checklist
 * nothing anywhere could produce, and an instruction that cannot be followed
 * cannot be told apart from one that can. Worse here than on
 * `decision.answered`, which at least sometimes had links to walk: an answer
 * recorded against a COMMENT names no row whatsoever, and this line still
 * sent its reader after that row's links.
 */
export function reviewAnsweredLine(p: NudgePayload): string {
  const about = namedTask(p);
  const subject = about ? `your review item on ${about}` : 'a review item you raised';
  const walk =
    Array.isArray(p.links) && p.links.length > 0
      ? '; walk its links as the propagation checklist'
      : '';
  return `[workspace.review_answered] ${subject} has an answer — read it and act on it now${walk}.`;
}
