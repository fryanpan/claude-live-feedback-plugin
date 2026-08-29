/**
 * The review walkthrough — one waiting item at a time, with the way out at
 * every step — as a Preact island.
 *
 * This is the card Bryan spends the most time in front of, and it is the one
 * the vanilla renderer treated worst. `renderReviewWalkthrough` began with
 * `container.replaceChildren()`, and the board repaints this surface on every
 * SSE event — a task moving, a thread arriving, a presence tick — so on a busy
 * board the card the reader was working was rebuilt every second or two.
 * Everything the card was HOLDING died with it, and each rescue had to be
 * hand-built: `keepFields`/`restoreFields` for the drafts, and (0.1.100) a
 * snapshot of two expansion states read off the DOM a line before it was
 * thrown away. Bryan, 2026-08-24 — "when I expand a task, it collapses a
 * second later."
 *
 * Keyed components fix all three at the root. `WalkCard` is keyed on
 * `ReviewItem.key`, so an unchanged item keeps its component instance AND its
 * DOM across a repaint:
 *
 *   - the two expansions are real component state (`useState`) rather than a
 *     snapshot off the DOM — the `data-walk-expanded` / `data-walk-item`
 *     machinery is gone, because it only ever existed as a place to put state
 *     the vanilla renderer had nowhere else to keep;
 *   - an uncontrolled `<textarea>` that keeps its node keeps its value for
 *     free, so the drafts need no `keepFields` pass at all;
 *   - moving to another item changes the key, which unmounts the card — so the
 *     next one opens the way its author wrote it, with an empty box, which is
 *     the other half of the guarantee.
 *
 * The bridge is one-directional, as in the board, Home-review and presence
 * islands: `renderWalkthrough` in hub-app still owns the queue, the position
 * and the sitting's tally, and writes them into `walkthroughData`; the island
 * only reads. It fetches nothing and subscribes to nothing.
 *
 * The one departure from the other islands: the HANDLERS ride the signal
 * rather than being bound at mount. They are not stable here — `onAnswer` and
 * `onReply` close over the item this paint drew and the one after it, which is
 * what makes the advance land on the right card — so a set bound at boot would
 * be answering about a queue several answers old. Same reasoning as the board
 * island's `knownAgentIds`: what changes per paint travels on the signal.
 */
