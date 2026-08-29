/**
 * The task detail panel — the ticket a reader opens to answer something — as a
 * Preact island.
 *
 * `renderTaskDetail` rebuilt the whole panel with `replaceChildren()` on every
 * `thread.*` and `task.transitioned` event, and the board emits those
 * constantly. Everything the panel was HOLDING died with each rebuild, and
 * every rescue had to be hand-built against the same one-line window before
 * the swap:
 *
 *   - `keepFields` / `restoreFields` snapshotted the drafts out of the doomed
 *     DOM and wrote them back into the fresh one, caret and all;
 *   - `priorTab` read which tab was showing off `panel.dataset.tab`;
 *   - `priorReviewIndex` / `priorReviewItemId` read the queue's position off
 *     `.hub-decide`'s dataset;
 *   - `priorQuoteOpen` read whether the reader had unfolded the preserved
 *     capture off the `<details>` a line before it was destroyed.
 *
 * Every one of those was a workaround for the node being thrown away, and all
 * four are gone. `TaskDetailPanel` is keyed on `task.id`, so a repaint of the
 * SAME task reuses the instance and its DOM — the tab and the queue position
 * are `useState`, the `<details>`'s `open` is the node's own (Preact is never
 * told about it, so it never writes it back), and an uncontrolled `<textarea>`
 * that keeps its node keeps its words, its focus and its caret for free.
 * Moving to another task changes the key, which unmounts the panel — so the
 * next ticket opens on Comments, with the capture folded and an empty box,
 * which is the other half of the guarantee.
 *
 * The bridge is one-directional, as in the board, Home-review, presence and
 * walkthrough islands: `renderDetail` in hub-app still owns the fetches, the
 * projection and the audit rows, and writes them into `taskDetailData`; the
 * island only reads.
 *
 * Two things ride the signal rather than being bound at mount, both for the
 * walkthrough's reason — they answer about THIS paint:
 *
 *   - the HANDLERS, which close over the task, the review rows, the blocked
 *     row and the clock the loader resolved for this paint;
 *   - the DISCUSSION, which is refetched per task.
 *
 * And two kinds of node are deliberately not Preact's children, because they
 * re-parent or replace their own DOM and Preact would drag them back on the
 * next diff:
 *
 *   - every composer `<form>` — `attachMarkdownComposer` REPLACES the textarea
 *     with a wrapper and moves it (design point 4). The form element is
 *     Preact's and its children are not: a vnode with no children is diffed
 *     against nothing, so nothing inside is touched.
 *   - the description slot and the title `<h2>` — the live Tiptap editor mounts
 *     INTO the slot, and `wireInPlaceTitle` swaps the heading's text for an
 *     `<input>` mid-rename. Same trick, same reason: an element with no vnode
 *     children is an element Preact never reaches into.
 */
import { reviewItemBodyMarkdown } from '@feedback/core';
import { signal } from '@preact/signals';
import { type ComponentChildren, Fragment, type RefObject, render } from 'preact';
import { type MutableRef, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { renderCommentMarkdown, renderCommentMarkdownInline } from '../comment-markdown.ts';
import { SPACE_HOLD_PAGE_ATTR } from '../voice-capture.ts';
import { ageShort } from './activity-model.ts';
import { ComposerForm, Discussion, useFill } from './detail-parts.tsx';
import {
  type ActivityEvent,
  type HubDecisionOption,
  type HubNote,
  type HubTask,
  answeredByLine,
  askedMetaLine,
  blockedNoteLine,
  isTaskArchived,
  taskActivity,
} from './hub-model.ts';
import {
  BODY_LIVE_CLASS,
  type DetailHandlers,
  type PanelReviewItem,
  type TaskDiscussion,
  activityRow,
  bodySlot,
  detailFields,
  panelReviewQueue,
  renderTaskLinks,
  renderTransitionRow,
  wireInPlaceTitle,
} from './hub-render.ts';
import { markPhrase } from './review-item-phrase.ts';
import { selectWordAtPoint, useSelectionPill } from './selection-pill.ts';
import { NOBODY, type OpenComment, ThreadCard, draftThread } from './thread-card.tsx';

// ── The contract with the vanilla loader ───────────────────────────────────

export interface TaskDetailView {
  /** The open ticket, or `null` for a closed panel. */
  task: HubTask | null;
  /** The task's comments, as fetched. Absent while the app has not asked. */
  discussion?: TaskDiscussion;
  /** Which tab the panel OPENS on — read once, when the panel for this task
   *  mounts; the reader's own switches win after that. Absent means
   *  Comments. The Home activity pane's title tap asks for Activity, since
   *  the reader was already looking at what happened to the task. */
  tab?: DetailTab;
  /** Aimed at the task this paint draws — see the head of the file for why
   *  these travel with the data rather than being bound at mount. */
  handlers: DetailHandlers;
}

/** A closed panel answers nothing, which is what the signal holds until the
 *  loader's first write. */
const IDLE_HANDLERS: DetailHandlers = {
  onClose: () => {},
  onStatusSet: () => {},
  onTitleCommit: () => {},
  onAnswer: () => undefined,
  onAssign: () => {},
};

/** The one write target the vanilla loader has for the detail panel. */
export const taskDetailData = signal<TaskDetailView>({
  task: null,
  handlers: IDLE_HANDLERS,
});

/** The two tabs at the bottom of the panel, and which one is showing. */
export type DetailTab = 'comments' | 'activity';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'comments', label: 'Comments' },
  { id: 'activity', label: 'Activity' },
];

// ── What is waiting on the reader ──────────────────────────────────────────

/**
 * What was decided — and the way back out of it.
 *
 * Answering is a single click with no confirmation step, which is the right
 * cost for the common case and unrecoverable for the stray one. The recovery
 * is a persistent UNDO rather than a confirm dialog or a five-second toast: it
 * does not tax the 99% of taps that are deliberate, it is still there when the
 * reader notices a minute later, and it survives a reload because it is
 * rendered from the stored answer rather than from a timer nobody can see.
 */
