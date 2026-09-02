/**
 * One task row, as everything outside the store sees it.
 *
 * `projectTask` is the §3.3 visitor contract in one function: the fields a
 * board viewer may read, with no actor ids and a capped body. It is a pure
 * function of a `Task` — no store, no room, no clock — which is why it lives
 * here rather than in `task-projection.ts`, the class that drives the
 * snapshots. The redaction path and the review-item derivation both call it
 * without wanting any of that machinery.
 */
import {
  decodeEntities,
  latestThreadedQuestion,
  readTaskReviewItem,
  reviewItemState,
} from '@feedback/core';
import type { TaskReviewItem } from '@feedback/core';
import { TASK_NOTES_READ_CAP } from './agent-notes.ts';
import { type OwnerKind } from './task-owner.ts';
import { type Task, legacyDecisionItem, taskAskedBy } from './tasks.ts';

/**
 * The docId of a task's live body room.
 *
 * DECIDED, so nobody has to re-derive it: `task:<taskId>` is a RESERVED
 * PATTERN, not an alias and not a caller-chosen doc id. The `task:` and `ws:`
 * prefixes belong to the server, and everything after the prefix is an
 * already-opaque generated id (`t-…`, `w-…`) — so the address inherits its
 * opacity from the task rather than needing an identity of its own. There is
 * nothing here for a readable-alias layer to protect: no person bookmarks a
 * body room, it is derived on demand from a task the reader already has, and
 * it changes only when the task itself ceases to exist.
 *
 * What that settles, deliberately: a body room never gets a second, prettier
 * name, so the alias layer that generated DOC ids need does not extend here.
 * `isHubOwnedRoom` (rooms.ts) is already the prefix authority; making the
 * prefixes unwritable by an outside caller belongs with the doc-id half of
 * this work, and is noted there rather than claimed here.
 */
export function taskBodyDocId(taskId: string): string {
  return `task:${taskId}`;
}

/** taskId ⇦ its body room docId (inverse of taskBodyDocId). */
/** The task a body docId belongs to, or null if the docId isn't one.
 *  One spelling of "not found" — callers that hold a body room and callers
 *  handed an arbitrary docId ask the same question and read the same answer. */
export function taskIdOfBodyDoc(docId: string): string | null {
  return docId.startsWith('task:') ? docId.slice('task:'.length) : null;
}

/**
 * How much of a description the board projection carries.
 *
 * A task body is a live doc anyone can paste a plan into, and the ws room
 * re-syncs to every board viewer on every debounced snapshot — so an
 * uncapped body makes the board's sync cost proportional to the longest
 * thing anyone ever pasted. Past the cap the panel shows the head and says
 * so; the doc link carries the rest. The cap is on the PROJECTION only: the
 * store keeps the whole body.
 */
export const BODY_PROJECTION_LIMIT = 4_000;

/** The projected slice of a body, plus the flag that keeps the truncation
 *  honest on the surface. */
export function projectBody(body: string | undefined): {
  body?: string;
  bodyTruncated?: boolean;
} {
  const text = body?.trim();
  if (!text) return {};
  if (text.length <= BODY_PROJECTION_LIMIT) return { body: text };
  return { body: text.slice(0, BODY_PROJECTION_LIMIT), bodyTruncated: true };
}

/** The ticket's review items, normalized, or nothing at all. Absent rather
 *  than empty: `refresh` deletes projected keys missing from the object, so an
 *  empty array would be a key every board carries forever saying nothing. */
/**
 * Where the ticket's OWN decision stands with the reader, when that is
 * something other than plainly open: `waiting` — the reader asked on it
 * (the card's "I have a question", or a phrase of the body) and the owner
 * has not revised since — or `revised`, with what the revision answered.
 *
 * Derived here, on the projection, because the browser draws the Home
 * decision card and the panel's own-decision card off THIS row, not off
 * `GET /review-items` — that route already drops a waiting `r-legacy` row
 * and marks a revised one, but a card built from `needs`/`answer` alone
 * would keep showing a decision the reader had just sent away. Same
 * derivation as the route's (`legacyDecisionItem` + `reviewItemState`), so
 * the two surfaces cannot disagree. Absent when open or answered: the
 * refresh deletes keys absent here, so a revision followed by an answer
 * clears the mark on its own.
 */
function projectDecisionState(task: Task): {
  decisionState?: 'waiting' | 'revised';
  decisionRevision?: {
    at: number;
    question?: string;
    threadId?: string;
    range?: { start: number; end: number };
  };
} {
  const item = legacyDecisionItem(task);
  if (!item) return {};
  const state = reviewItemState(item);
  if (state === 'waiting') return { decisionState: 'waiting' };
  if (state !== 'revised') return {};
  const revision = item.revisions?.at(-1);
  if (!revision) return {};
  // The question is quoted only when the revision answered one — the same
  // pairing `taskReviewItems` in review-queue.ts makes for a stored item.
  const question = latestThreadedQuestion(item);
  return {
    decisionState: 'revised',
    decisionRevision: {
      at: revision.at,
      ...(question !== undefined ? { question: question.text } : {}),
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      ...(revision.revisedRange ? { range: revision.revisedRange } : {}),
    },
  };
}

