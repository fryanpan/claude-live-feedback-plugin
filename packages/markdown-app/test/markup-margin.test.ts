import { prose } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import type { RedlineDeletion } from '../src/redline/live-markup.ts';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';
import { groupDeletions, mountMarkupMargin } from '../src/redline/markup-margin.ts';

/**
 * The markup margin: Word's balloon column for deletions. jsdom/happy-dom
 * can't do real layout, so these tests assert DOM structure and classes —
 * the pixel math lives in layoutBalloons (unit-tested separately).
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
});

function mountSurface(baseText: string, md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    debounceMs: 0,
  });
  open.push(() => {
    surface.destroy();
    parent.remove();
  });
  return { parent, surface };
}

function mountMargin(
  parent: HTMLElement,
  surface: LiveRedlineSurface,
  getDeletions?: () => RedlineDeletion[],
) {
  const scope = new MountScope();
  const margin = mountMarkupMargin({
    editorEl: parent,
    view: surface.handle.editor.view,
    getDeletions: getDeletions ?? (() => surface.getDeletions()),
    scope,
  });
  open.push(() => scope.dispose());
  return { scope, margin };
}

/** Let the (0ms in tests) markup debounce fire and the view repaint. */
const tick = () => new Promise((r) => setTimeout(r, 25));

describe('groupDeletions — consecutive same-paragraph deletions collapse', () => {
  it('returns an empty list for no deletions', () => {
    expect(groupDeletions([], () => 0)).toEqual([]);
  });

  it('collapses consecutive deletions with the same block key into one group', () => {
    const groups = groupDeletions(
      [
        { pos: 5, deletedMarkdown: 'beta' },
        { pos: 12, deletedMarkdown: 'delta' },
      ],
      () => 0,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].pos).toBe(5);
    expect(groups[0].deletedMarkdown).toContain('beta');
    expect(groups[0].deletedMarkdown).toContain('delta');
  });

  it('keeps deletions in different blocks as separate groups', () => {
    const groups = groupDeletions(
      [
        { pos: 5, deletedMarkdown: 'first' },
        { pos: 30, deletedMarkdown: 'second' },
      ],
      (pos) => (pos < 20 ? 0 : 2),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].deletedMarkdown).toBe('first');
    expect(groups[1].deletedMarkdown).toBe('second');
  });
});

describe('mountMarkupMargin — balloon DOM', () => {
  it('renders one deletion balloon with the deleted markdown as plain text', async () => {
    const { parent, surface } = mountSurface(
      'Alpha.\n\nRemoved paragraph.\n\nBravo.\n',
      'Alpha.\n\nBravo.\n',
    );
    await tick();
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    expect(parent.classList.contains('redline-layout')).toBe(true);
    const marginEl = parent.querySelector('.markup-margin');
    expect(marginEl).not.toBeNull();
    const balloons = parent.querySelectorAll('.lf-balloon.lf-balloon-del');
    expect(balloons).toHaveLength(1);
    expect(balloons[0].querySelector('.lf-balloon-label')?.textContent).toBe('Deleted');
    expect(balloons[0].querySelector('.lf-balloon-text')?.textContent).toContain(
      'Removed paragraph.',
    );
    // One SVG overlay with one leader line per balloon.
    const overlay = parent.querySelectorAll('svg.lf-leader-overlay');
    expect(overlay).toHaveLength(1);
    expect(overlay[0].querySelectorAll('.lf-leader')).toHaveLength(1);
  });

  it('collapses two inline deletions in the same paragraph into one balloon', async () => {
    const { parent, surface } = mountSurface(
      'Alpha beta gamma delta epsilon.\n',
      'Alpha gamma epsilon.\n',
    );
    await tick();
    expect(surface.getDeletions().length).toBeGreaterThanOrEqual(2);
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(1);
    const text = balloons[0].querySelector('.lf-balloon-text')?.textContent ?? '';
    expect(text).toContain('beta');
    expect(text).toContain('delta');
  });

  it('renders separate balloons for deletions anchored in different paragraphs', async () => {
    const { parent, surface } = mountSurface(
      'One.\n\nFirst removed.\n\nTwo.\n\nSecond removed.\n\nThree.\n',
      'One.\n\nTwo.\n\nThree.\n',
    );
    await tick();
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(2);
    expect(parent.querySelectorAll('svg.lf-leader-overlay .lf-leader')).toHaveLength(2);
  });

  it('re-renders balloons when the deletions list changes', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const deletions: RedlineDeletion[] = [];
    const { margin } = mountMargin(parent, surface, () => deletions);
    margin.relayout();
    expect(parent.querySelectorAll('.lf-balloon')).toHaveLength(0);

    deletions.push({ pos: 1, deletedMarkdown: 'now gone' });
    margin.relayout();
    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(1);
    expect(balloons[0].textContent).toContain('now gone');
  });
});

describe('mountMarkupMargin — truncation & expand toggle', () => {
  const longMd = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'].join('\n');

  it('clamps long deletions and toggles expansion from the balloon', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: longMd }]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    const text = balloon.querySelector('.lf-balloon-text') as HTMLElement;
    const toggle = balloon.querySelector('.lf-balloon-expand') as HTMLButtonElement;
    expect(text.classList.contains('is-clamped')).toBe(true);
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toBe('Show more');

    toggle.click();
    expect(balloon.classList.contains('is-expanded')).toBe(true);
    expect(text.classList.contains('is-clamped')).toBe(false);
    expect(toggle.textContent).toBe('Show less');

    toggle.click();
    expect(balloon.classList.contains('is-expanded')).toBe(false);
    expect(text.classList.contains('is-clamped')).toBe(true);
  });

  it('shows no toggle for short deletions', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: 'short' }]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    expect(balloon.querySelector('.lf-balloon-expand')).toBeNull();
    expect(balloon.querySelector('.lf-balloon-text')?.classList.contains('is-clamped')).toBe(false);
  });
});

describe('mountMarkupMargin — teardown', () => {
  it('scope.dispose() removes the margin DOM and disconnects observers', async () => {
    const observed: unknown[] = [];
    const disconnected: number[] = [];
    class FakeResizeObserver {
      observe(el: unknown): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnected.push(1);
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const { parent, surface } = mountSurface(
        'Alpha.\n\nRemoved.\n\nBravo.\n',
        'Alpha.\n\nBravo.\n',
      );
      await tick();
      const scope = new MountScope();
      const margin = mountMarkupMargin({
        editorEl: parent,
        view: surface.handle.editor.view,
        getDeletions: () => surface.getDeletions(),
        scope,
      });
      margin.relayout();
      expect(parent.querySelector('.markup-margin')).not.toBeNull();
      expect(observed.length).toBeGreaterThan(0);

      scope.dispose();
      expect(parent.querySelector('.markup-margin')).toBeNull();
      expect(parent.querySelector('svg.lf-leader-overlay')).toBeNull();
      expect(parent.classList.contains('redline-layout')).toBe(false);
      expect(disconnected.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
