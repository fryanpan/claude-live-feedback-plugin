/**
 * The thread card's expand/collapse morph.
 *
 * A card is not "collapsed content that grows". Each summary line is paired
 * with what it BECOMES, and both faces live in the same box, absolutely
 * positioned at `top: 0`:
 *
 * | slot | summary face          | detail face                |
 * |------|-----------------------|----------------------------|
 * | A    | the topic line        | the opening message        |
 * | B    | participants + state  | the replies + reply box    |
 *
 * A slot therefore has NO intrinsic height — its height exists only because
 * this module measures the showing face and writes it. Nothing ever collapses
 * to zero, because a slot is never empty: one face is always resting at its
 * measured height.
 *
 * Expanding is two overlapping phases over 150 ms. Slot A leads on expand
 * (the topic grows into the opening message) and slot B follows, riding down
 * intact on slot A's growth before it cross-fades into the replies. Collapse
 * runs the same two phases in the opposite order, so the thread retreats back
 * into the two lines it came from.
 */

/** Total morph, both phases. */
export const MORPH_MS = 150;
/** Each phase's own length: 62% of the total. */
export const MORPH_SPAN_MS = 93;
/** How far the second phase starts behind the first: 38% of the total. */
export const MORPH_LAG_MS = 57;
/** The leaving face fades out over this fraction of the phase, so the two
 *  texts never read as one overlapping smear. */
export const LEAVING_FRACTION = 0.6;

const EASE = 'cubic-bezier(.22,.72,.24,1)';

export interface PhaseTiming {
  duration: number;
  delay: number;
}

export interface MorphTiming {
  a: PhaseTiming;
  b: PhaseTiming;
}

/**
 * Which slot leads and by how much. Pure, so the phase order is checkable
 * without a browser.
 *
 * Expand leads with slot A (0 → 93 ms) and lags slot B (57 → 150 ms).
 * Collapse is the mirror: slot B leads, slot A lags. `reduce` zeroes the
 * DURATION AND THE DELAY only — the class flip and the measured height
 * assignment still run, so the card lands in exactly the right state with no
 * tween. Never branch to a different layout for reduced motion.
 */
export function morphTiming(open: boolean, reduce: boolean): MorphTiming {
  if (reduce) {
    return { a: { duration: 0, delay: 0 }, b: { duration: 0, delay: 0 } };
  }
  const duration = MORPH_SPAN_MS;
  return open
    ? { a: { duration, delay: 0 }, b: { duration, delay: MORPH_LAG_MS } }
    : { a: { duration, delay: MORPH_LAG_MS }, b: { duration, delay: 0 } };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** `CSS.escape` guarded — happy-dom (and very old browsers) may not have it. */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

/**
 * Every copy of one thread's card.
 *
 * A thread can be on screen TWICE — inline in the document and again in the
 * mobile sheet — and expand state is shared between them. Nothing may address
 * a card by a document-unique id: a singular lookup animates one copy and
 * leaves the other silently in the wrong state.
 */
export function threadCards(id: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`.thread[data-thread-id="${cssEscape(id)}"]`),
  );
}

/**
 * Did this click mean "fold this card", or was the user reaching past it?
 *
 * The whole card is the tap target and the caret is only a hint, so the
 * exclusions are the entire specification of what a tap means. They are all
 * things you tap FOR something else: a field, a control, a link — plus a text
 * selection being dragged out, which must never collapse the comment out from
 * under the reader mid-quote.
 *
 * Shared so the card's own handler and the balloon column's restack agree by
 * construction; two copies of this list would drift and the column would
 * re-stack on taps that folded nothing.
 */
export function isFoldingTap(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.closest?.('input, textarea, select, button, a, label')) return false;
  const sel = typeof window.getSelection === 'function' ? window.getSelection() : null;
  if (sel && !sel.isCollapsed) return false;
  return true;
}

/**
 * Hide the face that is not showing from assistive tech and from the tab
 * order.
 *
 * Both faces of a slot are in the DOM at once — that is what the morph
 * cross-fades between — and the resting one is hidden only by `opacity: 0`,
 * which hides nothing from a screen reader and removes nothing from the tab
 * order. Without this, a collapsed card reads its topic line AND its opening
 * message, and tabbing through the drawer lands in an invisible reply box.
 *
 * `opacity` is what animates, so visibility can't be expressed in CSS here;
 * it rides the class flip instead. Anything that toggles `expanded` on an
 * existing card must call this too.
 */
