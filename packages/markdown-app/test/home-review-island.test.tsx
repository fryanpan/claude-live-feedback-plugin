/**
 * The "For Your Review" Preact island — the first real pane on the framework
 * scaffold, replacing the vanilla `renderHomeReview`.
 *
 * Two families of properties under test:
 *
 *  1. The island contract the probe proved, now on real furniture: an
 *     unchanged row survives a signal update as the IDENTICAL node object
 *     (so focus, and later comment anchors and editor mounts, survive
 *     repaints); the island owns a wrapper it created; disposal is
 *     render(null, el) and leaves the host's own children alone.
 *
 *  2. Behavior parity with the vanilla renderer it replaces — same heading,
 *     Review All entry, row anatomy, empty state, settled rows. These are the
 *     renderHomeReview tests from hub-render.test.ts, re-aimed at the island.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type ReviewStripHandlers,
  homeReviewData,
  mountHomeReviewIsland,
} from '../src/hub/home-review-island.tsx';
import type { ReviewItem, ReviewQueue } from '../src/hub/hub-model.ts';

const NOW = 1_700_000_000_000;

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const handlers = (): ReviewStripHandlers => ({
  onReview: vi.fn(),
  onOpen: vi.fn(),
  onWalkthrough: vi.fn(),
});

let seq = 0;
/** A declared thread ask, the commonest row shape the server ships. */
function item(over: Partial<ReviewItem> = {}): ReviewItem {
  seq += 1;
  const key = over.key ?? `k-${seq}`;
  return {
    key,
    kind: 'task-thread',
    title: `Some task ${seq}`,
    ask: `Question ${seq}?`,
    why: 'Reviewer asked you 2m ago · on this task',
    since: NOW - 2 * 86_400_000,
    thread: {
      kind: 'task-thread',
      band: 'declared',
      docId: 'task:t-x',
      threadId: `th-${key}`,
      taskId: 't-x',
      title: `Some task ${seq}`,
      ask: `Question ${seq}?`,
      askedBy: 'Helper',
      since: NOW - 2 * 86_400_000,
      direct: true,
    },
    review: {
      shape: 'review',
      headline: `Question ${seq}?`,
    },
    ...over,
  };
}

const queueOf = (items: ReviewItem[]): ReviewQueue => ({
  items,
  total: items.length,
  blocking: 0,
});

function mount(items: ReviewItem[], h = handlers(), settled: ReviewItem[] = []) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  homeReviewData.value = { queue: queueOf(items), settled, now: NOW };
  const unmount = mountHomeReviewIsland(host, h);
  return { host, h, unmount };
}

describe('home-review island contract', () => {
  it('keeps an unchanged row as the IDENTICAL node object when another row changes', async () => {
    const a = item({ key: 'k-a', ask: 'First question?' });
    const b = item({ key: 'k-b', ask: 'Second question?' });
    const { host, unmount } = mount([a, b]);

    const rows = host.querySelectorAll('.hub-review-row');
    expect(rows).toHaveLength(2);
    const rowB = rows[1] as HTMLElement;

    // One row changes; the other must not be rebuilt (keyed on ReviewItem.key).
    homeReviewData.value = {
      queue: queueOf([{ ...a, ask: 'First question, reworded?' }, b]),
      settled: [],
      now: NOW,
    };
    await tick();

    const after = host.querySelectorAll('.hub-review-row');
    expect(after[0]?.querySelector('.hub-review-row-title')?.textContent).toBe(
      'First question, reworded?',
    );
    // The identity property the migration exists for: same object, not a
    // recreated equal.
    expect(after[1]).toBe(rowB);
    unmount();
    host.remove();
  });

  it('a focused row keeps focus across a signal update', async () => {
    const a = item({ key: 'k-a' });
    const b = item({ key: 'k-b' });
    const { host, unmount } = mount([a, b]);

    const rowB = host.querySelectorAll('.hub-review-row')[1] as HTMLButtonElement;
    rowB.focus();
    expect(document.activeElement).toBe(rowB);

    homeReviewData.value = {
      queue: queueOf([{ ...a, ask: 'Changed?' }, b]),
      settled: [],
      now: NOW,
    };
    await tick();

    // The vanilla renderer rebuilt every row on every repaint, which is
    // exactly what dropped focus (and ate iPad taps). Same node → same focus.
    expect(document.activeElement).toBe(rowB);
    unmount();
    host.remove();
  });

  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.appendChild(host);

    homeReviewData.value = { queue: queueOf([item()]), settled: [], now: NOW };
    const unmount = mountHomeReviewIsland(host, handlers());

    const wrapper = host.querySelector('[data-preact-island="home-review"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-home-review-card')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // Disposal removes the wrapper entirely; the host's own children survive.
    expect(host.querySelector('[data-preact-island="home-review"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
    host.remove();
  });

  it('render(null) disposal empties the wrapper before removal', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    homeReviewData.value = { queue: queueOf([item()]), settled: [], now: NOW };
    const unmount = mountHomeReviewIsland(host, handlers());
    const wrapper = host.querySelector('[data-preact-island="home-review"]');
    expect(wrapper).not.toBeNull();

    unmount();
    // render(null, el) ran before el.remove(): teardown, not bare removal.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.contains(wrapper)).toBe(false);
    host.remove();
  });
});

