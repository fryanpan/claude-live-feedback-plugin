/**
 * Where this reader's comments and doc list live, on THIS device.
 *
 * Two stored view preferences and the toggle that owns one of them: the
 * threads drawer, and the attachment-set doc list. They are one module
 * because they answer one question in one way — a stored choice wins in both
 * directions, and with nothing stored a width tier decides — and because
 * neither is a property of the document: navigating to another doc must not
 * re-ask either of them.
 *
 * A width tier is deliberately NOT an attempt to identify a device:
 * pinch-zoom scales the layout viewport (a 1366px iPad at 85% reports
 * 1607px), so width cannot say what hardware this is. It can still say how
 * much room there is.
 *
 * Every storage call is wrapped. Private mode, cleared site data and the
 * thumbnail renderer all throw on the accessor itself, and a review page that
 * cannot render without `sessionStorage` renders blank for the reader who
 * most needs it.
 *
 * Nothing here touches a ydoc, a thread or the mount's scope, which is what
 * lets `wireSetPaneToggle` run once per PAGE while the chrome around it
 * remounts on every doc change.
 */

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

/** Whether the attachment-set sidebar starts open. A stored choice wins in both
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
      open
        ? 'Hide the list of docs in this attachment set'
        : 'Show the list of docs in this attachment set',
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
