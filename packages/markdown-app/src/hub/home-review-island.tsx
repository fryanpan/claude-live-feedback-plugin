/**
 * The Home "For Your Review" pane, as the first real Preact island — the
 * vanilla `renderHomeReview` rebuilt on the framework scaffold (island-probe
 * proved the contract; this is the first pane to ride it).
 *
 * The read at the top of Home: what is waiting on you, in priority order,
 * across every surface this workspace has. This replaced a decisions-only
 * strip, then moved from the board to Home; the board keeps only a one-line
 * banner (`renderReviewBanner`). Urgency is still DERIVED, never declared:
 * "blocking work now" is the same fact as "something depends on it", which
 * `after` / `afterEnforce` already record.
 *
 * The bridge is one-directional: the vanilla loader keeps owning the fetch
 * and writes what it fetched into `homeReviewData`; the island renders from
 * that signal and calls back through the same handlers the vanilla renderer
 * took. No fetches, no subscriptions of its own — and because the loaders
 * schedule their repaints through the repaint-guard, a background event's
 * signal write still waits for the reader's finger the way every other
 * repaint does.
 *
 * Rows are keyed on `ReviewItem.key`, which is stable across re-fetches — so
 * an update that changes one row leaves every other row's DOM node IDENTICAL,
 * which is the property this migration exists for (focus survives, and later
 * panes can hold anchors and editor mounts through a repaint).
 */
import { signal } from '@preact/signals';
import { render } from 'preact';
import {
  type ReviewItem,
  type ReviewKind,
  type ReviewQueue,
  askedMeta,
  reviewRowTitle,
} from './hub-model.ts';

export interface ReviewStripHandlers {
  /** Open this one in the queue itself — the card that carries the ask and the
   *  box to answer it, aimed at this row. What a LIVE row does when tapped.
   *
   *  Tapping used to call `onOpen` and leave Home for the underlying task or
   *  doc, which is the opposite of what the row is for: the reader came to the
   *  queue to work the queue, and every tap ejected them from it. Going to the
   *  resource is still offered — from inside the opened card, as a second,
   *  deliberate tap. */
  onReview: (item: ReviewItem, index: number) => void;
  /** Jump straight to where this one gets answered — the decision's panel,
   *  the task's discussion at that thread, the doc anchored on that comment.
   *  "Exactly the place", not the containing surface.
   *
   *  Now reached from the card's own pointer out, and from a SETTLED row —
   *  which has left the queue, so there is no card left to open it in. */
  onOpen: (item: ReviewItem) => void;
  /** Go through all of them, one at a time. */
  onWalkthrough: () => void;
}

/** What each kind is, for the row's hover title. The card's own badge comes
 *  from `reviewBadge`, which is the mockup's two-tone vocabulary; this is the
 *  longer wording a tooltip can afford. */
const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  decision: 'Decision',
  'task-thread': 'Task comment',
  'goal-thread': 'Goal comment',
  'doc-thread': 'Doc comment',
  'task-review': 'Review item on a task',
};

export interface HomeReviewData {
  queue: ReviewQueue;
  /** What this sitting already cleared. Only rows that have actually LEFT the
   *  queue render as done — an item still present (a replied thread the next
   *  refresh hasn't dropped yet) stays a live row. */
  settled: ReviewItem[];
  now: number;
}

/** The one write target the vanilla side has. Module-level, like the probe's
 *  `probeCount`: the loaders write it, the island subscribes by reading it. */
export const homeReviewData = signal<HomeReviewData>({
  queue: { items: [], total: 0, blocking: 0 },
  settled: [],
  now: 0,
});

