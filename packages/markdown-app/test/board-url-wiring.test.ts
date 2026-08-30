/**
 * hub-app wires the address bar through the board-url codec.
 *
 * The codec itself is unit-tested in board-url.test.ts; hub-app has no boot
 * harness (main() runs on import against a real shell), so its wiring is
 * pinned by source text — the established shape for hub-app in this suite
 * (walk-handoff.test.ts, home-nav-reset.test.ts). All fixtures synthetic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HUB_APP = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

describe('boot reads the whole address once', () => {
  it('parses the boot URL through the codec', () => {
    expect(HUB_APP).toContain('parseBoardLocation(location.pathname, location.search)');
  });

  it('seeds the panels and the archived filter from it before first render', () => {
    expect(HUB_APP).toContain('detailTaskId: bootLoc.task');
    expect(HUB_APP).toContain('detailGoalId: bootLoc.goal');
    expect(HUB_APP).toContain('detailThreadId: bootLoc.thread');
    expect(HUB_APP).toContain('showArchived: bootLoc.archived');
  });
});

describe('one address writer', () => {
  it('renderDetail and renderWalkthrough end in syncBoardUrl, not raw history', () => {
    const detail = HUB_APP.match(/function renderDetail\(\)[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(detail, 'renderDetail went missing').not.toBe('');
    expect(detail).toContain('syncBoardUrl()');
    expect(detail.match(/history\.(pushState|replaceState)/g)).toBeNull();
    const walk = HUB_APP.match(/function renderWalkthrough\(\)[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(walk, 'renderWalkthrough went missing').not.toBe('');
    expect(walk).toContain('syncBoardUrl()');
  });

  it('closing unwinds with Back only for an entry this document pushed', () => {
    const sync = HUB_APP.match(/function syncBoardUrl\(\)[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(sync, 'syncBoardUrl went missing').not.toBe('');
    expect(sync).toContain('history.pushState({ res: resourceOf(next) }');
    expect(sync).toMatch(/res === closing\) history\.back\(\)/);
  });

  it('popstate applies the entry and abandons boot deep links', () => {
    expect(HUB_APP).toMatch(/addEventListener\('popstate'[\s\S]{0,400}applyHistoryLocation\(\)/);
    expect(HUB_APP).toMatch(/addEventListener\('popstate'[\s\S]{0,300}pendingBootItem = null/);
  });
});

describe('cold-load deep links wait for the projection', () => {
  it('an unresolved boot goal is not cleared before the deadline', () => {
    expect(HUB_APP).toContain(
      'if (state.detailGoalId !== pendingBootGoal) state.detailGoalId = null;',
    );
  });

  it('a boot ?item= opens once the queue holds it, without burning on empty', () => {
    const open = HUB_APP.match(/const maybeOpenBootItem[\s\S]*?\n {2}\};\n/)?.[0] ?? '';
    expect(open, 'maybeOpenBootItem went missing').not.toBe('');
    expect(open).toContain('openInQueue(item, idx)');
    // The don't-burn rule: an empty queue returns with the flag still armed.
    expect(open).toMatch(/if \(!item\) return/);
  });

  it('the deadline names the failure instead of leaving a blank panel', () => {
    expect(HUB_APP).toContain('Nothing on this board matches that link');
    expect(HUB_APP).toContain('That review item is not in the queue any more');
  });

  it('a deep-linked thread missing from the loaded discussion says so', () => {
    expect(HUB_APP).toContain('That comment thread is gone');
    expect(HUB_APP).toMatch(/function noteStaleBootThread[\s\S]{0,400}discussion\.threads\.some/);
  });
});

describe('the doc surface answers a stale ?thread=', () => {
  it('says the thread is gone instead of silently showing the doc top', () => {
    const APP = readFileSync(resolve(import.meta.dirname, '../src/app.ts'), 'utf8');
    const reveal = APP.match(/function revealLinkedThread\(\)[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(reveal, 'revealLinkedThread went missing').not.toBe('');
    expect(reveal).toContain('That comment thread is gone from this doc');
  });
});

describe('the card hands off to its item in one history step', () => {
  // Regression: tapping the card's task link bounced the reader back to Home.
  // Closing the walkthrough is a 'close' step, which syncBoardUrl unwinds
  // with history.back() — an ASYNC traversal. Rendering the close before
  // opening the item queued a back() that landed after the open's pushState;
  // its popstate re-applied the old ?item= entry, which closed the panel the
  // tap had just opened. The open must render first — walk → panel is one
  // push — with the card's own repaint after it.
  // Both handlers now share `openFromWalk`, which is where the ordering lives
  // — and where the doc jump's undo lives too (see walk-return.test.ts).
  it('renders the open before the walkthrough close', () => {
    const fn = HUB_APP.match(/function openFromWalk\([\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(fn, 'openFromWalk went missing').not.toBe('');
    const openAt = fn.indexOf('const stillHere = open(back)');
    const closeAt = fn.indexOf('renderWalkthrough()');
    expect(openAt, 'openFromWalk no longer opens the item').toBeGreaterThan(-1);
    expect(closeAt, 'the close repaint ran before the open').toBeGreaterThan(openAt);
    // And the state close precedes the open, which is the half that keeps the
    // pair one history step.
    expect(fn.indexOf('state.walkIndex = CLOSED_WALK.index')).toBeLessThan(openAt);
  });

  it('skips the close repaint when the item navigates the page away', () => {
    // The doc jump leaves via location.assign; a close-step history.back()
    // queued beside it races the navigation. The opener reports whether it
    // stayed in-app, and only then does the card repaint (and its URL
    // close-step) run.
    expect(HUB_APP).toMatch(/if \(stillHere\) renderWalkthrough\(\)/);
  });
});

describe('emitted links are canonical', () => {
  it('the task copy-link goes through the shared share-URL builder', () => {
    expect(HUB_APP).toContain('taskShareUrl(location.origin, workspaceIdFromPath(), taskId)');
  });

  it('a doc-thread review item navigates to the workspace doc address', () => {
    // The legacy `/review/` shape stays only where the doc's workspace is
    // unknown client-side (presence follows) — there the server's redirect is
    // the resolver. This jump knows its workspace, so it says so.
    expect(HUB_APP).toMatch(
      /\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/docs\/\$\{encodeURIComponent\(t\.docId\)\}\?thread=/,
    );
    expect(HUB_APP).not.toMatch(/`\/review\/[^\n]*\?thread=/);
  });
});
