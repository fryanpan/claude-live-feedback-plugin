import { type Thread, threadLines } from '@feedback/core';
import type { InlineThreadCard, ReviewSurface } from './review-surface.ts';
import { sizeThreadSlots } from './thread-morph.ts';

/**
 * Mobile review navigation.
 *
 * There is no standalone comment drawer on a phone. Two surfaces:
 *
 *  1. **Inline** — the card sits directly under the text (or the source line)
 *     it points at, exactly where a GitHub PR comment sits. Only threads that
 *     have a line to sit beside appear here: open, with a resolvable anchor.
 *  2. **The over-doc sheet** — what the app bar's comment-count badge opens.
 *     Grouped Open / Orphaned / Resolved. This is the ONLY place an orphaned
 *     or resolved thread appears, because neither has an anchor to sit under.
 *
 * `‹ ›` in the app bar, to the LEFT of the badge, walk the inline cards in
 * document order. A thread with no inline position cannot be walked — the
 * buttons go disabled rather than landing the reader on nothing.
 *
 * Expand state is SHARED between a thread's inline copy and its sheet copy:
 * this module never touches a card's expansion directly, it goes through the
 * panel's active thread, which folds every copy on screen at once.
 */

/** Everything `centreScrollTop` needs, and nothing that needs a browser. */
export interface CentreMetrics {
  /** The card's top edge in the scroll container's own content space. */
  elTop: number;
  elHeight: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Where a card has to sit for the jump to read as "go to that comment":
 * centred inside its OWN scroller, clamped to that scroller's range.
 *
 * Deliberately not `scrollIntoView()` — that walks up and scrolls every
 * ancestor scroller too, so the page moves out from under the review surface.
 * Pure so the clamp is checkable without a DOM.
 */
export function centreScrollTop(m: CentreMetrics): number {
  const max = Math.max(0, m.scrollHeight - m.clientHeight);
  const wanted = m.elTop - m.clientHeight / 2 + m.elHeight / 2;
  return Math.max(0, Math.min(max, wanted));
}

/**
 * The next index when walking a wrapping list. `current` starts at -1 (nothing
 * visited yet), so the first "next" lands on 0 and the first "previous" on the
 * last item. Tolerates a `current` left over from a longer list.
 */
export function stepIndex(current: number, dir: number, length: number): number {
  if (length <= 0) return -1;
  // Nothing visited yet: forward starts at the top of the doc, backward at
  // the bottom. Wrapping the arithmetic instead would land the first
  // "previous" on the second-to-last card for no reason a reader could name.
  if (current < 0) return dir < 0 ? length - 1 : 0;
  return (((current + dir) % length) + length) % length;
}

/** How long the target card stays highlighted after the nav jumps to it. */
export const NAV_FLASH_MS = 900;

export interface MobileReviewOpts {
  /** Phone-width, i.e. the viewport where inline + sheet replace the drawer. */
  isMobile: () => boolean;
  /** Every thread on this doc, as the chrome already reads them. */
  threads: () => Thread[];
  /** Live position of a thread's anchor, or null once it stops resolving. */
  resolveRange: (id: string) => { from: number; to: number } | null;
  /** THE shared card builder (`ThreadPanel.renderThread`). Never fork it —
   *  the inline card and the sheet card must be the same shape, and the morph
   *  needs both faces present in whatever node it is handed. */
  renderCard: (t: Thread, pendingReply?: string) => HTMLElement;
  surface: Pick<ReviewSurface, 'setInlineCards' | 'scrollToPos'>;
  /** Expand state, shared with every other copy of the card. */
  setActive: (id: string | null) => void;
  getActive: () => string | null;
  /** Scroll the sheet's own copy of a thread into view once the sheet is up. */
  revealInSheet: (id: string) => void;
  openSheet: () => void;
  closeSheet: () => void;
  isSheetOpen: () => boolean;
  listen: (t: EventTarget, type: string, h: EventListenerOrEventListenerObject) => void;
  onCleanup?: (fn: () => void) => void;
}

export interface MobileReview {
  /** Rebuild the inline card set from the current threads. Cheap when
   *  nothing a card displays has changed: card nodes are REUSED, which is
   *  what lets an expanded card survive an unrelated thread's new reply. */
  refresh: () => void;
  /** Walk to the next (+1) / previous (-1) inline comment. */
  step: (dir: number) => void;
  /** Focus one thread the mobile way. Returns true when it had an inline
   *  card to jump to, false when the sheet was opened instead. */
  showThread: (id: string) => boolean;
  /** Open threads with a resolvable anchor, in document order. */
  inlineThreads: () => Thread[];
}

/**
 * What a card DISPLAYS. Rebuild only on a change to this — never on expansion,
 * because a freshly built node mounts at its final height and cannot morph.
 *
 * The topic line comes from the anchor snippet, which moves whenever the doc
 * is edited, independently of every other term here. Leave it out and an
 * edited anchor keeps a stale topic until some unrelated change repaints.
 */
function cardKey(t: Thread): string {
  return `${t.status}|${t.commentCount}|${t.lastActivity}|${threadLines(t).topic}`;
}

/**
 * The scroller that actually holds this card. CodeMirror scrolls inside its
 * own `.cm-scroller`; prose scrolls in `#editor`. Anything above those is a
 * scroller we must NOT move.
 */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('.cm-scroller') ?? document.getElementById('editor');
}

