/**
 * The task discussion's renderers (plan §3.9): what a repaint owes the person
 * typing, the flattened comment stream a ticket shows, and the row each
 * comment is drawn as. Data in, elements out — no fetches, no Yjs.
 *
 * `reviewBadge` and `answeredRecord` are exported rather than private because
 * `hub-review-render.ts` draws a ticket-borne item with the same anatomy as a
 * declaring comment's row. One spelling, so the two cannot read differently.
 */
import { reviewAnswered, reviewWithdrawn } from '@feedback/core';
import type { ReviewPayload, ReviewShape } from '@feedback/core';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import {
  type ComposerSelection,
  composerSelection,
  composerState,
  focusMarkdownComposer,
  isComposerFocused,
  refreshMarkdownComposer,
} from '../md-composer.ts';
import { type HubReviewItem } from './hub-board-model.ts';
import { type TaskComment, type TaskThread } from './hub-detail-render.ts';
import { timeAgo } from './hub-presence-model.ts';
import { answeredByLine } from './hub-review-model.ts';
/** The verbatim words a tapped option recorded, when the payload still holds
 *  the candidate list. Undefined otherwise — the record never invents words.
 *  Exported because a ticket-borne item's answered record reads it too. */
export function optionLabel(r: ReviewPayload, optionId: string | undefined): string | undefined {
  if (optionId === undefined) return undefined;
  return r.options?.find((o) => o.id === optionId)?.label;
}

// ── What a repaint owes the person typing ──────────────────────────────────

type TextControl = HTMLTextAreaElement | HTMLInputElement;

/** What one text control held the instant before a repaint threw it away. */
export interface KeptField {
  value: string;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none';
  /** Where the caret was when the control is a live markdown composer. A
   *  ProseMirror position is not a string offset, so it needs its own slot —
   *  and it maps back exactly, because the restore puts the same markdown
   *  back before placing it. */
  composer: ComposerSelection | null;
}

/**
 * Snapshot every text control under `root` that carries a `data-keep` key.
 *
 * The detail panel is repainted by `replaceChildren` on every board change —
 * a task transition arriving over SSE, a reply landing, a picker list moving —
 * and a repaint rebuilds the composer, so whatever was typed and wherever the
 * caret was went with the old DOM. `discussionIsBusy` holds back one of those
 * doors (a discussion reload) and cannot see the others, so the guarantee
 * belongs here, at the one point every repaint passes through: read the
 * fields out before the swap, put them back after.
 *
 * The key is stamped by whoever builds the control and includes the task id,
 * so a draft belongs to the task it was typed on — the panel is one shared
 * container, and a half-typed comment must never follow the reader onto a
 * different task.
 */
export function keepFields(root: ParentNode): Map<string, KeptField> {
  const kept = new Map<string, KeptField>();
  for (const el of root.querySelectorAll<TextControl>('textarea[data-keep], input[data-keep]')) {
    const key = el.dataset.keep;
    if (!key) continue;
    // A composer's textarea is hidden behind its editor, so neither focus nor
    // the caret is on the element any more — both have to be asked of the
    // surface the reader is actually typing in. `composerSelection` answers
    // null for a plain control, which is what selects the other branch.
    const live = el instanceof HTMLTextAreaElement && composerState(el) === 'live';
    kept.set(key, {
      value: el.value,
      focused: live
        ? isComposerFocused(el as HTMLTextAreaElement)
        : el === el.ownerDocument.activeElement,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
      selectionDirection: el.selectionDirection ?? 'none',
      composer: live ? composerSelection(el as HTMLTextAreaElement) : null,
    });
  }
  return kept;
}

/**
 * Put a `keepFields` snapshot back into the freshly built controls under
 * `root`. Value always; focus and caret only for the field that HAD focus —
 * a draft the reader tapped away from is restored where it was, without
 * pulling focus back from wherever they went.
 */