import { REVIEW_LIMITS, reviewItemBodyMarkdown } from '@feedback/core';
import { signal } from '@preact/signals';
import { Fragment, render } from 'preact';
import { type MutableRef, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import { attachMarkdownComposer, refreshMarkdownComposer } from '../md-composer.ts';
import {
  type HubDecisionOption,
  type HubTask,
  type ReviewItem,
  type ReviewKind,
  type ReviewQueue,
  askedMeta,
  reviewCardHeadline,
  reviewHeadline,
  reviewItemAnchorTarget,
  reviewItemBadge,
  reviewRowTitle,
  revisedPhrase,
} from './hub-model.ts';
import { markPhrase, pillPlace, selectedPhraseIn, unmarkPhrase } from './review-item-phrase.ts';

// ── The contract with the vanilla loader ───────────────────────────────────

export interface WalkthroughHandlers {
  /** Record a verbatim answer. `optionId` rides along when the answer came
   *  from tapping one of the asker's candidates.
   *
   *  Resolves to whether the write LANDED. The advance is the confirmation
   *  that it did, so it has to follow the write rather than race it — and a
   *  refused write must leave the reader on the card with their words still in
   *  the box, which is the one direction that cannot lose anything. */
  onAnswer: (task: HubTask, text: string, optionId?: string) => Promise<boolean>;
  /** A question asked ON a phrase of a ticket-borne review item — doc-style,
   *  the way "Tell me more" now works (Bryan, 2026-08-29). Opens a thread
   *  anchored to that phrase of that item; the item then waits on its owner.
   *  Deliberately does NOT advance: nothing was answered, and the card stays
   *  where the reader is with the note that it is waiting. */
  onAskOnItem: (item: ReviewItem, phrase: { text: string }, question: string) => Promise<boolean>;
  /** Answer a thread without leaving the queue. Posts a reply on the thread the
   *  item came from, wherever that thread lives. `optionId` rides along when
   *  the reply came from tapping one of a declared item's candidates — the same
   *  shape `onAnswer` uses, because a tap and typed words must reach the thread
   *  by one path or the two will drift. */
  onReply: (item: ReviewItem, text: string, optionId?: string) => Promise<boolean>;
  /** Go to the exact place instead of answering here — the task's discussion at
   *  that thread, the doc anchored on that comment. */
  onOpenItem: (item: ReviewItem) => void;
  /** Go to the thread a revised item's question lives on — the reader's
   *  question and the owner's reply, where they were written. */
  onOpenThread: (item: ReviewItem) => void;
  /** Move to another position in the queue (skip forward, step back). */
  onStep: (index: number) => void;
  onClose: () => void;
}

/**
 * What this sitting has cleared so far.
 *
 * Without it the advance is invisible. The queue shrinks as it is worked, so
 * answering item 3 of 7 leaves you at "3 of 6" — the number that says WHERE
 * YOU ARE does not move, and the only thing that changed is a total that got
 * smaller. To a reader that is indistinguishable from "my answer did nothing"
 * or "the page reset", which is worse than not advancing at all, because they
 * cannot tell whether the answer landed.
 */
export interface WalkProgress {
  /** How many items this sitting has finished. */
  cleared: number;
  /** The one just finished. It is no longer in the queue, so Back cannot
   *  reach it — the banner is the only way back to something you answered by
   *  mistake, which is why it holds the whole item rather than a title. */
  last: ReviewItem | null;
}

export interface WalkthroughView {
  queue: ReviewQueue;
  /** The position in `queue.items`; past the end (or over an empty queue) is
   *  the done state, and a negative index means closed. */
  index: number;
  progress: WalkProgress;
  now: number;
  /** Aimed at the item this paint draws — see the note at the top of the file
   *  for why these travel with the data rather than being bound at mount. */
  handlers: WalkthroughHandlers;
}

/** A closed walkthrough answers nothing, which is what the signal holds until
 *  the loader's first write. Not exported: nobody outside should be handing
 *  these to anything. */
const IDLE_HANDLERS: WalkthroughHandlers = {
  onAnswer: () => Promise.resolve(false),
  onAskOnItem: () => Promise.resolve(false),
  onReply: () => Promise.resolve(false),
  onOpenItem: () => {},
  onOpenThread: () => {},
  onStep: () => {},
  onClose: () => {},
};

/** The one write target the vanilla loader has for the walkthrough. */
export const walkthroughData = signal<WalkthroughView>({
  queue: { items: [], total: 0, blocking: 0 },
  index: -1,
  progress: { cleared: 0, last: null },
  now: 0,
  handlers: IDLE_HANDLERS,
});

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── The composer, which stays imperative on purpose ────────────────────────

interface PromptSpec {
  placeholder: string;
  submitLabel: string;
  // The mockup's Send is `.btn.primary`, which is INK-dark there rather than
  // accent-blue — the two blue buttons stacked under a decision card are what
  // got the old layout called weird. Secondary prompts pass a plain button.
  submitClass: string;
  /** Scoped to the item the box belongs to. It names the box for the
   *  put-the-words-back path below, and it is the effect's dependency — so a
   *  card that moves to a different item rebuilds the box rather than handing
   *  the next reader the last one's draft. */
  keepKey: string;
  onSubmit: (text: string) => Promise<boolean>;
}

/**
 * Fill a Preact-owned `<form>` with a textarea + submit pair, and return the
 * teardown.
 *
 * The children are built imperatively rather than as JSX, and that is
 * load-bearing: `attachMarkdownComposer` REPLACES the textarea with a wrapper
 * and re-parents it (design point 4 — every composer is a live markdown
 * editor). Preact would find its own child sitting somewhere it did not put it
 * and move it back out of the editor on the next diff. So the form element is
 * Preact's and its children are not: a vnode with no children is diffed
 * against nothing, and nothing here is touched.
 *
 * The submit is ignored when the field is blank, and locked while the write is
 * in flight — for the same reason the discussion's composer is: the answer does
 * not come back through the POST (a decision's answer arrives later over the
 * ydoc), so between the tap and the card swapping there is a window in which
 * nothing on screen has changed and the button still works. Every extra tap in
 * that window is another recorded answer.
 */
function fillPromptForm(form: HTMLFormElement, spec: PromptSpec): () => void {
  const ta = document.createElement('textarea');
  ta.placeholder = spec.placeholder;
  ta.rows = 3;
  ta.dataset.keep = spec.keepKey;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = spec.submitClass;
  submit.textContent = spec.submitLabel;
  form.append(ta, submit);
  const refreshComposer = attachMarkdownComposer(ta);
  // A flag, not just the disabled attributes: disabling the CONTROLS stops a
  // second tap, and a form can still be submitted around them (Enter in the
  // field, a programmatic submit). The guard has to be on the handler.
  let busy = false;
  const onSubmit = (ev: Event): void => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text || busy) return;
    busy = true;
    ta.disabled = true;
    submit.disabled = true;
    // Cleared HERE rather than on the acknowledgement, same as `commentForm`:
    // a restored copy of in-flight text would be an enabled duplicate-submit
    // path whose eventual success clears only one of the two. Put back
    // verbatim if the write is refused.
    ta.value = '';
    refreshComposer();
    // Anything short of an acknowledged write puts the words back — but never
    // over something typed since. Under the island the box KEEPS ITS NODE
    // across a repaint, so "the live box" and "this box" are normally the same
    // element and the guard has to be about what is IN it rather than about
    // which node it is: rewriting a box somebody is typing in is the bug this
    // whole mechanism exists to remove. The lookup still runs, because a card
    // that moved on has a detached `ta` and the live box is somebody else's.
    const putBack = (): void => {
      const live =
        ta.ownerDocument.querySelector<HTMLTextAreaElement>(
          `textarea[data-keep="${spec.keepKey}"]`,
        ) ?? ta;
      if (live.value.trim() !== '') return;
      live.value = text;
      if (live === ta) refreshComposer();
      else refreshMarkdownComposer(live);
    };
    void Promise.resolve(spec.onSubmit(text))
      .then((ok) => {
        if (ok !== true) putBack();
      })
      .catch(() => {
        putBack();
      })
      .finally(() => {
        busy = false;
        ta.disabled = false;
        submit.disabled = false;
      });
  };
  form.addEventListener('submit', onSubmit);
  return () => {
    form.removeEventListener('submit', onSubmit);
    form.replaceChildren();
  };
}

