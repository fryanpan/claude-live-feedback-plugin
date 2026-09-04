/**
 * Where this reader's comments and doc list live, on THIS device.
 *
 * Three stored view preferences and the topbar toggles that own them: the
 * threads drawer, the In-This-Review doc list, and whether comment cards sit
 * in the flow or in the margin. They are one module because they answer one
 * question in one way — a stored choice wins in both directions, and with
 * nothing stored a width tier decides — and because none of them is a
 * property of the document: navigating to another doc must not re-ask any of
 * them.
 *
 * Deliberately NOT an attempt to identify a device: pinch-zoom scales the
 * layout viewport (a 1366px iPad at 85% reports 1607px), so width cannot say
 * what hardware this is. It can still say how much room there is.
 *
 * Nothing here touches a ydoc, a thread or the mount's scope, which is what
 * lets the two `wire*` functions run once per PAGE while the chrome around
 * them remounts on every doc change.
 */
import {
  cardPlacement,
  effectiveSurface,
  onPlacementChange,
  otherPlacement,
  placementToggleLabel,
  setCardPlacement,
} from '../card-placement.ts';

const DRAWER_PREF_KEY = 'lf:drawer';

/**
 * Should the threads drawer start open for this mount? Pure so the
 * drawer-default policy is unit-testable without a DOM.
 *  - mobile: never (it's an overlay there)
 *  - user toggled it this session: their choice wins
 *  - an always-on surface is showing (balloon margin, or inline cards):
 *    closed, because that surface already shows every comment and the drawer
 *    would be a second copy of the same threads
 *  - otherwise (a code doc above 1100px, which has neither): open
 */
export function initialDrawerOpen(opts: {
  isDesktop: boolean;
  marginVisible: boolean;
  /** Inline cards are this device's chosen surface — see `card-placement.ts`. */
  inlineVisible: boolean;
  stored: string | null;
}): boolean {
  if (!opts.isDesktop) return false;
  if (opts.stored === 'open') return true;
  if (opts.stored === 'closed') return false;
  return !opts.marginVisible && !opts.inlineVisible;
}

/** The drawer choice this session has stored, or null when nothing is stored
 *  (or storage is unavailable, where the tier default still applies). */
export function readDrawerPref(): string | null {
  try {
    return sessionStorage.getItem(DRAWER_PREF_KEY);
  } catch {
    // storage unavailable — default logic reapplies per mount
    return null;
  }
}

/** Explicit open/close via the toggle or the ✕ is a stated preference —
 *  remember it so per-file navigation in a diff review doesn't keep
 *  re-applying the balloon default the user just overrode. Session-scoped
 *  on purpose: a fresh visit re-evaluates the default. */
export function writeDrawerPref(open: boolean): void {
  try {
    sessionStorage.setItem(DRAWER_PREF_KEY, open ? 'open' : 'closed');
  } catch {
    // storage unavailable — default logic reapplies per mount
  }
}

/** Above this, a 320px doc list costs the prose nothing — Bryan's 4K monitor.
 *  Every phone, tablet and laptop is one tier below it and shares one answer. */
export const WIDE_SCREEN_QUERY = '(min-width: 1921px)';

const SET_PANE_PREF_KEY = 'lf:set-pane';

/** Whether the review-set sidebar starts open. A stored choice wins in both
 *  directions; with nothing stored, only a 4K-class screen opens it. */
export function initialSetPaneOpen(stored: string | null, isWide: boolean): boolean {
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return isWide;
}

/** Wire the topbar's doc-list toggle. Shell-level and doc-independent, so it
 *  runs once per page rather than per navigation — `mountReviewChrome` runs on
 *  every doc change, and a second listener here would flip the pane twice per
 *  click. The button's own visibility is CSS (`body.has-set` + the 1101px
 *  floor); this only owns the open/closed state. */
export function wireSetPaneToggle(): void {
  const btn = document.getElementById('toggle-set-pane');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  const apply = (open: boolean) => {
    document.body.classList.toggle('set-pane-open', open);
    btn.setAttribute('aria-pressed', String(open));
    btn.title = open ? 'Hide doc list' : 'Show doc list';
    btn.setAttribute(
      'aria-label',
      open ? 'Hide the list of docs in this review' : 'Show the list of docs in this review',
    );
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SET_PANE_PREF_KEY);
  } catch {
    // storage unavailable — the tier default still applies.
  }
  apply(initialSetPaneOpen(stored, window.matchMedia(WIDE_SCREEN_QUERY).matches));
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('set-pane-open');
    apply(next);
    try {
      localStorage.setItem(SET_PANE_PREF_KEY, next ? 'open' : 'closed');
    } catch {
      // storage unavailable — the choice holds for this page only.
    }
  });
}

/**
 * Wire the topbar's comment-placement toggle: cards in the flow, or cards in
 * the right margin.
 *
 * Beside the doc-list toggle and the comments toggle, because it is the same
 * kind of thing — a stored per-device view preference, not a doc setting. Runs
 * once per page for the same reason `wireSetPaneToggle` does: chrome remounts
 * on every doc change, and a second listener would flip the placement twice
 * per click.
 *
 * The glyph shows the placement IN FORCE and the labels name the destination,
 * so a reader who has never touched it can still tell where their comments
 * are. There is no `aria-pressed`: this is not an on/off, it is a choice
 * between two surfaces, and "pressed = margin" would be an arbitrary reading
 * of which one counts as on.
 */
export function wireCardPlacementToggle(): void {
  const btn = document.getElementById('toggle-cards');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  const paint = () => {
    // The SURFACE, not the stored choice: on a phone a stored `balloon`
    // resolves to the sheet, and the button has to say so.
    const label = placementToggleLabel(effectiveSurface());
    btn.textContent = label.glyph;
    btn.title = label.title;
    btn.setAttribute('aria-label', label.ariaLabel);
  };
  paint();
  // Repaint on a width change too: with nothing stored the placement follows
  // the width, so crossing the default boundary moves the cards and a button
  // still showing the old glyph would be describing the other surface.
  onPlacementChange((target, type, fn) => target.addEventListener(type, fn), paint);
  btn.addEventListener('click', () => {
    setCardPlacement(otherPlacement(cardPlacement()));
  });
}
