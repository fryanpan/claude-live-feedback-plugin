/**
 * The review-set sidebar has no title row.
 *
 * Bryan, 2026-08-19, reviewing on an iPad: *"In the doc viewer, please remove
 * 'In this review'. Takes up too much room"*. The header cost ~36px of vertical
 * space (14px + 8px padding around an 11px uppercase line) to name what the
 * pane's own contents already say, and vertical space is the scarce axis on a
 * tablet held in portrait.
 *
 * Guarded rather than just deleted because the accessible name still exists —
 * `aria-label="Docs in this review set"` on the <aside> — so a future reader
 * looking for a heading finds one in the markup and can reasonably re-add a
 * visible twin. This test is the note saying that was deliberate.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/styles.css'), 'utf8');

describe('review-set sidebar', () => {
  it('renders no title row above the doc list', () => {
    expect(HTML).not.toContain('set-pane-header');
    expect(HTML).not.toContain('In this review');
    // Positive control: this really is the file that holds the pane, so the
    // two absences above are absences and not a mis-resolved path.
    expect(HTML).toContain('id="set-pane"');
    expect(HTML).toContain('id="set-pane-list"');
  });

  it('drops the header’s stylesheet rule with it', () => {
    // A rule for markup nobody emits is how the header comes back: the next
    // person to add a heading finds it already styled and assumes it is wanted.
    expect(CSS).not.toContain('.set-pane-header');
    expect(CSS).toContain('#set-pane-list'); // positive control
  });

  it('gives the list the top gap the header used to supply', () => {
    // Without this the first doc sits flush against the topbar. The value is
    // deliberately smaller than the 14px the header had — the gap is now doing
    // one job (breathing room) instead of two (breathing room + a label).
    const rule = CSS.match(/#set-pane-list\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule, 'the #set-pane-list rule went missing').not.toBe('');
    const padding = rule.match(/padding:\s*([^;]+);/)?.[1] ?? '';
    expect(padding).not.toMatch(/^0[\s;]/);
  });
});

/**
 * The sidebar is hidden on an iPad in landscape, and the three rules that
 * decide that agree on where the line is.
 *
 * Bryan, 2026-08-19: *"The 'in this review' is no longer useful for any screen
 * resolution for an individual doc. It's only useful for diff reviews. And for
 * those, at iPad resolution, please also hide it and keep it in the dropdown
 * like for mobile."*
 *
 * A media query cannot read a custom property, so the breakpoint is written
 * out three times and nothing in CSS makes them agree. Changing one is a
 * silent half-fix: raise only the show gate and the grid still reserves a
 * 320px column with nothing in it; raise only the grid and the sidebar
 * renders into a track that no longer exists.
 */
describe('review-set sidebar breakpoint', () => {
  const SHOW_GATE = /@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*body\.has-set\s+#set-pane/;

  it('shows the sidebar only above every iPad landscape width', () => {
    const gate = CSS.match(SHOW_GATE);
    expect(gate, 'the #set-pane show gate went missing').not.toBeNull();
    const min = Number(gate?.[1]);
    // iPad Pro 12.9" landscape is 1366 CSS px — the widest iPad there is. The
    // gate must not admit it, so it starts at 1367 or higher.
    expect(min).toBeGreaterThan(1366);
  });

  it('collapses the grid at exactly the width the sidebar stops showing', () => {
    const min = Number(CSS.match(SHOW_GATE)?.[1]);
    const grid = CSS.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*body\.has-set\s+#main/);
    expect(grid, 'the has-set #main collapse rule went missing').not.toBeNull();
    // Off by one from the gate, and off by one in the right direction: the two
    // must tile the whole range with no width belonging to both or neither.
    expect(Number(grid?.[1])).toBe(min - 1);
  });

  it('hides the resize handle wherever the sidebar is hidden', () => {
    const min = Number(CSS.match(SHOW_GATE)?.[1]);
    const resize = CSS.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.set-resize/);
    expect(resize, 'the .set-resize hide rule went missing').not.toBeNull();
    expect(Number(resize?.[1])).toBe(min - 1);
  });
});