export function restoreFields(root: ParentNode, kept: Map<string, KeptField>): void {
  for (const el of root.querySelectorAll<TextControl>('textarea[data-keep], input[data-keep]')) {
    const snap = el.dataset.keep ? kept.get(el.dataset.keep) : undefined;
    if (!snap) continue;
    el.value = snap.value;
    // The value is the composer's source of truth but not its content — put
    // the words back into the editor too. No-op on a plain control, and safe
    // before the editor's chunk has landed: it seeds from the value on mount.
    if (el instanceof HTMLTextAreaElement) refreshMarkdownComposer(el);
    if (!snap.focused) continue;
    // A box whose editor has not mounted yet still restores through here: the
    // focus is remembered and applied the moment it does.
    if (el instanceof HTMLTextAreaElement && composerState(el) !== 'none') {
      focusMarkdownComposer(el, snap.composer);
      continue;
    }
    el.focus();
    if (snap.selectionStart !== null && snap.selectionEnd !== null) {
      el.setSelectionRange(snap.selectionStart, snap.selectionEnd, snap.selectionDirection);
    }
  }
}

/**
 * Whether someone is mid-sentence in the discussion's composer.
 *
 * A live refresh repaints the panel, and a repaint rebuilds the composer —
 * so refreshing under someone's hands deletes what they were typing. This
 * is deliberately one-directional: the worst it can do is make a reply
 * appear when the reader stops typing rather than the instant it lands.
 */
export function discussionIsBusy(root: ParentNode): boolean {
  const composers = [...root.querySelectorAll<HTMLTextAreaElement>('.hub-discussion textarea')];
  return composers.some((ta) => ta.value.trim() !== '' || ta === ta.ownerDocument.activeElement);
}

/** One comment, in the single chronological sequence the panel shows. The
 *  `threadId` is the one thread fact a row still carries, as DATA rather than
 *  presentation: it is how a reply lands in the conversation the agent is
 *  watching. (opensThread/closesThread/status/anchorText are gone — they fed
 *  the Reply button, badge and anchor quote this surface no longer has.) */
export interface StreamComment {
  threadId: string;
  comment: TaskComment;
}

/**
 * Every comment on the task, oldest first, in ONE sequence.
 *
 * Bryan, 2026-08-18: *"multi-threaded comments are too complicated — just a
 * single sequence of comments with clearer separation, authorship and
 * timing."* So this is a change to the RENDERING and to nothing else. Threads
 * remain exactly as stored (34 of 37 on the live board carry a text anchor
 * into the description, and `resolve_thread` still means "this point is
 * handled") — the stream simply reads them in the order they were said, and
 * each row keeps its `threadId` so a reply still lands in the right
 * conversation.
 *
 * The tie-break is declaration order rather than nothing: two comments written
 * in the same millisecond are a fixture, not a race, and an unstable sort
 * would make the panel repaint into a different order for no reason.
 */
export function flattenComments(threads: TaskThread[]): StreamComment[] {
  const rows = threads.flatMap((t, ti) =>
    t.comments.map((c, ci) => ({
      order: ti * 1000 + ci,
      row: { threadId: t.id, comment: c } satisfies StreamComment,
    })),
  );
  rows.sort((a, b) =>
    a.row.comment.ts !== b.row.comment.ts ? a.row.comment.ts - b.row.comment.ts : a.order - b.order,
  );
  return rows.map((r) => r.row);
}

/**
 * One row of the task's comment history: a comment, or a review item raised
 * ON THE TICKET (`add_review_item(taskId, …)`), which has no comment of its
 * own and so was never in the stream at all.
 */
export type StreamEntry =
  | { kind: 'comment'; row: StreamComment }
  | { kind: 'review-item'; item: HubReviewItem };

/**
 * Has this ticket-borne item been put in front of the reader? A held or
 * still-being-judged item is on the ticket but not yet asked (it shows in the
 * held note, with the judge's reason); an answered one has been, whatever
 * the judge said — a person acted on it.
 */
function reviewItemAsked(item: HubReviewItem): boolean {
  if (item.answer !== undefined) return true;
  const verdict = item.judge?.verdict;
  return verdict !== 'held' && verdict !== 'pending';
}

