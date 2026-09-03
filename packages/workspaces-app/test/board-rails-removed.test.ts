import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as boardIsland from '../src/hub/board-island.tsx';
import * as hubDetailRender from '../src/hub/hub-detail-render.ts';
import * as hubRender from '../src/hub/hub-render.ts';
import * as taskDetailIsland from '../src/hub/task-detail-island.tsx';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The board's two side rails — "Docs" and "Open threads (N)" — are gone.
 *
 * Bryan, 2026-08-18, reviewing the task-list overhaul: "the work on the task
 * list ux is a good start, but incomplete. Please remove docs and live threads
 * from the task list. Not needed."
 *
 * The instruction was REMOVE, not hide, so this pins the removal at all four
 * layers the surface occupied: the renderers, the data module that fed them,
 * the shell markup that mounted them, and the stylesheet that laid them out.
 * A `display: none` rule or a renderer left exported for a future caller would
 * satisfy "you can't see it" and none of these.
 *
 * Every assertion here is an ABSENCE, so every one is paired with a positive
 * control in the same layer — the same read, over the same artifact, finding
 * something that is still there. Without that half a mistyped path, a moved
 * file or an empty string reads as a clean removal.
 *
 * The stylesheet layer no longer greps `hub.css`. It installs the board's
 * sheets and reads the computed style of the classes, so the control and the
 * absence are both measured the way a browser would answer them.
 */

const SRC = resolve(import.meta.dirname, '../src');
const hubApp = readFileSync(resolve(SRC, 'hub/hub-app.ts'), 'utf8');

/* The stylesheet layer is read by RENDERING it, not by grepping it: the
   board's sheets are installed and the classes are built, so "no rail is
   styled" is measured as "nothing reaches an element carrying the rail's
   class" rather than as "the file does not contain the string". A hidden rail
   whose selector had been renamed would satisfy the old read and fail this
   one. `hub.css` before `styles.css` is the order `renderHubShell` links them
   in; `tokens.css` is left out because the served file is a vendored Open
   Props subset plus `src/tokens.css`, and the mapping half alone re-points
   every remapped token at an undefined `var(--gray-N)`. */
let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the board no longer carries the docs and open-threads rails', () => {
  it('exports neither renderer, and still exports the board renderers', () => {
    const names = Object.keys(hubRender);
    // Positive control: this read can see exports at all, and the board's own
    // renderers survived the excision beside them. `renderBoard` itself moved
    // to the Preact island — so the control follows it there rather than being
    // dropped, which would leave the two absences below unwitnessed.
    // `renderTaskDetail` has now made the same move, for the same reason, so
    // its control follows it to `task-detail-island.tsx` and the pieces it
    // still fills stand in for the surface here — `detailFields` among them,
    // which now lives in `hub-detail-render.ts`, so the control reads there.
    expect(Object.keys(boardIsland)).toContain('mountBoardIsland');
    expect(Object.keys(taskDetailIsland)).toContain('mountTaskDetailIsland');
    expect(Object.keys(hubDetailRender)).toContain('detailFields');
    expect(names).not.toContain('renderDocsSidebar');
    expect(names).not.toContain('renderThreadsSidebar');
  });

  it('has no rail containers in the shell, and still has the board regions', () => {
    // Positive control: the shell string is the one being read, and the
    // regions that stayed are in it.
    expect(hubApp).toContain('id="hub-board"');
    expect(hubApp).toContain('id="hub-quick"');
    expect(hubApp).toContain('id="hub-decisions"');
    expect(hubApp).not.toContain('hub-docs');
    expect(hubApp).not.toContain('hub-threads');
    // The whole `<aside>` element, not just its id — a rail kept as an empty
    // container is the "hidden, not removed" outcome this test exists for.
    expect(hubApp).not.toContain('<aside');
  });

  it('does not fetch rail data any more', () => {
    // Positive control: the other REST loaders the board still runs.
    expect(hubApp).toContain('loadAgents');
    expect(hubApp).toContain('loadReviewItems');
    expect(hubApp).not.toContain('loadSidebars');
    expect(hubApp).not.toContain('sidebarEntriesFor');
    // The module that resolved an attachment into rail entries is deleted, not
    // orphaned — an unimported file still compiles, still ships in nobody's
    // bundle, and still reads as a live part of the surface.
    expect(existsSync(resolve(SRC, 'hub/hub-render.ts'))).toBe(true); // control
    expect(existsSync(resolve(SRC, 'hub/hub-sidebar.ts'))).toBe(false);
  });

  it('styles no rail, and the board layout still lays out around the columns it kept', () => {
    setViewport(IPAD);
    // Positive control: the sheets are installed and the layout rule the rails
    // used to sit beside is live. Without it every absence below would pass by
    // measuring an element no stylesheet reaches.
    expect(styleOf(attach('hub-main')).display).toBe('grid');
    // The board column is a real, styled surface: Home hides it, the board
    // shows it. Both halves, so the selector is proved reachable.
    const home = attach('hub-main hub-main--home');
    expect(styleOf(attach('hub-board-col', { parent: home })).display).toBe('none');
    expect(styleOf(attach('hub-board-col', { parent: attach('hub-main') })).display).not.toBe(
      'none',
    );
    // And nothing at all reaches a rail: a bare <div> the cascade never
    // touches computes the UA's own `display: block`.
    expect(styleOf(attach('hub-side', { tag: 'aside' })).display).toBe('block');
  });

  it('gives the board a min-0 track, so a long title cannot widen the page', () => {
    // The CONTENT column must stay `minmax(0, 1fr)`. Bare `1fr` is
    // `minmax(auto, 1fr)`, whose content-driven minimum is what let one long
    // unbreakable task title push the whole page wider than the viewport —
    // the bug the three-column layout was already guarding against. The nav
    // rail's `max-content` track may sit in front of it; what may never come
    // back is a bare `1fr` anywhere in the template. Read off the cascade, so
    // a media override that reintroduced one would be caught too.
    setViewport(IPAD);
    const template = styleOf(attach('hub-main')).gridTemplateColumns;
    expect(template).toContain('minmax(0, 1fr)');
    expect(template.replace(/minmax\(0, 1fr\)/g, '')).not.toContain('1fr');
    // Below 1100 the same guarantee is bought differently — a block-level flex
    // item is sized from its container, so there is no track to widen at all.
    setViewport(PHONE);
    const phone = styleOf(attach('hub-main'));
    expect(phone.display).toBe('flex');
    expect(phone.flexDirection).toBe('column');
  });
});