function UndoAnswer(props: { undo: () => Promise<boolean> | undefined }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      class="hub-btn hub-detail-undo-answer"
      disabled={busy}
      title="Take this answer back — it reopens the decision and keeps a record"
      aria-label="Undo this answer and reopen the decision"
      onClick={() => {
        // Disabled for the round trip. On success the panel repaints without
        // this note. On FAILURE the handler resolves `false` — the app's
        // `send()` never rejects — and nothing repaints, so re-enabling on
        // that resolved `false` is the only thing that gives the reader a
        // retry on a quiet board; the `.catch` alone could never fire.
        setBusy(true);
        void Promise.resolve(props.undo())
          .then((ok) => {
            if (ok === false) setBusy(false);
          })
          .catch(() => setBusy(false));
      }}
    >
      Undo
    </button>
  );
}

/** The task's own recorded answer — in the same voice as every other
 *  answered record ("Answered by you" when the reader answered), because it
 *  is the same record. */
function TaskAnsweredNote(props: { task: HubTask; handlers: DetailHandlers }) {
  const { task, handlers } = props;
  const answer = task.answer;
  return (
    <div class="hub-detail-answered">
      <p class="hub-detail-answer">
        {answer ? `${answeredByLine(answer.by, handlers.selfName)}${answer.text}”` : ''}
      </p>
      {handlers.onUndoAnswer && <UndoAnswer undo={() => handlers.onUndoAnswer?.(task)} />}
    </div>
  );
}

/**
 * The answered RECORD for a thread-borne item, in place: the same anatomy as
 * the task decision's, because a typed answer and a tapped option produce the
 * identical record (approved design). "you" when the reader is the one who
 * answered; the answer's words render markdown-inline, since they are a
 * comment's words.
 */
function ThreadAnsweredNote(props: {
  task: HubTask;
  item: PanelReviewItem;
  answered: NonNullable<PanelReviewItem['answered']>;
  handlers: DetailHandlers;
}) {
  const { task, item, answered, handlers } = props;
  // No comment id means the undo route has nothing to name — the record still
  // renders, without a button that could only 400.
  const undoable = handlers.onUndoThreadAnswer !== undefined && item.commentId !== undefined;
  return (
    <div class="hub-detail-answered">
      <p class="hub-detail-answer">
        {answeredByLine(answered.by, handlers.selfName)}
        <span
          class="hub-answer-words"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderCommentMarkdownInline escapes first and re-adds only known-safe tags.
          dangerouslySetInnerHTML={{ __html: renderCommentMarkdownInline(answered.text ?? '') }}
        />
        {'”'}
      </p>
      {undoable && <UndoAnswer undo={() => handlers.onUndoThreadAnswer?.(task, item)} />}
    </div>
  );
}

/** The asker's candidates. The LABEL is the verbatim answer and the id says
 *  which candidate it was, so a tap and typed words land in the same field. */