/**
 * The task's whole discussion, oldest first: every comment on its threads AND
 * every review item raised on the ticket itself, at the moment it was raised.
 *
 * Bryan, 2026-09-01: *"Review items disappear and I can't find them any
 * more."* A ticket-borne item reached the panel only through the review-items
 * route, which ships what is still WAITING; the moment he answered one it
 * left that list, and nothing else read `task.reviews` except the held note.
 * Forty-five tasks on the live board carried answered items with no renderer.
 * A thread-borne item never had this problem — its declaring comment and the
 * reply that answered it are both comments — so the fix is to give the
 * ticket-borne item the same standing: a row in the history at its own time,
 * carrying its answered record once somebody has answered it.
 *
 * Comments keep `flattenComments`' order; an item raised in the same
 * millisecond as a comment sorts after it, deterministically.
 */
export function discussionStream(
  threads: TaskThread[],
  reviews: HubReviewItem[] | undefined,
): StreamEntry[] {
  const rows: Array<{ ts: number; order: number; entry: StreamEntry }> = flattenComments(
    threads,
  ).map((row, i) => ({ ts: row.comment.ts, order: i, entry: { kind: 'comment', row } }));
  (reviews ?? []).forEach((item, i) => {
    if (!reviewItemAsked(item)) return;
    rows.push({
      ts: item.createdAt ?? 0,
      order: 1_000_000 + i,
      entry: { kind: 'review-item', item },
    });
  });
  rows.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.order - b.order));
  return rows.map((r) => r.entry);
}

/**
 * Where the one composer's next comment lands.
 *
 * The reader is never asked and is never shown a choice: Bryan, 2026-08-18,
 * on seeing the version that offered one — *"Mocks still show threaded
 * comments design. I explicitly asked for that to be removed."* So this is
 * derivation, not selection. It goes to the thread the review queue sent the
 * reader here to answer, else the thread the NEWEST comment belongs to —
 * which is the conversation the composer sits directly under in the stream —
 * and on a task with no threads at all it returns null and the caller opens
 * one.
 *
 * Reading the newest off `flattenComments` rather than off `threads` matters:
 * the panel orders comments by TIME, so the last thread in the array and the
 * last thread on the screen are not the same thread once two conversations
 * interleave, and replying into the one that is no longer on screen would put
 * the answer somewhere the person cannot see it.
 */
export function composerTarget(threads: TaskThread[], focusThreadId?: string): TaskThread | null {
  const stream = flattenComments(threads);
  const newest = stream[stream.length - 1]?.threadId ?? threads[threads.length - 1]?.id ?? null;
  const wanted = focusThreadId ?? newest;
  if (wanted === null) return null;
  return threads.find((t) => t.id === wanted) ?? threads[threads.length - 1] ?? null;
}

/**
 * One comment, as the stream draws it — the row anatomy the task panel and
 * the goal panel share.
 *
 * Exported because the task detail island owns the `<ol>` these rows land in
 * but not the rows themselves: a comment row holds nothing a reader can be
 * part-way through, so rebuilding it on every paint costs nothing — while a
 * second copy of this markup in JSX would be a second thing to keep in step.
 */
