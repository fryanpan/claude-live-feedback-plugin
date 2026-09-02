import type { Thread } from '@feedback/core';
import type { MountScope } from './mount-scope.ts';
import { type ThreadGlyph, type ThreadKind, threadKind } from './thread-kind.ts';

/**
 * Information scent for comments the reader cannot see.
 *
 * Two hints, one at the top of the comment column and one at the bottom, each
 * saying how many threads sit off-screen in that direction and what they are
 * — "4 comments & 1 question above" — and a chip in the top bar saying how
 * many questions are waiting on the reader anywhere in the doc. Tapping a
 * hint jumps to the nearest off-screen thread in that direction; tapping the
 * chip jumps to the first open question. Approved design: comments mock 3
 * (2026-09-01).
 *
 * Above 1100px the hints live INSIDE the balloon margin, sticky to the
 * scroller's top and bottom edges, so they read as part of the column. At
 * phone widths the margin is gone and the hints float over the prose instead
 * — a second pair of elements, because the margin is `display: none` there
 * and nothing inside it can be shown. One render feeds both pairs.
 *
 * "New" rides along: a thread that arrived since the reader last looked
 * (`comment-seen.ts`) is counted on the hint in its direction, and once it has
 * sat in the viewport for `SEEN_DWELL_MS` it stops being new — on the hint, on
 * its glyph and on its highlight, which the caller repaints via `onSeen`.
 */

export const SEEN_DWELL_MS = 1500;

export interface HintItem {
  id: string;
  kind: ThreadKind;
  isNew: boolean;
  /** The anchor's edges in the same coordinate space as the viewport. */
  top: number;
  bottom: number;
}

export interface Tally {
  /** Threads with nothing waiting on the reader: comments, answered, resolved. */
  comments: number;
  /** Open review items — questions and decisions alike, one glyph. */
  questions: number;
  /** How many of the above are new since the reader last looked. */
  fresh: number;
}

export interface OffscreenSplit {
  above: Tally;
  below: Tally;
  /** Ids currently inside the viewport, in document order. */
  inView: string[];
  /** The nearest off-screen thread in each direction, if any. */
  nearestAbove: string | null;
  nearestBelow: string | null;
}

function emptyTally(): Tally {
  return { comments: 0, questions: 0, fresh: 0 };
}

export function tallyTotal(t: Tally): number {
  return t.comments + t.questions;
}

/**
 * Which threads are above, below, or inside the viewport. Pure — the caller
 * measures. `items` must be in document order; "nearest" relies on it. An
 * anchor is off-screen only when the WHOLE of it is out, so a highlight half
 * under the top edge still counts as visible.
 */