export function mountMobileReview(opts: MobileReviewOpts): MobileReview {
  /** One live node per inline thread, keyed by thread id. Kept across
   *  refreshes so an expanded card is not rebuilt out from under its morph. */
  const built = new Map<string, { key: string; el: HTMLElement }>();
  let navIdx = -1;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const prevBtn = document.getElementById('prev-comment') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('next-comment') as HTMLButtonElement | null;
  const navBtns = [prevBtn, nextBtn].filter((b): b is HTMLButtonElement => b != null);
  const navTitles = new Map<HTMLButtonElement, string>();
  for (const b of navBtns) navTitles.set(b, b.title);
  if (prevBtn) opts.listen(prevBtn, 'click', () => step(-1));
  if (nextBtn) opts.listen(nextBtn, 'click', () => step(1));

  function inlineThreads(): Thread[] {
    const withPos: Array<{ t: Thread; from: number }> = [];
    for (const t of opts.threads()) {
      // A resolved thread has no highlight to sit under, and an orphaned one
      // has no anchor at all. Both live in the sheet and only there.
      if (t.status !== 'open') continue;
      if (t.anchor.kind !== 'text-range') continue;
      const r = opts.resolveRange(t.id);
      if (!r) continue;
      withPos.push({ t, from: r.from });
    }
    withPos.sort((a, b) => a.from - b.from);
    return withPos.map((x) => x.t);
  }

  function syncNavButtons(count: number): void {
    for (const b of navBtns) {
      b.disabled = count === 0;
      b.title =
        count === 0
          ? 'No comments anchored in this file — open the comment list'
          : (navTitles.get(b) ?? b.title);
    }
  }

  function refresh(): void {
    const list = opts.isMobile() ? inlineThreads() : [];
    const cards: InlineThreadCard[] = [];
    const seen = new Set<string>();
    for (const t of list) {
      const r = opts.resolveRange(t.id);
      if (!r) continue;
      seen.add(t.id);
      const key = cardKey(t);
      let entry = built.get(t.id);
      if (!entry || entry.key !== key) {
        // Carry an in-progress reply across the rebuild — the same trick the
        // drawer and the balloon margin use, and needed here for the same
        // reason: someone else's reply must not wipe what you were typing.
        const draft = entry?.el.querySelector<HTMLTextAreaElement>('textarea')?.value;
        const el = opts.renderCard(t, draft || undefined);
        el.classList.add('lf-inline-card');
        // A widget decoration is outside the document's content model, but
        // nothing stops native editing INSIDE the injected DOM unless the
        // widget opts out itself (same rule live-markup.ts's chip follows).
        el.contentEditable = 'false';
        entry = { key, el };
        built.set(t.id, entry);
      }
      cards.push({ id: t.id, from: r.from, to: r.to, el: entry.el });
    }
    for (const id of Array.from(built.keys())) if (!seen.has(id)) built.delete(id);
    opts.surface.setInlineCards?.(cards);
    // A card's folding slots hold a height we MEASURE — do it now the nodes
    // are actually in the document, or every inline card renders as a header
    // and a footer with nothing between them.
    for (const c of cards) if (c.el.isConnected) sizeThreadSlots(c.el);
    syncNavButtons(cards.length);
  }

  function flash(el: HTMLElement): void {
    if (flashTimer) clearTimeout(flashTimer);
    for (const other of Array.from(document.querySelectorAll('.lf-nav-flash')))
      other.classList.remove('lf-nav-flash');
    el.classList.add('lf-nav-flash');
    flashTimer = setTimeout(() => el.classList.remove('lf-nav-flash'), NAV_FLASH_MS);
  }

  function centreCard(el: HTMLElement): void {
    const sc = scrollContainerOf(el);
    if (!sc) return;
    const top = centreScrollTop({
      elTop: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop,
      elHeight: el.offsetHeight,
      clientHeight: sc.clientHeight,
      scrollHeight: sc.scrollHeight,
    });
    // Scroll THIS container by hand. `scrollIntoView()` would walk up and
    // scroll every ancestor scroller too, dragging the page behind the
    // review surface along with it.
    if (typeof sc.scrollTo === 'function') sc.scrollTo({ top, behavior: 'smooth' });
    else sc.scrollTop = top;
  }

  function showThread(id: string): boolean {
    // Expanding goes through the panel's active thread, so the inline copy
    // and the sheet copy fold together — never touch one copy directly.
    opts.setActive(id);
    const el = built.get(id)?.el;
    if (el?.isConnected) {
      if (opts.isSheetOpen()) opts.closeSheet();
      centreCard(el);
      flash(el);
      return true;
    }
    // The card exists but isn't in the DOM: CodeMirror only renders its
    // viewport, so an off-screen inline card is genuinely absent. Scroll the
    // surface to the anchor first and centre once it has been rendered.
    const r = built.has(id) ? opts.resolveRange(id) : null;
    if (r) {
      opts.surface.scrollToPos?.(r.from);
      requestAnimationFrame(() => {
        const later = built.get(id)?.el;
        if (later?.isConnected) {
          centreCard(later);
          flash(later);
        }
      });
      return true;
    }
    // Orphaned or resolved: no line to sit beside, so the sheet is the only
    // place this thread exists at all.
    opts.openSheet();
    opts.revealInSheet(id);
    return false;
  }

  function step(dir: number): void {
    const list = inlineThreads();
    // Nothing to walk. The buttons are disabled in this state; bail anyway
    // rather than wrap onto an empty list and land the reader on nothing.
    if (list.length === 0) return;
    // Pick up wherever the reader already is, so ‹ › continue from the card
    // they tapped rather than from wherever the nav last stopped.
    const active = opts.getActive();
    const activeIdx = active ? list.findIndex((t) => t.id === active) : -1;
    if (activeIdx >= 0) navIdx = activeIdx;
    navIdx = stepIndex(navIdx, dir, list.length);
    const target = list[navIdx];
    if (target) showThread(target.id);
  }

  opts.onCleanup?.(() => {
    if (flashTimer) clearTimeout(flashTimer);
    built.clear();
    opts.surface.setInlineCards?.([]);
  });

  return { refresh, step, showThread, inlineThreads };
}
