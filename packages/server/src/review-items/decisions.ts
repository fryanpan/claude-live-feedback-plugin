/**
 * The ONE decision a legacy ticket carries — `needs: 'decision'`, whose words
 * are the ticket's own title, body and options rather than a stored row.
 *
 * Its own store beside the item store because the two write to different
 * places and guard on different versions: an item stamps its wrapper and
 * counts `revisions`; the decision stamps the TASK and counts
 * `wordsRevisionOf`. Folding them together would mean one function whose
 * every line asks which shape it is holding.
 *
 * Bodies moved out of `TaskStore` unchanged — the refusals, the events and
 * the soft-delete of superseded answers are exactly what they were.
 */
import {
  type ReviewItemRange,
  type ReviewItemRevision,
  type ReviewOption,
  type TaskReviewItem,
  changedRange,
  latestThreadedQuestion,
} from '@feedback/core';
import type { DecisionOption, Task, TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from '../actor-identity.ts';
import { checkDecisionShape, decisionShapeMessage } from '../decision-shape.ts';
import { bumpWordsRevision, cryptoId } from '../task-fields.ts';
import { legacyDecisionItem } from './derive.ts';
import type { ReviewItemPersistence } from './persistence.ts';
import type {
  AnswerDecisionResult,
  RequestMoreInfoResult,
  ReviseTaskDecisionResult,
  WithdrawAnswerResult,
} from './types.ts';

/** One refusal for every way an options array can be malformed — the caller
 *  fixes the shape, not one field at a time. */
const BAD_DECISION_OPTIONS_MESSAGE =
  'options must be an array of { label, detail? } — label is required and non-empty, and an id you already hold is kept as you sent it';

export class TaskDecisionStore {
  constructor(private readonly p: ReviewItemPersistence) {}

  /**
   * The one legacy decision as a review item, or undefined when there is none.
   *
   * ONE rule, in ONE place, because three callers ask it — the reader above
   * and both answer paths. If the answer paths resolved `r-legacy` under a
   * different condition than the reader lists it under, a row nothing shows
   * would still accept answers.
   *
   * The payload mapping is `reviewFromDecisionTask` in core (pure, mints
   * nothing). What is added here is the ROW around it: the task's own clock,
   * and — the part that matters — the legacy `answer` carried across, because
   * an answered decision read as open is a queue that never empties.
   *
   * `createdBy` is `taskAskedBy` — who filed the ticket, and for a row older
   * than that field whoever first moved it, which is what the Home card
   * already named. It used to be deliberately empty ("no legacy decision
   * recorded who raised it"), which was true of the row and false of the
   * board: the same decision read "Asked by Harbor agent" on Home and
   * "Asked 11 minutes ago" in the task panel and the REST queue. NOT the
   * `assignee` — that is who has to answer, a different person.
   */
  legacyReviewItem(task: Task): TaskReviewItem | undefined {
    return legacyDecisionItem(task);
  }

  /**
   * Record a decision's VERBATIM answer (§3.2: decisions keep the human's
   * exact words) and emit `decision.answered` carrying the text, the actor,
   * and the decision task's links — a ready-made propagation checklist for
   * the attached agent (§3.6). Recording the answer does NOT transition the
   * task: status changes stay with the single gate, and what the answer
   * unblocks is the agent's next move, not this method's side effect.
   */
  answerDecision(
    taskId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; optionId?: string },
  ): AnswerDecisionResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    // An optionId that resolves to nothing would record an answer whose
    // provenance is a lie — and the UI's whole point is that tapping a
    // candidate is the same act as writing its words.
    if (opts.optionId !== undefined && !task.options?.some((o) => o.id === opts.optionId)) {
      return { ok: false, error: 'unknown-option' };
    }
    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // A second answer landing over a standing one is a race, not a rewrite
    // request — two browsers both showing the unanswered card, the slower tap
    // arriving after the faster one recorded. Last write stands (the panel's
    // busy-disable is DOM-local, so the server is the only place this can be
    // handled), but the displaced words move to `answerHistory` exactly as an
    // undo would move them: overwriting IS a withdrawal, performed by the
    // overwriting actor, and a hard delete here is the loss that field was
    // added to prevent.
    if (task.answer) {
      task.answerHistory = [
        ...(task.answerHistory ?? []),
        { ...task.answer, withdrawnAt: ts, withdrawnBy: actor.name },
      ];
    }
    // `by` is the display name — the projection ships display names, not ids
    // (§3.3 visitor contract), and the event carries the full actor anyway.
    // `text` stays the answer whether it was typed or tapped: an option is a
    // shortcut to words, never a replacement for them.
    task.answer = {
      text,
      by: actor.name,
      ts,
      ...(opts.optionId !== undefined ? { optionId: opts.optionId } : {}),
    };
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.answered',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: text,
      ...(opts.optionId !== undefined ? { optionId: opts.optionId } : {}),
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  /**
   * Take an answer back.
   *
   * Answering is one click with no confirmation step, and a stray one on a
   * phone used to be permanent — the surface offered no way back, and the
   * words were gone the moment a second answer overwrote them. This is the
   * way back, and it is a SOFT delete: the answer moves to `answerHistory`
   * with who withdrew it and when, so the record of what was decided (and
   * un-decided) survives, which is the project-wide rule for user content.
   *
   * Refuses when there is nothing to withdraw rather than succeeding
   * vacuously: two readers racing the same undo must not both be told they
   * took something back.
   */
  withdrawAnswer(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): WithdrawAnswerResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    const answer = task.answer;
    if (!answer) return { ok: false, error: 'no-answer' };
    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.answerHistory = [
      ...(task.answerHistory ?? []),
      { ...answer, withdrawnAt: ts, withdrawnBy: actor.name },
    ];
    task.answer = undefined;
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.answer_withdrawn',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: answer.text,
      answeredBy: answer.by,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  /**
   * Ask a decision for more context INSTEAD of answering it — the third
   * first-class response next to picking an option and writing your own
   * answer, and the one that keeps options from becoming a closed set.
   *
   * Nothing about the task's status or answer changes: it stays open, stays
   * counted at the top of the board, and stays in the walkthrough. What the
   * attached agent owes back is context, which is why this is its own event
   * rather than an answer carrying a flag.
   */
  requestMoreInfo(
    taskId: string,
    question: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** The thread the question was asked on, and the phrase — see
       *  `InfoRequest.threadId`. Present only when the question came in the
       *  review-item way; the typed "tell me more" carries neither. */
      threadId?: string;
      range?: ReviewItemRange;
    },
  ): RequestMoreInfoResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.infoRequests = [
      ...(task.infoRequests ?? []),
      {
        text: question,
        by: actor.name,
        ts,
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.range !== undefined ? { range: opts.range } : {}),
      },
    ];
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.info_requested',
      workspaceId: task.workspaceId,
      taskId: task.id,
      question,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  /**
   * Rewrite the words of a ticket's own decision — what
   * `revise_review_item(taskId=…)` does, and the reason a hold on one is not
   * a dead end.
   *
   * The decision has no stored row to patch: its headline IS the title, its
   * detail IS the body, and its options are the task's. So this maps the
   * patch onto those three and writes them through the SAME choke points
   * every other words-writer uses — `applyTitle` (which stamps the rename
   * marks and bumps `wordsRevision`) and the body stamp — rather than
   * assigning the fields here. That is what keeps the audit trail, the
   * preserved `quote` and the staleness counter identical whether the words
   * moved through this door or through `rewrite_task`.
   *
   * Refused on an ANSWERED decision, for `reviseReviewItem`'s reason: the
   * answer was given to the words that are there, and rewriting them under
   * it would leave a recorded decision about text nobody can see.
   */
  reviseTaskDecision(
    taskId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): ReviseTaskDecisionResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') {
      return {
        ok: false,
        error: 'not-a-decision',
        message: `task ${taskId} is not a decision, so it has no decision of its own to revise — pass reviewItemId to revise one of the items filed on it`,
      };
    }
    if (task.answer) {
      return {
        ok: false,
        error: 'answered',
        message: `the decision on ${taskId} is already answered — the answer is to the words it has; file a new item instead of rewriting these`,
      };
    }
    const { headline, detail, options } = patch;
    if (headline === undefined && detail === undefined && options === undefined) {
      return { ok: false, error: 'empty-patch' };
    }
    if (headline !== undefined && (typeof headline !== 'string' || headline.trim() === '')) {
      return { ok: false, error: 'bad-review', message: 'headline must be a non-empty string' };
    }
    if (detail !== undefined && typeof detail !== 'string') {
      return { ok: false, error: 'bad-review', message: 'detail must be a string' };
    }
    let nextOptions = task.options;
    if (options !== undefined) {
      if (!Array.isArray(options)) {
        return { ok: false, error: 'bad-review', message: BAD_DECISION_OPTIONS_MESSAGE };
      }
      const parsed: DecisionOption[] = [];
      for (const entry of options) {
        if (typeof entry !== 'object' || entry === null) {
          return { ok: false, error: 'bad-review', message: BAD_DECISION_OPTIONS_MESSAGE };
        }
        const o = entry as { id?: unknown; label?: unknown; detail?: unknown };
        if (typeof o.label !== 'string' || o.label.trim() === '') {
          return { ok: false, error: 'bad-review', message: BAD_DECISION_OPTIONS_MESSAGE };
        }
        if (o.detail !== undefined && typeof o.detail !== 'string') {
          return { ok: false, error: 'bad-review', message: BAD_DECISION_OPTIONS_MESSAGE };
        }
        parsed.push({
          // An id the caller kept is kept: an answer already recorded against
          // one names it by id, and re-minting would orphan that provenance.
          id: typeof o.id === 'string' && o.id.trim() !== '' ? o.id : cryptoId('o'),
          label: o.label.trim(),
          ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
        });
      }
      nextOptions = parsed;
    }
    const nextTitle = typeof headline === 'string' ? headline.trim() : task.title;
    const nextBody = typeof detail === 'string' ? detail : task.body;
    // The same shape gate `createTask` runs, on the words as they WILL be —
    // so a revision cannot leave the ticket in a state the create door would
    // have refused, and the filer is told in the create door's own words.
    const check = checkDecisionShape(nextBody, nextOptions);
    if (!check.ok) {
      return { ok: false, error: 'bad-review', message: decisionShapeMessage(check) };
    }
    // The superseded reading, filed the way `reviseReviewItem` files one on
    // a stored item — stamped with the thread of the question it answers
    // (the newest threaded one, as `latestThreadedQuestion` reads it) and
    // with where in the new body the change landed. This record is what
    // puts a decision the reader asked on BACK on their queue, marked
    // Revised: `legacyDecisionItem` hangs it on the derived row and
    // `reviewItemState` reads it. Kept before the words move, because the
    // words are what it keeps.
    const before = this.legacyReviewItem(task);
    const asked = before ? latestThreadedQuestion(before) : undefined;
    const revisedRange =
      typeof detail === 'string' && detail !== (task.body ?? '')
        ? changedRange(task.body ?? '', detail)
        : undefined;
    const previous: ReviewItemRevision = {
      at: this.p.now(),
      by: opts.actor.name,
      headline: task.title,
      ...(typeof task.body === 'string' && task.body.trim() !== '' ? { detail: task.body } : {}),
      ...(task.options && task.options.length > 0
        ? {
            options: task.options.map(
              (o): ReviewOption => ({
                id: o.id,
                label: o.label,
                ...(o.detail !== undefined ? { detail: o.detail } : {}),
              }),
            ),
          }
        : {}),
      ...(asked?.threadId !== undefined ? { threadId: asked.threadId } : {}),
      ...(revisedRange !== undefined ? { revisedRange } : {}),
    };
    task.decisionRevisions = [...(task.decisionRevisions ?? []), previous];
    if (options !== undefined) task.options = nextOptions;
    if (detail !== undefined) {
      task.body = nextBody;
      // The body door — it stamps `bodyWrittenAt`, bumps `wordsRevision`,
      // applies the title in the same act, and emits ONE task.body_edited.
      this.p.noteBodyEdited(taskId, {
        actor: opts.actor,
        ...(headline !== undefined ? { title: nextTitle } : {}),
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });
    } else if (headline !== undefined) {
      this.p.renameTask(taskId, nextTitle, {
        actor: opts.actor,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      });
    } else {
      // Options alone moved. Nothing above bumped the counter, and it has to
      // move: it is what makes the verdict about the old options stale.
      bumpWordsRevision(task);
      task.updatedAt = this.p.now();
      this.p.save(task.workspaceId);
    }
    const item = this.legacyReviewItem(task);
    if (!item) return { ok: false, error: 'not-a-decision' };
    return { ok: true, task, item };
  }
}
