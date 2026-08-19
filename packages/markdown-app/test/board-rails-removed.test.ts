import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hubRender from '../src/hub/hub-render.ts';

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
 */

const SRC = resolve(import.meta.dirname, '../src');
const hubApp = readFileSync(resolve(SRC, 'hub/hub-app.ts'), 'utf8');
const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8');

describe('the board no longer carries the docs and open-threads rails', () => {
  it('exports neither renderer, and still exports the board renderers', () => {
    const names = Object.keys(hubRender);
    // Positive control: this read can see exports at all, and the board's own
    // renderers survived the excision beside them.
    expect(names).toContain('renderBoard');
    expect(names).toContain('renderTaskDetail');
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

  it('styles no rail, and the board layout track survives', () => {
    // Positive control: the stylesheet read is the right file and the layout
    // rule the rails used to sit beside is still in it.
    expect(css).toContain('.hub-main {');
    expect(css).toContain('.hub-board-col');
    expect(css).not.toContain('.hub-side');
  });

  it('gives the board a min-0 track, so a long title cannot widen the page', () => {
    // The CONTENT column must stay `minmax(0, 1fr)`. Bare `1fr` is
    // `minmax(auto, 1fr)`, whose content-driven minimum is what let one long
    // unbreakable task title push the whole page wider than the viewport —
    // the bug the three-column layout was already guarding against. The nav
    // rail's `max-content` track may sit in front of it; what may never come
    // back is a bare `1fr` anywhere in the template.
    const main = css.slice(css.indexOf('.hub-main {'));
    const block = main.slice(0, main.indexOf('}'));
    const template = /grid-template-columns:([^;]*);/.exec(block)?.[1] ?? '';
    expect(template).toContain('minmax(0, 1fr)');
    expect(template.replace(/minmax\(0, 1fr\)/g, '')).not.toContain('1fr');
  });
});