function projectReviews(reviews: TaskReviewItem[] | undefined): {
  reviews?: TaskReviewItem[];
} {
  if (!reviews || reviews.length === 0) return {};
  const rows: TaskReviewItem[] = [];
  for (const raw of reviews) {
    const item = readTaskReviewItem(raw);
    if (item) rows.push(item);
  }
  return rows.length > 0 ? { reviews: rows } : {};
}

/**
 * The agent's own one-liners on the row, NEWEST FIRST and capped at
 * `TASK_NOTES_READ_CAP` — the pane reads "what did this agent do lately",
 * and a row worked for a week has more history than any pane wants. Display
 * fields only: the session id stays in the store, like actor ids do on
 * transitions. Absent when there are none, so a row without notes projects
 * exactly as it did before the field existed.
 */
function projectNotes(notes: Task['notes']): { notes?: Record<string, unknown>[] } {
  if (!notes || notes.length === 0) return {};
  return {
    notes: notes
      .slice(-TASK_NOTES_READ_CAP)
      .reverse()
      .map((n) => ({ at: n.ts, kind: n.kind, text: n.text, agent: n.agent })),
  };
}

/** The plain-JSON shape of one task inside the `tasks` Y.Map — the §3.3
 *  visitor-contract fields, stated here so it's a decision, not an
 *  accident. No actor ids (display names only); the body is the capped
 *  snapshot, and the live one stays in its own room. */
