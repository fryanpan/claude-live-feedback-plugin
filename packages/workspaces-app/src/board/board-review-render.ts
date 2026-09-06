import { reviewAnswered } from '@feedback/core';
import { renderCommentMarkdown } from '../comment-markdown.ts';
/**
 * The review surface's renderers (plan §3.9): a ticket-borne review item drawn
 * as a row of the comment history, the question a decision task is asking
 * lifted out of its body, and the detail panel's queue of things waiting on the
 * reader — with the answer and question composers it opens. Data in, elements
 * out — no fetches, no Yjs.
 *
 * The top of the render layer: it reads the panel's shapes from
 * `board-detail-render.ts` and a comment row's badge from
 * `board-discussion-render.ts`, and neither reads back.
 */
import { api } from '../doc-path.ts';
import { focusMarkdownComposer } from '../md-composer.ts';
import { type PanelReviewItem, type TaskDiscussion } from './board-detail-render.ts';
import { answeredRecord, optionLabel, reviewBadge } from './board-discussion-render.ts';
import { type BoardReviewItem, type BoardTask } from './board-model.ts';
import { timeAgo } from './board-presence-model.ts';
import {
  LEGACY_REVIEW_ITEM_ID,
  type ReviewThreadItem,
  decisionAskedBy,
  reviewItemThreadRequest,
} from './board-review-model.ts';
/**
 * A review item raised on the TICKET, drawn as a row of the comment history.
 *
 * Same anatomy as a declaring comment's row (`commentRow`): who raised it and
 * when, the kind chip, the headline, the detail as the body — and, once
 * answered, the answered record. There is no comment text because there was
 * no comment: the item is the whole of what the agent said.
 */
export function reviewItemRow(
  item: BoardReviewItem,
  now: number,
  selfName?: string,
): HTMLLIElement {
  const r = item.review;
  const withdrawn = r.withdrawnAt !== undefined;
  const li = document.createElement('li');
  li.className = 'board-comment board-comment-review board-comment-ticket-item';
  li.dataset.reviewItemId = item.id;

  const head = document.createElement('div');
  head.className = 'board-comment-head';
  const who = document.createElement('span');
  who.className = 'board-comment-author';
  who.textContent = item.createdBy ?? 'Someone';
  head.append(who);
  if (item.createdAt !== undefined) {
    const when = document.createElement('span');
    when.className = 'board-comment-when';
    when.textContent = timeAgo(item.createdAt, now);
    when.title = new Date(item.createdAt).toLocaleString();
    head.append(when);
  }
  head.append(reviewBadge(r.shape, withdrawn, item.answer !== undefined));
  li.append(head);

  const headline = document.createElement('p');
  headline.className = withdrawn
    ? 'board-comment-review-headline is-withdrawn'
    : 'board-comment-review-headline';
  headline.textContent = r.headline;
  li.append(headline);

  if (r.detail !== undefined && r.detail.trim() !== '') {
    const body = document.createElement('div');
    body.className = 'board-comment-body';
    body.innerHTML = renderCommentMarkdown(r.detail);
    li.append(body);
  }

  if (item.answer !== undefined) {
    li.classList.add('board-comment-answered-item');
    const a = item.answer;
    li.append(
      answeredRecord(
        {
          ...(a.by !== undefined ? { by: a.by } : {}),
          text: a.text,
          ...(a.ts !== undefined ? { at: a.ts } : {}),
        },
        now,
        selfName,
      ),
    );
  }
  return li;
}

/**
 * The question a decision task is asking, lifted out of its body.
 *
 * Bryan, 2026-08-18: *"For decisions, the ticket title is not the decision. A
 * decision is a part of a ticket, and there should be a decision blurb above
 * the options."* A task-borne decision has no headline FIELD — the question
 * and the stakes live in the body markdown, which is exactly what the server's
 * create gate reads (`checkDecisionShape` refuses a body that never asks
 * anything). So the blurb is derived the same way the gate judges: the first
 * line that asks something is the question, and the prose that is not the
 * question and not the options list is what is at stake.
 *
 * This is also why the description below can be de-emphasised — on a decision
 * task it repeats what the card now shows.
 *
 * The second half was called `why` while the payload had a field of that name
 * and this fed it. It never was one: it is everything in the body that is not
 * the question and not the options — a BODY — so it is spelled as one now and
 * lands in `detail`, which is where the card reads a body from.
 *
 * One-directional, like the gate: a body it cannot read yields an empty
 * headline, and the caller falls back rather than inventing a question.
 */