export function syncFaceVisibility(card: HTMLElement, expanded: boolean): void {
  const showing = expanded ? 'face-detail' : 'face-summary';
  for (const face of Array.from(card.querySelectorAll<HTMLElement>('.thread-face'))) {
    if (face.classList.contains(showing)) {
      face.removeAttribute('inert');
      face.removeAttribute('aria-hidden');
    } else {
      face.setAttribute('inert', '');
      face.setAttribute('aria-hidden', 'true');
    }
  }
}

/** The face a slot is currently resting on, given its card's state. */
function faceOf(slot: HTMLElement, expanded: boolean): HTMLElement | null {
  return slot.querySelector<HTMLElement>(expanded ? '.face-detail' : '.face-summary');
}

/**
 * Give every slot under `root` the height of the face that is currently
 * showing.
 *
 * Must run after every render — before anything reads a card's own height,
 * because the balloon margin's layout pass does exactly that — and again
 * whenever text metrics change underneath a measurement that has already been
 * taken (see `installSlotRemeasure`).
 */
export function sizeThreadSlots(root: ParentNode): void {
  for (const slot of Array.from(root.querySelectorAll<HTMLElement>('.thread-slot'))) {
    const expanded = slot.closest('.thread')?.classList.contains('expanded') ?? false;
    const face = faceOf(slot, expanded);
    if (face) slot.style.height = `${face.offsetHeight}px`;
  }
}

/**
 * Re-measure every card on screen when the measurement could have gone stale.
 *
 * A slot's height is a NUMBER we wrote, not something the browser maintains.
 * A reflow changes how many lines a message takes, and a webfont landing after
 * first paint leaves every card holding a height computed against the fallback
 * face — in both cases the card keeps a height that no longer matches its
 * content until something else happens to re-render it.
 */
export function installSlotRemeasure(scope: {
  listen: (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject) => void;
  disposed?: boolean;
}): void {
  scope.listen(window, 'resize', () => sizeThreadSlots(document));
  document.fonts?.ready.then(() => {
    if (scope.disposed) return;
    sizeThreadSlots(document);
  });
}

/**
 * Fold or unfold every copy of one thread's card, IN PLACE.
 *
 * Toggling must mutate the existing node, never re-render it: a freshly built
 * node mounts at its final height and cannot animate — there is no "from" to
 * tween out of.
 */
export function morphThread(id: string, open: boolean, root: ParentNode = document): void {
  for (const card of threadCards(id, root)) morphCard(card, open);
}

/**
 * One card. The class flip happens FIRST and sets the resting state; the
 * keyframes only replay the journey, so an interrupted or unsupported
 * animation still leaves the card correct.
 */
export function morphCard(card: HTMLElement, open: boolean): void {
  const slotA = card.querySelector<HTMLElement>('.slot-a');
  const slotB = card.querySelector<HTMLElement>('.slot-b');
  // Measure BEFORE the class flip: `from` is the height the card is leaving.
  const fromA = slotA?.offsetHeight ?? 0;
  const fromB = slotB?.offsetHeight ?? 0;

  card.classList.toggle('expanded', open);
  syncFaceVisibility(card, open);

  const timing = morphTiming(open, prefersReducedMotion());
  slide(slotA, open, fromA, timing.a);
  slide(slotB, open, fromB, timing.b);
}

/**
 * One slot's journey.
 *
 * The delayed keyframes use `fill: 'backwards'`, which holds the OLD height
 * and opacity through the delay. That is precisely what lets the lagging slot
 * sit still and simply TRAVEL while the leading slot is still growing,
 * instead of jumping to its final height at t=0 — drop the fill and slot B
 * snaps open the instant you tap.
 */
function slide(
  slot: HTMLElement | null,
  expanded: boolean,
  from: number,
  timing: PhaseTiming,
): void {
  if (!slot) return;
  const arriving = faceOf(slot, expanded);
  const leaving = faceOf(slot, !expanded);
  if (!arriving || !leaving) return;
  const to = arriving.offsetHeight;
  // The resting state lands immediately; the tween below replays the journey.
  slot.style.height = `${to}px`;
  if (!timing.duration || typeof slot.animate !== 'function') return;

  const opts: KeyframeAnimationOptions = {
    duration: timing.duration,
    delay: timing.delay,
    easing: EASE,
    fill: 'backwards',
  };
  slot.animate([{ height: `${from}px` }, { height: `${to}px` }], opts);
  arriving.animate([{ opacity: 0 }, { opacity: 1 }], opts);
  leaving.animate([{ opacity: 1 }, { opacity: 0 }], {
    ...opts,
    duration: timing.duration * LEAVING_FRACTION,
  });
}