export function projectTask(
  task: Task,
  /**
   * How many comments the task's discussion holds. Lives outside `Task`
   * because the discussion lives in the task's body ROOM, not in the store —
   * but the row has to say a discussion exists, or the only way to find one
   * is to open every task.
   */
  commentCount = 0,
  /**
   * Person, agent, or nobody-has-said — resolved by the SERVER, because half
   * the evidence is the workspace's agent roster and that never enters a
   * ydoc. Deriving it in the browser would give a share visitor a different
   * answer from the owner's, and the review strip is one shared read of the
   * workspace: its count has to be the same number for every reader.
   *
   * Omitted by the one caller that legitimately cannot know (the SSE event
   * redactor, which holds a task and no workspace). Every reader treats an
   * absent value as `unknown`, which is what it is.
   */
  ownerKind?: OwnerKind,
  /**
   * The owner's roster id, resolved by the server for the same reason as
   * `ownerKind`: the roster never enters a ydoc. Defaults to what the row
   * stored; the projection loop passes the read-time resolution so rows
   * older than the field, and rows whose id was merged away, carry the
   * surviving id.
   */
  assigneeId: string | undefined = task.assigneeId,
): Record<string, unknown> {
  return {
    id: task.id,
    ...(commentCount > 0 ? { commentCount } : {}),
    workspaceId: task.workspaceId,
    // Decoded here because this is the board's ONLY source of task titles, and
    // the browser renders every one of them through `textContent` — so a
    // caller that stored "Decisions &amp; open questions" reaches the screen
    // with the entity intact. It matters beyond the row: the Home queue builds
    // its DECISION items in the browser, off these projected titles rather
    // than off `GET /review-items`, so a title left raw here is a review row
    // with a raw entity in it however carefully the REST queue normalizes its
    // own. See `decodeEntities` — one pass, so a deliberate `&amp;amp;` still
    // shows as `&amp;`.
    title: decodeEntities(task.title),
    // The title above is a placeholder; the board draws the row as empty and
    // focuses its title field. Conditional like every flag here, so naming
    // the row removes the key from the projection.
    ...(task.untitled ? { untitled: true } : {}),
    status: task.status,
    assignee: task.assignee,
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(ownerKind !== undefined ? { ownerKind } : {}),
    ...(task.needs !== undefined ? { needs: task.needs } : {}),
    // Options and info-requests are workspace CONTENT — the board's decision
    // strip and its batch walkthrough render straight off this projection, so
    // withholding them would be the store-has-it/surface-can't-show-it bug by
    // construction. Everything in a workspace is available to everyone in it.
    ...(task.options !== undefined ? { options: task.options } : {}),
    ...(task.infoRequests !== undefined ? { infoRequests: task.infoRequests } : {}),
    // The ticket's review items — 0..n, each with its own blurb above its own
    // options. Beside `options`/`answer` rather than instead of them: nothing
    // is replaced and nothing is purged, so every surface reading the legacy
    // fields keeps reading them. Read through the loose reader so a row
    // corrupted on disk drops out here instead of reaching a renderer that
    // never touched this ticket. The DERIVED legacy row is deliberately absent
    // — the browser already has `options`/`answer` on this same object, and
    // projecting both spellings would list one decision twice.
    ...projectReviews(task.reviews),
    // The ticket's own decision, waiting on its owner or back revised — the
    // one fact about the derived `r-legacy` row the browser cannot read off
    // `options`/`answer`. See `projectDecisionState`.
    ...projectDecisionState(task),
    goal: task.goal,
    order: task.order,
    after: task.after,
    ...(task.afterEnforce !== undefined ? { afterEnforce: task.afterEnforce } : {}),
    ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}),
    // Soft-deleted, by whom, and why. Conditional like everything else here,
    // and the refresh deletes projected keys absent from this object — so a
    // RESTORE removes the keys and the row rejoins its lane with nothing
    // having to clear a flag. This is the field the browser filters lanes on.
    ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
    ...(task.archivedBy !== undefined ? { archivedBy: task.archivedBy } : {}),
    ...(task.archiveReason !== undefined ? { archiveReason: task.archiveReason } : {}),
    links: task.links,
    ...(task.origin !== undefined ? { origin: task.origin } : {}),
    // Plan-draft state, both halves conditional so a release / reconcile
    // removes the key on refresh (the refresh deletes keys absent here).
    // Workspace content, not host data: the docId is a workspace doc's own
    // id, and everything in a workspace is available to everyone in it.
    ...(task.planHold !== undefined ? { planHold: task.planHold } : {}),
    ...(task.possiblyStale !== undefined ? { possiblyStale: task.possiblyStale } : {}),
    ...(task.quote !== undefined ? { quote: task.quote } : {}),
    ...(task.answer !== undefined ? { answer: task.answer } : {}),
    // Narrowed to the declared shape, never spread: the pre-fix writer
    // stamped the ENTIRE workspace goal text into this marker, and 187 rows
    // on the live hub board still carry ~3KB each — 546KB of the board ydoc
    // shipped to every reader on every open. The store
    // keeps whatever the sidecar recorded; the wire gets { goalId, ts } —
    // same precedent as `evidence` two fields down.
    ...(task.triagedAgainst !== undefined
      ? { triagedAgainst: { goalId: task.triagedAgainst.goalId, ts: task.triagedAgainst.ts } }
      : {}),
    // Nobody has named this task's band, and since when. Projected so the
    // board and the queue can say the sentence out loud without new plumbing
    // — a field only the store can see is the "flag nobody renders" bug.
    ...(task.unplacedSince !== undefined ? { unplacedSince: task.unplacedSince } : {}),
    transitions: task.transitions.map((t) => ({
      ts: t.ts,
      from: t.from,
      to: t.to,
      by: { name: t.by.name, kind: t.by.kind },
      ...(t.note !== undefined ? { note: t.note } : {}),
      // `evidence` and `amendments` are deliberately NOT projected. Evidence
      // support was removed 2026-08-25: the store still holds what older
      // transitions recorded, and no surface reads it.
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
    })),
    ...projectNotes(task.notes),
    bodyDocId: taskBodyDocId(task.id),
    ...projectBody(task.body),
    createdAt: task.createdAt,
    // Who filed it, already resolved through the one reader the derived
    // review item uses — so the Home card (built in the browser off this
    // row) and the REST queue say the same name. Omitted when nothing is
    // known, and the card states the clock alone rather than a guess.
    ...(taskAskedBy(task) !== '' ? { createdBy: taskAskedBy(task) } : {}),
    // The effort model's two numbers, and the measured attention behind one
    // of them. Projected because the GOAL BAR is computed in the browser
    // (`@feedback/core/goal-effort`): the board already holds every row and
    // its trail over this ydoc, so the bar and the finish date recompute the
    // instant an estimate lands, with no fetch and no second implementation
    // of the arithmetic to keep in step with this one.
    //
    // Conditional, like every other optional key here, and that is the whole
    // contract rather than a style rule. Both fields are documented on `Task`
    // as absent-means-not-measured, never zero; projecting `{ totalSeconds: 0 }`
    // for a ticket nobody has read, or a zeroed estimate for one nobody has
    // scored, would erase that distinction at the last step before the screen.
    // `refresh` deletes projected keys absent from this object, so an estimate
    // that is later withdrawn takes its key with it.
    //
    // The FAILED variant is projected too, in full. A row that says "we tried
    // and got nothing" is a different thing to show than a row that was never
    // scored, and the board can only draw the difference if the difference
    // reaches it.
    ...(task.effortEstimate !== undefined ? { effortEstimate: task.effortEstimate } : {}),
    ...(task.readingTime !== undefined ? { readingTime: task.readingTime } : {}),
    updatedAt: task.updatedAt,
  };
}
