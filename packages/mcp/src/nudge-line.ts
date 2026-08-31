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

/** One stuck row, as `stall-nudge.ts` puts it on the wire. Every field is
 *  optional here and required there, deliberately: this renderer also has to
 *  survive a frame from a server older than the field it is reading. */
export interface StalledRowPayload {
  id?: string;
  title?: string;
  bucket?: string;
  quietMs?: number;
}

/** One review item the quality gate is holding past its window, as
 *  `stall-nudge.ts` puts it on the wire. `id` is the ticket's. */
export interface HeldRowPayload {
  id?: string;
  title?: string;
  reviewItemId?: string;
  headline?: string;
  reason?: string;
  heldMs?: number;
  filedBy?: string;
  /** The paste-ready `revise_review_item(…)` call for whichever surface the
   *  item is on. See `ReviewItemHeldPayload.revise`. */
  revise?: string;
}

/** What `workspace.stalled` carries. Four lists, because the lead's next act
 *  differs for each — see `stalledLine`. */
export interface StallPayload {
  taskId?: string;
  title?: string;
  stalledCount?: number;
  consideredCount?: number;
  rows?: StalledRowPayload[];
  unfiled?: StalledRowPayload[];
  undetermined?: { count?: number; reasons?: string[] };
  /** `heldItems`, not `held` — ready_idle spends that name on its counts. */
  heldItems?: HeldRowPayload[];
  /** The lead this wake was addressed to, when it could not be reached and
   *  came here instead. Absent on the ordinary wake — its presence is the
   *  whole signal, and without it the reader has no way to tell why it was
   *  woken about a board it does not lead. */
  escalatedFrom?: string;
}

