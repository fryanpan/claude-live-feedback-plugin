/**
 * WHERE a comment card lives on this device — the reader's own choice, stored.
 *
 * The card itself is one component (`doc/thread-card.ts`); this module owns
 * only the question of where copies of it are placed:
 *
 *  - `inline`  — cards sit in the document flow, under the phrase they are
 *                about, where a GitHub PR comment sits. One column, so the
 *                prose keeps the full width.
 *  - `balloon` — nothing sits in the flow; each card rides in the right
 *                margin beside its phrase. Needs a margin to ride in, so
 *                below `BALLOON_ROOM_QUERY` a balloon has nowhere to go and
 *                the over-doc sheet is the comment surface instead.
 *
 * A STORED PREFERENCE, never a media query. This replaced a hard
 * `(max-width: 1100px)` switch, and the reason is written down in
 * docs/process/learnings.md ("Width cannot identify a device, because page
 * zoom moves it"): a 1366px iPad at 85% zoom reports 1607px, so width can
 * say how much ROOM there is and can never say what hardware this is. Width
 * therefore picks the DEFAULT and nothing else — once the reader has chosen,
 * their choice survives every zoom, rotation and resize.
 *
 * The choice is published as `data-cards` on `<body>` so the stylesheet can
 * key off it exactly where it used to key off the media query, and changes
 * are announced on `window` as `PLACEMENT_CHANGED_EVENT` so the chrome can
 * re-render the surface that just changed.
 */

/** Where this device puts comment cards. */
export type CardPlacement = 'inline' | 'balloon';

/** Same shape as the app's other view preferences (`lf:drawer`, `lf:set-pane`). */
export const PLACEMENT_PREF_KEY = 'lf:cards';

/**
 * Enough width for a 300px margin column beside the prose. The DEFAULT only:
 * a stored choice wins at every width, including this one.
 */
export const BALLOON_ROOM_QUERY = '(min-width: 1101px)';

/**
 * Below this there is no margin at all — not for the default and not for a
 * stored choice. A reader who picked balloons on their laptop and opens the
 * same doc on a phone gets the over-doc sheet rather than a 300px column
 * squeezed into 430px.
 */
export const BALLOON_SHEET_QUERY = '(max-width: 900px)';

/** Fired on `window` after the placement changes. */
export const PLACEMENT_CHANGED_EVENT = 'lf:cards-changed';

/**
 * The placement in force, given what is stored and how much room there is.
 *
 * Pure, so the policy is checkable without a DOM or a storage. Only the two
 * known tokens win — anything else stored (a truncated write, a value from a
 * future version) falls back to the width default rather than to a placement
 * nobody can name.
 */
export function resolvePlacement(stored: string | null, roomForMargin: boolean): CardPlacement {
  if (stored === 'inline') return 'inline';
  if (stored === 'balloon') return 'balloon';
  return roomForMargin ? 'balloon' : 'inline';
}

/** The stored choice, or null. Storage can throw (Safari private mode). */
export function readStoredPlacement(): string | null {
  try {
    return localStorage.getItem(PLACEMENT_PREF_KEY);
  } catch {
    return null;
  }
}

function media(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

/** Is there room beside the prose for a margin column? */
export function roomForMargin(): boolean {
  return media(BALLOON_ROOM_QUERY);
}

/** Too narrow for a margin at all — balloons become the over-doc sheet. */
export function balloonsBecomeSheet(): boolean {
  return media(BALLOON_SHEET_QUERY);
}

/** What this device is set to right now. */
export function cardPlacement(): CardPlacement {
  return resolvePlacement(readStoredPlacement(), roomForMargin());
}

/**
 * Do inline cards render? The question `mobile-review.ts` asks before it
 * builds any, and no longer a question about width.
 */
export function inlineCardsVisible(): boolean {
  return cardPlacement() === 'inline';
}

/**
 * Does the balloon margin render? Both halves matter: the reader has to have
 * chosen balloons AND there has to be a margin for them to sit in.
 *
 * The pair of predicates is exhaustive and non-overlapping except in the one
 * state the mock names — balloons on a narrow screen — where neither surface
 * is in the flow and the sheet is the comment surface.
 */
export function balloonMarginVisible(): boolean {
  return cardPlacement() === 'balloon' && !balloonsBecomeSheet();
}

/**
 * Publish the placement to the stylesheet. Every rule that used to sit in a
 * `(max-width: 1100px)` block now sits under `body[data-cards="inline"]`, so
 * this attribute is what actually moves the cards.
 */
export function applyPlacement(placement: CardPlacement = cardPlacement()): void {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.dataset.cards = placement;
}

/**
 * Store a choice, publish it, and announce it.
 *
 * Announced even when the value did not change: a caller that re-applies on
 * resize is asking the surfaces to re-measure, and a silent no-op there
 * leaves a card holding a height computed against the old column width.
 */
export function setCardPlacement(placement: CardPlacement): void {
  try {
    localStorage.setItem(PLACEMENT_PREF_KEY, placement);
  } catch {
    // Storage unavailable — the choice still applies for this page.
  }
  applyPlacement(placement);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PLACEMENT_CHANGED_EVENT, { detail: placement }));
  }
}

/** The other one. */
export function otherPlacement(placement: CardPlacement): CardPlacement {
  return placement === 'inline' ? 'balloon' : 'inline';
}

/**
 * What the toggle says it will do. Named for the DESTINATION, because a
 * control that names its current state reads as a claim rather than an
 * offer — the same rule the edit-mode and doc-list toggles follow.
 */
export function placementToggleLabel(current: CardPlacement): {
  title: string;
  ariaLabel: string;
  glyph: string;
} {
  return current === 'inline'
    ? {
        glyph: '⫞',
        title: 'Comments in the flow — tap to move them to the margin',
        ariaLabel: 'Comment cards are in the document flow. Move them to the right margin.',
      }
    : {
        glyph: '⫟',
        title: 'Comments in the margin — tap to move them into the flow',
        ariaLabel: 'Comment cards are in the right margin. Move them into the document flow.',
      };
}