describe('home-review island parity', () => {
  it('heads the section "For Your Review" with the dark Review All button that starts the walkthrough', () => {
    const { host, h, unmount } = mount([item()]);
    expect(host.querySelector('.hub-home-heading')?.textContent).toBe('For Your Review');
    const go = host.querySelector('.hub-review-go') as HTMLButtonElement;
    expect(go.textContent).toBe('Review All');
    expect(go.className).toContain('hub-btn-ink');
    expect(go.getAttribute('aria-label')).toBe('Go through these one at a time');
    go.click();
    expect(h.onWalkthrough).toHaveBeenCalledTimes(1);
    unmount();
    host.remove();
  });

  it('renders each item as a ranked row: the question as the title, the asked-by meta as the subline', () => {
    const first = item({ ask: 'Ship now or wait?' });
    const second = item({ ask: 'Which repo does this land in?' });
    const { host, h, unmount } = mount([first, second]);
    const rows = [...host.querySelectorAll('.hub-review-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.hub-review-row-title')?.textContent).toBe('Ship now or wait?');
    expect(rows[1]?.querySelector('.hub-review-row-title')?.textContent).toBe(
      'Which repo does this land in?',
    );
    expect(rows[1]?.querySelector('.hub-review-row-sub')?.textContent).toBe(
      'Asked by Helper 2 days ago',
    );
    // No separate why line — the why lives in the card's body (approved design).
    expect(rows[0]?.querySelector('.hub-review-row-why')).toBeNull();
    // The hover title carries kind, subject, ask and why, as before.
    expect(rows[1]?.getAttribute('title')).toContain('Task comment');
    (rows[1] as HTMLElement).click();
    expect(h.onReview).toHaveBeenCalledTimes(1);
    expect(h.onReview).toHaveBeenCalledWith(second, 1);
    unmount();
    host.remove();
  });

  it('highlights the top live row — the one the walkthrough would open on', () => {
    const { host, unmount } = mount([item(), item()]);
    const rows = [...host.querySelectorAll('.hub-review-row')];
    expect(rows[0]?.className).toContain('hub-review-row-current');
    expect(rows[1]?.className).not.toContain('hub-review-row-current');
    unmount();
    host.remove();
  });

  it('empty queue says so plainly and offers no Review All', () => {
    const { host, unmount } = mount([]);
    expect(host.querySelector('.hub-home-quiet')?.textContent).toBe(
      'Nothing is waiting for your review right now.',
    );
    expect(host.querySelector('.hub-review-go')).toBeNull();
    expect(host.querySelectorAll('.hub-review-row')).toHaveLength(0);
    unmount();
    host.remove();
  });

  it('keeps settled items in the stack struck through, and only ones the queue really dropped', () => {
    const stillLive = item({ key: 'k-live', ask: 'Still open?' });
    const settledGone: ReviewItem = {
      key: 'decision:t-gone',
      kind: 'decision',
      title: 'Already answered one',
      ask: '',
      why: '',
      since: NOW - 3_600_000,
    };
    const { host, h, unmount } = mount([stillLive], handlers(), [stillLive, settledGone]);
    // The still-open item renders once, as a live row — not twice.
    const titles = [...host.querySelectorAll('.hub-review-row-title')].map((n) => n.textContent);
    expect(titles.filter((t) => t === 'Still open?')).toHaveLength(1);
    const done = host.querySelector('.hub-review-row-done') as HTMLElement;
    expect(done.textContent).toContain('Already answered one');
    expect(done.querySelector('.hub-review-row-sub')?.textContent).toContain(
      'answered this sitting',
    );
    // A done row is still the way back to the thing just answered.
    done.click();
    expect(h.onOpen).toHaveBeenCalledWith(settledGone);
    unmount();
    host.remove();
  });

  it('an item leaving the queue drops its row on the next signal write', async () => {
    const a = item({ key: 'k-a' });
    const b = item({ key: 'k-b' });
    const { host, unmount } = mount([a, b]);
    expect(host.querySelectorAll('.hub-review-row')).toHaveLength(2);

    homeReviewData.value = { queue: queueOf([b]), settled: [], now: NOW };
    await tick();
    const rows = host.querySelectorAll('.hub-review-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.hub-review-row-title')?.textContent).toBe(b.ask);
    unmount();
    host.remove();
  });
});
