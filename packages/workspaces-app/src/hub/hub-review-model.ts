/**
 * The review queue and the walkthrough that walks it: everything waiting on a
 * person, in one list, plus the wording each row and card wears (plan §3.9).
 * Pure — no DOM, no fetch — so the ranking rules are unit-testable without a
 * browser.
 *
 * Imports `hub-board-model.ts` for the row shape and the board's own ordering,
 * and `hub-presence-model.ts` for the two duration labels a queue row prints.
 * Nothing imports back: the queue is a reader of the board, not a peer of it.
 */
import type { ReviewPayload } from '@feedback/core';
import { type HubGoal, type HubTask, goalRank, ownedByPerson } from './hub-board-model.ts';
import { timeAgo, waitShort } from './hub-presence-model.ts';

// ── Decisions strip ────────────────────────────────────────────────────────

/** Open, unanswered decisions — the quick-decisions strip is a FILTER over
 *  tasks (§3.2: a decision is a task with needs:'decision'), not a second
 *  entity. */
export function decisionRows(tasks: HubTask[]): HubTask[] {
  return (
    tasks
      // WAITING is the owner's turn: the reader asked on it, and it comes
      // back — marked Revised — when the owner revises. The same rule that
      // keeps a waiting ticket item off `GET /review-items`, read off the
      // projection because this card is drawn from the projection.
      .filter(
        (t) =>
          t.needs === 'decision' &&
          t.status !== 'done' &&
          !t.answer &&
          t.decisionState !== 'waiting',
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  );
}

/** One open decision plus the work that is actually waiting on it. */
export interface DecisionRow {
  task: HubTask;
  /** Open tasks that name this decision in `after`. */
  blocks: HubTask[];
  /** At least one dependent names it in `afterEnforce` — that work cannot
   *  proceed at all, rather than merely being ordered behind it. */
  hard: boolean;
}

export interface DecisionQueue {
  rows: DecisionRow[];
  total: number;
  /** Decisions with at least one open dependent: "blocking work now". */
  blocking: number;
  /** The rest: real questions, but nothing is stalled on them. */
  waiting: number;
}

/**
 * The queue behind the count at the top of the board.
 *
 * Urgency here is DERIVED, never declared. "This is blocking work now" is the
 * same fact as "something depends on it", and `after` / `afterEnforce` already
 * record that — so there is deliberately no urgency field to set. A hand-set
 * one would be written at creation, the moment its author knows least about
 * what will end up waiting on the answer (the same reasoning that kept a
 * `lane` field off tasks).
 *
 * Ordering is what it blocks, not which goal it sits under: enforced edges
 * first, then by how many tasks are waiting, then oldest.
 */
export function decisionQueue(tasks: HubTask[]): DecisionQueue {
  const rows = dependentsRows(tasks, decisionRows(tasks));
  const blocking = rows.filter((r) => r.blocks.length > 0).length;
  return { rows, total: rows.length, blocking, waiting: rows.length - blocking };
}

/**
 * "What open work is waiting on each of these?" — the engine behind both bands.
 *
 * The walk is generic on purpose: only the candidate set says which question is
 * being asked. Ordering is what it blocks, not which goal it sits under:
 * enforced edges first, then by how many tasks are waiting, then oldest.
 */
function dependentsRows(tasks: HubTask[], candidates: HubTask[]): DecisionRow[] {
  if (candidates.length === 0) return [];
  const byId = new Map(
    candidates.map((d) => [d.id, { task: d, blocks: [] as HubTask[], hard: false }]),
  );
  for (const t of tasks) {
    // Finished work waits on nothing, and a task can't block on itself.
    if (t.status === 'done') continue;
    const seen = new Set<string>();
    for (const id of t.after) {
      if (id === t.id || seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (!row) continue;
      row.blocks.push(t);
      if (t.afterEnforce?.includes(id)) row.hard = true;
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      b.blocks.length - a.blocks.length ||
      a.task.createdAt - b.task.createdAt ||
      a.task.id.localeCompare(b.task.id),
  );
}

/** A task and the open work waiting on it. Same shape as a decision's row
 *  because it is the same computation — but it feeds the task PANEL's blocked
 *  note now, not a queue band. */
export type BlockerRow = DecisionRow;

/**
 * Open, human-owned tasks that other open work names in `after`.
 *
 * The board's six real dependency edges pointed at none of its decisions —
 * they pointed at a person's own tasks (turn on the tunnel, merge the PR), and
 * no surface said so. **Where this surfaces moved (approved design,
 * review-flow-mock-v1): a blocker is task STATE, not a review item.** There is
 * nothing to answer on it — the only move is to go and do the work — so it
 * renders as the amber note on its own task's detail panel, and `reviewQueue`
 * deliberately does not read these rows any more. Two rules are still
 * load-bearing:
 *
 * - **Nothing waiting means not here.** A task nobody is waiting on is just a
 *   task; a note on every human-owned ticket would mean nothing.
 * - **A decision is not a blocker.** A decision already surfaces as itself,
 *   with an answer path; stamping it blocked too would say one thing twice.
 *
 * Ownership is the server-resolved `ownerKind`, so a task handed to a person
 * by NAME is in this band and one held by a named agent is not. That closes a
 * limit this band shipped with — the literal `human` — without reaching for
 * either tempting name comparison. Matching the VIEWER's name was rejected
 * because the strip is one shared read of the workspace and keying it on the
 * reader would make the count at the top differ per reader; matching a list of
 * known people was rejected because a reader whose display name happens to be
 * an agent's would sweep every agent-owned blocker in, which is the inflation
 * this band's other rules exist to prevent. An owner nobody has declared
 * resolves to `unknown` and stays OUT — the direction that keeps the strip
 * short, and the one that a wrong guess costs least.
 */
export function humanBlockerRows(tasks: HubTask[]): BlockerRow[] {
  const candidates = tasks.filter(
    (t) => ownedByPerson(t) && t.status !== 'done' && t.needs !== 'decision',
  );
  return dependentsRows(tasks, candidates).filter((r) => r.blocks.length > 0);
}

// ── The review queue: everything waiting on a person, in one list ──────────

/**
 * One thread-shaped item, exactly as `GET /api/workspaces/:id/review-items`
 * ships it. The server owns this half because "is this comment an agent's" is
 * `classifyActor`'s judgement and must not be re-decided in the browser.
 */
export interface ReviewThreadItem {
  /**
   * `task-review` is a row hanging on a TICKET rather than on a comment — the
   * server ships it on the same route, in the same band, and `reviewQueue`
   * places it like any other declared ask. It carries `taskId` +
   * `reviewItemId` instead of `docId`/`threadId` (those are absent on the
   * wire despite the field types below — the shape predates the kind), and an
   * answer posts to the task review-item route rather than a thread. This
   * model SKIPPED the kind until 2026-08-24, which was the measured defect:
   * review items filed via `create_tasks` / `add_review_item` were shipped by
   * the route and rendered by nothing, so a decision addressed to a person
   * never reached their Home queue.
   */
  /**
   * `goal-thread` is a question asked on a GOAL's discussion. Its own kind
   * rather than a `task-thread` carrying a goal id, because the two open
   * different panels — and `taskId` on one of these holds the GOAL's id, which
   * resolves to no task at all.
   */
  kind: 'task-thread' | 'goal-thread' | 'doc-thread' | 'task-review';
  /** Which row on the ticket, on a `task-review` item — an answer is stamped
   *  back at this id. */
  reviewItemId?: string;
  /**
   * How this row earned its place. Since 2026-08-21 membership is the
   * SERVER's call and every shipped row is an ask: `declared` — an agent
   * said in so many words that it is asking for something, by putting a
   * `review` payload on its comment; `unreplied` — the inferred half, which
   * now fires only on a direct question to a named person that nobody has
   * answered (the old any-agent-comment rule accumulated one permanent row
   * per thing the agents got right, which is what this feature removed).
   *
   * Absent on a payload from a server older than the field. The row is still
   * placed — the server shipped it, so hiding it here would be the
   * vanishing-row bug — it just never renders as a declared card.
   */
  band?: 'declared' | 'unreplied';
  /** The declaration itself, on a `declared` item. */
  review?: ReviewPayload;
  /** Which comment carries the declaration — the answer is written against
   *  it, so a thread with several declarations answers the right one. */
  commentId?: string;
  docId: string;
  threadId: string;
  taskId?: string;
  title: string;
  ask: string;
  askedBy: string;
  since: number;
  /** The run contains a question addressed to a person by name. Ranks the item
   *  to the top of its band and changes the line the row reads. Absent on a
   *  payload from a server older than this field, which reads as false — the
   *  pre-existing ordering, which is the safe direction. */
  direct?: boolean;
  /** When the question was asked, when there is one. Absent from an older
   *  server's payload, in which case the row falls back to `since` — the
   *  pre-existing wording. */
  askedAt?: number;
  /**
   * On a `task-review` row: `open`, or `revised` — the owner changed the
   * item's words after the reader asked on a phrase of it (2026-08-29). A
   * `waiting` item — asked on, not yet revised — is exactly what the route
   * omits, since it is the owner's turn. Absent from an older server.
   */
  state?: 'open' | 'revised';
  /**
   * On a revised row: when, what the reader had asked (the anchored thread's
   *  first comment), and which span of the NEW detail changed. `threadId`
   *  above names the thread that asked.
   *
   * Carried by a DECLARED THREAD row as well as a `task-review` one — a
   * review item raised on a doc thread became correctable in place, and it
   * keeps its superseded wording on the payload rather than on a wrapper. The
   * two fields mean the same thing on both, which is why they are one shape
   * here. `question` stays task-only: a doc-thread item's conversation is the
   * thread the row already points at.
   */
  revisedAt?: number;
  question?: string;
  revisedRange?: { start: number; end: number };
}

/**
 * "The request did not complete" is not "there is nothing here."
 *
 * The board's REST-backed regions refresh on a timer and on SSE nudges, and
 * `fetchJson` answers null for every failure — a dead socket, a 502, a server
 * mid-restart. Reading that as an empty payload made the board blank its own
 * review strip during a deploy: everything waiting on the reader became
 * nothing, which is the falling-over reading the reconnect banner exists to
 * prevent, arriving through a different door.
 *
 * The guard keys strictly on whether the payload arrived. An empty LIST is a
 * real answer — a workspace whose last thread was resolved must still be
 * allowed to say so — so only `null` holds the previous value.
 */
export function applyRefresh<R, V>(current: V, res: R | null, read: (r: R) => V): V {
  if (res === null) return current;
  return read(res);
}

/**
 * The review strip's refresh, kept here rather than inline in hub-app so the
 * survives-an-outage behaviour is driven by a test instead of asserted about.
 */
export async function refreshReviewItems(
  state: { reviewItems: ReviewThreadItem[] },
  fetchItems: () => Promise<{ items?: ReviewThreadItem[] } | null>,
): Promise<void> {
  const res = await fetchItems();
  state.reviewItems = applyRefresh(state.reviewItems, res, (r) => r.items ?? []);
}

export type ReviewKind = 'decision' | 'task-thread' | 'goal-thread' | 'doc-thread' | 'task-review';

/**
 * The id the store gives the review item it DERIVES from a legacy
 * `needs: 'decision'` task — the same string on every legacy ticket, by
 * design (server: `LEGACY_REVIEW_ITEM_ID` in tasks.ts). The queue skips a
 * `task-review` row carrying it, because that decision already arrives as a
 * `decision` row read off the board projection; admitting the derived copy
 * would list one question twice.
 */
export const LEGACY_REVIEW_ITEM_ID = 'r-legacy';

export interface ReviewItem {
  /** Stable across re-fetches. The walkthrough steps by position and the list
   *  reorders underneath it, so identity cannot be the index. */
  key: string;
  kind: ReviewKind;
  /** What this is ABOUT — the decision, the task, the doc. */
  title: string;
  /** The ask itself, one line. Empty for a decision whose body is the ask. */
  ask: string;
  /**
   * Why it sits where it does; the row's DERIVED second line.
   *
   * Not the payload's — that field is gone (2026-08-25). This has always been
   * the queue's own sentence: a decision's blocking line, or the provenance
   * of the comment that raised it. A declared row used to substitute the
   * author's `why` here; it now takes the same provenance line every other
   * thread row gets, and the author's words are read where they were written,
   * in the card's one body.
   */
  why: string;
  since: number;
  /** Set on a decision — the row the answer form and the blocks line need. */
  decision?: DecisionRow;
  /** Set on either thread kind — where the reply gets written. */
  thread?: ReviewThreadItem;
  /** Set when an agent DECLARED this as a review item. Presence decides how
   *  the row RENDERS (the authored card vs the derived line) — never whether
   *  it is in the queue, which is the server's membership call. */
  review?: ReviewPayload;
  /**
   * The owner revised this item's words in answer to a question the reader
   * asked on a phrase of it. The row comes back marked Revised, quoting the
   * question, with the changed span highlighted and a way to the thread.
   * Read off the server row; never set client-side.
   */
  revision?: ReviewRevisionNote;
}

export interface ReviewRevisionNote {
  at: number;
  /** The reader's question, as the anchored thread's first comment. */
  question?: string;
  threadId?: string;
  /** The span of the CURRENT `review.detail` that changed, when known. */
  range?: { start: number; end: number };
}

/** A declared item's headline is authored to fit and validated at the API, so
 *  it is shown as written. Everything else is somebody's paragraph and gets
 *  the derived heading — which CLIPS, and clipping an authored headline is
 *  exactly the unreadable row this feature removes. */
export function reviewCardHeadline(item: ReviewItem): string {
  return item.review ? item.review.headline : reviewHeadline(reviewRowTitle(item));
}

/** The task-and-dependents row an item carries, when it carries one. Kept as
 *  the one reader for "which task is this row about" so a future band with a
 *  row lands here rather than in a second spelling of the same question. */
export function reviewRow(item: ReviewItem): DecisionRow | undefined {
  return item.decision;
}

export interface ReviewQueue {
  /**
   * Every row, in the one order. There used to be an `unreplied` shelf
   * beside this for rows the inferred rule produced — kept out of the count
   * and the walkthrough because that rule fired on every agent comment,
   * including exactly what a finished exchange looks like. The server stopped
   * shipping those on 2026-08-21 (a thread row is now a declared item or a
   * surviving direct ask, nothing else), which left the shelf holding real
   * questions that NOTHING rendered — a computed ask invisible on Home. So
   * the shelf is retired: a row the server ships is placed here or it does
   * not exist anywhere, and "every row names something waiting on a person"
   * is the server's promise, not one the client re-derives.
   */
  items: ReviewItem[];
  total: number;
  /** How many are holding other work up right now: decisions with dependents,
   *  and nothing else. Not threads — a comment blocks nothing structurally.
   *  Not human-owned blockers either — those are task state (the panel's
   *  blocked note), not items in this queue, so counting them would promise
   *  the reader something to clear from here that is not here. */
  blocking: number;
}

/**
 * Where one ask sits in the queue. Compared field by field, in this order.
 *
 * A record rather than a tuple so each key can be named at the point it is
 * built — a five-element array of numbers is unreadable at the call site and
 * silently wrong if anyone inserts a key in the middle.
 */
interface AskRank {
  /** 0 = this ask is about a task on the board, so it has a priority to rank
   *  by. 1 = it does not, and sorts after everything that does. */
  placed: 0 | 1;
  /** The task's goal band, then its position inside it — the board's own
   *  order, so the queue and the board agree about what is important. */
  goal: number;
  order: number;
  createdAt: number;
  taskId: string;
  /** Among asks about ONE task (or among the ones with no task at all): the
   *  decision row, then that task's discussion, then a doc
   *  comment. */
  band: number;
  /** 0 = a question addressed to a person by name. Only ever a tiebreak. */
  direct: 0 | 1;
  since: number;
  tie: string;
}

const BAND_TASK_ROW = 0;
const BAND_TASK_THREAD = 1;
const BAND_DOC_THREAD = 2;

function compareAsk(a: AskRank, b: AskRank): number {
  return (
    a.placed - b.placed ||
    a.goal - b.goal ||
    a.order - b.order ||
    a.createdAt - b.createdAt ||
    a.taskId.localeCompare(b.taskId) ||
    a.band - b.band ||
    a.direct - b.direct ||
    a.since - b.since ||
    a.tie.localeCompare(b.tie)
  );
}

/**
 * Everything waiting on a person, in ONE priority order.
 *
 * Bryan's question on coming back to the board is "what do I look at next",
 * and until this existed the board could only answer it for open decisions.
 * The other two kinds were in the store and unreachable from the surface —
 * the failure this codebase has been bitten by before, and the one that
 * presents as the worst possible bug because nothing is actually lost.
 *
 * **Task priority is the primary key** (Bryan, 2026-08-18, answering
 * on the ask-ordering ticket: *"Always order asks by task priority"*). That question was
 * filed precisely because two sort keys disagreed with no stated tiebreak —
 * a P1 asked five hours ago against a P3 that has waited two days — and the
 * standing lean was the opposite, waiting time first inside a priority band.
 * His answer settles it the other way, so priority is the band and the wait
 * is the tiebreak inside it.
 *
 * Priority means the BOARD's order and nothing invented here: goal band
 * first, then the task's own position in it (`goalRank` + `byBoardOrder`).
 * There is deliberately no priority FIELD to set — the board's order already
 * is the priority, so a second one would immediately disagree with the list
 * Bryan drags rows around in.
 *
 * Three consequences worth stating, because each replaces a rule this
 * function used to apply as a primary key:
 *
 *  - **Kind is no longer a band.** A decision and a comment about
 *    the same task now sit together, in that order; asks about a
 *    higher-priority task all come first. Previously every decision on the
 *    board outranked every comment regardless of what either was about.
 *  - **Oldest-first survives only as a tiebreak.** It still orders the
 *    comments on one task, which is where the starvation it protects against
 *    actually happens (an agent's follow-ups burying its own question — see
 *    `since` in review-queue.ts). Across tasks it would contradict the
 *    instruction, so it does not apply there.
 *  - **`direct` likewise.** A question still outranks a status note, but only
 *    among asks of equal task priority.
 *
 * An ask with no task priority — a doc comment, or a task discussion whose
 * task is not in `tasks` — sorts after every ask that has one, keeping the
 * question-first, then oldest-first rule among themselves. That is not a
 * shelf: a doc read still rides in the one queue and the one walkthrough
 * (Bryan, same answer: *"it's okay to mix in 15-30 minute doc reads with
 * quick decisions"*). It is simply the only defined place for an item the
 * primary key cannot speak about.
 *
 * `goals` is optional so a caller that has no goal list still gets a total
 * order — every task then lands in one band and ranks by board order alone,
 * which is a degraded ordering rather than a wrong one.
 */
/**
 * This task's rows, as the DETAIL PANEL is allowed to use them.
 *
 * Rows are matched by `taskId` — a doc-thread row has none and correctly
 * never matches. A TICKET-borne row (`task-review`) passes the same door
 * `reviewQueue` holds for the Home queue: it needs the two ids its answer
 * posts to and the payload the card renders, and the DERIVED legacy row
 * (`r-legacy`) stays out because the task's own `needs: 'decision'` already
 * renders that question as the panel's first card — admitting the copy would
 * put a second set of option buttons under the live ones.
 *
 * This held the kind back wholesale until 2026-08-29, from when the panel
 * answered every card by commenting on `item.threadId` — a ticket-borne row
 * has none, so its buttons would have filed a stray comment and recorded
 * nothing. The Home queue admitted the kind on 2026-08-24, and opening one
 * of its rows lands HERE; the panel then showed no card at all, which a
 * fresh-eyes pass found as "`add_review_item` is a silent no-op". The panel
 * now answers the kind at `POST /api/tasks/:id/review-items/:rid/answer`
 * (`panelAnswerRequest` in hub-render), so the door is the same as Home's.
 *
 * A function rather than an inline filter in the app so the rule has one home
 * and a test can hold it — the two guards being separate is exactly how one
 * of them was updated and the other forgotten.
 */
export function panelAsks(items: ReviewThreadItem[], taskId: string): ReviewThreadItem[] {
  return items.filter((i) => {
    if (i.taskId !== taskId) return false;
    if (i.kind !== 'task-review') return true;
    return (
      i.reviewItemId !== undefined &&
      i.reviewItemId !== LEGACY_REVIEW_ITEM_ID &&
      i.review !== undefined
    );
  });
}

export function reviewQueue(
  tasks: HubTask[],
  threadItems: ReviewThreadItem[],
  now: number,
  goals: HubGoal[] = [],
): ReviewQueue {
  const rankGoal = goalRank(goals);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  /** The rank an ask inherits from the task it is about, or the tail. */
  const rankOf = (
    task: HubTask | undefined,
    band: number,
    direct: boolean,
    since: number,
    tie: string,
  ): AskRank =>
    task
      ? {
          placed: 0,
          goal: rankGoal(task.goal),
          order: task.order,
          createdAt: task.createdAt,
          taskId: task.id,
          band,
          direct: direct ? 0 : 1,
          since,
          tie,
        }
      : {
          placed: 1,
          goal: 0,
          order: 0,
          createdAt: 0,
          taskId: '',
          band,
          direct: direct ? 0 : 1,
          since,
          tie,
        };

  const ranked: Array<{ item: ReviewItem; rank: AskRank }> = [];

  // The decision band's own ordering (enforced edges, then how much is
  // waiting, then age) is no longer the queue's — `decisionQueue` still owns
  // it for the board's own strip, and this only borrows its ROWS.
  const decisions = decisionQueue(tasks);
  for (const row of decisions.rows) {
    ranked.push({
      item: {
        key: `decision:${row.task.id}`,
        kind: 'decision',
        title: row.task.title,
        ask: '',
        why: row.blocks.length === 0 ? 'Nothing is waiting on this yet' : blockingLine(row),
        since: row.task.createdAt,
        decision: row,
        // Marked Revised exactly as a ticket-borne item is, off the same
        // server derivation — so a decision the reader asked on comes back
        // saying so, quoting their question, rather than as a fresh ask.
        ...(row.task.decisionRevision
          ? {
              revision: {
                at: row.task.decisionRevision.at,
                ...(row.task.decisionRevision.question !== undefined
                  ? { question: row.task.decisionRevision.question }
                  : {}),
                ...(row.task.decisionRevision.threadId !== undefined
                  ? { threadId: row.task.decisionRevision.threadId }
                  : {}),
                ...(row.task.decisionRevision.range
                  ? { range: row.task.decisionRevision.range }
                  : {}),
              },
            }
          : {}),
      },
      rank: rankOf(row.task, BAND_TASK_ROW, false, row.task.createdAt, row.task.id),
    });
  }

  // A person's own open task that other work waits on is deliberately NOT
  // enqueued (design point 5). It was never a question — there is nothing to
  // answer, only work to do — so it surfaces as state on its own task: the
  // detail panel's blocked note, built from the same `humanBlockerRows`.

  for (const t of threadItems) {
    // TICKET-borne review items place like any other declared ask — this loop
    // skipped the kind wholesale until 2026-08-24, which was the measured
    // defect: an ask filed with `create_tasks`/`add_review_item` was shipped
    // by the route and rendered by nothing, whatever the carrying task's
    // status. Two rows are still refused, each for its own reason: the
    // DERIVED legacy row (`r-legacy`) whose decision already arrives as a
    // `decision` row from the board above — admitting the copy lists one
    // question twice — and a row missing the ids its answer path posts to,
    // because a card whose Answer button writes nowhere is worse than none.
    if (t.kind === 'task-review') {
      if (
        !t.taskId ||
        !t.reviewItemId ||
        t.reviewItemId === LEGACY_REVIEW_ITEM_ID ||
        t.review === undefined
      )
        continue;
      ranked.push({
        item: {
          key: `task-review:${t.taskId}:${t.reviewItemId}`,
          kind: 'task-review',
          title: t.title,
          ask: t.ask,
          review: t.review,
          // Nothing derives a second line for a ticket-borne item: it has no
          // comment to quote the provenance of, and the row renders title +
          // askedMeta regardless. Empty rather than invented.
          why: '',
          since: t.since,
          thread: t,
          ...(t.state === 'revised'
            ? {
                revision: {
                  at: t.revisedAt ?? t.since,
                  ...(t.question !== undefined ? { question: t.question } : {}),
                  ...(t.threadId !== undefined ? { threadId: t.threadId } : {}),
                  ...(t.revisedRange ? { range: t.revisedRange } : {}),
                },
              }
            : {}),
        },
        // Ranks with the task-thread band: it is a question about the WORK,
        // and it inherits the task's own priority when the board read holds
        // the task. A triage row's item may not — it then takes the tail
        // rank rather than vanishing, because the ask is an ask whatever the
        // row's vetting status is.
        rank: rankOf(
          taskById.get(t.taskId),
          BAND_TASK_THREAD,
          true,
          t.since,
          `${t.taskId}:${t.reviewItemId}`,
        ),
      });
      continue;
    }
    // A row of a kind this queue does not place is SKIPPED, not half-built.
    if (t.kind !== 'task-thread' && t.kind !== 'goal-thread' && t.kind !== 'doc-thread') continue;
    const where =
      t.kind === 'task-thread'
        ? 'on this task'
        : t.kind === 'goal-thread'
          ? 'on this goal'
          : 'on this doc';
    const declared = t.band === 'declared' && t.review !== undefined;
    const entry = {
      item: {
        key: `${t.kind}:${t.docId}:${t.threadId}`,
        kind: t.kind,
        title: t.title,
        ask: t.ask,
        ...(declared ? { review: t.review } : {}),
        // "asked" is a claim about there being a question. Say it only when
        // there is one; otherwise the row promises an answerable thing and
        // delivers a status note, which is how a strip stops being believed.
        // The clock beside "asked" has to be the QUESTION's, not the run's.
        // The run can start days before the ask — status, status, then a
        // question — and quoting the run's start there tells the reader they
        // have been sitting on something they were handed minutes ago.
        // The derived provenance line, for declared and inferred rows alike.
        // A declared row used to substitute its author's `why` here; that
        // field is gone, and its words are in the card's one body, which is
        // where a reader opening the row reads them.
        why: t.direct
          ? `${t.askedBy} asked you ${timeAgo(t.askedAt ?? t.since, now)} · ${where}`
          : `${t.askedBy} posted ${timeAgo(t.since, now)} · ${where}`,
        since: t.since,
        thread: t,
        // Marked Revised, exactly as a ticket-borne item is. Without this the
        // corrected row is indistinguishable from a fresh ask, which is the
        // confusion the correction verb exists to remove — a reader who
        // cannot tell which of two rows they already answered has been helped
        // by nothing.
        ...(t.revisedAt !== undefined
          ? {
              revision: {
                at: t.revisedAt,
                ...(t.revisedRange ? { range: t.revisedRange } : {}),
              },
            }
          : {}),
      },
      rank: rankOf(
        t.kind === 'task-thread' && t.taskId ? taskById.get(t.taskId) : undefined,
        // A goal's question ranks with a task's rather than with a doc's: it
        // is a question about the WORK, asked by somebody who wants to act on
        // the answer, which is the distinction the two bands draw.
        t.kind === 'doc-thread' ? BAND_DOC_THREAD : BAND_TASK_THREAD,
        t.direct ?? false,
        t.since,
        t.threadId,
      ),
    };
    // Placed regardless of band. Declaring changes what the row LOOKS like
    // (the authored card above vs the derived line), never whether it exists:
    // membership was decided by the server when it shipped the row, and a
    // client-side second opinion is where the shelf full of invisible
    // questions came from.
    ranked.push(entry);
  }

  ranked.sort((a, b) => compareAsk(a.rank, b.rank));
  const items = ranked.map((r) => r.item);

  // Only decisions with dependents count as blocking. A thread blocks nothing
  // structurally, and a human-owned blocker is no longer IN this queue — a
  // count that included it would promise something to clear from here that
  // the list below does not hold.
  return {
    items,
    total: items.length,
    blocking: decisions.blocking,
  };
}

/**
 * Where an item's answer gets WRITTEN — path and body, minus the author the
 * caller adds. One spelling for all three doors, because the walkthrough's
 * reply handler used to build its two thread routes inline: a ticket-borne
 * row reaching it would have posted at `/api/docs/undefined/…` — an answer
 * that lands nowhere while the card advances, which is the one failure the
 * answer flow cannot afford.
 *
 * - `task-review` → the task review-item answer route. `answeredWith` is that
 *   entity's spelling of the tapped candidate's id.
 * - a declared thread item → the thread `/answer` route, which posts the same
 *   reply AND records which candidate it came from on the declaring comment.
 * - anything else → a plain thread comment.
 *
 * Null when the row holds no address to write to; the caller keeps the words
 * in the box rather than sending them nowhere.
 */
export function reviewReplyRequest(
  item: ReviewItem,
  text: string,
  optionId?: string,
): { path: string; body: Record<string, unknown> } | null {
  const t = item.thread;
  if (!t) return null;
  if (t.kind === 'task-review') {
    if (!t.taskId || !t.reviewItemId) return null;
    return {
      path: `/api/tasks/${encodeURIComponent(t.taskId)}/review-items/${encodeURIComponent(t.reviewItemId)}/answer`,
      body: { text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
    };
  }
  if (!t.docId || !t.threadId) return null;
  const doc = encodeURIComponent(t.docId);
  const thread = encodeURIComponent(t.threadId);
  const declared = item.review !== undefined && t.commentId !== undefined;
  return declared
    ? {
        path: `/api/docs/${doc}/threads/${thread}/answer`,
        body: {
          text,
          commentId: t.commentId,
          ...(optionId !== undefined ? { optionId } : {}),
        },
      }
    : { path: `/api/docs/${doc}/threads/${thread}/comments`, body: { text } };
}

/**
 * What a question asked ON a review item anchors to: the item, on its task's
 * doc. A TICKET-borne item has one, and so does a ticket's OWN decision — it
 * anchors as the derived `r-legacy` row, which the server admits since
 * 2026-08-31 (before that a `needs: 'decision'` card was the one card with
 * no way to ask). A thread-borne declaration's words live in a comment, and
 * its thread is where a question goes. Null means "no link on this card".
 */
export function reviewItemAnchorTarget(
  item: ReviewItem,
): { docId: string; taskId: string; reviewItemId: string } | null {
  if (item.decision) {
    const taskId = item.decision.task.id;
    return { docId: `task:${taskId}`, taskId, reviewItemId: LEGACY_REVIEW_ITEM_ID };
  }
  const t = item.thread;
  if (!t || t.kind !== 'task-review' || !t.taskId || !t.reviewItemId) return null;
  if (t.reviewItemId === LEGACY_REVIEW_ITEM_ID) return null;
  return { docId: `task:${t.taskId}`, taskId: t.taskId, reviewItemId: t.reviewItemId };
}

/** Who a question on this item goes to — the item's asker, or for a
 *  ticket's own decision the ticket's filer — named in the box's hint and
 *  the toast. Undefined when nothing recorded one. */
export function reviewItemOwner(item: ReviewItem): string | undefined {
  const who = item.thread?.askedBy?.trim();
  if (who) return who;
  return item.decision ? decisionAskedBy(item.decision.task) : undefined;
}

/**
 * Where a question on an item gets WRITTEN: a thread on the task's doc with
 * a `review-item` anchor. Snippet only, no offsets — the card renders the
 * detail as HTML, and the server locates the phrase in the markdown source
 * itself (uniquely, or it stores the words alone). ONE spelling for the two
 * surfaces that ask (the walkthrough card and the task panel's card) and the
 * two ways of asking (on a phrase, or on the whole item); the author is the
 * caller's to add. This route — not `…/review-items/:rid/more-info` — is
 * what takes the item off the reader's queue: the server records the
 * question WITH the thread it made, and `reviewItemState` reads only a
 * threaded question as "waiting on the owner"; the more-info route is the
 * agent-side "tell me more" that deliberately leaves the item on the queue.
 */
export function reviewItemThreadRequest(
  target: { taskId: string; reviewItemId: string },
  phrase: string,
  question: string,
): { path: string; body: Record<string, unknown> } {
  return {
    path: `/api/docs/${encodeURIComponent(`task:${target.taskId}`)}/threads`,
    body: {
      text: question,
      anchor: { kind: 'review-item', reviewItemId: target.reviewItemId, snippet: { text: phrase } },
    },
  };
}

/** The request for a question asked ON A PHRASE of a queue item — the
 *  selection pill's flow. Null for an item with nothing to anchor to. */
export function reviewItemAskRequest(
  item: ReviewItem,
  phrase: string,
  question: string,
): { path: string; body: Record<string, unknown> } | null {
  const target = reviewItemAnchorTarget(item);
  if (!target) return null;
  return reviewItemThreadRequest(target, phrase, question);
}

/**
 * The phrase a question about the WHOLE item is anchored to: its headline.
 *
 * "I have a question" needs no selection, but the thread it makes still
 * needs a snippet to quote — and the headline is what the item is, in its
 * author's words. Same shape the server itself uses when it converts a
 * question typed into the answer box (`answerAsksBack`): the anchor quotes
 * the headline, offsets only if those words happen to sit uniquely in the
 * detail, so the two ways of asking about the whole item land identically.
 */
export function wholeItemPhrase(item: ReviewItem): string {
  // A ticket's own decision has no payload here; its headline IS the title
  // (`reviewFromDecisionTask`), and the title is what the server quotes.
  return item.review?.headline ?? item.decision?.task.title ?? item.ask;
}

/** The request for a question about the item AS A WHOLE — the card's
 *  "I have a question" link. Null for an item with nothing to anchor to. */
export function reviewItemQuestionRequest(
  item: ReviewItem,
  question: string,
): { path: string; body: Record<string, unknown> } | null {
  return reviewItemAskRequest(item, wholeItemPhrase(item), question);
}

/** The words of the current detail that a revision changed, when the range
 *  is known and still spells something. Undefined otherwise — the card then
 *  quotes the question without a mark rather than marking the wrong words. */
export function revisedPhrase(item: ReviewItem): string | undefined {
  const range = item.revision?.range;
  const detail = item.review?.detail;
  if (!range || detail === undefined) return undefined;
  const phrase = detail.slice(range.start, range.end);
  return phrase.trim() === '' ? undefined : phrase;
}

/** "Blocking 2 tasks" / "Hard-blocking 1 task". One phrasing everywhere a
 *  dependent count is spoken. */
function blockingLine(row: DecisionRow): string {
  const n = row.blocks.length;
  return `${row.hard ? 'Hard-blocking' : 'Blocking'} ${n === 1 ? '1 task' : `${n} tasks`}`;
}

/**
 * The task panel's blocked note, in words: the count phrase the decision rows
 * already use, then the NAMES of the open work standing behind this task.
 * The note is read ON the task, where a bare "2 tasks" answers nothing — the
 * reader's next question is always "which ones".
 */
export function blockedNoteLine(row: BlockerRow): string {
  return `${blockingLine(row)}: ${row.blocks.map((t) => t.title).join(', ')}`;
}

// ── Where the walkthrough is standing ──────────────────────────────────────

/**
 * The walkthrough aimed at nothing — what "closed" is spelled as.
 *
 * `walkPosition` answers -1 for this pair whatever the queue holds, and -1 is
 * what puts the Home page back on screen. It is a named constant because two
 * places close the walkthrough for two different reasons — the card's own
 * close button, and arriving at Home from the nav — and a second hand-written
 * spelling is how one of them ends up leaving half the aim behind.
 */
export const CLOSED_WALK = { index: -1, key: null } as const;

/** Where the walkthrough is aimed: the two fields that survive a render. */
export interface WalkAim {
  index: number;
  key: string | null;
}

/**
 * Where the walkthrough should be aimed after opening one of its items.
 *
 * Opening closes the walk in state BEFORE the opener runs, so that the close
 * and the open reach the URL writer as a single step — rendering the close
 * first wrote a `close` step whose `history.back()` landed after the open's
 * `pushState`, and the reader bounced back to Home.
 *
 * That is right only while the reader stays on this page. A doc item leaves
 * via `location.assign`, so nothing renders and the close buys nothing — but
 * the closed state is what bfcache freezes, and on the way back the restored
 * page normalises `?item=` out of a URL the browser had restored correctly.
 * So an open that leaves keeps the aim: the snapshot is of a reader who is
 * mid-sitting, because they are.
 */
export function walkAimAfterOpen(aim: WalkAim, stillOnPage: boolean): WalkAim {
  if (!stillOnPage) return aim;
  return { index: CLOSED_WALK.index, key: CLOSED_WALK.key };
}

/**
 * The position the walkthrough should render, given where it was AIMED.
 *
 * The queue is re-derived on every render and shrinks underneath the reader —
 * their own answer removes an item, and so does a peer's. A bare index is
 * therefore not a position: when anything BEFORE it drops out, the same index
 * silently lands one item further on, and the reader never sees the one that
 * was skipped. So the aim is a `ReviewItem.key`, and the index is only the
 * fallback for the two cases a key cannot express — the aimed item is gone,
 * and the walk has run off the end into the done state.
 *
 * A negative index means closed, and stays closed: resolving it against the
 * queue would reopen the panel on every repaint.
 */
export function walkPosition(queue: ReviewQueue, index: number, key: string | null): number {
  if (index < 0) return -1;
  if (key) {
    const at = queue.items.findIndex((i) => i.key === key);
    if (at !== -1) return at;
  }
  return Math.min(Math.max(index, 0), queue.items.length);
}

/**
 * Where to stand after the item at `index` was answered or replied to.
 *
 * Answering usually takes the item OUT of the queue, so `index + 1` steps over
 * whatever slid into its place — the classic off-by-one of a list that edits
 * itself. Aim instead at the item that was NEXT when the answer was submitted,
 * by identity.
 *
 * Two fallbacks, both real: the answered item can still be in the queue when
 * the write lands (a decision's answer arrives back through the ydoc
 * projection, not in the POST's response), in which case stepping past it is
 * right; and the next item can be gone too, when a peer answered it while this
 * one was being written — then the gap left behind is as good a place as any.
 */
export function advanceWalk(
  queue: ReviewQueue,
  index: number,
  finishedKey: string,
  nextKey: string | null,
): number {
  if (nextKey) {
    const at = queue.items.findIndex((i) => i.key === nextKey);
    if (at !== -1) return at;
  }
  const still = queue.items.findIndex((i) => i.key === finishedKey);
  if (still !== -1) return still + 1;
  return Math.min(Math.max(index, 0), queue.items.length);
}

// ── Landing-page walk handoff ──────────────────────────────────────────────

/**
 * What the landing page's review chip and "Review all" bar hand this app:
 * `?walk=1` means open the walkthrough as soon as the queue is loaded, and
 * `&then=<id,id>` names the workspaces still holding items, to visit after
 * this board's queue drains. Server side of the contract: the landing
 * renderer in `packages/server/src/server.ts`.
 */
export interface WalkHandoff {
  walk: boolean;
  /** The remaining workspaces to visit, in order. Rides in the URL as
   *  `then=` but is named `chain` here — an object with a `then` property
   *  is a thenable, and `await` would try to call it. */
  chain: string[];
}

export function walkHandoff(search: string): WalkHandoff {
  const params = new URLSearchParams(search);
  const walk = params.get('walk') === '1';
  const chain = (params.get('then') ?? '')
    .split(',')
    .map((id) => decodeURIComponent(id).trim())
    .filter(Boolean);
  return { walk, chain: walk ? chain : [] };
}

/**
 * Which halves of the queue have landed since boot. The queue is built from
 * two sources that arrive separately on a cold load: the REST review-items
 * list (threads and ticket asks) and the ydoc task projection (decisions,
 * and the tasks every thread ranks against).
 */
export interface WalkSources {
  reviewItems: boolean;
  projection: boolean;
}

/**
 * Whether an armed `?walk=1` handoff may open the walkthrough NOW.
 *
 * The walk aims by item key, chosen from the queue as it stands when the walk
 * opens. Opening on the first non-empty queue — as this did until 2026-08-29
 * — opened on a HALF queue: review items alone have no tasks to rank against,
 * so every one takes the tail rank ordered by age, and the walk pinned the
 * oldest ask. When the projection landed, the key rightly followed that ask
 * to its real rank, which is the bottom — "Review all" opened on N of N.
 *
 * So: both sources, then open at the head. An empty queue is never ready
 * (the flag stays armed for the half still coming), and the deadline opens
 * on whatever has landed — a board with items in hand must not hop the
 * chain as though it were clear.
 */
export function walkHandoffReady(
  queue: ReviewQueue,
  sources: WalkSources,
  deadlinePassed = false,
): boolean {
  if (queue.items.length === 0) return false;
  return deadlinePassed || (sources.reviewItems && sources.projection);
}

/** The next hop of the chain, or null when there is nowhere left to go. */
export function walkNextUrl(chain: string[]): string | null {
  const [next, ...rest] = chain;
  if (!next) return null;
  const tail = rest.length ? `&then=${rest.map(encodeURIComponent).join(',')}` : '';
  return `/workspaces/${encodeURIComponent(next)}/home?walk=1${tail}`;
}

/** The mockup's row title is the QUESTION itself — the ask when the item
 *  carries one, the subject when the subject IS the question (a decision). */
export function reviewRowTitle(item: Pick<ReviewItem, 'title' | 'ask'>): string {
  return item.ask.trim() !== '' ? item.ask : item.title;
}

/** How long a card heading may run before it stops being a heading. */
const HEADLINE_MAX = 90;

/**
 * The heading form of a review item's question.
 *
 * The mockup's card carries a SHORT title and, below it, the ask in full. Our
 * threads have no short title — a thread's question is whatever somebody
 * typed, which is regularly a paragraph — so the heading is derived: the first
 * sentence, capped. A decision's title is already short and comes back
 * unchanged.
 *
 * The point is the pair. Print the paragraph as the heading AND again in the
 * quote below it and the card says everything twice, which is the "layout is
 * weird" half of what got the last build rejected.
 */
export function reviewHeadline(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  // First sentence: a terminator followed by a space or the end. `\S` before
  // it keeps "e.g. " and a bare "?" from ending a sentence that hasn't begun.
  const end = flat.match(/\S[.?!](?=\s|$)/);
  const first = end?.index === undefined ? flat : flat.slice(0, end.index + 2);
  if (first.length <= HEADLINE_MAX) return first;
  const cut = first.slice(0, HEADLINE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The card's kind badge (mockup: the amber `Decision` and the blue
 * `Needs your reply`). A blocker has no entry because a blocker has no card —
 * it is task state, not a review item (design point 5).
 */
export function reviewBadge(kind: ReviewKind): { label: string; tone: string } {
  if (kind === 'decision') return { label: 'Decision', tone: 'decision' };
  return { label: 'Needs your reply', tone: 'reply' };
}

/**
 * The badge for a queue item, declaration included.
 *
 * A declared decision reads as one whether it arrived as a task row or as a
 * comment — which is the point of declaring — so it borrows the task
 * decision's own tone rather than inventing a third amber. A declared
 * `review` gets its own label because "needs your reply" understates a
 * fifteen-minute doc read.
 */
export function reviewItemBadge(item: ReviewItem): { label: string; tone: string } {
  if (item.review?.shape === 'decision') return { label: 'Decision', tone: 'decision' };
  if (item.review?.shape === 'review') return { label: 'Question', tone: 'review' };
  return reviewBadge(item.kind);
}

/**
 * "Asked by Harbor agent 2 days ago" — the head row's top-right meta, the ONE
 * provenance line the card carries (approved design, review-flow-mock-v1; it
 * replaced the left-bordered context block and the bare wait chip).
 *
 * Split from `askedMeta` so a surface with its own row shape (the task
 * panel's `PanelReviewItem`) spells the line identically without inventing a
 * `ReviewItem` to say it — two spellings of "who asked, when" is how the row
 * and the card come to disagree.
 *
 * Built only out of parts we actually hold: a decision whose transitions
 * carry no actor says when it was asked without claiming who asked it. The
 * clock uses `waitShort`, so the row subline and the card head can never
 * disagree about the wait — and the singular/plural comes with it.
 */
export function askedMetaLine(
  who: string | undefined,
  asked: boolean,
  at: number,
  now: number,
): string {
  // "Asked by" is a claim that there is a question — a status note says
  // "Posted by" instead. Saying "asked" over a deploy note is the card
  // promising something answerable and delivering something that is not.
  const verb = asked ? 'Asked' : 'Posted';
  const when = `${waitShort(at, now)} ago`;
  return who && who.trim() !== '' ? `${verb} by ${who} ${when}` : `${verb} ${when}`;
}

/**
 * "Filed by Index Keeper · held 4m" — the held note's provenance line, the
 * counterpart to `askedMetaLine` on the answerable card directly above it.
 *
 * Its own line rather than `askedMetaLine` with the hold time passed in as
 * the ask time: the only clock a held item carries in the projection is
 * `judge.at`, which is when the HOLD was placed — on a re-hold after a
 * revision that is minutes or hours after the question was asked, and a line
 * reading "Asked by … 4m ago" over it would state a fact nothing measured.
 * The judge was just tightened for doing exactly that (UX review,
 * 2026-08-29). `waitShort` is shared with the card, so the two clocks beside
 * each other cannot round differently.
 *
 * Both halves are optional and neither is invented: a projection with no
 * filer says only how long, and one from a server older than `judge` says
 * only who.
 */
export function heldMetaLine(
  who: string | undefined,
  heldAt: number | undefined,
  now: number,
): string {
  const name = who?.trim();
  const by = name ? `Filed by ${name}` : '';
  const stood = heldAt === undefined ? '' : `held ${waitShort(heldAt, now)}`;
  if (by && stood) return `${by} · ${stood}`;
  return by || (stood ? stood.charAt(0).toUpperCase() + stood.slice(1) : '');
}

/**
 * Who is asking the decision a TASK carries — the name after "Asked by" on
 * the Home card and on the task panel's own decision card alike. One reader
 * so the two cannot name different people: the projection's `createdBy`
 * (the server's `taskAskedBy`, creator-else-first-mover) when it shipped
 * one, else the first mover, which is all a projection from before that
 * field can say. Undefined when neither is known — the meta line then
 * states the clock alone rather than a name nothing recorded.
 */
export function decisionAskedBy(
  task: Pick<HubTask, 'createdBy' | 'transitions'>,
): string | undefined {
  const who = task.createdBy?.trim() || task.transitions[0]?.by.name?.trim();
  return who ? who : undefined;
}

/**
 * The opening of every answered record — "Answered by you: “", "Answered by
 * Cara: “", or "Answered: “" when the record names nobody. ONE spelling for
 * the doc card, the task panel's thread record and the task's own answer:
 * the doc said "Answered by you" while the panel said "Answered by Probe
 * Reviewer" for the same reader and the same answer, because each surface
 * spelled the rule itself and one of them never compared against the reader.
 * `selfName` is the reader's display name; a record whose `by` equals it is
 * the reader's own.
 */
export function answeredByLine(by: string | undefined, selfName: string | undefined): string {
  const who = by?.trim() ?? '';
  if (who === '') return 'Answered: “';
  return `Answered by ${selfName !== undefined && who === selfName ? 'you' : who}: “`;
}

/**
 * "Decided by you 2 hours ago" — the provenance UNDER a settled item, once
 * the outcome has a labelled strip of its own and no longer needs a sentence
 * wrapped around it (the approved mock's decided block).
 *
 * The verb follows the item's shape, the way the card's own kind chip does:
 * a decision is decided, a question is answered. Saying "Decided" over "Both,
 * Zoom first" would promise a ruling the item never asked for.
 *
 * The clock is RELATIVE, matching `askedMetaLine` directly above it on the
 * same card — the mock draws an absolute date, but two clocks on one card is
 * how "Asked 3 hours ago / Decided Aug 28, 2:14 PM" stops being subtractable
 * at a glance. `at` is absent on records written before `answeredAt` existed;
 * those keep the line and lose only the time.
 */
export function decidedMetaLine(
  by: string | undefined,
  selfName: string | undefined,
  at: number | undefined,
  now: number,
  decision: boolean,
): string {
  const verb = decision ? 'Decided' : 'Answered';
  const who = by?.trim() ?? '';
  const name = selfName !== undefined && who === selfName ? 'you' : who;
  const head = name === '' ? verb : `${verb} by ${name}`;
  return at === undefined ? head : `${head} ${waitShort(at, now)} ago`;
}

/**
 * The meta for a queue item. For a DECLARED item "Asked by" is always true —
 * a declaration IS an ask, in so many words, whatever the `direct` heuristic
 * measured. The inferred band keeps its measured Posted/Asked honesty, since
 * over-including is how a queue stops being believed.
 */
export function askedMeta(item: ReviewItem, now: number): string {
  const thread = item.thread;
  const row = reviewRow(item);
  // A thread carries its asker; a decision's is the ticket's filer, read the
  // one way every surface reads it.
  const who = thread?.askedBy ?? (row ? decisionAskedBy(row.task) : undefined);
  const asked = item.review !== undefined || (thread ? thread.direct === true : true);
  // The clock beside "asked" is the QUESTION's, not the run's: a run can start
  // days before the ask, and quoting its start tells the reader they have been
  // sitting on something they were handed minutes ago.
  const at = asked ? (thread?.askedAt ?? item.since) : item.since;
  return askedMetaLine(who, asked, at, now);
}

/**
 * The board's one line about the review queue. Null when nothing is waiting —
 * the banner only exists while items are open (approved design), so an empty
 * queue renders nothing rather than an all-clear box.
 *
 * No count, deliberately (Bryan, 2026-08-18, answering the review-queue ticket:
 * "Remove the count. Don't think I need it."). The decision that number was
 * built to make honest — which rows a needs-you COUNT may admit — dissolved
 * with the number itself: the banner says the queue is non-empty, and the
 * Home list is the queue.
 */
export function reviewBannerText(queue: ReviewQueue): string | null {
  if (queue.total === 0) return null;
  return 'Something is waiting for your review';
}