export function splitOffscreen(
  items: HintItem[],
  view: { top: number; bottom: number },
): OffscreenSplit {
  const above = emptyTally();
  const below = emptyTally();
  const inView: string[] = [];
  let nearestAbove: string | null = null;
  let nearestBelow: string | null = null;
  for (const it of items) {
    let target: Tally | null = null;
    if (it.bottom < view.top) {
      target = above;
      nearestAbove = it.id;
    } else if (it.top > view.bottom) {
      target = below;
      if (nearestBelow === null) nearestBelow = it.id;
    }
    if (!target) {
      inView.push(it.id);
      continue;
    }
    if (it.kind === 'question') target.questions += 1;
    else target.comments += 1;
    if (it.isNew) target.fresh += 1;
  }
  return { above, below, inView, nearestAbove, nearestBelow };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The hint's words, as parts a renderer can show or hide by width: the full
 * sentence on a wide screen, icon + count only on a phone. Empty when there is
 * nothing in that direction.
 */
export interface HintPart {
  glyph: ThreadGlyph;
  count: number;
  /** The noun, for the wide rendering. */
  word: string;
  /** Carries the red dot: new comments are counted, not itemised. */
  fresh: boolean;
}

export function hintParts(t: Tally): HintPart[] {
  const parts: HintPart[] = [];
  if (t.comments)
    parts.push({
      glyph: 'comment',
      count: t.comments,
      word: t.comments === 1 ? 'comment' : 'comments',
      fresh: t.fresh > 0,
    });
  if (t.questions)
    parts.push({
      glyph: 'question',
      count: t.questions,
      word: t.questions === 1 ? 'question' : 'questions',
      fresh: false,
    });
  return parts;
}

/** The full sentence, for the wide screen and for assistive tech. */
export function hintSentence(t: Tally, dir: 'above' | 'below'): string {
  const parts = hintParts(t).map((p) => `${p.count} ${p.word}`);
  if (parts.length === 0) return '';
  const fresh = t.fresh > 0 ? ` · ${t.fresh} new` : '';
  return `${parts.join(' & ')} ${dir}${fresh}`;
}

/** The top-bar chip's words. */
export function chipSentence(questions: number): string {
  if (questions === 0) return 'Nothing waiting on you';
  return `${plural(questions, 'question', 'questions')} for you`;
}

export function threadHintItem(
  t: Thread,
  rect: { top: number; bottom: number },
  isNew: boolean,
): HintItem {
  return { id: t.id, kind: threadKind(t), isNew, top: rect.top, bottom: rect.bottom };
}

// --- the mount -------------------------------------------------------------

export interface CommentHintsOpts {
  /** The doc's scroll container — the viewport the counts are against. */
  scroller: HTMLElement;
  /** The balloon column; on a wide screen the hints line up over it. Null
   *  when the surface has no margin (the hints then sit at the pane's edges
   *  at every width). */
  marginEl: HTMLElement | null;
  /** Where the hints attach — the editor pane (`position: relative`), which
   *  does not scroll; the doc scrolls inside it. */
  floatParent: HTMLElement;
  /** The top-bar "N questions for you" chip, if the page has one. */
  chipEl: HTMLElement | null;
  threads: () => Thread[];
  /** The thread's rendered highlight, or null when it has none. */
  spanFor: (id: string) => Element | null;
  /** The thread's cards (balloon, inline card, panel row). A card in view
   *  counts as having SEEN the thread even when its sentence has scrolled
   *  off — on a phone the card sits under the sentence, and the reader is
   *  looking at the card. Counts stay keyed to the sentence. */
  cardsFor?: (id: string) => Element[];
  isNew: (t: Thread) => boolean;
  /** Record as seen; returns true when the thread stops being new. */
  markSeen: (t: Thread) => boolean;
  /** A thread stopped being new — repaint its glyph and highlight. */
  onSeen: (id: string) => void;
  onJump: (id: string) => void;
  /** The floating action dock the bottom hint must stay clear of. */
  dockEl?: () => HTMLElement | null;
  scope: MountScope;
  dwellMs?: number;
  /** Is the balloon margin showing at this width? Decides where the pair
   *  sits: over the margin column, or at the pane's corners. */
  marginVisible: () => boolean;
}

export interface CommentHintsHandle {
  /** Re-measure and re-render — call when threads change. */
  refresh: () => void;
  /** The last split, for tests and for the chip. */
  last: () => OffscreenSplit | null;
}

function glyphEl(glyph: ThreadGlyph, fresh: boolean): HTMLElement {
  const i = document.createElement('i');
  i.className = `lf-ic lf-ic-${glyph}${fresh ? ' is-new' : ''}`;
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function renderHint(el: HTMLElement, t: Tally, dir: 'above' | 'below'): void {
  const total = tallyTotal(t);
  el.dataset.n = String(total);
  el.dataset.new = String(t.fresh);
  el.hidden = total === 0;
  el.textContent = '';
  const sentence = hintSentence(t, dir);
  el.setAttribute('aria-label', sentence ? `${sentence} — jump to the nearest` : '');
  el.title = sentence;
  if (total === 0) return;
  const parts = hintParts(t);
  parts.forEach((p, i) => {
    if (i > 0) {
      const amp = document.createElement('span');
      amp.className = 'w';
      amp.textContent = ' & ';
      el.appendChild(amp);
    }
    el.appendChild(glyphEl(p.glyph, p.fresh));
    const b = document.createElement('b');
    b.textContent = String(p.count);
    el.appendChild(b);
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = ` ${p.word}`;
    el.appendChild(w);
  });
  const dirEl = document.createElement('span');
  dirEl.className = 'w';
  dirEl.textContent = ` ${dir}`;
  el.appendChild(dirEl);
  if (t.fresh > 0) {
    const fresh = document.createElement('span');
    fresh.className = 'w lf-offscreen-new';
    fresh.textContent = ` · ${t.fresh} new`;
    el.appendChild(fresh);
  }
  const arrow = document.createElement('span');
  arrow.className = 'm';
  arrow.textContent = dir === 'above' ? '▲' : '▼';
  el.appendChild(arrow);
}

function makeHint(dir: 'above' | 'below'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `lf-offscreen lf-offscreen-${dir === 'above' ? 'top' : 'bottom'}`;
  b.dataset.n = '0';
  b.hidden = true;
  return b;
}

export function mountCommentHints(opts: CommentHintsOpts): CommentHintsHandle {
  const { scroller, scope } = opts;
  const dwell = opts.dwellMs ?? SEEN_DWELL_MS;

  // One pair, absolutely positioned in the pane (which does not scroll), so
  // a balloon — itself absolutely positioned inside the scrolling margin —
  // can never sit on top of a hint, and a hint never joins the balloon flow.
  // A sticky hint inside the margin was tried first: it stuck to the wrong
  // edge and the balloons overlapped it.
  const floatTop = makeHint('above');
  const floatBot = makeHint('below');
  opts.floatParent.append(floatTop, floatBot);

  let last: OffscreenSplit | null = null;
  let lastVisible = new Set<string>();
  let lastQuestions = -1;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;
  const dwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function items(): { list: HintItem[]; byId: Map<string, Thread> } {
    const viewRect = scroller.getBoundingClientRect();
    const withPos: Array<{ item: HintItem; y: number }> = [];
    const byId = new Map<string, Thread>();
    for (const t of opts.threads()) {
      const span = opts.spanFor(t.id);
      if (!span) continue;
      const r = span.getBoundingClientRect();
      byId.set(t.id, t);
      withPos.push({
        item: threadHintItem(
          t,
          { top: r.top - viewRect.top, bottom: r.bottom - viewRect.top },
          opts.isNew(t),
        ),
        y: r.top,
      });
    }
    withPos.sort((a, b) => a.y - b.y);
    return { list: withPos.map((x) => x.item), byId };
  }

  function placeFloats(wide: boolean): void {
    const pane = opts.floatParent.getBoundingClientRect();
    const r = scroller.getBoundingClientRect();
    floatTop.style.top = `${Math.max(0, r.top - pane.top) + 8}px`;
    // Clear of the action dock (Make Plan and friends) when it is showing;
    // otherwise sit just above the scroller's bottom edge.
    const dock = opts.dockEl?.() ?? null;
    const dockRect = dock && !dock.hidden ? dock.getBoundingClientRect() : null;
    const clearFrom = dockRect && dockRect.height > 0 ? dockRect.top - 8 : r.bottom - 12;
    floatBot.style.bottom = `${Math.max(0, pane.bottom - clearFrom)}px`;
    // Over the balloon column on a wide screen; at the pane's corners (the
    // stylesheet's insets) on a phone, where there is no column.
    const m = wide && opts.marginEl ? opts.marginEl.getBoundingClientRect() : null;
    for (const el of [floatTop, floatBot]) {
      if (m && m.width > 0) {
        el.style.left = `${m.left - pane.left + 6}px`;
        el.style.right = `${pane.right - m.right + 6}px`;
      } else {
        el.style.left = '';
        el.style.right = '';
      }
    }
  }

  function armDwell(id: string, t: Thread): void {
    if (dwellTimers.has(id)) return;
    dwellTimers.set(
      id,
      setTimeout(() => {
        dwellTimers.delete(id);
        if (scope.disposed) return;
        // Still on screen? A flick past a comment must not mark it seen.
        if (!lastVisible.has(id)) return;
        if (opts.markSeen(t)) opts.onSeen(id);
        refresh();
      }, dwell),
    );
  }

  function disarm(id: string): void {
    const timer = dwellTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      dwellTimers.delete(id);
    }
  }

  function renderChip(questions: number): void {
    const chip = opts.chipEl;
    if (!chip) return;
    if (questions > 0) {
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = null;
      chip.hidden = false;
      chip.classList.remove('is-done');
      chip.textContent = '';
      chip.appendChild(glyphEl('question', false));
      const b = document.createElement('b');
      b.textContent = String(questions);
      chip.appendChild(b);
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = ` ${questions === 1 ? 'question' : 'questions'} for you`;
      chip.appendChild(w);
      chip.title = chipSentence(questions);
      chip.setAttribute('aria-label', `${chipSentence(questions)} — jump to the first`);
    } else if (lastQuestions > 0) {
      // The last one was just answered: say so, briefly. A permanent "nothing
      // waiting" chip is metadata the reader cannot act on.
      chip.hidden = false;
      chip.classList.add('is-done');
      chip.textContent = '';
      chip.appendChild(glyphEl('done', false));
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = ` ${chipSentence(0)}`;
      chip.appendChild(w);
      chip.title = chipSentence(0);
      chip.setAttribute('aria-label', chipSentence(0));
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = setTimeout(() => {
        doneTimer = null;
        chip.hidden = true;
      }, 4000);
    } else if (!doneTimer) {
      chip.hidden = true;
    }
    lastQuestions = questions;
  }

  function refresh(): void {
    if (scope.disposed) return;
    const { list, byId } = items();
    const split = splitOffscreen(list, { top: 4, bottom: scroller.clientHeight - 4 });
    last = split;
    renderHint(floatTop, split.above, 'above');
    renderHint(floatBot, split.below, 'below');
    placeFloats(opts.marginVisible());
    // New threads in view start their dwell; ones that left it stop. A card
    // in view is as good as the sentence in view.
    const visible = new Set(split.inView);
    if (opts.cardsFor) {
      const v = scroller.getBoundingClientRect();
      for (const it of list) {
        if (visible.has(it.id) || !it.isNew) continue;
        for (const card of opts.cardsFor(it.id)) {
          const r = card.getBoundingClientRect();
          if (r.height > 0 && r.top < v.bottom && r.bottom > v.top) {
            visible.add(it.id);
            break;
          }
        }
      }
    }
    lastVisible = visible;
    for (const id of Array.from(dwellTimers.keys())) if (!visible.has(id)) disarm(id);
    for (const it of list) {
      if (!it.isNew) continue;
      if (!visible.has(it.id)) continue;
      const t = byId.get(it.id);
      if (t) armDwell(it.id, t);
    }
    // The chip counts every open ask on the doc, anchored or not.
    let questions = 0;
    for (const t of opts.threads()) if (threadKind(t) === 'question') questions += 1;
    renderChip(questions);
  }

  function jump(dir: 'above' | 'below'): void {
    refresh();
    const id = dir === 'above' ? last?.nearestAbove : last?.nearestBelow;
    if (id) opts.onJump(id);
  }

  function jumpToFirstAsk(): void {
    const { list } = items();
    const first = list.find((it) => it.kind === 'question');
    if (first) {
      opts.onJump(first.id);
      return;
    }
    // An open ask with no highlight to scroll to (a subject-anchored thread):
    // still hand it over — the caller's reveal knows how to open it.
    const any = opts.threads().find((t) => threadKind(t) === 'question');
    if (any) opts.onJump(any.id);
  }

  scope.listen(floatTop, 'click', () => jump('above'));
  scope.listen(floatBot, 'click', () => jump('below'));
  if (opts.chipEl) scope.listen(opts.chipEl, 'click', jumpToFirstAsk);

  // Scroll is the hot path: one measurement per frame at most, and a settle
  // pass afterwards so the last position always gets counted.
  let raf: number | null = null;
  const onScroll = (): void => {
    if (raf != null) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      refresh();
    });
  };
  scope.listen(scroller, 'scroll', onScroll, { passive: true });
  scope.listen(window, 'resize', onScroll);
  scope.onCleanup(() => {
    if (raf != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = null;
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
    for (const id of Array.from(dwellTimers.keys())) disarm(id);
    floatTop.remove();
    floatBot.remove();
    if (opts.chipEl) opts.chipEl.hidden = true;
  });

  refresh();
  return { refresh, last: () => last };
}