function DecideOptions(props: {
  options: HubDecisionOption[];
  busy: boolean;
  onPick: (option: HubDecisionOption) => void;
}) {
  return (
    <div class="hub-decide-options">
      {props.options.map((o) => (
        <button
          key={o.id}
          type="button"
          class="hub-decide-option"
          disabled={props.busy}
          onClick={() => props.onPick(o)}
        >
          <span class="hub-decide-option-label">{o.label}</span>
          {o.detail && <span class="hub-decide-option-detail">{o.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * One item's card: the head row and body, then the ways to answer it — or the
 * answered record, once somebody has.
 *
 * Keyed on `PanelReviewItem.id` by its caller, which is what lets a reader
 * walk to another question and back without losing the answer they were
 * drafting for either.
 */
function ReviewCard(props: {
  task: HubTask;
  item: PanelReviewItem;
  handlers: DetailHandlers;
  now: number;
  shown: boolean;
}) {
  const { task, item, handlers, now, shown } = props;
  const [busy, setBusy] = useState(false);

  // Answering the task's own decision goes through `answer_decision`; every
  // other card — a thread-borne item, answered by a REPLY on its thread so the
  // agent watching it hears it, or a ticket-borne item, answered at the task
  // review-item route — goes through the item handler, which reads the
  // destination off the item (`panelAnswerRequest`). Keyed on `source`, not
  // on `threadId`: a ticket-borne card has no thread, and the old test sent it
  // to the decision route, where its answer would have landed on the WRONG
  // question.
  const answer = (text: string, optionId?: string): Promise<boolean> | undefined => {
    const sent =
      item.source === 'task'
        ? handlers.onAnswer(task, text, optionId)
        : handlers.onAnswerThread?.(task, item, text, optionId);
    return sent;
  };

  const bodyMarkdown = reviewItemBodyMarkdown(item);
  // The headline is dropped when it came out as the ticket title anyway:
  // `panelReviewQueue` falls back to `task.title` for a decision whose body
  // yields no blurb, and this card renders directly under the panel's own
  // `.hub-detail-title`, so the reader would get the same words twice in a
  // row. Only when the body below still says something, though — the fallback
  // exists so an unreadable body yields the title rather than a card that says
  // nothing at all.
  const echoesTitle = item.headline.trim() === task.title.trim();

  const classes = ['hub-decide-card'];
  if (busy) classes.push('is-busy');
  if (!shown) classes.push('hidden');

  return (
    <div
      class={classes.join(' ')}
      data-review-item-id={item.id}
      // Routing data, and what the focus-scroll guard reads to tell whether
      // the thread a deep link named is already hoisted to the top.
      {...(item.threadId ? { 'data-review-thread-id': item.threadId } : {})}
    >
      {/* ONE anatomy (approved design, review-flow-mock-v1): a head row — kind
          badge, the headline, the asked-by meta top-right — then one markdown
          body. */}
      <div class="hub-decide-card-head">
        {/* New UI text says Question; the class token stays `review` — stored
            vocabulary and tone classes are unchanged by the rename. */}
        <span
          class={`hub-decide-k hub-decide-k-${item.shape === 'decision' ? 'decision' : 'review'}`}
        >
          {item.shape === 'decision' ? 'Decision' : 'Question'}
        </span>
        {/* The owner revised the words after the reader asked on them: the
            item is back in the queue and says so, beside its kind rather than
            instead of it — the walkthrough's own treatment. */}
        {item.revision && <span class="hub-decide-k hub-decide-k-revised">Revised</span>}
        {!(echoesTitle && bodyMarkdown !== '') && (
          <p class="hub-decide-headline">{item.headline}</p>
        )}
        <p class="hub-decide-meta">
          {askedMetaLine(item.askedBy, item.asked ?? true, item.since, now)}
        </p>
      </div>
      {/* The reader asked in their own words; the card gives those words
          back so "what did I ask?" is answered before "what changed?". The
          thread itself is in the discussion below — this is its panel. */}
      {item.revision?.question !== undefined && (
        <blockquote class="hub-decide-question">{`You asked: “${item.revision.question}”`}</blockquote>
      )}
      {bodyMarkdown !== '' && (
        <div
          class="hub-decide-body"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderCommentMarkdown escapes first and re-adds only known-safe tags.
          dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(bodyMarkdown) }}
        />
      )}
      {item.answered ? (
        <ThreadAnsweredNote task={task} item={item} answered={item.answered} handlers={handlers} />
      ) : (
        <Fragment>
          {item.options && item.options.length > 0 && (
            <DecideOptions
              options={item.options}
              busy={busy}
              onPick={(o) => {
                setBusy(true);
                void Promise.resolve(answer(o.label, o.id)).finally(() => setBusy(false));
              }}
            />
          )}
          {/* Always present, options or not: the candidates are a shortcut,
              never a closed set. */}
          <ComposerForm
            className="hub-answer-form hub-decide-form"
            // Says which of the two this box is. With options above it and no
            // line between, the box read as a required second step rather than
            // as an alternative.
            hint={
              item.options && item.options.length > 0
                ? 'Or answer in your own words'
                : 'Answer in your own words'
            }
            placeholder="Record your answer, verbatim…"
            submitLabel="Record answer"
            submitClass="hub-btn hub-btn-primary"
            rows={3}
            emptyMessage="Write an answer first"
            // Keyed by ITEM, so walking to the next question and back does not
            // hand the reader the answer they were drafting for a different
            // one.
            keepKey={`answer:${task.id}:${item.id}`}
            onSubmit={(text) => answer(text)}
            // Only an explicit `false` is a refusal. A handler that returns
            // nothing has said nothing about success, and reading that as
            // failure would put a "your words are still in the box" story over
            // a write that landed.
            refused={(ok) => ok === false}
            onBusy={setBusy}
          />
        </Fragment>
      )}
    </div>
  );
}

/**
 * The review queue INSIDE a ticket: what is waiting on the reader, one item
 * expanded, with a walkthrough when there is more than one.
 *
 * Every item is BUILT and the walkthrough only changes which one is SHOWN —
 * stepping the queue must not tear down the answer box the reader may be
 * typing in.
 *
 * The position is the ITEM, not its number. A repaint that inserts an item
 * ahead (a peer's undo puts the task's own decision back at rank 0) must not
 * swap which question is under the reader mid-thought; the numeric index is
 * only the fallback for when the kept item itself left the queue.
 */
function ReviewRegion(props: {
  task: HubTask;
  handlers: DetailHandlers;
  now: number;
  discussion?: TaskDiscussion;
}) {
  const { task, handlers, now, discussion } = props;
  // `index < 0` means "nothing has been walked to yet" — so a deep link into a
  // thread opens the queue AT that thread's item rather than at whatever
  // happened to be first. State rather than a reading of `.hub-decide`'s
  // dataset: the instance is the place, and it outlives every repaint.
  const [pos, setPos] = useState<{ index: number; itemId: string | null }>({
    index: -1,
    itemId: null,
  });

  const answered = task.answer ? <TaskAnsweredNote task={task} handlers={handlers} /> : null;
  const queue = panelReviewQueue(task, handlers.asks, discussion);
  if (queue.length === 0) {
    // The answered line is one PART of the region rather than the whole of it:
    // retiring the region on an answered decision left a task with two open
    // thread items showing no queue at all.
    if (!answered) return null;
    return <section class="hub-decide hub-decide--answered">{answered}</section>;
  }

  const linked =
    pos.index < 0 && handlers.focusThreadId
      ? queue.findIndex((i) => i.threadId === handlers.focusThreadId)
      : -1;
  const kept = pos.itemId !== null ? queue.findIndex((i) => i.id === pos.itemId) : -1;
  const wanted = linked >= 0 ? linked : kept >= 0 ? kept : pos.index;
  const at = Math.min(Math.max(Number.isInteger(wanted) ? wanted : 0, 0), queue.length - 1);
  const item = queue[at];
  const step = (i: number): void => {
    const to = Math.min(Math.max(i, 0), queue.length - 1);
    setPos({ index: to, itemId: queue[to]?.id ?? null });
  };

  // Two headings, and a settled item is neither: the card below it is the
  // RECORD, and the kicker says so.
  const kicker =
    item?.answered !== undefined
      ? 'Answered'
      : item?.shape === 'decision'
        ? 'Waiting on your decision'
        : 'Waiting on your review';

  return (
    <section class="hub-decide" data-review-index={String(at)} data-review-item-id={item?.id ?? ''}>
      {answered}
      <div class="hub-decide-head">
        <p class="hub-decide-kicker">{kicker}</p>
        {/* The walkthrough chrome appears only from two items up. With one —
            the common case — a "1 of 1" counter and two dead arrows are
            furniture that says nothing. */}
        {queue.length > 1 && (
          <div class="hub-decide-walk">
            <button
              type="button"
              class="hub-btn hub-decide-step"
              aria-label="Previous item"
              disabled={at === 0}
              onClick={() => step(at - 1)}
            >
              ‹
            </button>
            <span class="hub-decide-count">{`${at + 1} of ${queue.length}`}</span>
            <button
              type="button"
              class="hub-btn hub-decide-step"
              aria-label="Next item"
              disabled={at === queue.length - 1}
              onClick={() => step(at + 1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
      {queue.map((q, qi) => (
        <ReviewCard
          key={q.id}
          task={task}
          item={q}
          handlers={handlers}
          now={now}
          shown={qi === at}
        />
      ))}
    </section>
  );
}

// ── The Activity feed ──────────────────────────────────────────────────────

/**
 * One entry of the feed, whatever it came from: a stored transition, an
 * audit row from the workspace log, or a note. Keyed on its own facts rather
 * than its position, so a note landing on top of the list leaves every
 * other row's node — and the thread card open under one of them — where it
 * was.
 */
interface FeedEntry {
  key: string;
  ts: number;
  kind: 'move' | 'event' | HubNote['kind'];
  note?: HubNote;
  build?: () => HTMLLIElement;
}

/** ONE feed, newest first (Bryan, 2026-08-29: *"all task events as well as
 *  agent end of turn updates in one feed"*). */
function feedOf(task: HubTask, events: ActivityEvent[] | undefined): FeedEntry[] {
  const entries: FeedEntry[] = [
    ...task.transitions.map((t) => ({
      key: `move:${t.ts}:${t.from}:${t.to}`,
      ts: t.ts,
      kind: 'move' as const,
      build: () => renderTransitionRow(t),
    })),
    ...taskActivity(events, task.id).map((e) => ({
      key: `event:${e.ts}:${e.event}`,
      ts: e.ts,
      kind: 'event' as const,
      build: () => activityRow(e, task.title),
    })),
    ...(task.notes ?? []).map((n) => ({
      key: `note:${n.at}:${n.kind}:${n.agent}`,
      ts: n.at,
      kind: n.kind,
      note: n,
    })),
  ];
  // Stable sort: at an equal timestamp a move stays above an audit row,
  // and both above a note — the build order, pinned by test.
  return uniqueKeys(entries.sort((a, b) => b.ts - a.ts));
}

/** Two notes in the same millisecond from one agent (a retried post, two
 *  quick statuses) share every fact the key is built from; a repeat gets a
 *  serial so Preact keeps both rows. Serials follow the sorted order, so
 *  they are as stable as the facts are. */
function uniqueKeys(entries: FeedEntry[]): FeedEntry[] {
  const seen = new Map<string, number>();
  for (const e of entries) {
    const n = seen.get(e.key) ?? 0;
    seen.set(e.key, n + 1);
    if (n > 0) e.key = `${e.key}#${n}`;
  }
  return entries;
}

/** The word on a note's kind token. A denial says what it is — a refusal —
 *  rather than the store's name for it. */
const KIND_LABEL: Record<HubNote['kind'], string> = {
  turn: 'turn',
  status: 'status',
  denial: 'blocked',
};

/** Past this a note folds behind "more": HEIGHT is the scarce axis at
 *  1180×820, and a full end-of-turn message can run to forty lines. Counted
 *  on the text — happy-dom measures nothing, and a rule the reader can
 *  predict beats one that depends on the panel's width. */
const FOLD_LINES = 6;
const FOLD_CHARS = 600;
function isLongNote(text: string): boolean {
  return (
    text.split('\n').filter((l) => l.trim() !== '').length > FOLD_LINES || text.length > FOLD_CHARS
  );
}

/** The phrase an open thread is about, marked the way the editor marks a
 *  thread's ACTIVE range. */
const ACTIVE_MARK = 'thread-range active';

/**
 * A move or an audit row: the words the vanilla renderer already builds for
 * the workspace trail, filled into a span Preact owns and never reaches
 * into. The mark, when there is one, goes on after the fill.
 *
 * Filled only when the WORDS change, not on every paint: a refill swaps the
 * text nodes, and the reader's selection — the one the pill is about to
 * offer a comment on — was in the old ones. The pill's own state change is
 * a paint, so a per-paint fill hid the pill the moment it was earned.
 */
function BuiltRow(props: { entry: FeedEntry; mark?: string; children?: ComponentChildren }) {
  const { entry, mark } = props;
  const wordsRef = useRef<HTMLSpanElement | null>(null);
  const built = entry.build?.();
  const words = built?.textContent ?? '';
  useLayoutEffect(() => {
    const el = wordsRef.current;
    if (!el || !built) return;
    el.replaceChildren(...built.childNodes);
    if (mark) markPhrase(el, mark, ACTIVE_MARK);
    // `built` is rebuilt each render; the words are what decide a refill.
  }, [entry.key, words, mark]);
  const classes = ['hub-hist-row', `hub-hist-row-${entry.kind}`];
  if (built?.className) classes.push(built.className);
  return (
    <li class={classes.join(' ')} title={built?.title ?? ''} data-hist-key={entry.key}>
      <span ref={wordsRef} class="hub-hist-words" />
      {props.children}
    </li>
  );
}

/**
 * A note, in FULL: the agent, its kind, the age, then the whole text as
 * comment markdown (the same renderer the discussion uses — a turn note is
 * an end-of-turn message, which is prose with lists and fences). A denial
 * shows its shape in code under the "blocked" token.
 *
 * The body is Preact's element with no vnode children — its HTML is written
 * in a layout effect keyed on the text and the mark — so a repaint of the
 * same task leaves the rendered words (and the mark on them) alone, and a
 * selection in them survives the board events that arrive while the reader
 * is choosing a phrase.
 */
function NoteRow(props: {
  entry: FeedEntry;
  note: HubNote;
  now: number;
  mark?: string;
  children?: ComponentChildren;
}) {
  const { entry, note, now, mark } = props;
  const [unfolded, setUnfolded] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const { text, kind } = note;
  const long = isLongNote(text);
  const folded = long && !unfolded;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (kind === 'denial') {
      // The kind token above already reads "blocked"; the body is just the
      // shape (the Home pane, with no token, keeps DENIAL_PREFIX).
      const shape = document.createElement('code');
      shape.className = 'acti-shape';
      shape.textContent = text;
      el.replaceChildren(shape);
    } else {
      // Same escape-then-allow-known-tags path every comment takes.
      el.innerHTML = renderCommentMarkdown(text);
    }
    if (mark) markPhrase(el, mark, ACTIVE_MARK);
  }, [text, kind, mark]);
  return (
    <li
      class={`hub-hist-row hub-hist-row-${kind}`}
      title={new Date(note.at).toLocaleString()}
      data-hist-key={entry.key}
    >
      <div class="hub-note-head">
        <span class="hub-note-agent">{note.agent}</span>
        <span class="hub-note-kind">{KIND_LABEL[kind]}</span>
        <span class="hub-note-age">{ageShort(note.at, now)}</span>
      </div>
      <div ref={bodyRef} class={`hub-note-body${folded ? ' is-folded' : ''}`} />
      {long && (
        <button
          type="button"
          class="hub-note-more"
          aria-expanded={unfolded ? 'true' : 'false'}
          onClick={() => setUnfolded((u) => !u)}
        >
          {unfolded ? 'less' : 'more'}
        </button>
      )}
      {props.children}
    </li>
  );
}

// ── The panel's other regions ──────────────────────────────────────────────

/**
 * The RECORD: the feed, the words the task came from, the leftover fields,
 * the link chips. Behind a second tab because it used to sit inline under
 * the discussion, so scrolling to the bottom of a conversation meant
 * scrolling through a transition list first.
 *
 * The feed takes comments the way the Home pane's lines do: select (or tap)
 * words of a note or of a row → the shared comment pill → the real thread
 * card under THAT row, quoting the phrase; Reply opens a subject thread on
 * the task's doc (`activityCommentRequest`). The tab is one column, so the
 * card goes under the row rather than beside it. An open draft and the
 * words in its box survive a repaint — the card is keyed on the row and
 * holds the draft thread object rather than rebuilding it per paint.
 */
function ActivityTab(props: { task: HubTask; handlers: DetailHandlers; hidden: boolean }) {
  const { task, handlers, hidden } = props;
  const now = handlers.now ?? Date.now();
  const historyRef = useRef<HTMLUListElement | null>(null);
  const metaRef = useRef<HTMLDListElement | null>(null);
  const linksRef = useRef<HTMLDivElement | null>(null);
  const feed = feedOf(task, handlers.activity);
  const hasFeed = feed.length > 0;
  const canComment = handlers.onActivityComment !== undefined;
  const user = handlers.user ?? NOBODY;

  const pill = useSelectionPill(
    historyRef as MutableRef<HTMLElement | null>,
    !hidden && canComment,
  );
  const [open, setOpen] = useState<OpenComment | null>(null);
  // Escape puts a draft away. A posted thread's card stays — it is a real
  // thread now, and the way to it is to fold it like any card.
  useLayoutEffect(() => {
    if (!open || open.thread !== null) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // "Tap a word to select it" on the words — and only the words: a tap on
  // the fold toggle, the head, or the card's own box is not a selection.
  useLayoutEffect(() => {
    const el = historyRef.current;
    if (!el || !canComment) return;
    const tapWord = (ev: MouseEvent): void => {
      const target = ev.target as Element | null;
      if (!target?.closest('.hub-note-body, .hub-hist-words')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      selectWordAtPoint(ev.clientX, ev.clientY, el);
    };
    el.addEventListener('click', tapWord);
    return () => el.removeEventListener('click', tapWord);
  }, [hasFeed, canComment]);

  // The row the selection sits in — and only when the words are the row's
  // own: a note's body or a move's / audit row's sentence. An agent's name,
  // a kind token, an age, the fold toggle and the card's own text are the
  // feed's chrome, so a selection there gets no pill.
  const rowKey = pill.phrase
    ? pill.at
        ?.closest<HTMLElement>('.hub-note-body, .hub-hist-words')
        ?.closest<HTMLElement>('li.hub-hist-row')?.dataset.histKey
    : undefined;
  const openCard = (): void => {
    if (!pill.phrase || !rowKey) return;
    setOpen({
      key: rowKey,
      phrase: pill.phrase,
      thread: null,
      draft: draftThread(`${task.id}:${rowKey}`, pill.phrase, user, now),
    });
    pill.clear();
    window.getSelection()?.removeAllRanges();
  };
  const reply = async (text: string): Promise<boolean> => {
    if (!open) return false;
    const t = open.thread
      ? await handlers.onActivityReply?.(task, open.thread.id, text)
      : await handlers.onActivityComment?.(task, { text: open.phrase }, text);
    if (!t) return false;
    setOpen((o) => (o ? { ...o, thread: t } : o));
    return true;
  };

  // What is left of the old definition list: reference material. `Goal` and
  // `Due` are not repeated here — they are in the fields row above.
  const meta: [string, string][] = task.after.length > 0 ? [['After', task.after.join(', ')]] : [];
  useFill(metaRef as RefObject<HTMLElement>, () =>
    meta.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );

  const links = renderTaskLinks(task);
  useFill(linksRef as RefObject<HTMLElement>, () => [...(renderTaskLinks(task)?.childNodes ?? [])]);

  return (
    <div
      class={`hub-detail-tabpanel hub-detail-tabpanel-activity${hidden ? ' hidden' : ''}`}
      role="tabpanel"
    >
      {!hasFeed && (
        <p class="hub-hist-empty">Nothing yet — the first move, edit or note lands here.</p>
      )}
      {hasFeed && (
        <Fragment>
          <h3 class="hub-detail-subhead">History</h3>
          <ul ref={historyRef} class="hub-detail-transitions">
            {feed.map((entry) => {
              const isOpen = open !== null && open.key === entry.key;
              const mark = isOpen ? open.phrase : undefined;
              const card = isOpen ? (
                <ThreadCard
                  key="card"
                  thread={open.thread ?? open.draft}
                  user={user}
                  onReply={reply}
                  onFold={() => {
                    // Folding a POSTED thread's card is the card's own fold;
                    // only a draft has nothing to keep.
                    if (open.thread === null) setOpen(null);
                  }}
                />
              ) : null;
              return entry.note ? (
                <NoteRow key={entry.key} entry={entry} note={entry.note} now={now} mark={mark}>
                  {card}
                </NoteRow>
              ) : (
                <BuiltRow key={entry.key} entry={entry} mark={mark}>
                  {card}
                </BuiltRow>
              );
            })}
          </ul>
        </Fragment>
      )}
      {/* The shared pill, on the feed: fixed-position, placed by the hook
          beside the selection's end. `mousedown` is swallowed so the tap does
          not blur the selection before the click lands (touch is left alone,
          since cancelling it cancels the click on iOS). */}
      {canComment && (
        <button
          type="button"
          class={`comment-pill hub-hist-pill${rowKey ? '' : ' hidden'}`}
          style={{ left: `${pill.place.left}px`, top: `${pill.place.top}px` }}
          aria-label="Comment on this"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={openCard}
        >
          💬
        </button>
      )}
      {/*
       * The words the task came from, kept verbatim — collapsed, and below the
       * description rather than above it. The LABEL settles two readings an
       * unlabelled blockquote invites ("here is what you said, check I
       * understood it" versus "here is a source somebody chose to quote"),
       * which want opposite reactions. "Original words" rather than anything
       * naming a person: the preserved pre-rewrite body of an agent-created
       * row is not something a human said, and a label that lies is worse than
       * no label.
       *
       * `open` is deliberately NOT a prop. Preact writes a DOM property only
       * when the prop CHANGES, so an attribute it was never told about is one
       * it never writes — which leaves the reader's own toggle as the single
       * source of truth, kept by the node surviving the repaint. Opening a
       * different task remounts the panel, so the next capture starts folded.
       */}
      {task.quote && (
        <details class="hub-detail-quote-block">
          <summary
            class="hub-detail-quote-label"
            title="The words this task came from, kept verbatim."
          >
            Original words
          </summary>
          <blockquote class="hub-detail-quote">{task.quote}</blockquote>
        </details>
      )}
      {meta.length > 0 && <dl ref={metaRef} class="hub-detail-meta" />}
      {links !== null && <div ref={linksRef} class="hub-detail-links" />}
      <p class="hub-detail-body-link">
        {/* A secondary way in, not the way to edit: the same room in the full
            review surface, for anchored comments and the wider page. */}
        <a href={`/review/${encodeURIComponent(task.bodyDocId)}`}>Open in the full editor</a>
      </p>
    </div>
  );
}

// ── The panel ──────────────────────────────────────────────────────────────

/**
 * One ticket's panel. Mounted under `key={task.id}`, which is the whole point:
 * a repaint of the same task reuses this instance — so the tab, the queue
 * position, the unfolded capture and every composer's draft survive it — and
 * moving to another task unmounts it, so nothing the last ticket was holding
 * follows the reader onto the next one.
 */
function TaskDetailPanel(props: {
  host: HTMLElement;
  task: HubTask;
  discussion?: TaskDiscussion;
  handlers: DetailHandlers;
  initialTab?: DetailTab;
}) {
  const { host, task, discussion, handlers } = props;
  const now = handlers.now ?? Date.now();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const fieldsRef = useRef<HTMLDListElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<DetailTab>(props.initialTab ?? 'comments');
  // Full screen is a preference of the READER, not of the task, so it lives on
  // the container and survives both a repaint and a move to another task.
  const [full, setFull] = useState(host.classList.contains('hub-detail--full'));

  // What the title and the composers need at the moment they fire, rather than
  // at the moment they were wired.
  const latest = useRef({ task, handlers });
  latest.current = { task, handlers };

  // The title is Preact's element with no vnode children, because
  // `wireInPlaceTitle` swaps its text for an `<input>` mid-rename — and an
  // element with no children is diffed against nothing, so a rename in flight
  // now simply survives a repaint instead of being snapshotted through one.
  const beginRename = useRef<((caret?: number) => void) | null>(null);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    beginRename.current = wireInPlaceTitle(
      el,
      // Empty for an unnamed row: the placeholder is the server's stand-in,
      // and a rename that started on it would begin by deleting it.
      () => (latest.current.task.untitled ? '' : latest.current.task.title),
      (v) => latest.current.handlers.onTitleCommit(latest.current.task, v),
      undefined,
      { placeholder: () => latest.current.task.title },
    );
  }, []);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    // The dressing follows the projection: muted while the row has no name,
    // plain the paint after one lands.
    el.classList.toggle('hub-detail-title-placeholder', task.untitled === true);
    // Not while the reader is renaming: writing the stored title over the
    // input would delete what they are typing.
    if (!el.querySelector('input')) el.textContent = task.title;
  });

  useFill(fieldsRef as RefObject<HTMLElement>, () => [...detailFields(task, handlers).childNodes]);

  // The description slot is the one node a repaint must never rebuild: the
  // live editor is a ProseMirror view bound to a Yjs room, and even MOVING the
  // node removes it from the document first, which blurs it and drops the
  // caret. Preact owns the element and none of its children, and the fallback
  // below only runs while no editor has claimed it — an un-mounted slot must
  // follow the projection like everything else in the panel.
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el || el.classList.contains(BODY_LIVE_CLASS)) return;
    el.replaceChildren(...bodySlot(task).childNodes);
  });

  // How tall the sticky head actually is, published to the stylesheet. The tab
  // row docks under it, and the head's height is not a constant a stylesheet
  // can know: it grows by a line whenever the title wraps, which depends on
  // the title and on the panel's width.
  useLayoutEffect(() => {
    const head = headRef.current;
    const panel = panelRef.current;
    if (!head || !panel) return;
    const sync = (): void => {
      const h = head.getBoundingClientRect?.().height ?? 0;
      // happy-dom measures everything as 0, which is why a zero is discarded
      // rather than published over the stylesheet's own fallback.
      if (h > 0) panel.style.setProperty('--hub-detail-head-h', `${Math.round(h)}px`);
    };
    sync();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(sync);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  // The reader's full-screen choice, on the container and on `<body>`: at full
  // screen the panel covers the board, so the board must stop reserving room
  // for it — otherwise it is squeezed to nothing behind a panel that is
  // already hiding it.
  useLayoutEffect(() => {
    host.classList.toggle('hub-detail--full', full);
    document.body.classList.toggle('hub-detail-full', full);
  }, [host, full]);

  // Take the focus on OPEN only — this effect runs once per mount, and a mount
  // is a new task. A repaint that focused the panel would pull the caret out
  // of the composer every time a peer's comment landed.
  //
  // Both halves of this are one fix: a dialog that never takes focus leaves
  // the keyboard behind the thing it opened, and because the board opens this
  // panel from a CLICK on a task row, focus stayed on that row — where a held
  // Space is not "the page", so hold-to-talk was dead for the entire time a
  // task was open.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.focus === 'function') panel.focus({ preventScroll: true });
  }, []);

  // The Board's "New task": the panel opens with the title in rename, empty
  // and focused, so the first keystroke names the row. Declared AFTER the
  // panel's own focus so the input, not the panel, ends up holding it. Once
  // per mount — a mount is a new task, and a repaint must not drag the reader
  // back into rename.
  useLayoutEffect(() => {
    if (latest.current.handlers.focusTitle) beginRename.current?.();
  }, []);

  // The slot this hands over is the one this render decided on — a rebuilt
  // element when the panel opened on another task, the SAME element when a
  // repaint kept a live editor in place. Idempotent for an unchanged pair, so
  // the repaints that arrive while somebody is typing cost nothing. It lives
  // here rather than after the loader's call because a signal write does not
  // paint synchronously: the loader cannot know when the slot exists.
  useLayoutEffect(() => {
    handlers.onBodySlot?.(task, slotRef.current);
  });

  // Centre the thread a deep link named — but NOT when the review queue is
  // already carrying that same thread's item. Measured in a browser at 430px
  // before this guard existed: opening a review item left the panel at
  // scrollTop 112 with the queue's heading cut off above the fold, because the
  // deep link centred the thread the panel had just hoisted to the top.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const focusThreadId = handlers.focusThreadId;
    if (!panel || focusThreadId === undefined) return;
    const inQueue =
      panel.querySelector(
        `.hub-decide-card[data-review-thread-id="${CSS.escape(focusThreadId)}"]`,
      ) !== null;
    if (inQueue) return;
    const focus = panel.querySelector<HTMLElement>(
      `.hub-comment[data-thread-id="${CSS.escape(focusThreadId)}"]`,
    );
    if (focus && typeof focus.scrollIntoView === 'function')
      focus.scrollIntoView({ block: 'center' });
  });

  const archived = isTaskArchived(task);

  return (
    <div
      ref={panelRef}
      class="hub-detail-panel"
      // biome-ignore lint/a11y/useSemanticElements: a real <dialog> would own
      // its own top-layer, backdrop and dismissal, and this panel is painted
      // inside `.hub-detail`'s backdrop by an app that opens and closes it
      // from board state. The role is the accurate description of what it is.
      role="dialog"
      aria-modal="true"
      // Focusable as a container, and declared page-like for the Space hold —
      // the panel is a scroll container with no Space behaviour of its own, so
      // taking the focus is what makes the hold legible again.
      tabIndex={-1}
      {...{ [SPACE_HOLD_PAGE_ATTR]: 'page' }}
      data-task-id={task.id}
      data-tab={tab}
    >
      <div ref={headRef} class="hub-detail-head">
        {/* The same affordance the board row's title carries: renaming here was
            pointer-only, so on a keyboard the panel's title could not be
            reached at all — and with no tooltip nothing said it was editable. */}
        {/* biome-ignore lint/a11y/useHeadingContent: deliberately childless.
            `wireInPlaceTitle` swaps the text for an <input> and back, so the
            heading's content is imperative — a vnode child here would make
            every repaint an instruction to throw a half-typed rename away. */}
        <h2
          ref={titleRef}
          class="hub-detail-title"
          // It IS interactive — Enter opens the rename, exactly as the board
          // row's title does. Without the stop the panel title is pointer-only.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
          tabIndex={0}
          title="Click or press Enter to rename"
        />
        <div class="hub-detail-head-actions">
          {/* Share first, because it is the one action about the task AS A
              LINK, and the reader who wants it wants it before they have read
              anything. Icons rather than words, asked for by name — each one
              keeps BOTH an `aria-label` (what a screen reader says) and a
              `title` (what a desktop hover says). */}
          {handlers.onCopyLink && (
            <button
              type="button"
              class="hub-btn hub-icon-btn hub-detail-share"
              title="Copy a link to this task"
              aria-label="Copy a link to this task"
              onClick={() => handlers.onCopyLink?.(task)}
            >
              🔗
            </button>
          )}
          <button
            type="button"
            class="hub-btn hub-icon-btn hub-detail-expand"
            title={full ? 'Exit full screen' : 'Full screen'}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            aria-pressed={full ? 'true' : 'false'}
            onClick={() => setFull((on) => !on)}
          >
            {full ? '⤡' : '⤢'}
          </button>
          {/* Archive, between the reader's preference and the way out: the only
              one of the three that CHANGES the task, so it sits closest to
              Close. The glyph is the tray every mail client uses; the tooltip
              says "archive" in words, because a box outline on its own has
              been read as both "download" and "delete". */}
          {(archived ? handlers.onRestore : handlers.onArchive) && (
            <button
              type="button"
              class="hub-btn hub-icon-btn hub-detail-archive"
              title={archived ? 'Restore this task to the board' : 'Archive this task (e)'}
              aria-label={archived ? 'Restore this task to the board' : 'Archive this task (e)'}
              onClick={() => (archived ? handlers.onRestore?.(task) : handlers.onArchive?.(task))}
            >
              {archived ? '↩︎' : '🗄'}
            </button>
          )}
          <button
            type="button"
            class="hub-btn hub-icon-btn hub-detail-close"
            title="Close task detail"
            aria-label="Close task detail"
            onClick={() => handlers.onClose()}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Then the four key fields, then whatever is WAITING on the reader, and
          only then the description. The old order — statuses, a nine-row
          metadata list, the preserved capture, and finally the description —
          spent the entire first screen on facts identical across every task. */}
      <dl ref={fieldsRef} class="hub-detail-fields" />

      {/* The blocked note (design point 5): this task is a person's own open
          work that other tasks wait on, and this panel is the ONE surface that
          says so — a blocker is task state, never a review item, so it appears
          in no queue and no row badge. "Blocking", because this task IS the
          blocker. */}
      {handlers.blocked && (
        <div class="hub-blocked-note">
          <span class="hub-decide-k hub-blocked-k">Blocking</span>
          <p>{blockedNoteLine(handlers.blocked)}</p>
        </div>
      )}

      {/* Archived, and the panel has to SAY so: a deep link, a search result or
          a restore list can all open a task that is no longer on any board, and
          without this its absence from the lanes reads as a rendering bug
          rather than as something somebody decided. */}
      {archived && (
        <div class="hub-archived-note">
          <span class="hub-decide-k hub-archived-k">Archived</span>
          <p>
            {`${task.archivedAt ? new Date(task.archivedAt).toLocaleDateString() : ''}${
              task.archivedBy ? ` by ${task.archivedBy}` : ''
            }${task.archiveReason ? ` — ${task.archiveReason}` : ''}`}
          </p>
          {handlers.onRestore && (
            <button
              type="button"
              class="hub-btn hub-archived-restore"
              onClick={() => handlers.onRestore?.(task)}
            >
              Restore to the board
            </button>
          )}
        </div>
      )}

      {/* Everything waiting on the reader, as ONE queue — the task's own
          decision and every declared or unanswered item on its threads, ranked
          together. There used to be two regions here, each rendering one item
          and each blind to the other. */}
      <ReviewRegion task={task} handlers={handlers} now={now} discussion={discussion} />

      {/* A heading above the description, because it is a SECTION and
          everything around it now announces itself. Without one the body ran
          straight on from whatever was above it — on a decision task, prose
          appearing directly under the answer buttons. */}
      <h3 class="hub-detail-subhead hub-detail-body-head">Description</h3>
      <div ref={slotRef} class="hub-detail-body-slot" data-task-id={task.id} />

      <div ref={tabsRef} class="hub-detail-tabs" role="tablist">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            class={`hub-detail-tab hub-detail-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id ? 'true' : 'false'}
            onClick={() => {
              setTab(t.id);
              // Where the reader lands after switching, and it is not
              // "wherever the scrollbar ends up": hiding the taller panel
              // shortens the content under the scroll position, so the browser
              // clamps it — measured going straight to 0 on a switch to
              // Activity. Parking the tab row under the sticky head puts the
              // switch where it happened.
              if (typeof tabsRef.current?.scrollIntoView === 'function') {
                tabsRef.current.scrollIntoView({ block: 'start' });
              }
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        class={`hub-detail-tabpanel hub-detail-tabpanel-comments${tab === 'comments' ? '' : ' hidden'}`}
        role="tabpanel"
      >
        {discussion && handlers.onComment && (
          <Discussion
            rowId={task.id}
            discussion={discussion}
            onComment={(text, threadId) => handlers.onComment?.(task, text, threadId)}
            {...(handlers.focusThreadId !== undefined
              ? { focusThreadId: handlers.focusThreadId }
              : {})}
            now={now}
          />
        )}
      </div>
      <ActivityTab task={task} handlers={handlers} hidden={tab !== 'activity'} />
    </div>
  );
}

/**
 * The panel, or nothing at all.
 *
 * The two container classes live on the HOST the shell built rather than on
 * anything the island renders — same reasoning as the presence strip's and the
 * walkthrough's: the host is what the CSS targets, and a class is not a child,
 * so this writes nothing Preact believes it owns. `hub-detail-open` marks
 * `<body>` rather than being inferred with `:has()`, because the board and the
 * panel are siblings under different subtrees.
 */
function TaskDetail(props: { host: HTMLElement }) {
  const { task, discussion, handlers, tab } = taskDetailData.value;
  const { host } = props;
  useLayoutEffect(() => {
    host.classList.toggle('hidden', task === null);
    if (task !== null) {
      document.body.classList.add('hub-detail-open');
      return;
    }
    // The marker says "an overlay is open", and the GOAL panel is the other
    // one — it lives in a container of its own now, and it paints
    // synchronously while this effect lands a microtask later. Dropping the
    // class unconditionally would therefore take it straight back off a goal
    // panel that had just put it on.
    if (host.ownerDocument.querySelector('.hub-detail:not(.hidden)') === null) {
      document.body.classList.remove('hub-detail-open');
    }
  }, [host, task]);
  // The editor host is told the slot is gone before the render that removes it
  // could leave it holding a detached node.
  useLayoutEffect(() => {
    if (task === null) handlers.onBodySlot?.(null, null);
  }, [task, handlers]);
  if (task === null) return null;
  // Keyed on the task id — the one id that survives a re-fetch, a reorder and
  // a peer's edit. See the head of the file.
  return (
    <TaskDetailPanel
      key={task.id}
      host={host}
      task={task}
      discussion={discussion}
      handlers={handlers}
      initialTab={tab}
    />
  );
}

/**
 * Mounts the panel into a wrapper it appends to `host` (`#hub-detail`);
 * returns the disposer. The island contract, exactly as the probe proved it:
 * the wrapper — not the host — is Preact's container, disposal is
 * `render(null, el)`, and no vanilla code may `replaceChildren` or `innerHTML`
 * a container holding the live island. (Which is why the GOAL panel, which
 * shared `#hub-detail` and rebuilt it wholesale, now has a container of its
 * own.)
 *
 * The backdrop tap is wired here rather than per paint: it is a fact about the
 * container, and the old renderer added a fresh listener every time it built a
 * panel from scratch.
 *
 * No handlers argument: they change with every paint and travel on
 * `taskDetailData` instead.
 */
export function mountTaskDetailIsland(host: HTMLElement): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'task-detail');
  host.appendChild(el);
  const onBackdrop = (ev: Event): void => {
    if (ev.target === host) taskDetailData.value.handlers.onClose();
  };
  host.addEventListener('click', onBackdrop);
  render(<TaskDetail host={host} />, el);
  return () => {
    host.removeEventListener('click', onBackdrop);
    render(null, el);
    el.remove();
  };
}