export function decisionBlurb(body: string | undefined): { headline: string; body: string } {
  const text = (body ?? '').trim();
  if (!text) return { headline: '', body: '' };
  const rows = text.split('\n');
  // A markdown list item — the options, which the card renders as buttons and
  // must not repeat as prose.
  const isListItem = (l: string) => /^\s{0,3}([-*+]|\d+[.)])\s+\S/.test(l);
  // Heading hashes, bold wrappers and a leading list marker are markup, not
  // words; the card is not a markdown renderer and a stray `##` in a headline
  // reads as a typo.
  const plain = (l: string) =>
    l
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*/g, '')
      .trim();
  // A line that introduces the list we are about to drop — `Options:` — is
  // dropped with it. Measured in the browser 2026-08-18: keeping it welded the
  // orphaned label onto the sentence after the list ("…not shipping it.
  // Options: Blocked until answered: …"), which reads as a typo rather than as
  // prose. The test is deliberately narrow — a trailing colon AND a list item
  // as the next non-blank line — so a sentence that merely ends in a colon and
  // introduces nothing keeps its place.
  const introducesList = (i: number) => {
    if (isListItem(rows[i] ?? '') || !plain(rows[i] ?? '').endsWith(':')) return false;
    for (let j = i + 1; j < rows.length; j += 1) {
      if (plain(rows[j] ?? '') === '') continue;
      return isListItem(rows[j] ?? '');
    }
    return false;
  };
  const questionAt = rows.findIndex((l) => l.includes('?'));
  const headline = questionAt >= 0 ? plain(rows[questionAt] ?? '') : '';
  const rest = rows
    .filter((l, i) => i !== questionAt && !isListItem(l) && plain(l) !== '' && !introducesList(i))
    .map(plain)
    .join(' ')
    .trim();
  return { headline, body: rest };
}

/**
 * Everything on this task that is waiting on the reader, ranked.
 *
 * Bryan, 2026-08-18: *"over time, there may be more than one decision
 * associated with a ticket. In fact, at any point in time there might be
 * multiple open decisions for a ticket. Please accommodate and have a similar
 * review queue within a ticket details interface."* So the panel's review
 * region is a QUEUE rather than a card — the same two sources the strip reads,
 * merged: the task's own `needs: 'decision'`, and every declared or unanswered
 * item the server computed for this task's threads.
 *
 * Nothing about storage changes and nothing is re-derived here: the thread
 * items arrive from `GET /workspaces/:id/review-items`, which is where
 * "is this run waiting on a person" is decided, and this only merges and
 * orders. Ranking is the strip's own rule so the two cannot disagree —
 * declared before inferred, a named person before nobody, oldest first inside
 * each group — with the task's decision ahead of all of it, because it is the
 * one item that is structurally blocking rather than inferred from who spoke
 * last.
 */
