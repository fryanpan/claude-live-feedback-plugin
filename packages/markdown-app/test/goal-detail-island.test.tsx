import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { options } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { goalDetailData, mountGoalDetailIsland } from '../src/hub/goal-detail-island.tsx';
import { type BoardSection, DEFAULT_DONE_WINDOW, boardSections } from '../src/hub/hub-model.ts';
import type { GoalDetailHandlers, TaskDiscussion } from '../src/hub/hub-render.ts';

/**
 * The goal panel's ISLAND contract, as opposed to what the panel shows — that
 * is `goal-detail.test.ts`, which drives the same island through the app's
 * call shape and is where every behavioural assertion still lives.
 *
 * What is pinned here is what stops being true the moment the panel goes back
 * to being rebuilt from scratch. The vanilla renderer carried all of it by
 * hand, in a one-line window either side of `replaceChildren()`:
 *
 *   - `keepFields` / `restoreFields` snapshotted a half-typed rename out of
 *     the doomed DOM and wrote it back into the fresh one;
 *   - `keptBodySlot` found the live description editor's node and the renderer
 *     then patched AROUND it, because moving that node detaches a ProseMirror
 *     view from the document and drops the caret;
 *   - a `title.click()` at the end reopened a rename the repaint had closed.
 *
 * Under a keyed component none of those have anything to rescue.
 *
 * All fixtures are synthetic. The repo is public.
 */

const NOW = 1_700_000_000_000;

// A signal write re-renders on the next microtask — before the next paint, and
// after the next line of a test. Flushed inline.
options.debounceRendering = (cb: () => void) => cb();

function section(id = 'g-pr', over: Record<string, unknown> = {}): BoardSection {
  const found = boardSections([{ id, title: '1. Get the PR out', ...over }], [], {
    tab: 'all',
    userName: 'Jordan',
    doneWindow: DEFAULT_DONE_WINDOW,
    now: NOW,
  }).find((s) => s.id === id);
  if (!found) throw new Error('section missing');
  return found;
}

const handlers = (extra: Partial<GoalDetailHandlers> = {}): GoalDetailHandlers => ({
  onClose: vi.fn(),
  onTitleCommit: vi.fn(),
  onStatusSet: vi.fn(),
  ...extra,
});

const EMPTY: TaskDiscussion = { loading: false, threads: [] };

let live: (() => void) | null = null;
function mount(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hub-detail hidden';
  document.body.replaceChildren(host);
  live = mountGoalDetailIsland(host);
  return host;
}

/** A repaint: the same goal arriving again the way an SSE event delivers it.
 *  A fresh object, because writing the same object back would not notify and a
 *  repaint that is a no-op proves nothing. */
function repaint(
  s: BoardSection,
  discussion?: TaskDiscussion,
  extra?: Partial<GoalDetailHandlers>,
) {
  goalDetailData.value = { section: { ...s }, discussion, handlers: handlers(extra) };
}

afterEach(() => {
  live?.();
  live = null;
  goalDetailData.value = { section: null, handlers: handlers() };
  document.body.className = '';
});