/** The form shell Preact owns, with imperative innards. `keepKey` is the
 *  identity of the box: change it and the box is rebuilt, which is what stops
 *  a draft following the reader onto another card. */
function PromptForm(props: {
  className: string;
  placeholder: string;
  submitLabel: string;
  submitClass?: string;
  keepKey: string;
  hidden?: boolean;
  formRef?: MutableRef<HTMLFormElement | null>;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const own = useRef<HTMLFormElement | null>(null);
  const form = props.formRef ?? own;
  // Everything the builder needs is read through a ref at BUILD time, so that
  // none of it can become a reason to rebuild. `onSubmit` in particular closes
  // over the item this paint drew and the box outlives the paint, so it is
  // re-read at submit time rather than captured.
  const latest = useRef(props);
  latest.current = props;
  const keepKey = props.keepKey;
  useLayoutEffect(() => {
    const node = form.current;
    if (!node) return;
    return fillPromptForm(node, {
      placeholder: latest.current.placeholder,
      submitLabel: latest.current.submitLabel,
      submitClass: latest.current.submitClass ?? 'hub-btn hub-btn-ink',
      keepKey,
      onSubmit: (text) => latest.current.onSubmit(text),
    });
    // The box's IDENTITY, and nothing else. Any other dependency is a way for
    // a repaint that changed only the clock to rebuild the box the reader is
    // typing in — which is the whole defect this island exists to remove.
  }, [form, keepKey]);
  return <form ref={form} class={props.hidden ? `${props.className} hidden` : props.className} />;
}

// ── The card's parts ───────────────────────────────────────────────────────

/**
 * The `‹ N of M ›` stepper (mockup: right-aligned in the "Review" head),
 * shared by both card kinds because "go through the list" is the feature and
 * it must not stop working when the next item is a comment. Lives in the page
 * head around the position readout, so stepping does not mean scrolling past
 * a long card to find the buttons.
 */
function WalkStepper(props: {
  index: number;
  total: number;
  cleared: number;
  handlers: WalkthroughHandlers;
}) {
  const { index, total, cleared, handlers } = props;
  return (
    <span class="hub-walk-nav">
      <button
        type="button"
        class="hub-btn hub-walk-back"
        aria-label="Back"
        disabled={index === 0}
        onClick={() => handlers.onStep(index - 1)}
      >
        ‹
      </button>
      {/* Two readings, because the queue shrinks as it is worked and neither
          number alone says you moved: where you are in what REMAINS, and what
          this sitting has taken off the list. */}
      <span class="hub-walk-pos">
        {`${index + 1} of ${total}`}
        {cleared > 0 && <span class="hub-walk-cleared">{`${cleared} cleared`}</span>}
      </span>
      <button
        type="button"
        class="hub-btn hub-walk-skip"
        aria-label={index + 1 === total ? 'Skip — finish' : 'Skip for now'}
        onClick={() => handlers.onStep(index + 1)}
      >
        ›
      </button>
    </span>
  );
}

/** How the thing you just finished reads in the banner. A ticket-borne
 *  review item is ANSWERED like a decision — nothing was replied on. */
function clearedVerb(kind: ReviewKind): string {
  return kind === 'decision' || kind === 'task-review' ? 'Answered' : 'Replied on';
}

/**
 * "You just did that, here is the next one" — the half of the advance that
 * turns a jump-cut into a queue.
 */
function AdvancedBanner(props: { last: ReviewItem; handlers: WalkthroughHandlers }) {
  const { last, handlers } = props;
  return (
    <div class="hub-walk-advanced">
      <span class="hub-walk-advanced-said">
        {`✓ ${clearedVerb(last.kind)} “${clip(last.title, 60)}”`}
      </span>
      {/* Not `onStep(index - 1)`: the answered item LEFT the queue, so stepping
          back lands on whatever preceded it. Opening it where it lives is the
          only route to the thing that was actually just answered. */}
      <button
        type="button"
        class="hub-btn hub-walk-advanced-back"
        onClick={() => handlers.onOpenItem(last)}
      >
        Back to it
      </button>
    </div>
  );
}

/**
 * The mockup's card head, in its order: kind badge, the question, and how
 * long it has waited. The goal chip that sat between them is gone (Bryan,
 * 2026-08-26: "remove the goal showing in the top right, it takes up too
 * much space") — within one workspace it named the same few goals over and
 * over, and the card's Task line already points at the work.
 */
function WalkCardHead(props: { item: ReviewItem; now: number }) {
  const { item, now } = props;
  const badge = reviewItemBadge(item);
  return (
    <div class="hub-walk-card-head">
      <span class={`hub-walk-k hub-walk-k-${badge.tone}`}>{badge.label}</span>
      {/* The owner revised the words after the reader asked on them: the
          item is back in the queue and says so, beside its kind rather than
          instead of it. */}
      {item.revision && <span class="hub-walk-k hub-walk-k-revised">Revised</span>}
      {/* The QUESTION, not the subject — the same title the queue row shows, so
          tapping a row and stepping onto it cannot read as two different items.
          A DECLARED headline is already a heading and goes through untouched —
          clipping it at the first sentence terminator is what "Ship v2 now. Or
          wait?" cannot survive. */}
      <h3 class="hub-walk-title">{reviewCardHeadline(item)}</h3>
      {/* The head's top-right meta is the card's ONE provenance line — who
          asked and how long ago — replacing both the bare wait chip and the old
          left-bordered context block (approved design, review-flow-mock-v1). */}
      <span class="hub-walk-wait">{askedMeta(item, now)}</span>
    </div>
  );
}

/**
 * The one pointer up and out of the card: the task or doc this came from.
 *
 * ALWAYS rendered, on every kind. It used to be dropped for an item whose
 * question IS its subject, on the grounds that naming the subject would print
 * the same words twice — true of the words, and it left those cards with no
 * exit at all. Now that a row opens the card, this link is the reader's ONLY
 * way to the resource, so a card without it is a dead end. Where the title
 * would repeat the headline, the link says what it does instead of what it
 * points at.
 */
function WalkWhere(props: { item: ReviewItem; handlers: WalkthroughHandlers }) {
  const { item, handlers } = props;
  const doc = item.kind === 'doc-thread';
  const title = item.title.trim();
  // Compared against the ROW title rather than the rendered headline: the
  // headline clips, so a long subject would differ from itself and read as
  // new information the card has already shown.
  const names = title !== '' && title !== reviewRowTitle(item).trim();
  return (
    <p class="hub-walk-where">
      <b>{doc ? 'Doc:' : 'Task:'}</b>{' '}
      {/* Its own class, kept distinct from every button class the cards use:
          sharing a selector with a primary button once turned this link into
          bare blue text — measured on staging at 430px. */}
      <button type="button" class="hub-walk-where-link" onClick={() => handlers.onOpenItem(item)}>
        {names ? `${title} ↗` : `${doc ? 'Open the doc' : 'Open the task'} ↗`}
      </button>
    </p>
  );
}

/** The asker's candidates. Full-width targets, label + optional detail; the
 *  LABEL is the verbatim answer and the id says which candidate it was, so a
 *  tap and typed words land in the same field. */
function WalkOptions(props: {
  options: HubDecisionOption[];
  onPick: (option: HubDecisionOption) => void;
}) {
  return (
    <div class="hub-walk-options">
      {props.options.map((o) => (
        <button key={o.id} type="button" class="hub-walk-option" onClick={() => props.onPick(o)}>
          <span class="hub-walk-option-label">{o.label}</span>
          {o.detail && <span class="hub-walk-option-detail">{o.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/** The task's own description, or an honest line saying there isn't one.
 *  `renderCommentMarkdown` escapes first and only adds known-safe tags, so a
 *  body written by anyone with write access is inert markup either way. */
function WalkTaskBody(props: { task: HubTask }) {
  const body = props.task.body?.trim();
  if (!body) {
    return (
      <div class="hub-walk-body hub-walk-body-empty">No context was written for this one.</div>
    );
  }
  return (
    <div
      class="hub-walk-body"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: renderCommentMarkdown escapes first and re-adds only known-safe tags.
      dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(body) }}
    />
  );
}

/**
 * A declared item's ONE body, read through core and rendered as markdown. The
 * labelled sub-sections this replaces ("What to review for", the separate
 * detail block) are the anatomy the approved design collapsed — every word is
 * still here, in the author's order, unlabelled.
 *
 * The API stopped refusing a long detail (the refusal split every real ask
 * into a thread body and a weaker card copy), so the card now has to carry it:
 * the FULL words are always in the DOM — card and thread say the same thing —
 * and past the review target the body clamps ON THE PHONE TIER ONLY (the CSS
 * scopes it; wider screens render everything, since 430px is where an
 * unbounded body buries the options and the composer). The button is the
 * explicit expand affordance; expanding is one-way, like reading.
 */
function WalkReviewBody(props: {
  review: NonNullable<ReviewItem['review']>;
  expanded: boolean;
  onExpand: () => void;
  /** The body's node, for whoever reads the selection inside it. */
  bodyRef?: MutableRef<HTMLDivElement | null>;
  /** The revised phrase to mark — the editor's resolved-range treatment on
   *  the words the owner changed. Left unmarked when it cannot be found. */
  mark?: string;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const bodyRef = props.bodyRef ?? own;
  const markdown = reviewItemBodyMarkdown(props.review);
  const html = markdown === '' ? '' : renderCommentMarkdown(markdown);
  const mark = props.mark;
  // After the HTML is in place (and again whenever it or the phrase
  // changes): take the old mark out, put the new one in. A mark is
  // presentation over Preact-owned innerHTML — Preact only rewrites that
  // string when it changes, so the wrapping survives an ordinary repaint.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (mark) markPhrase(el, mark);
    else unmarkPhrase(el);
  }, [bodyRef, html, mark]);
  if (markdown === '') return null;
  const clamped =
    !props.expanded && markdown.split(/\s+/).length > REVIEW_LIMITS.detailTargetWords.review;
  return (
    <Fragment>
      <div
        ref={bodyRef}
        class={clamped ? 'hub-walk-body hub-walk-body-clamp' : 'hub-walk-body'}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: renderCommentMarkdown escapes first and re-adds only known-safe tags.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {clamped && (
        <button type="button" class="hub-walk-body-expand" onClick={props.onExpand}>
          Show the whole ask
        </button>
      )}
    </Fragment>
  );
}

/**
 * A revised item's question, quoted under the headline, with the way to the
 * thread it was asked on. The reader asked in their own words; the card
 * gives those words back so "what did I ask?" is answered before "what
 * changed?" — the mark in the body answers that one.
 */
function WalkRevision(props: { item: ReviewItem; handlers: WalkthroughHandlers }) {
  const rev = props.item.revision;
  if (!rev) return null;
  return (
    <div class="hub-walk-question">
      {rev.question !== undefined && (
        <blockquote class="hub-walk-question-text">{`You asked: “${rev.question}”`}</blockquote>
      )}
      {rev.threadId !== undefined && (
        <button
          type="button"
          class="hub-walk-thread-link"
          onClick={() => props.handlers.onOpenThread(props.item)}
        >
          See thread ↗
        </button>
      )}
    </div>
  );
}

/**
 * "Waiting on Helper" — the item is the owner's to move now. Subtle on
 * purpose: the card stays exactly where it was (no collapse, no advance), and
 * this one line is the only thing that changed. The question is quoted so the
 * reader can see what they sent without opening the thread.
 */
function WalkWaiting(props: { waiting: { question: string; owner: string } }) {
  return (
    <p class="hub-walk-waiting">
      {`Waiting on ${props.waiting.owner} — you asked: “${props.waiting.question}”`}
    </p>
  );
}

/**
 * The selection → pill → thread pattern the review-doc editor uses, on the
 * card's rendered detail.
 *
 * Not the editor's pill (app.ts `positionPill`): that one keys off a
 * ProseMirror selection resolvable to Yjs offsets, and the card's body is
 * server-fetched markdown rendered to static HTML. What the two share is
 * the shape — select words, a pill appears beside them, tapping it opens a
 * place to write — and the `.comment-pill` dressing. The pill sends the
 * WORDS; the server locates them in the item's source.
 *
 * Keys off `selectionchange` on the document, debounced the way the editor's
 * is, and only ever reads a selection inside the body node — a selection
 * anywhere else on the page hides the pill.
 */
function useSelectionPill(
  body: MutableRef<HTMLDivElement | null>,
  enabled: boolean,
): { phrase: string | null; place: { left: number; top: number }; clear: () => void } {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [place, setPlace] = useState({ left: 8, top: 8 });
  // A LAYOUT effect: the listener has to be on the document before the first
  // selection can happen, and a passive effect lands a frame after mount —
  // a phrase selected in that frame would never show the pill.
  useLayoutEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      const el = body.current;
      const found = el ? selectedPhraseIn(el) : null;
      if (found && el) {
        setPlace(pillPlace(found.range, el));
        setPhrase(found.text);
      } else {
        setPhrase(null);
      }
    };
    const onChange = (): void => {
      clearTimeout(timer);
      timer = setTimeout(read, 120);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [body, enabled]);
  return { phrase, place, clear: () => setPhrase(null) };
}

/**
 * The thread card that opens off the pill: the phrase quoted the way a doc
 * thread quotes its range, one box for the question, Ask and Cancel. Its
 * `PromptForm` keeps its node across a repaint like the answer box does, so
 * a board event mid-sentence loses nothing.
 */
function WalkAskThread(props: {
  item: ReviewItem;
  phrase: string;
  onAsk: (question: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  // The card lives in the stage's margin column — beside the card at
  // tablet/laptop widths, BELOW the whole card (options, answer box, Skip)
  // at ≤1100px, where a tap on the pill could otherwise open it off-screen.
  // Bring it into view once, on open; `nearest` moves nothing when it is
  // already visible.
  const self = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    self.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <div class="hub-walk-thread" ref={self}>
      <blockquote class="hub-walk-thread-quote">{props.phrase}</blockquote>
      <PromptForm
        className="hub-walk-thread-form"
        placeholder="Ask about this…"
        submitLabel="Ask"
        submitClass="hub-btn"
        keepKey={`walk-ask:${props.item.key}`}
        onSubmit={props.onAsk}
      />
      <div class="hub-walk-thread-actions">
        <button
          type="button"
          class="hub-btn hub-btn-ghost hub-walk-thread-cancel"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── The card ───────────────────────────────────────────────────────────────

/**
 * One item's card. Mounted under `key={item.key}`, which is the whole point:
 * a repaint of the same item reuses this instance — so the two expansions
 * below and the composer's uncontrolled textarea survive it — and moving to
 * another item unmounts it, so nothing the last card was holding follows the
 * reader onto the next one.
 */
function WalkCard(props: {
  item: ReviewItem;
  index: number;
  progress: WalkProgress;
  now: number;
  handlers: WalkthroughHandlers;
}) {
  const { item, index, progress, now, handlers } = props;
  // Both expansions are STATE, not a reading of the DOM. The vanilla renderer
  // snapshotted them off the nodes a line before `replaceChildren` destroyed
  // them, because there was nowhere else to keep them; here the instance is
  // the place, and it outlives every repaint of this item.
  const [bodyExpanded, setBodyExpanded] = useState(false);
  // Commenting on a phrase of the item, doc-style. Only a TICKET-borne item
  // has a phrase to anchor to (`reviewItemAnchorTarget`); the others render
  // no pill at all rather than a pill that opens nothing.
  const anchorable = reviewItemAnchorTarget(item) !== null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The phrase the thread card is open on, and the question this card sent
  // (until the server's row catches up — the hold in hub-app carries
  // `item.waiting` across repaints; this is the same fact one render early).
  const [draft, setDraft] = useState<string | null>(null);
  const [asked, setAsked] = useState<{ question: string; owner: string; at: number } | null>(null);
  const owner = item.thread?.askedBy ?? 'the owner';
  // The waiting note: the hold's word first; else this card's own, unless
  // a revision has landed since — then it is the reader's turn again and the
  // note would be stale.
  const waiting =
    item.waiting ?? (asked && !(item.revision && item.revision.at >= asked.at) ? asked : null);
  // A second question cannot be filed while the item is already waiting on
  // its owner — the server refuses it (409 `waiting`), and a pill that only
  // bounces is worse than none. Computed from the SAME `waiting` the note
  // reads, so the two can never disagree about whose turn it is.
  const pill = useSelectionPill(bodyRef, anchorable && !waiting);
  const openThread = (): void => {
    if (!pill.phrase) return;
    setDraft(pill.phrase);
    pill.clear();
    window.getSelection()?.removeAllRanges();
  };
  const ask = async (question: string): Promise<boolean> => {
    if (draft === null) return false;
    const ok = await handlers.onAskOnItem(item, { text: draft }, question);
    if (ok) {
      setAsked({ question, owner, at: Date.now() });
      setDraft(null);
    }
    return ok;
  };

  // Only a decision gets the answer furniture — the thread kinds get a reply
  // path instead. (A blocker never reaches this queue at all: it is task
  // state, surfaced as the detail panel's blocked note.)
  const row = item.decision;
  const review = item.review;
  const skip = (
    <button
      type="button"
      class="hub-btn hub-btn-ghost hub-walk-skip-link"
      onClick={() => handlers.onStep(index + 1)}
    >
      Skip for now
    </button>
  );

  return (
    // The stage (approved mock `.demo-doc-layout`): the card, and a margin
    // column that holds the thread a pill opens — beside the card at
    // ≥1101px, where height is the scarce axis, stacked below it at ≤1100px.
    <div class="hub-walk-stage">
      <div class={`hub-walk-card hub-walk-${item.kind}`}>
        {/* First thing on the card, above the new item: what you just finished.
          It belongs here rather than in a toast because this is read on a
          phone, where a toast is gone before the thumb has come back down. */}
        {progress.last && <AdvancedBanner last={progress.last} handlers={handlers} />}
        {/* ONE anatomy (approved design): head row — kind badge, headline, goal
          chip, asked-by meta — then one markdown body. */}
        <WalkCardHead item={item} now={now} />
        {/* Under the headline: what the reader asked, when the item came back
          revised — and the way to the thread. */}
        <WalkRevision item={item} handlers={handlers} />
        {/* The same pointer out on every kind. Answering here is the point —
          going through the queue must not mean leaving the queue on every
          item — but a comment sometimes only makes sense in place. */}
        <WalkWhere item={item} handlers={handlers} />
        {waiting && draft === null && <WalkWaiting waiting={waiting} />}

        {row ? (
          <Fragment>
            <WalkTaskBody task={row.task} />
            {row.task.infoRequests && row.task.infoRequests.length > 0 && (
              <p class="hub-walk-asked">
                {`You already asked: “${row.task.infoRequests[row.task.infoRequests.length - 1]?.text ?? ''}”`}
              </p>
            )}
            {row.task.options && row.task.options.length > 0 && (
              <WalkOptions
                options={row.task.options}
                onPick={(o) => void handlers.onAnswer(row.task, o.label, o.id)}
              />
            )}
            {/* Always present, options or not: the candidates are a shortcut,
              never a closed set. */}
            <PromptForm
              className="hub-walk-answer"
              placeholder="…or answer in your own words — the agent gets your text verbatim"
              submitLabel="Send"
              keepKey={`walk-answer:${row.task.id}`}
              onSubmit={(text) => handlers.onAnswer(row.task, text)}
            />
            {/* The "Tell me more" box that sat here is gone (Bryan, 2026-08-29:
              "maybe instead we can let me comment directly on the review item
              like in a doc"). Asking back is a comment on a phrase of a
              declared item now — the pill below — and a legacy decision's
              words are the task body, reached through its discussion. */}
            <div class="hub-walk-actions">{skip}</div>
          </Fragment>
        ) : (
          <Fragment>
            {review ? (
              // A DECLARED review item. Everything below was written by the agent
              // for this card, so none of it is derived, clipped or guessed at —
              // which is the whole reason declaring exists.
              <Fragment>
                <WalkReviewBody
                  review={review}
                  expanded={bodyExpanded}
                  onExpand={() => setBodyExpanded(true)}
                  bodyRef={bodyRef}
                  mark={revisedPhrase(item)}
                />
                {anchorable && !waiting && (
                  // The editor's pill, on the card: fixed-position, placed by
                  // the hook beside the selection's end. `mousedown` is
                  // swallowed so the tap does not blur the selection before
                  // the click lands (the editor's pill does the same; touch is
                  // left alone, since cancelling it cancels the click on iOS).
                  // Absent entirely while the item is waiting on its owner —
                  // see the note where `waiting` is computed above.
                  <button
                    type="button"
                    class={`comment-pill hub-walk-pill${pill.phrase ? '' : ' hidden'}`}
                    style={{ left: `${pill.place.left}px`, top: `${pill.place.top}px` }}
                    aria-label="Comment on this"
                    title="Comment on this"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={openThread}
                  >
                    💬
                  </button>
                )}
                {review.options && review.options.length > 0 && (
                  <WalkOptions
                    options={review.options}
                    onPick={(o) => void handlers.onReply(item, o.label, o.id)}
                  />
                )}
              </Fragment>
            ) : (
              // The mockup's "What I need from you" block — rendered only when it
              // says more than the heading already did. A one-line question fits
              // in the heading, and quoting it again underneath is the card
              // repeating itself.
              reviewHeadline(item.ask) !== item.ask.trim().replace(/\s+/g, ' ') && (
                <div class="hub-walk-askbox">
                  <h4 class="hub-walk-ask-head">What I need from you</h4>
                  <blockquote class="hub-walk-ask">{item.ask}</blockquote>
                </div>
              )
            )}
            {/* Always present, options or not — the candidates are a shortcut,
              never a closed set, and a review item with no options only has
              this. */}
            <PromptForm
              className="hub-walk-answer"
              placeholder={review?.options?.length ? '…or answer in your own words' : 'Reply…'}
              submitLabel="Send"
              keepKey={`walk-answer:${item.key}`}
              onSubmit={(text) => handlers.onReply(item, text)}
            />
            <div class="hub-walk-actions">{skip}</div>
          </Fragment>
        )}
      </div>
      {draft !== null && (
        <aside class="hub-walk-margin">
          <WalkAskThread item={item} phrase={draft} onAsk={ask} onCancel={() => setDraft(null)} />
        </aside>
      )}
    </div>
  );
}

/**
 * The end of a sitting.
 *
 * Answering the LAST one lands here, which makes this the likeliest moment to
 * want the item back — so the banner belongs on the finished screen too, not
 * only on the card that replaces something. The count is what makes this an
 * ENDING rather than an empty surface: a sitting that cleared four things and
 * one that found nothing waiting read identically otherwise.
 */
function WalkDone(props: { progress: WalkProgress; handlers: WalkthroughHandlers }) {
  const { progress, handlers } = props;
  return (
    <div class="hub-walk-done">
      {progress.last && <AdvancedBanner last={progress.last} handlers={handlers} />}
      <h2>All caught up</h2>
      <p>Nothing else is waiting on you right now.</p>
      {progress.cleared > 0 && (
        <p class="hub-walk-done-tally">
          {progress.cleared === 1
            ? 'You cleared 1 in this sitting.'
            : `You cleared ${progress.cleared} in this sitting.`}
        </p>
      )}
      <button type="button" class="hub-btn hub-btn-primary" onClick={() => handlers.onClose()}>
        Back to Home
      </button>
    </div>
  );
}

/**
 * An empty walkthrough must not sit in the Home column taking room, and the
 * `hidden` class lives on the HOST the shell built rather than on anything the
 * island renders — same reasoning as the presence strip's: the host is what
 * the CSS targets, and a class is not a child, so this writes nothing Preact
 * believes it owns.
 */
function useHostVisibility(host: HTMLElement, closed: boolean): void {
  useLayoutEffect(() => {
    host.classList.toggle('hidden', closed);
  }, [host, closed]);
}

/**
 * One item at a time, in the derived order, with the way out at every step:
 * tap one of the asker's options, write your own answer, ask for more
 * information, or skip. Six answers should be one sitting, not six
 * navigations — so the position and the queue live here rather than in six
 * separate detail-panel visits.
 *
 * A PAGE, not a modal (approved mockup home-pane-mockup-v1). It replaces the
 * Home pane's content behind a `‹ Back to Home` link and keeps the workspace
 * shell — rail, topbar — where it was.
 */
function Walkthrough(props: { host: HTMLElement }) {
  const { queue, index, progress, now, handlers } = walkthroughData.value;
  useHostVisibility(props.host, index < 0);
  if (index < 0) return null;
  const item = queue.items[index] ?? null;
  return (
    <div class="hub-walk-panel">
      {/* The way back out, above everything (mockup: its own row over the
          head). */}
      <div class="hub-walk-topline">
        <button
          type="button"
          class="hub-btn hub-btn-ghost hub-walk-home"
          onClick={() => handlers.onClose()}
        >
          ‹ Back to Home
        </button>
      </div>
      {item === null ? (
        <WalkDone progress={progress} handlers={handlers} />
      ) : (
        <Fragment>
          <div class="hub-walk-head">
            <h2 class="hub-walk-heading">Review</h2>
            <WalkStepper
              index={index}
              total={queue.items.length}
              cleared={progress.cleared}
              handlers={handlers}
            />
          </div>
          {/* Keyed on `ReviewItem.key` — the one id that survives a re-fetch,
              a reorder and a peer's answer. See the head of the file. */}
          <WalkCard
            key={item.key}
            item={item}
            index={index}
            progress={progress}
            now={now}
            handlers={handlers}
          />
        </Fragment>
      )}
    </div>
  );
}

/**
 * Mounts the walkthrough into a wrapper it appends to `host`
 * (`#hub-walkthrough`); returns the disposer. The island contract, exactly as
 * the probe proved it: the wrapper — not the host — is Preact's container,
 * disposal is `render(null, el)`, and no vanilla code may `replaceChildren` or
 * `innerHTML` a container holding the live island.
 *
 * No handlers here: they change with every paint (see the head of the file)
 * and travel on `walkthroughData` instead.
 */
export function mountWalkthroughIsland(host: HTMLElement): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'walkthrough');
  host.appendChild(el);
  render(<Walkthrough host={host} />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