export function panelReviewQueue(
  task: BoardTask,
  asks: ReviewThreadItem[] | undefined,
  discussion?: TaskDiscussion,
): PanelReviewItem[] {
  const items: PanelReviewItem[] = [];
  // The ticket's own decision — unless it is WAITING on its owner: the
  // reader asked on it, and it comes back marked Revised when the owner
  // revises (the same rule that keeps a waiting ticket item off the
  // review-items route, read off the projection here).
  if (!task.answer && task.needs === 'decision' && task.decisionState !== 'waiting') {
    const blurb = decisionBlurb(task.body);
    items.push({
      id: `task:${task.id}`,
      source: 'task',
      shape: 'decision',
      // The title is the fallback and not the default: it names the ticket,
      // and the ticket is not the decision. An unreadable body yields the
      // title rather than a blank card, which would say nothing at all.
      headline: blurb.headline || task.title,
      ...(blurb.body !== '' ? { detail: blurb.body } : {}),
      ...(task.options ? { options: task.options } : {}),
      // The ticket's filer, read the one way the Home card reads it, so the
      // same decision does not say "Asked by UX Bot" there and "Asked" here.
      ...(decisionAskedBy(task) !== undefined ? { askedBy: decisionAskedBy(task) } : {}),
      since: task.createdAt,
      asked: true,
      // Came back revised after the reader asked: say so, quote the question,
      // and aim the focus-scroll at the thread — as a ticket item does.
      ...(task.decisionRevision
        ? {
            revision: {
              at: task.decisionRevision.at,
              ...(task.decisionRevision.question !== undefined
                ? { question: task.decisionRevision.question }
                : {}),
            },
            ...(task.decisionRevision.threadId ? { threadId: task.decisionRevision.threadId } : {}),
          }
        : {}),
    });
  }
  for (const a of asks ?? []) {
    const r = a.review;
    if (a.kind === 'task-review') {
      // A TICKET-borne item: the same card a declared thread item gets, keyed
      // by the ids its answer posts to and carrying no `threadId` — there is
      // no thread, and inventing one would aim the focus-scroll and the deep
      // link at nothing. `panelAsks` has already refused a row without the
      // payload or the ids; the guard here is what makes THIS function total.
      if (!a.taskId || !a.reviewItemId || r === undefined) continue;
      items.push({
        id: `task-review:${a.taskId}:${a.reviewItemId}`,
        source: 'task-review',
        shape: r.shape,
        headline: r.headline,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        ...(r.options ? { options: r.options } : {}),
        askedBy: a.askedBy,
        since: a.askedAt ?? a.since,
        ...(a.direct !== undefined ? { direct: a.direct } : {}),
        reviewItemId: a.reviewItemId,
        declared: true,
        asked: true,
        // A REVISED item keeps what the server said about the revision, and
        // the thread that asked — so the card can say "this came back
        // changed" and the focus-scroll can aim at it. A fresh item carries
        // no thread: there is none, and inventing one would aim the deep link
        // at nothing.
        ...(a.state === 'revised'
          ? {
              revision: {
                at: a.revisedAt ?? a.since,
                ...(a.question !== undefined ? { question: a.question } : {}),
              },
              ...(a.threadId ? { threadId: a.threadId } : {}),
            }
          : {}),
      });
      continue;
    }
    items.push({
      id: `thread:${a.threadId}`,
      source: 'thread',
      shape: r?.shape ?? 'review',
      // A declared item says what it wants in its own words. An inferred one
      // has no declaration, so its headline is the comment itself — which is
      // what the strip shows, and it is honest about being an excerpt.
      headline: r?.headline ?? a.ask,
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(r?.options ? { options: r.options } : {}),
      askedBy: a.askedBy,
      since: a.askedAt ?? a.since,
      ...(a.direct !== undefined ? { direct: a.direct } : {}),
      threadId: a.threadId,
      docId: a.docId,
      ...(a.commentId !== undefined ? { commentId: a.commentId } : {}),
      declared: r !== undefined,
      // A declaration is an ask; an inferred item only measured one.
      asked: r !== undefined || a.direct === true,
    });
  }
  // ANSWERED declared items stay in the panel as the record (approved
  // design): the "Answered by …" line with its persistent Undo renders where
  // the item card stood, not on some other surface. They come from the
  // DISCUSSION rather than from `asks`, because the review-items route only
  // ships what is still waiting — the stamps on the declaring comment are the
  // record that survives a reload. An unanswered declaration is skipped here:
  // its row already arrived through `asks`, and admitting it twice would put
  // a dead copy of the card above the live one.
  for (const t of discussion?.threads ?? []) {
    for (const c of t.comments) {
      const r = c.review;
      if (!r || !reviewAnswered(r)) continue;
      items.push({
        id: `answered:${t.id}:${c.id ?? c.ts}`,
        source: 'thread',
        shape: r.shape,
        headline: r.headline,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        askedBy: c.author,
        since: c.ts,
        threadId: t.id,
        docId: task.bodyDocId,
        ...(c.id !== undefined ? { commentId: c.id } : {}),
        declared: true,
        asked: true,
        answered: {
          ...(r.answeredBy !== undefined ? { by: r.answeredBy } : {}),
          // A legacy tap stamped `answeredWith` alone; the option's label is
          // the verbatim words that tap recorded.
          ...((r.answerText ?? optionLabel(r, r.answeredWith)) !== undefined
            ? { text: r.answerText ?? optionLabel(r, r.answeredWith) }
            : {}),
          at: r.answeredAt ?? 0,
        },
      });
    }
  }
  // Declared before inferred. This asked `why !== ''` while the payload had a
  // required `why` and an inferred item had none — a proxy for exactly this,
  // which the row now states outright. Same ordering, no longer inferred from
  // a field's emptiness.
  const rank = (i: PanelReviewItem): number =>
    i.answered
      ? 3
      : i.source === 'task'
        ? 0
        : i.shape === 'decision' || i.declared === true
          ? 1
          : 2;
  return items.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const d = Number(b.direct ?? false) - Number(a.direct ?? false);
    return d !== 0 ? d : a.since - b.since;
  });
}

