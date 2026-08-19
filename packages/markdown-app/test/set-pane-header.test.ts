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