describe('the goal detail island’s mount contract', () => {
  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanilla = document.createElement('p');
    vanilla.textContent = 'vanilla-owned';
    host.appendChild(vanilla);
    document.body.replaceChildren(host);

    goalDetailData.value = { section: section(), handlers: handlers() };
    const unmount = mountGoalDetailIsland(host);

    const wrapper = host.querySelector('[data-preact-island="goal-detail"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-detail-panel')).not.toBeNull();
    expect(host.firstChild).toBe(vanilla);

    unmount();
    // render(null, el) before el.remove(): teardown, not bare removal. An
    // orphaned tree keeps its effects and its signal subscription, and goes on
    // answering events nobody can see.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="goal-detail"]')).toBeNull();
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so the panel stays a direct child of the backdrop', () => {
    // happy-dom resolves no layout, so this is pinned at the rule level:
    // `.hub-detail` centres with flex, and without `display: contents` the
    // wrapper — not the panel — becomes the flex item.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-detail\s*>\s*\[data-preact-island\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display'); // positive control: the rule was found
    expect(rule).toMatch(/display:\s*contents/);
  });

  it('closes on a backdrop tap, and stops listening once disposed', () => {
    const host = mount();
    const onClose = vi.fn();
    repaint(section(), EMPTY, { onClose });

    // A click inside the panel bubbles through the same listener and must not
    // close the goal the reader is reading.
    (host.querySelector('.hub-detail-panel') as HTMLElement).dispatchEvent(
      new Event('click', { bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
    host.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    live?.();
    live = null;
    host.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the host when the panel closes, and shows it again on the next goal', () => {
    const host = mount();
    repaint(section(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(document.body.classList.contains('hub-detail-open')).toBe(true);

    goalDetailData.value = { section: null, handlers: handlers() };
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.querySelector('.hub-detail-panel')).toBeNull();
    // Still MOUNTED: the wrapper is the island's for as long as the app runs,
    // and a closed panel is a render of nothing rather than an unmount.
    expect(host.querySelector('[data-preact-island="goal-detail"]')).not.toBeNull();

    repaint(section(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);
  });

  it('refuses Backlog, which is a bucket rather than a goal', () => {
    const host = mount();
    const chores = section('chores', { title: 'Backlog' });
    goalDetailData.value = { section: { ...chores, isChores: true }, handlers: handlers() };
    expect(host.querySelector('.hub-detail-panel')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });
});

describe('the goal detail island keeps its nodes across a repaint', () => {
  it('reuses the panel, the title and the description slot for the same goal', () => {
    const host = mount();
    const s = section();
    repaint(s, EMPTY);
    const panel = host.querySelector('.hub-detail-panel');
    const title = host.querySelector('.hub-detail-title');
    const slot = host.querySelector('.hub-detail-body-slot');
    expect(panel).not.toBeNull();
    expect(slot).not.toBeNull();

    repaint(s, EMPTY);
    expect(host.querySelector('.hub-detail-panel')).toBe(panel);
    expect(host.querySelector('.hub-detail-title')).toBe(title);
    // The one node a repaint must NEVER rebuild: the live editor is a
    // ProseMirror view bound to a Yjs room, and even MOVING the node removes
    // it from the document first, which blurs it and drops the caret.
    expect(host.querySelector('.hub-detail-body-slot')).toBe(slot);
  });

  it('rebuilds them when the reader moves to another goal', () => {
    const host = mount();
    repaint(section('g-pr'), EMPTY);
    const slot = host.querySelector('.hub-detail-body-slot');
    repaint(section('g-two', { title: '2. Ship it' }), EMPTY);
    expect(host.querySelector('.hub-detail-body-slot')).not.toBe(slot);
  });

  it('keeps a half-typed rename through a repaint, with no snapshot to restore', () => {
    const host = mount();
    const s = section();
    repaint(s, EMPTY);
    const title = host.querySelector<HTMLElement>('.hub-detail-title');
    title?.click();
    const input = title?.querySelector('input');
    expect(input).not.toBeNull();
    if (input) input.value = 'half typed';

    repaint(s, EMPTY);
    // The SAME input, still carrying the words — not a rebuilt one that had to
    // be re-opened by a `title.click()` and refilled from a snapshot.
    expect(host.querySelector('.hub-detail-title input')).toBe(input);
    expect(input?.value).toBe('half typed');
  });

  it('keeps a half-written comment through a repaint', () => {
    const host = mount();
    const s = section();
    const onComment = vi.fn(async () => true);
    repaint(s, EMPTY, { onComment });
    const box = host.querySelector<HTMLTextAreaElement>('.hub-comment-form textarea');
    expect(box).not.toBeNull();
    if (box) box.value = 'half a thought';

    repaint(s, EMPTY, { onComment });
    expect(host.querySelector('.hub-comment-form textarea')).toBe(box);
    expect(box?.value).toBe('half a thought');
  });

  it('follows the projection when nothing is being typed', () => {
    const host = mount();
    repaint(section(), EMPTY);
    expect(host.querySelector('.hub-detail-title')?.textContent).toBe('1. Get the PR out');
    repaint(section('g-pr', { title: 'Renamed by a peer' }), EMPTY);
    expect(host.querySelector('.hub-detail-title')?.textContent).toBe('Renamed by a peer');
  });
});
