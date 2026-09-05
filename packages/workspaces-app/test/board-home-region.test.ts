import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBoardHomeRegion } from '../src/board/board-home-region.ts';
import { homeActivityData } from '../src/board/home-activity-island.tsx';
import { homeReviewData } from '../src/board/home-review-island.tsx';
import { boardState, mountShell, task } from './support/board-region-harness.ts';

/**
 * The Home pane and the three REST calls that feed it.
 *
 * All four things here are functions of ONE payload plus the queue derived
 * from the live projection, and the rules driven below are the ones that
 * crossed sixty lines while this lived in `bootBoard`: the poll that waits for
 * a generated brief, the repaint that must go through the touch guard rather
 * than straight to the DOM, and "a failed fetch is not an empty Home".
 */
function home(over: Partial<Parameters<typeof createBoardHomeRegion>[0]> = {}) {
  const el = mountShell();
  const state = boardState({ pane: 'home', nav: 'home', tasks: new Map([['t-1', task('t-1')]]) });
  const scheduled: Array<() => void> = [];
  const api = createBoardHomeRegion({
    state,
    workspaceId: 'w-1',
    author: { id: 'u-1', name: 'Bryan', kind: 'known', color: '#000' },
    user: { name: 'Bryan' },
    document,
    el,
    currentQueue: () => ({ items: [], counts: {} }) as never,
    taskList: () => [...state.tasks.values()],
    schedule: (paint) => scheduled.push(paint),
    ...over,
  });
  return { el, state, scheduled, ...api };
}

function serve(body: unknown, onRequest?: (url: string) => void) {
  vi.stubGlobal('fetch', (url: string) => {
    onRequest?.(url);
    return body === null
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createBoardHomeRegion', () => {
  it('marks the destination the reader is on, and only that one', () => {
    const h = home();
    h.renderHomeRegion();
    const active = [...document.querySelectorAll('.board-nav-item')].filter((b) =>
      b.classList.contains('board-nav-item-active'),
    );
    expect(active).toHaveLength(1);
    expect((active[0] as HTMLElement).dataset.nav).toBe('home');
    expect(active[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('draws nothing into the pane while the reader is on the board', () => {
    const h = home();
    h.state.pane = 'board';
    homeReviewData.value = { queue: { items: [], counts: {} }, settled: [], now: 0 } as never;
    const before = homeReviewData.value;
    h.renderHomeRegion();
    expect(h.el('board-home').classList.contains('hidden')).toBe(true);
    expect(homeReviewData.value).toBe(before);
  });

  it('hands the queue and the projection to the two islands as signals', () => {
    const h = home();
    h.renderHomeRegion();
    expect(homeReviewData.value.queue).toBeDefined();
    expect(homeActivityData.value.tasks.map((t) => t.id)).toEqual(['t-1']);
  });

  it('keeps the last brief when the fetch never reached the server', async () => {
    const h = home();
    serve({ headline: 'first' });
    await h.loadHome();
    expect((h.state.home as { headline?: string })?.headline).toBe('first');
    serve(null);
    await h.loadHome();
    expect((h.state.home as { headline?: string })?.headline).toBe('first');
  });

  it('repaints through the touch guard, never straight to the DOM', () => {
    // Home is the surface whose option buttons a mid-press repaint was
    // measured eating; the poll below re-runs this every 1.5s.
    const h = home();
    serve({ generating: false });
    return h.loadHome().then(() => {
      expect(h.scheduled).toHaveLength(1);
    });
  });

  it('keeps polling while the server says a brief is still being generated', async () => {
    const h = home();
    let calls = 0;
    serve({ generating: true }, () => {
      calls += 1;
    });
    await h.loadHome();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toBe(2);
  });

  it('stops the moment the brief arrives, and forgets it was ever waiting', async () => {
    const h = home();
    serve({ generating: true });
    await h.loadHome();
    expect(h.state.homePollStarted).toBeGreaterThan(0);
    serve({ generating: false, headline: 'ready' });
    await h.loadHome();
    expect(h.state.homePollStarted).toBe(0);
    const before = JSON.stringify(h.state.home);
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.stringify(h.state.home)).toBe(before);
  });
});
