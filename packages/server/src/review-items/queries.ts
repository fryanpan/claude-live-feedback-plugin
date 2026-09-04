/**
 * Reading review items — across one ticket, and across a board.
 *
 * Reads only, with one exception that belongs with its reader: the board's
 * judging criteria, whose setter exists so "what does default mean" is
 * answered in exactly one place.
 */
import {
  type TaskReviewItem,
  isReviewItemGated,
  isReviewItemHeld,
  isReviewItemOpen,
  readTaskReviewItem,
  reviewItemState,
  reviewWithdrawn,
} from '@feedback/core';
import { DEFAULT_REVIEW_ITEM_CRITERIA } from '@feedback/core/review-judge-prompt';
import { isArchived } from '../task-fields.ts';
import { legacyDecisionItem } from './derive.ts';
import type { ReviewItemPersistence } from './persistence.ts';
import type {
  HeldReviewItem,
  ReviewItemCriteriaRead,
  ReviewStateCounts,
  SetReviewItemCriteriaResult,
} from './types.ts';

/**
 * Is this item an ask the READER can actually see and act on?
 *
 * The stall clock parks a row while `reviewState.open` is above zero, on the
 * reading that the row is legitimately waiting on a person. That is only true
 * of items the person has in front of them, so this predicate has to agree
 * with the Home queue's own filter (`review-queue.ts`) item for item. When the
 * two drift, the row parks forever on an ask that is off the queue: nobody can
 * answer it, so nothing ever clears it, and the watchdog stays off the row.
 *
 * Four exclusions, and each one is the queue's:
 *
 *  - ANSWERED (`isReviewItemOpen`) — settled.
 *  - GATED — held or still being judged; the reader was never shown it.
 *  - WITHDRAWN — its asker took it back, so no decision was ever needed.
 *  - WAITING — the reader asked back and it is the OWNER's turn; the row is
 *    the one holding things up, which is the opposite of waiting on a person.
 *
 * The predicates are reused rather than re-derived for exactly that reason: a
 * second spelling of "on the queue" is free to disagree with the first, and
 * this bug is what that disagreement costs.
 */
function isCountedOpen(item: TaskReviewItem): boolean {
  return (
    isReviewItemOpen(item) &&
    !isReviewItemGated(item) &&
    !reviewWithdrawn(item.review) &&
    reviewItemState(item) !== 'waiting'
  );
}

export class ReviewItemQueries {
  constructor(private readonly p: ReviewItemPersistence) {}