/**
 * Where a panel card's answer gets WRITTEN — path and body, minus the author
 * the caller adds. The sibling of `reviewReplyRequest` (Home queue), for the
 * panel's own row shape, and one spelling for the same reason: `board-app`
 * built the two thread routes inline, which is exactly how a ticket-borne
 * card would have posted its answer at api(`docs/<task doc>/threads/
 * undefined/…`) — a write that lands nowhere while the card says "posted".
 *
 * - a `task-review` card → the task review-item answer route. `answeredWith`
 *   is that entity's spelling of the tapped candidate's id.
 * - a declared thread card with a comment to stamp → the thread `/answer`
 *   route, which posts the same reply AND records the candidate.
 * - any other thread card → a plain thread comment.
 *
 * Null when the card holds no address to write to — the task's own decision
 * included, which answers through `answer_decision` and never comes here.
 */
export function panelAnswerRequest(
  task: Pick<BoardTask, 'id' | 'bodyDocId'>,
  item: PanelReviewItem,
  text: string,
  optionId?: string,
): { path: string; body: Record<string, unknown> } | null {
  if (item.source === 'task-review') {
    if (!item.reviewItemId) return null;
    return {
      path: api(
        `tasks/${encodeURIComponent(task.id)}/review-items/${encodeURIComponent(item.reviewItemId)}/answer`,
      ),
      body: { text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
    };
  }
  if (item.source !== 'thread' || !item.threadId) return null;
  const doc = encodeURIComponent(item.docId ?? task.bodyDocId);
  const thread = encodeURIComponent(item.threadId);
  return item.declared && item.commentId !== undefined
    ? {
        path: api(`docs/${doc}/threads/${thread}/answer`),
        body: {
          text,
          commentId: item.commentId,
          ...(optionId !== undefined ? { optionId } : {}),
        },
      }
    : { path: api(`docs/${doc}/threads/${thread}/comments`), body: { text } };
}

/**
 * Where a panel card's QUESTION gets written — "I have a question", the
 * card's way of asking back without selecting a phrase. The same thread the
 * Home walkthrough's card makes (`reviewItemThreadRequest`, quoting the
 * headline as the phrase), so the item is derived `waiting` by the same rule
 * and leaves both queues on the same re-read. A ticket-borne card anchors
 * to its item; the ticket's OWN decision anchors to the derived `r-legacy`
 * row, quoting the title (its headline, server-side). A thread-borne card
 * has no item — its thread is where a question goes — so null, and the
 * card says so instead of drawing the link.
 */
export function panelQuestionRequest(
  task: Pick<BoardTask, 'id' | 'title'>,
  item: PanelReviewItem,
  question: string,
): { path: string; body: Record<string, unknown> } | null {
  if (item.source === 'task') {
    return reviewItemThreadRequest(
      { taskId: task.id, reviewItemId: LEGACY_REVIEW_ITEM_ID },
      task.title,
      question,
    );
  }
  if (item.source !== 'task-review' || !item.reviewItemId) return null;
  return reviewItemThreadRequest(
    { taskId: task.id, reviewItemId: item.reviewItemId },
    item.headline,
    question,
  );
}

/**
 * Say why a submit did nothing, next to the control that did nothing.
 *
 * A disabled button would be the tidier affordance and it is the wrong one
 * here: these boxes are refilled by `restoreFields` after every repaint,
 * which sets `.value` directly and fires no `input` event — so a button whose
 * enabled state is driven by typing would sit disabled over a full box. This
 * says the same thing at the moment it matters and needs no state to be kept
 * in sync.
 */
export function requireText(field: HTMLTextAreaElement, near: HTMLElement, message: string): void {
  const form = near.closest('form');
  const existing = form?.querySelector('.board-form-error');
  const note = existing instanceof HTMLElement ? existing : document.createElement('p');
  note.className = 'board-form-error';
  note.textContent = message;
  note.setAttribute('role', 'alert');
  if (!existing) near.insertAdjacentElement('beforebegin', note);
  // Through the composer: the textarea is hidden behind its editor, and
  // focusing a hidden control puts the caret nowhere the reader can see.
  focusMarkdownComposer(field);
  // Clears itself the moment the reason goes away, so it never contradicts
  // what the reader can see in the box.
  field.addEventListener('input', () => note.remove(), { once: true });
}
