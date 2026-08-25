import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { options } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-model.ts';
import type { DetailHandlers, TaskDiscussion } from '../src/hub/hub-render.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/hub/task-detail-island.tsx';
import { frame, surfaceOf, typeInComposer } from './support/composer.ts';

/**
 * The island's own contract, as opposed to what the panel SHOWS — that is
 * `hub-render.test.ts`, which drives the same island through the app's call
 * shape and is where every behavioural assertion still lives.
 *
 * What is pinned here is the four things that stop being true the moment the
 * panel goes back to being rebuilt from scratch: a wrapper of its own, a
 * disposal that tears the tree down instead of orphaning it, a wrapper that is
 * out of layout, and — the whole reason for the move — node identity across a
 * repaint. Before this, every one of those was carried by a snapshot taken
 * just before `replaceChildren()` and put back just after.
 *
 * All fixtures are synthetic.
 */

const NOW = 1_700_000_000_000;

// A signal write re-renders on the next microtask, which is still before the
// next paint and still after the next line of a test. Flushed inline.
options.debounceRendering = (cb: () => void) => cb();

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const handlers = (extra: Partial<DetailHandlers> = {}): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
  ...extra,
});

const EMPTY: TaskDiscussion = { loading: false, threads: [] };

/** A host with an island in it, disposed after the test. An island left alive
 *  keeps its subscription to the module-level signal, so the next test's first
 *  write would paint a panel into a detached tree. */
let live: (() => void) | null = null;
function mount(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hub-detail hidden';
  document.body.replaceChildren(host);
  live = mountTaskDetailIsland(host);
  return host;
}

/** A repaint: the same task, arriving again the way an SSE event delivers it.
 *  The object is fresh — `taskDetailData.value = <same object>` would not
 *  notify, and a test whose repaint is a no-op proves nothing. */
function repaint(t: HubTask, discussion?: TaskDiscussion, extra?: Partial<DetailHandlers>): void {
  taskDetailData.value = {
    task: { ...t },
    discussion,
    handlers: handlers(extra),
  };
}

afterEach(() => {
  live?.();
  live = null;
  taskDetailData.value = { task: null, handlers: handlers() };
});

describe('the task detail island’s mount contract', () => {
  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.replaceChildren(host);

    taskDetailData.value = { task: task(), handlers: handlers() };
    const unmount = mountTaskDetailIsland(host);

    const wrapper = host.querySelector('[data-preact-island="task-detail"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-detail-panel')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // render(null, el) ran before el.remove(): teardown, not bare removal. An
    // orphaned tree keeps its effects, its ResizeObserver and its signal
    // subscription, and goes on answering events nobody can see.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="task-detail"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so the panel stays a direct child of the backdrop', () => {
    // happy-dom resolves no layout, so this is pinned at the rule level:
    // `.hub-detail` is a centring flex container, and without
    // `display: contents` the wrapper — not the panel — becomes the flex item,
    // so the panel stretches to fill it and the `min(var(--hub-detail-w), …)`
    // width above stops describing anything on screen.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-detail\s*>\s*\[data-preact-island\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display'); // positive control: found the rule
    expect(rule).toMatch(/display:\s*contents/);
  });

  it('closes on a backdrop tap, and stops listening once disposed', () => {
    const host = mount();
    const onClose = vi.fn();
    repaint(task(), EMPTY, { onClose });

    // The tap has to be the backdrop itself. A click inside the panel bubbles
    // through the same listener and must not close the task the reader is
    // reading — the assertion pair below is what tells those two apart.
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

  it('hides the host when the panel closes, and shows it again on the next task', () => {
    const host = mount();
    repaint(task(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);

    taskDetailData.value = { task: null, handlers: handlers() };
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.querySelector('.hub-detail-panel')).toBeNull();
    // Still mounted, though — the wrapper is the island's for as long as the
    // app runs, and a closed panel is a render of nothing rather than an
    // unmount.
    expect(host.querySelector('[data-preact-island="task-detail"]')).not.toBeNull();

    repaint(task(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);
  });
});

describe('the task detail island keeps its nodes across a repaint', () => {
  it('reuses the panel and the head for the same task, and rebuilds them for another', () => {
    const host = mount();
    const t = task();
    repaint(t, EMPTY);
    const panel = host.querySelector('.hub-detail-panel');
    const title = host.querySelector('.hub-detail-title');
    expect(panel).not.toBeNull();

    // A status flip lands: the same ticket, drawn again.
    repaint({ ...t, status: 'in-progress' }, EMPTY);
    expect(host.querySelector('.hub-detail-panel')).toBe(panel);
    expect(host.querySelector('.hub-detail-title')).toBe(title);
    // …and it really was a repaint rather than a skipped render.
    expect(host.querySelector<HTMLSelectElement>('.hub-detail-status')?.value).toBe('in-progress');

    // A different ticket is a different panel. Keyed on the task id precisely
    // so this case does NOT reuse: one reader's half-typed comment must not
    // reappear in a box belonging to somebody else's task.
    repaint(task(), EMPTY);
    expect(host.querySelector('.hub-detail-panel')).not.toBe(panel);
  });

  it('keeps the comment composer itself — the node, its words and its caret', async () => {
    // The composer is the case that forced the island's shape. Attaching one
    // REPLACES the textarea with a wrapper and moves the textarea inside it,
    // so its DOM is not the DOM Preact rendered. The answer is that the
    // `<form>` is Preact's and its children are nobody's: a vnode with no
    // children diffs against nothing, so a repaint leaves everything inside
    // untouched.
    const host = mount();
    const t = task();
    repaint(t, EMPTY, { onComment: vi.fn() });
    const ta = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(ta).not.toBeNull();
    const surface = surfaceOf(ta as HTMLTextAreaElement);
    expect(surface).not.toBeNull(); // control: a live editor, not a bare box
    await typeInComposer(ta as HTMLTextAreaElement, 'half a sentence', 4);

    repaint({ ...t, status: 'in-progress' }, EMPTY, { onComment: vi.fn() });
    await frame();

    const after = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    // The same node, so nothing had to be carried across: no `keepFields`
    // snapshot, no `restoreFields` pass, and no editor torn down and rebuilt
    // under a caret that was in it.
    expect(after).toBe(ta);
    expect(surfaceOf(after as HTMLTextAreaElement)).toBe(surface);
    expect(after?.value).toBe('half a sentence');
  });

  it('empties the composer when the panel moves to another task', async () => {
    // The other half of the same rule, and the reason identity is keyed rather
    // than global: a draft belongs to the ticket it was typed on.
    const host = mount();
    repaint(task(), EMPTY, { onComment: vi.fn() });
    const ta = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    await typeInComposer(ta as HTMLTextAreaElement, 'meant for this one');

    repaint(task(), EMPTY, { onComment: vi.fn() });
    await frame();
    const after = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(after).not.toBe(ta);
    expect(after?.value).toBe('');
  });

  it('leaves an open capture open, because nothing writes `open` back', () => {
    // `<details open>` is deliberately NOT a prop. Passing it would make every
    // repaint an instruction to close what the reader opened — the same defect
    // in a new place, since Preact would be reasserting a value the DOM has
    // moved on from.
    const host = mount();
    const t = task({ quote: 'the original words, verbatim' });
    repaint(t, EMPTY);
    const quote = host.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    quote.open = true;

    repaint({ ...t, status: 'in-progress' }, EMPTY);
    const after = host.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    expect(after).toBe(quote);
    expect(after.open).toBe(true);
  });
});