/** What `workspace.review_item_held` carries — the filer's own wake. */
export interface ReviewItemHeldPayload {
  taskId?: string;
  title?: string;
  reviewItemId?: string;
  /** The doc-thread address, when the item was filed as a `review` payload
   *  on a comment rather than on a ticket. */
  docId?: string;
  threadId?: string;
  commentId?: string;
  /** The paste-ready `revise_review_item(…)` call, spelled by the server for
   *  whichever surface the item is on. Preferred over anything assembled
   *  here: the two forms take different arguments, and a filer that guesses
   *  spends a call finding out. */
  revise?: string;
  headline?: string;
  reason?: string;
  overdue?: boolean;
  heldMs?: number;
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

/** How many rows the line names before it starts counting instead. Five is
 *  what fits in a channel message a reader takes in at a glance; the rest are
 *  summarised rather than dropped, because a truncated list a reader cannot
 *  tell from a complete one is worse than either. The FRAME carries them all
 *  — see `stall-nudge.ts`. */
const STALL_ROWS_SHOWN = 5;

/** One stuck row as the line names it: what it is, and how long it has been
 *  silent. The bucket is left out — the reader's action is the same for both
 *  stalled kinds, and the word "in-progress" beside a title reads as status
 *  rather than as diagnosis. */
function stalledRowClause(row: StalledRowPayload): string {
  const named = row.title ? `"${truncate(row.title, 50)}" (${row.id})` : (row.id ?? 'a row');
  return row.quietMs === undefined ? named : `${named} quiet ${humanDuration(row.quietMs)}`;
}

/** The named rows, then a count of whatever did not fit. */
function stalledRowsClause(rows: readonly StalledRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(stalledRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/**
 * Render `workspace.stalled` — work that was supposed to be moving and is not.
 *
 * This wake differs from `readyIdleLine` in what it asks for. Ready work needs
 * one row picked up, so that line names one and points at the queue. A stall
 * frame names work that already has an owner who stopped, and the lead's job
 * is to go and drive EACH row — so the list is what the line is for, and it
 * carries several rather than a head and a count.
 *
 * Two other lists ride the same frame and each asks for something different,
 * which is why they are separate sentences rather than one merged total:
 *
 *  - `unfiled` is a row waiting on a person nobody actually asked. Nothing is
 *    stalled there; the remedy is to file the question where they read it, and
 *    telling the lead to "drive" it would send them to chase somebody who was
 *    never asked.
 *  - `undetermined` is rows the pass could not read. Spelled loudly and with
 *    which way the uncertainty falls, for the reason the ready line spells it:
 *    a row nobody could read that arrives as "already handled" is the exact
 *    swap this clause exists to prevent.
 */
export function stalledLine(p: StallPayload): string {
  const parts: string[] = [];
  const rows = p.rows ?? [];
  const count = p.stalledCount ?? rows.length;
  const denominator =
    p.consideredCount === undefined ? '' : ` (of ${p.consideredCount} open row(s) checked)`;
  if (count > 0) {
    const subject = count === 1 ? '1 task has' : `${count} tasks have`;
    const list = rows.length > 0 ? ` — ${stalledRowsClause(rows)}` : '';
    parts.push(
      `${subject} stopped moving${denominator}${list}. Drive each one: read its thread, ` +
        'then unblock it, hand it to somebody, or park it with a reason.',
    );
  }
  const unfiled = p.unfiled ?? [];
  if (unfiled.length > 0) {
    const noun = unfiled.length === 1 ? 'row is' : 'rows are';
    parts.push(
      `${unfiled.length} ${noun} waiting on a person with NO question filed — ` +
        `${stalledRowsClause(unfiled)}. File the ask where they will see it, or the wait is invisible.`,
    );
  }
  const unread = p.undetermined?.count ?? p.undetermined?.reasons?.length ?? 0;
  if (unread > 0) {
    const reasons = p.undetermined?.reasons ?? [];
    parts.push(
      `${unread} open row(s) could NOT be evaluated (${
        reasons.length > 0 ? reasons.join(', ') : 'reason not reported'
      }) and are not counted healthy. Read them with list_tasks before treating this board as fine.`,
    );
  }
  const held = p.heldItems ?? [];
  if (held.length > 0) {
    const noun = held.length === 1 ? 'review item is' : 'review items are';
    parts.push(
      `${held.length} ${noun} HELD by the quality gate and off the reader's queue — ` +
        `${heldRowsClause(held)}. Get each filer to revise_review_item; nobody can answer a held ask.`,
    );
  }
  // Never empty: the server does not send this frame with all four lists
  // empty, and a line that could render to a bare slug would be the
  // no-subject wake the whole file exists to prevent.
  const body =
    parts.join(' ') ||
    'the board reported a stall with no rows on it — treat this as a bug in the wake, not as a clear board.';
  // FIRST, when it is there. The reader of an escalated wake is not the lead:
  // before it can weigh the rows it has to know that it is standing in, and
  // that the board's own addressee is unreachable — which is a finding of its
  // own, and the one nobody could see before.
  //
  // It says UNREACHABLE, never "gone" or "has not answered for N": the sender
  // knows only that the seat holder holds no stream right now, which a
  // reconnecting session also looks like. Deciding a session is dead takes
  // evidence over a window (`leadSeatHealth`), and this line is not where
  // that call is made.
  if (p.escalatedFrom !== undefined && p.escalatedFrom !== '') {
    return (
      `[workspace.stalled] You are not this board's lead — ${p.escalatedFrom} holds the seat and ` +
      'is not reachable, so this came to you instead. Nothing addressed to that seat is arriving: ' +
      'take it (attach_agent) or hand it to a session that is here. Then, on the board itself: ' +
      body
    );
  }
  return `[workspace.stalled] ${body}`;
}

/**
 * The judge's reason as a CLAUSE — no trailing full stops — because every
 * line here continues after it. Without this the channel read "…'see
 * below'.. It has been held for 4m" and the lead's row read "…see below.;
 * and 2 more" (UX review, 2026-08-29).
 *
 * Spelled here rather than imported: this package publishes standalone and
 * does not depend on `@feedback/core`, whose `judgeReasonClause` is the same
 * rule for the server and the hub.
 */
function judgeReasonClauseLocal(reason: string): string {
  return reason.trim().replace(/\.+$/, '').trimEnd();
}

/** One held item as the lead's line names it: the ask, the ticket, who filed
 *  it, how long it has been held, and the gap the judge named. */
function heldRowClause(row: HeldRowPayload): string {
  const ask = row.headline ? `"${truncate(row.headline, 50)}"` : (row.reviewItemId ?? 'an item');
  const on = row.title ? ` on "${truncate(row.title, 40)}"` : '';
  const id = row.id ? ` (${row.id})` : '';
  const by = row.filedBy ? ` filed by ${row.filedBy}` : '';
  const age = row.heldMs === undefined ? '' : ` held ${humanDuration(row.heldMs)}`;
  // The lead's remedy is to get the FILER to revise, and the two surfaces
  // take different arguments — so the call rides along rather than being
  // guessed from the row id.
  const how = row.revise ? `, revise with ${row.revise}` : '';
  // Trailing full stop off for the same reason as `reviewItemHeldLine` below:
  // these clauses are joined with "; ", so a reason that ends in one reads
  // "…see below.; and 2 more".
  const why = row.reason ? ` — ${truncate(judgeReasonClauseLocal(row.reason), 120)}` : '';
  return `${ask}${on}${id}${by}${age}${why}${how}`;
}

function heldRowsClause(rows: readonly HeldRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(heldRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/**
 * Render `workspace.review_item_held` — the quality gate telling the FILER
 * that one of their items is off the reader's queue until they revise it.
 *
 * Two moments send it: the filing itself (the route's tool result already
 * said so; this is the same fact on the channel, for a session whose tool
 * result scrolled past) and the stall loop, once the hold has stood past the
 * window (`overdue`). The line carries the item id and the reason because
 * the reader's next act is one call with exactly those inputs.
 */
export function reviewItemHeldLine(p: ReviewItemHeldPayload): string {
  const ask = p.headline ? `"${truncate(p.headline, 60)}"` : 'a review item you filed';
  const on = p.title ? ` on "${truncate(p.title, 40)}"` : '';
  const ids = p.taskId
    ? p.reviewItemId
      ? ` (taskId ${p.taskId}, reviewItemId ${p.reviewItemId})`
      : ''
    : p.docId && p.threadId && p.commentId
      ? ` (docId ${p.docId}, threadId ${p.threadId}, commentId ${p.commentId})`
      : '';
  const why = p.reason ? ` — ${judgeReasonClauseLocal(p.reason)}` : '';
  const stood =
    p.overdue === true
      ? ` It has been held${p.heldMs === undefined ? '' : ` for ${humanDuration(p.heldMs)}`} and the reader still cannot see it.`
      : '';
  // The exact call, when the server spelled one. A comment-borne item and a
  // ticket item take different arguments, so "call revise_review_item" alone
  // is an instruction the filer can carry out wrongly.
  const fix = p.revise
    ? `Fix the gap named and call ${p.revise} now; it is judged again on every revision.`
    : 'Fix the gap named and call revise_review_item now; it is judged again on every revision.';
  return `[workspace.review_item_held] your review item ${ask}${on}${ids} was held off the queue by the quality gate${why}.${stood} ${fix}`;
}
