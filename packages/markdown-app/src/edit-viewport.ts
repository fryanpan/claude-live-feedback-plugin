/**
 * Editing a document while an on-screen keyboard is up.
 *
 * Two defects, both reported by Bryan from an iPhone after tapping a table
 * cell in a review doc: *"the keyboard and voice recording panel moved up to
 * cover what I'm editing. I don't need the voice recording panel while
 * editing and the screen should also scroll up to show the point being
 * edited"*.
 *
 * 1. THE MEETING STRIP YIELDS. It is `#editor-pane`'s third grid row, so on a
 *    phone — where it is a stacked panel, not a 40px bar — it costs the prose
 *    ~70px on top of whatever the keyboard already takes. It is also the one
 *    thing on that screen with nothing to say while somebody types. So while
 *    an editor holds focus at phone width the strip gives its row back.
 *
 *    It yields in CSS, never by unmounting: `stripYield` publishes a mode on
 *    `<body>` and the stylesheet reads it. The strip's state machine, its
 *    socket and any in-progress capture never learn this happened, which is
 *    what keeps a live huddle recording through an edit. It is also why the
 *    yield is NOT `root.hidden` — that attribute already means "no meeting
 *    surface is available here" (meeting-strip.ts), and overloading it would
 *    make a yielded strip indistinguishable from an unavailable one, with the
 *    strip's own availability logic free to un-yield it at any moment.
 *
 *    A RECORDING strip never disappears — a live mic with no indicator is not
 *    a thing to ship. It collapses instead, to the meta row that carries the
 *    pulsing dot, the clock and Stop; only the transcript caption goes.
 *
 * 2. THE CARET STAYS ABOVE THE KEYBOARD. Nothing scrolled to follow it. iOS
 *    does not shrink the LAYOUT viewport for the keyboard, so `#editor` still
 *    extends behind it and the browser's own scroll-into-view has no reason
 *    to fire. `caretScrollDelta` measures the caret against the band the
 *    visual viewport says is actually visible and scrolls `#editor` — by
 *    hand, for the same reason `mobile-review.ts` does: `scrollIntoView()`
 *    walks up and moves every ancestor scroller too.
 *
 *    The LAST LINE of a long doc is the case a delta alone cannot fix — the
 *    scroller is already at its maximum, so there is nothing left to scroll.
 *    The runway comes from the stylesheet: `#editor`'s bottom padding grows
 *    by `--kb-bottom`, so the document gains exactly as much scrollable room
 *    as the keyboard took. `caretScrollDelta` clamps to the range that
 *    padding produces rather than promising a scroll that cannot happen.
 */

import { IOS_ACCESSORY, keyboardInset } from './keyboard-inset.ts';

/** Width at which the strip becomes a stacked panel rather than a bar — the
 *  canonical phone breakpoint (docs/product/design-mobile.md). Above it the
 *  strip is 40px in a row, which is what the iPad reads, and it does not
 *  yield: the complaint is a phone complaint and the iPad's scarce axis is
 *  paid for by a bar that small only once. */
export const STRIP_YIELD_QUERY = '(max-width: 720px)';

/** How much clear space to keep between the caret and either edge of the
 *  visible band. One line of 16px prose at 1.55, near enough. */
export const CARET_MARGIN = 26;

/** What the stylesheet is told to do with the strip. `full` publishes no
 *  attribute at all — the strip's normal layout is the absence of a mode. */
export type StripMode = 'full' | 'compact' | 'hidden';

export interface StripYieldInput {
  /** Phone width — see `STRIP_YIELD_QUERY`. */
  narrow: boolean;
  /** An editable element inside the document surface holds focus. */
  editing: boolean;
  /** A meeting is being recorded right now. */
  live: boolean;
}

/**
 * Should the strip give its grid row back, and how much of it?
 *
 * Pure, because the interesting part is the third case: a live recording is
 * the one state where "hide it" is the wrong answer, and that has to be
 * checkable without a browser.
 */
export function stripYield(i: StripYieldInput): StripMode {
  if (!i.narrow || !i.editing) return 'full';
  return i.live ? 'compact' : 'hidden';
}