function ReviewRow(props: {
  item: ReviewItem;
  index: number;
  now: number;
  handlers: ReviewStripHandlers;
}) {
  const { item, index, now, handlers } = props;
  return (
    <button
      type="button"
      class={`hub-review-row hub-review-${item.kind}${index === 0 ? ' hub-review-row-current' : ''}`}
      title={`${REVIEW_KIND_LABEL[item.kind]}: ${item.title}${item.ask ? ` — ${item.ask}` : ''} · ${item.why}`}
      // Into the queue's own card at this row, not out to the task or the doc.
      // The index rides along so the card opens where the reader was pointing;
      // the card re-resolves it by key on every repaint from there.
      onClick={() => handlers.onReview(item, index)}
    >
      <span class="hub-review-row-title">{reviewRowTitle(item)}</span>
      {/* The asked-by meta, in the same spelling the card head uses — one
          clock, one sentence, so the row and the card it opens can never
          disagree. The declared why lives in the card's one markdown body
          (approved design); the row is title + meta and nothing else. */}
      <span class="hub-review-row-sub">{askedMeta(item, now)}</span>
    </button>
  );
}

/** What this sitting already cleared: kept in the stack as struck-through
 *  rows, same anatomy as the live ones (mockup: answered items stay put). */
function SettledRow(props: { item: ReviewItem; now: number; handlers: ReviewStripHandlers }) {
  const { item, now, handlers } = props;
  return (
    <button
      type="button"
      class="hub-review-row hub-review-row-done"
      title={`Done this sitting: ${item.title}`}
      // Still a way back to the thing that was just answered — the row is the
      // only pointer left once the queue dropped it.
      onClick={() => handlers.onOpen(item)}
    >
      <span class="hub-review-row-title">{reviewRowTitle(item)}</span>
      <span class="hub-review-row-sub">{`${askedMeta(item, now)} · answered this sitting`}</span>
    </button>
  );
}

function HomeReview(props: { handlers: ReviewStripHandlers }) {
  const { queue, settled, now } = homeReviewData.value;
  // Settled rows stay in the stack marked done (approved design): an answered
  // item vanishing outright reads as the page losing things.
  const live = new Set(queue.items.map((i) => i.key));
  const done = settled.filter((s) => !live.has(s.key));
  return (
    <section class="hub-home-review-card">
      <div class="hub-home-review-head">
        <h2 class="hub-home-heading">For Your Review</h2>
        {/* The walkthrough entry: the mockup's dark "Review All", top-right of
            the section head. Only offered when there is something to walk
            through. */}
        {queue.total > 0 && (
          <button
            type="button"
            class="hub-btn hub-btn-ink hub-review-go"
            aria-label="Go through these one at a time"
            onClick={() => props.handlers.onWalkthrough()}
          >
            Review All
          </button>
        )}
      </div>
      {queue.total === 0 && (
        <p class="hub-home-quiet">Nothing is waiting for your review right now.</p>
      )}
      {/* The mockup's row anatomy, exactly: a ranked vertical list, hairlines
          between rows, the QUESTION as the row title, the asked-by meta as
          the subline, the top row highlighted because it is the one Review
          All opens on. Keyed on `ReviewItem.key` — stable across re-fetches —
          so an unchanged row keeps its node across a signal update. */}
      {queue.items.map((item, i) => (
        <ReviewRow key={item.key} item={item} index={i} now={now} handlers={props.handlers} />
      ))}
      {done.map((item) => (
        <SettledRow key={`done:${item.key}`} item={item} now={now} handlers={props.handlers} />
      ))}
    </section>
  );
}

/**
 * Mounts the pane into a wrapper it appends to `host` (`#hub-home-review`);
 * returns the disposer. The island contract, exactly as the probe proved it:
 * the wrapper — not the host — is Preact's container, disposal is
 * render(null, el), and no vanilla code may replaceChildren/innerHTML a
 * container holding the live island. Handlers are bound once at mount — they
 * are stable closures over app state, same as the vanilla call site's.
 */
export function mountHomeReviewIsland(
  host: HTMLElement,
  handlers: ReviewStripHandlers,
): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'home-review');
  host.appendChild(el);
  render(<HomeReview handlers={handlers} />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
