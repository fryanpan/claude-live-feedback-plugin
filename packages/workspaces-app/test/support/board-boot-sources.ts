/**
 * The modules that make up the board page's boot, for the suites that read it
 * as source text.
 *
 * `board-app.ts` used to be all of it, so those suites named that one file.
 * The shell, the settings panel and the walkthrough moved into modules of
 * their own first; the render closure then followed, one region per module.
 * An assertion about the board's shape — "the mic is mounted from MIC_ICON",
 * "no rail container survives", "renderWalkthrough ends in syncBoardUrl" — is
 * not an assertion about which of these files the line landed in. Reading
 * them as one string is what keeps a pure move from failing a test that has
 * nothing to say about moves.
 *
 * It also makes every ABSENCE check stricter than it was: a string that has
 * to be gone is now checked across the whole boot rather than one file of it.
 */
export const BOARD_BOOT_SOURCES = [
  'board-app',
  'board-shell',
  'board-settings-panel',
  'board-walkthrough',
  'board-islands',
  'board-region',
  'board-home-region',
  'board-detail-panel',
  'board-discussion',
  'board-queue-open',
  'board-chrome-region',
  'board-data-loads',
  'board-projection',
  'board-deep-links',
  'board-load-report',
  'board-voice',
  'board-shortcuts',
] as const;