export interface CaretBand {
  /** The caret's rect in LAYOUT-viewport (client) coordinates — what
   *  `getBoundingClientRect` and ProseMirror's `coordsAtPos` both return. */
  caretTop: number;
  caretBottom: number;
  /** The part of the window the keyboard is NOT over, in the same
   *  layout-viewport coordinates. `vvBottom` should already have the iOS
   *  form-accessory bar taken off it. */
  vvTop: number;
  vvBottom: number;
  /** The scroller's OWN visible box. The band is the intersection of the two,
   *  which is what makes this correct when something else is taking room out
   *  of the scroller rather than covering the window — the format bar above,
   *  and the meeting strip below. A recording strip appearing mid-edit is
   *  exactly that case: the window is unchanged, `#editor` gets shorter, and
   *  a caret measured against the window alone reads as fine while sitting
   *  below the scroller's clip box. Measured in a browser at 430x932. */
  viewTop: number;
  viewBottom: number;
  /** Clear space to keep at each edge of the band. */
  margin: number;
  /** The scroller that holds the caret, and how far it can still travel. */
  scrollTop: number;
  scrollMax: number;
}

/**
 * How far to scroll the caret's own scroller so the caret sits inside the
 * visible band. Positive scrolls the content up (the usual case: the caret is
 * under the keyboard); negative scrolls it back down; zero means leave it
 * alone — a caret already in the band must not be nudged, or every keystroke
 * would shuffle the page.
 *
 * The result is CLAMPED to the scroll the container can actually perform.
 * That is the honest answer for the last line of a document: if the stylesheet
 * has not given the scroller room to lift that line clear of the keyboard,
 * this returns the part it can do rather than pretending.
 */
export function caretScrollDelta(b: CaretBand): number {
  const bandTop = Math.max(b.vvTop, b.viewTop) + b.margin;
  const bandBottom = Math.min(b.vvBottom, b.viewBottom) - b.margin;
  // Nothing is visible to aim at (a collapsed pane, a keyboard taller than
  // the scroller). Scrolling to a band that does not exist would just jump.
  if (bandBottom <= bandTop) return 0;
  let want = 0;
  if (b.caretBottom > bandBottom) want = b.caretBottom - bandBottom;
  else if (b.caretTop < bandTop) want = b.caretTop - bandTop;
  if (want === 0) return 0;
  const down = Math.max(0, b.scrollMax - b.scrollTop);
  const up = -Math.max(0, b.scrollTop);
  const delta = Math.round(Math.max(up, Math.min(down, want)));
  // `Math.round(-0)` is -0, and every caller here compares against 0.
  return delta === 0 ? 0 : delta;
}

/**
 * Is this element one that opens a keyboard? `isContentEditable` covers the
 * document surface and every ProseMirror a thread card mounts; the input
 * types excluded below are the ones that are buttons, pickers or sliders
 * wearing `<input>`.
 */
export function isTextEntry(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(
    type,
  );
}

export interface EditViewportOpts {
  /** Regions whose focused text entry counts as "editing this document" —
   *  the prose surface and the comment composer. */
  roots: () => Array<HTMLElement | null | undefined>;
  /** The scroller that holds the caret. Only focus INSIDE it is followed;
   *  the composer rides `--kb-bottom` in fixed position and is nobody's
   *  scroll problem. */
  scroller: () => HTMLElement | null;
  /** The caret's rect from the editor that owns it, when it has one.
   *  Falls back to the focused element's own box. */
  caretRect?: () => { top: number; bottom: number } | null;
  /** The meeting strip, read only for whether it is recording. */
  strip: () => HTMLElement | null;
  listen: (
    t: EventTarget,
    type: string,
    h: EventListenerOrEventListenerObject,
    o?: AddEventListenerOptions,
  ) => void;
  onCleanup: (fn: () => void) => void;
}

export interface EditViewport {
  /** Bring the caret back into the visible band if the keyboard has covered
   *  it. Safe to call on every selection change: a caret already in the band
   *  scrolls nothing. */
  follow: () => void;
  /** Recompute the strip's mode now (focus, width or recording changed). */
  sync: () => void;
}

/** How long to wait for the keyboard to finish sliding up before measuring,
 *  when no `visualViewport` resize arrives to say it already has. Matches the
 *  composer's existing fallback in app.ts. */
const KEYBOARD_SETTLE_MS = 500;