  /**
   * Every review item on a ticket, in order.
   *
   * When the ticket IS a legacy decision, one derived row leads the list with
   * the fixed id `r-legacy`. The derivation happens at READ time and writes
   * nothing: it is idempotent by construction and cannot double-apply across a
   * restart, which is strictly safer than the lazy back-fill `hydrateFromDisk`
   * does for `unplacedSince`. Nothing is purged either — `needs`, `options`,
   * `answer` and `infoRequests` keep being read and written exactly as before.
   *
   * Real rows do NOT suppress the derived one, and that is a correction rather
   * than a preference. Suppressing on "a stored row exists" keys the decision
   * on the wrong fact: the legacy decision is a SEPARATE open question from
   * whatever somebody filed later, so the moment a ticket gained its second
   * question the first one silently left this list — and with it `GET
   * /review-items`, which is the one route that answers "what is waiting on
   * me". The derived row leaves for exactly one reason now: the decision was
   * answered, at which point it is still LISTED and merely closed.
   *
   * It leads rather than trails because it is the oldest question on the
   * ticket (`createdAt` is the task's own), and this queue is oldest-first.
   *
   * Rows are read through `readTaskReviewItem`, so a row corrupted on disk
   * drops out of the list instead of throwing inside a renderer that never
   * touched this ticket — and because the derived row no longer depends on how
   * many raw rows there are, an unreadable one can no longer take the legacy
   * decision down with it.
   */
  listReviewItems(taskId: string): TaskReviewItem[] {
    const task = this.p.getTask(taskId);
    if (!task) return [];
    const out: TaskReviewItem[] = [];
    const legacy = legacyDecisionItem(task);
    if (legacy) out.push(legacy);
    for (const raw of task.reviews ?? []) {
      const item = readTaskReviewItem(raw);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * How much of this ticket is still waiting on a person — and, separately,
   * how much of it could not be READ.
   *
   * The second number is the whole reason this exists next to
   * `listReviewItems`. That reader deliberately drops a row that does not
   * parse, so a ticket whose questions are corrupt answers "no open
   * questions", byte-identical to a ticket that genuinely has none. That is
   * fine for a renderer — better a short list than a thrown exception inside a
   * card — and wrong for anything that ACTS on the answer, which the ready-work
   * gate does: it would read an unreadable ticket as free work and wake
   * somebody about a row that may well be blocked on Bryan.
   *
   * `open` counts the legacy `needs: 'decision'` row too, because
   * `listReviewItems` derives one — so both spellings of "a question is
   * outstanding" arrive here as one number and cannot drift apart.
   *
   * `undefined` for a task that does not exist. Not `{ open: 0, unreadable: 0 }`:
   * "this ticket is clear" and "there is no such ticket" are the two answers
   * this method exists to keep apart, so it must not merge them itself.
   */
  reviewState(taskId: string): ReviewStateCounts | undefined {
    const task = this.p.getTask(taskId);
    if (!task) return undefined;
    // A HELD item is open — nobody has answered it — and yet it is not an
    // ask anyone can see: the quality gate kept it off the queue. So it is
    // counted apart, and `open` excludes it: a row whose only question is
    // held is not legitimately waiting on a person, and reading it as such
    // would exonerate it from the stall clock on the strength of an ask the
    // reader was never shown.
    const items = this.listReviewItems(taskId);
    const held = items.filter(isReviewItemHeld).length;
    const open = items.filter(isCountedOpen).length;
    let unreadable = 0;
    for (const raw of task.reviews ?? []) {
      if (!readTaskReviewItem(raw)) unreadable++;
    }
    return { open, unreadable, held };
  }

  /**
   * Every HELD item on a board, with what the stall monitor needs to name
   * it and to find its filer. Read off the raw rows because `filedBy` is
   * store-only. Done tickets are skipped — a held question on finished work
   * is not a finding anyone should act on.
   */
  heldReviewItems(workspaceId: string): HeldReviewItem[] {
    const out: HeldReviewItem[] = [];
    for (const task of this.p.listTasksIn(workspaceId)) {
      if (task.status === 'done' || isArchived(task)) continue;
      // The ticket's OWN decision, when the gate is holding it. First,
      // because it is the oldest question on the row — the same order
      // `listReviewItems` puts it in. It is reported under the derived id,
      // which is how its caller knows to address the nudge at the ticket
      // (`revise_review_item(taskId=…)`) rather than at an item id that does
      // not exist.
      const decision = legacyDecisionItem(task);
      if (decision && isReviewItemHeld(decision) && decision.judge) {
        out.push({
          taskId: task.id,
          title: task.title,
          reviewItemId: decision.id,
          headline: decision.review.headline,
          reason: decision.judge.reason,
          heldAt: decision.judge.at,
          filedBy: decision.createdBy,
          ...(task.decisionFiledBy?.id !== undefined
            ? { filerAgentId: task.decisionFiledBy.id }
            : {}),
        });
      }
      for (const raw of task.reviews ?? []) {
        const item = readTaskReviewItem(raw);
        if (!item || !isReviewItemHeld(item) || !item.judge) continue;
        out.push({
          taskId: task.id,
          title: task.title,
          reviewItemId: item.id,
          headline: item.review.headline,
          reason: item.judge.reason,
          heldAt: item.judge.at,
          filedBy: item.createdBy,
          ...(raw.filedBy?.id !== undefined ? { filerAgentId: raw.filedBy.id } : {}),
        });
      }
    }
    return out;
  }

  /**
   * The criteria this board judges review items against: the owner's own
   * text, or the default when nobody has written any. The ONE reader of
   * `HubWorkspace.reviewItemCriteria`, so "what does default mean" is
   * answered in exactly one place. `undefined` for a board that does not
   * exist — distinct from a board on the default, which is the ordinary case.
   */
  reviewItemCriteria(workspaceId: string): ReviewItemCriteriaRead | undefined {
    const workspace = this.p.getWorkspaceRecord(workspaceId);
    if (!workspace) return undefined;
    const own = workspace.reviewItemCriteria;
    return own !== undefined && own.trim() !== ''
      ? { value: own, isDefault: false }
      : { value: DEFAULT_REVIEW_ITEM_CRITERIA, isDefault: true };
  }

  /**
   * Set — or, with `undefined`/blank, clear back to the default — what this
   * board judges review items against. A settings write, not a board event:
   * nothing in §3.6's table describes it and no subscriber acts on it, the
   * same contract as `setDependencies`. The next filing reads it.
   */
  setReviewItemCriteria(
    workspaceId: string,
    criteria: string | undefined,
    _opts: { actor: { id: string; name: string; kind?: string } },
  ): SetReviewItemCriteriaResult {
    const workspace = this.p.getWorkspaceRecord(workspaceId);
    if (!workspace) return { ok: false, error: 'workspace-not-found' };
    const next = criteria?.trim();
    if (next === undefined || next === '') workspace.reviewItemCriteria = undefined;
    else workspace.reviewItemCriteria = next;
    this.p.save(workspaceId);
    const read = this.reviewItemCriteria(workspaceId);
    return {
      ok: true,
      workspace,
      criteria: read ?? { value: DEFAULT_REVIEW_ITEM_CRITERIA, isDefault: true },
    };
  }

  /**
   * WHICH ticket holds this review item — the lookup behind addressing an
   * item by bare `reviewItemId`. Minted ids are unique by construction
   * (twelve random base64url chars), so the first hit is the only hit; the
   * fixed LEGACY_REVIEW_ITEM_ID is on every legacy-decision ticket at once
   * and is refused by the route before it gets here. In-memory over the
   * sidecars the store already holds — no doc is hydrated for this.
   */
  findReviewItem(reviewItemId: string): { taskId: string; workspaceId: string } | undefined {
    for (const workspaceId of this.p.listWorkspaceIds()) {
      for (const task of this.p.listTasksIn(workspaceId)) {
        if (task.reviews?.some((r) => r.id === reviewItemId)) {
          return { taskId: task.id, workspaceId };
        }
      }
    }
    return undefined;
  }
}