export function commentRow(
  row: StreamComment,
  focusThreadId: string | undefined,
  now: number,
  selfName?: string,
): HTMLLIElement {
  const c = row.comment;
  const li = document.createElement('li');
  // Every comment is a peer of every other one. No resolved styling, no
  // "opens a thread" styling, no quoted anchor above the first of a run —
  // those were the last places the thread structure showed through, and
  // Bryan's instruction was to remove it from the UX, not only to remove the
  // buttons. `focus` survives because it is not about threads: it marks the
  // comment the review queue sent the reader here to read.
  li.className = [
    'hub-comment',
    c.review ? 'hub-comment-review' : '',
    row.threadId === focusThreadId ? 'hub-comment-focus' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Kept as DATA and rendered nowhere: it is how a reply reaches the agent
  // watching that conversation, and dropping it would make every answer a
  // new thread nobody is subscribed to.
  li.dataset.threadId = row.threadId;

  // Author AND time, both as text. The time used to live only in a `title`
  // attribute — which is a hover tooltip, and the reader this surface is
  // for is on a phone, where nothing hovers. "Who said this and when" was
  // therefore unanswerable on the device it mattered on.
  const head = document.createElement('div');
  head.className = 'hub-comment-head';
  const who = document.createElement('span');
  who.className = 'hub-comment-author';
  who.textContent = c.author;
  const when = document.createElement('span');
  when.className = 'hub-comment-when';
  when.textContent = timeAgo(c.ts, now);
  when.title = new Date(c.ts).toLocaleString();
  head.append(who, when);
  if (c.review) {
    // A WITHDRAWN item still belongs in the stream — it is history, and the
    // reader may already have acted on it — but badging it 'Question' is the
    // whole bug the verb exists to prevent, one surface over. The doc pane's
    // `reviewHeader` marks it the same way; both read the one predicate.
    head.append(reviewBadge(c.review.shape, reviewWithdrawn(c.review), reviewAnswered(c.review)));
  }
  // "Needs your reply" was a THREAD badge — it named a thread, because the
  // server's queue names threads — so it went with the rest of the thread
  // presentation. The signal did not go with it: everything waiting on the
  // reader now renders in the review queue at the TOP of the panel, which is
  // where they were told to look and is above the fold. A badge two hundred
  // pixels down a comment stream was the weaker of the two anyway.
  li.append(head);

  if (c.review) {
    // The declared headline, in the author's words. It goes ABOVE the
    // comment text rather than replacing it: the text is what the agent
    // said, the declaration is what it is asking for, and the two are not
    // the same sentence. The why paragraph is gone from here — it leads the
    // item card's markdown body at the top of the panel, and a second copy
    // in the stream was the duplication the one-card anatomy removes.
    const headline = document.createElement('p');
    headline.className = reviewWithdrawn(c.review)
      ? 'hub-comment-review-headline is-withdrawn'
      : 'hub-comment-review-headline';
    headline.textContent = c.review.headline;
    li.append(headline);
  }

  const body = document.createElement('div');
  body.className = 'hub-comment-body';
  // Same escape-then-allow-known-tags path the description uses, so a
  // comment written by anyone with write access is inert markup.
  body.innerHTML = renderCommentMarkdown(c.text);
  li.append(body);
  if (c.review && reviewAnswered(c.review)) {
    // The answered state ON the declaration, in the history. The reply that
    // answered it is also in the stream, further down — but a reader scanning
    // for "what did I decide on this" finds it here, against the question.
    li.classList.add('hub-comment-answered-item');
    const r = c.review;
    li.append(
      answeredRecord(
        {
          ...(r.answeredBy !== undefined ? { by: r.answeredBy } : {}),
          ...((r.answerText ?? optionLabel(r, r.answeredWith)) !== undefined
            ? { text: r.answerText ?? optionLabel(r, r.answeredWith) }
            : {}),
          ...(r.answeredAt !== undefined ? { at: r.answeredAt } : {}),
        },
        now,
        selfName,
      ),
    );
  }
  return li;
}

/** The kind chip on a review row — one spelling for a comment-borne and a
 *  ticket-borne item, so the two cannot read differently. Withdrawn wins
 *  over the kind: a retracted ask must not be badged as a question. */
export function reviewBadge(
  shape: ReviewShape | undefined,
  withdrawn: boolean,
  answered: boolean,
): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = withdrawn
    ? 'hub-comment-review-k is-withdrawn'
    : answered
      ? 'hub-comment-review-k is-answered'
      : 'hub-comment-review-k';
  badge.textContent = withdrawn ? 'Withdrawn' : shape === 'decision' ? 'Decision' : 'Question';
  return badge;
}

/**
 * "Answered by Bryan: “Read-only reference” · 2h ago" — the record under a
 * review row in the history. The same words as the panel's answered card
 * (`answeredByLine`), so the reader's own answer says "you" on both.
 */
export function answeredRecord(
  answer: { by?: string; text?: string; at?: number },
  now: number,
  selfName: string | undefined,
): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'hub-comment-answered';
  const words = document.createElement('span');
  words.className = 'hub-comment-answered-text';
  words.textContent = `${answeredByLine(answer.by, selfName)}${answer.text ?? ''}”`;
  p.append(words);
  if (answer.at !== undefined && answer.at > 0) {
    const when = document.createElement('span');
    when.className = 'hub-comment-when';
    when.textContent = timeAgo(answer.at, now);
    when.title = new Date(answer.at).toLocaleString();
    p.append(when);
  }
  return p;
}
