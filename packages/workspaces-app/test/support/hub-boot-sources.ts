/**
 * The modules that make up the hub page's boot, for the suites that read it
 * as source text.
 *
 * `hub-app.ts` used to be all of it, so those suites named that one file.
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
export const HUB_BOOT_SOURCES = [
  'hub-app',
  'hub-shell',
  'hub-settings-panel',
  'hub-walkthrough',
  'hub-islands',
  'hub-board-region',
  'hub-home-region',
  'hub-detail-panel',
  'hub-discussion',
  'hub-queue-open',
  'hub-chrome-region',
  'hub-data-loads',
  'hub-projection',
  'hub-deep-links',
  'hub-load-report',
  'hub-voice',
  'hub-shortcuts',
] as const;