export function wireEditViewport(opts: EditViewportOpts): EditViewport {
  const media =
    typeof window.matchMedia === 'function' ? window.matchMedia(STRIP_YIELD_QUERY) : null;

  function activeEl(): Element | null {
    return document.activeElement;
  }

  function editing(): boolean {
    const el = activeEl();
    if (!isTextEntry(el)) return false;
    for (const root of opts.roots()) if (root?.contains(el)) return true;
    return false;
  }

  function sync(): void {
    const mode = stripYield({
      narrow: media?.matches ?? false,
      editing: editing(),
      live: opts.strip()?.classList.contains('is-live') ?? false,
    });
    if (mode === 'full') delete document.body.dataset.editViewport;
    else document.body.dataset.editViewport = mode;
  }

  function rectOf(): { top: number; bottom: number } | null {
    const fromEditor = opts.caretRect?.();
    if (fromEditor) return fromEditor;
    const el = activeEl();
    if (!(el instanceof HTMLElement)) return null;
    const r = el.getBoundingClientRect();
    return r.height > 0 || r.width > 0 ? { top: r.top, bottom: r.bottom } : null;
  }

  function follow(): void {
    const sc = opts.scroller();
    const el = activeEl();
    // Only the caret in this scroller. Focus in the composer sheet is a
    // fixed-position surface that already rides the inset.
    if (!sc || !el || !sc.contains(el) || !isTextEntry(el)) return;
    const vv = window.visualViewport;
    // Nothing is covering the bottom (desktop, or the keyboard is down), so
    // the browser's own caret handling is enough and a scroll here would be
    // an unexplained jump.
    if (keyboardInset(window.innerHeight, vv) <= 0) return;
    const rect = rectOf();
    if (!rect) return;
    const vvTop = vv?.offsetTop ?? 0;
    const box = sc.getBoundingClientRect();
    const delta = caretScrollDelta({
      caretTop: rect.top,
      caretBottom: rect.bottom,
      vvTop,
      // `visualViewport.height` excludes the keyboard but NOT the iOS
      // form-accessory bar floating above it (keyboard-inset.ts), so the
      // band that is really visible is that much shorter.
      vvBottom: vvTop + (vv?.height ?? window.innerHeight) - IOS_ACCESSORY,
      viewTop: box.top,
      viewBottom: box.bottom,
      margin: CARET_MARGIN,
      scrollTop: sc.scrollTop,
      scrollMax: Math.max(0, sc.scrollHeight - sc.clientHeight),
    });
    if (delta === 0) return;
    // Instant, not smooth: this is a correction chasing a keyboard that is
    // itself animating, and an easing curve on top reads as drift.
    if (typeof sc.scrollBy === 'function') sc.scrollBy({ top: delta, behavior: 'auto' });
    else sc.scrollTop += delta;
  }

  /** Focus has moved: republish the strip mode, then follow the caret once
   *  the keyboard has finished arriving. The `visualViewport` resize is the
   *  real signal; the timer is the fallback for a keyboard already up. */
  let settle: ReturnType<typeof setTimeout> | null = null;
  function onFocusChange(): void {
    sync();
    if (!editing()) return;
    const vv = window.visualViewport;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      vv?.removeEventListener('resize', run);
      follow();
    };
    vv?.addEventListener('resize', run);
    if (settle) clearTimeout(settle);
    settle = setTimeout(run, KEYBOARD_SETTLE_MS);
  }

  // `focusout` fires before the incoming `focusin`, so both defer a frame and
  // read `document.activeElement` once it has settled.
  let frame: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (frame) clearTimeout(frame);
    frame = setTimeout(onFocusChange, 0);
  };
  opts.listen(document, 'focusin', schedule);
  opts.listen(document, 'focusout', schedule);

  const vv = window.visualViewport;
  if (vv) {
    opts.listen(vv, 'resize', () => {
      sync();
      follow();
    });
  }
  /** The scroller's height just changed, so the caret may now be outside it
   *  even though the window did not move. */
  const syncAndFollow = () => {
    sync();
    follow();
  };
  if (media) media.addEventListener('change', syncAndFollow);

  // The strip can start or stop recording while the mode is published (a
  // huddle opened from the board, or Stop pressed from another surface), and
  // `compact` vs `hidden` turns on exactly that.
  const stripEl = opts.strip();
  const obs =
    stripEl && typeof MutationObserver === 'function'
      ? new MutationObserver(() => syncAndFollow())
      : null;
  if (obs && stripEl) obs.observe(stripEl, { attributes: true, attributeFilter: ['class'] });

  opts.onCleanup(() => {
    if (settle) clearTimeout(settle);
    if (frame) clearTimeout(frame);
    if (media) media.removeEventListener('change', syncAndFollow);
    obs?.disconnect();
    // Leaving the attribute behind would hide the next document's strip.
    delete document.body.dataset.editViewport;
  });

  sync();
  return { follow, sync };
}
