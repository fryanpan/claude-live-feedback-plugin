/**
 * The chrome's icon vocabulary: 24×24, no fill, `currentColor` stroke, round
 * ends. Every glyph in the nav rail and the top-right cluster is drawn this
 * way, so anything that sits beside them has to be drawn this way too.
 *
 * The mic lives here rather than in `hub/hub-app.ts` with the nav glyphs
 * because three surfaces mount a mic — the board's docked one, the capture
 * composer's, and the review doc's — and only one of them is a hub module.
 * Importing `hub-app.ts` from `voice-dock.ts` to reach a string would pull the
 * whole board into the doc bundle.
 */

/** The opening attributes every icon shares. Split from the closing ones so a
 *  glyph reads as `<svg ${SVG} ${SVG_ENDS}>…` at the call site. */
export const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"';
export const SVG_ENDS = 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/**
 * Hold-to-talk. A stroked capsule on a stand, not the `🎙` / `🎤` emoji the
 * three mics used until 2026-08-21 — those were the only colour glyphs in a
 * chrome drawn entirely in outlines, and they rendered in the system font
 * stack, so the one control Bryan reaches for most read as the one nobody had
 * finished.
 */
export const MIC_ICON = `<svg ${SVG} ${SVG_ENDS}><rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3.2"/><path d="M8.6 21.2h6.8"/></svg>`;

/**
 * Two people — the Board's "Record a conversation". The mic beside it starts
 * a huddle for one voice; this one says there is somebody else in the room,
 * which is the whole difference between the two buttons.
 */
export const PEOPLE_ICON = `<svg ${SVG} ${SVG_ENDS}><circle cx="9" cy="8" r="3.2"/><path d="M3.2 20a5.8 5.8 0 0 1 11.6 0"/><path d="M16.2 5.2a3.2 3.2 0 0 1 0 6.2"/><path d="M17.4 14.6A5.8 5.8 0 0 1 20.8 20"/></svg>`;

/** New task — the Board's primary action, drawn in the same vocabulary. */
export const PLUS_ICON = `<svg ${SVG} ${SVG_ENDS}><path d="M12 5v14"/><path d="M5 12h14"/></svg>`;
