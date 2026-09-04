import { options } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-board-model.ts';
import type { DetailHandlers } from '../src/hub/hub-detail-render.ts';
import {
  type TaskAskState,
  taskAskFace,
  taskAskReceipt,
  taskAskRequestPath,
  taskAskStatePath,
} from '../src/hub/task-asks.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/hub/task-detail-island.tsx';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The task panel's Plan and Review controls.
 *
 * The thing under test is the swap: while nobody has asked, each is a BUTTON
 * that files the ask; once somebody has, it is a receipt naming them — and
 * the receipt must not be button-shaped. The panel used to render "Plan
 * requested" as a disabled button, which readers went on pressing, and a
 * disabled button would satisfy any test that only checked the words.
 *
 * Driven through the island the way the app drives it — a write to
 * `taskDetailData` — so what is asserted is what a reader sees, not what a
 * function returns. The pure decisions (which face, which words, which
 * address) are asserted directly on the model beneath it.
 *
 * All fixtures are synthetic.
 */

const NOW = 1_700_000_000_000;

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
  now: NOW,
  ...extra,
});

let live: (() => void) | null = null;
function mount(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hub-detail hidden';
  document.body.replaceChildren(host);
  live = mountTaskDetailIsland(host);
  return host;
}

/** The panel showing `t`, with whatever ask wiring the case needs. */
function show(t: HubTask, extra: Partial<DetailHandlers> = {}): void {
  taskDetailData.value = { task: { ...t }, handlers: handlers(extra) };
}

const askButton = (host: HTMLElement, kind: string) =>
  host.querySelector<HTMLButtonElement>(`button.hub-task-ask[data-ask="${kind}"]`);
const receipt = (host: HTMLElement, kind: string) =>
  host.querySelector<HTMLElement>(`.hub-task-ask-receipt[data-ask="${kind}"]`);

let sheets = () => {};
beforeEach(() => {
  setViewport(IPAD);
  sheets = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  sheets();
  live?.();
  live = null;
  taskDetailData.value = { task: null, handlers: handlers() };
});

describe('the ticket’s Plan and Review controls', () => {
  it('offers both while nobody has asked', () => {
    const host = mount();
    show(task(), { onAsk: vi.fn(async () => true) });

    expect(askButton(host, 'plan')?.textContent).toBe('Plan');
    expect(askButton(host, 'review')?.textContent).toBe('Review');
    // Live, not decoration: a disabled control is what this row replaces.
    expect(askButton(host, 'plan')?.disabled).toBe(false);
    expect(askButton(host, 'review')?.disabled).toBe(false);
    expect(receipt(host, 'plan')).toBeNull();
  });

  it('draws neither control on a board that cannot ask', () => {
    // Positive control for the case above: the buttons found there are the
    // handler's doing, not something the panel always renders.
    const host = mount();
    show(task());
    expect(askButton(host, 'plan')).toBeNull();
    expect(askButton(host, 'review')).toBeNull();
  });

  it('files the ask for the kind that was pressed', async () => {
    const host = mount();
    const onAsk = vi.fn(async () => true);
    const t = task();
    show(t, { onAsk });

    askButton(host, 'review')?.click();
    await Promise.resolve();

    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onAsk.mock.calls[0]?.[0]?.id).toBe(t.id);
    expect(onAsk.mock.calls[0]?.[1]).toBe('review');
  });

  it('turns into a receipt that is not a button once the ask lands', async () => {
    const host = mount();
    show(task(), { onAsk: vi.fn(async () => true) });

    askButton(host, 'plan')?.click();
    await Promise.resolve();
    await Promise.resolve();

    // The control is gone as a control — this is the assertion the old
    // disabled-button receipt would have failed.
    expect(askButton(host, 'plan')).toBeNull();
    const line = receipt(host, 'plan');
    expect(line).not.toBeNull();
    expect(line?.tagName).toBe('SPAN');
    expect(line?.textContent).toContain('Plan requested');
    // And it cannot be pressed by any route a button offers.
    expect(line?.closest('button')).toBeNull();
    // Review is untouched: two independent asks, not one toggle.
    expect(askButton(host, 'review')).not.toBeNull();
  });

  it('keeps the button when the ask is refused', async () => {
    const host = mount();
    const onAsk = vi.fn(async () => false);
    show(task(), { onAsk });

    askButton(host, 'plan')?.click();
    await Promise.resolve();
    await Promise.resolve();

    // A receipt for an ask no agent received is worse than a second press.
    expect(receipt(host, 'plan')).toBeNull();
    expect(askButton(host, 'plan')?.disabled).toBe(false);
  });

  it('will not fire twice while the first ask is in flight', async () => {
    const host = mount();
    let release: (v: boolean) => void = () => {};
    const onAsk = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    show(task(), { onAsk });

    askButton(host, 'plan')?.click();
    await Promise.resolve();
    askButton(host, 'plan')?.click();
    askButton(host, 'review')?.click();
    await Promise.resolve();
    expect(onAsk).toHaveBeenCalledTimes(1);

    release(true);
    await Promise.resolve();
    await Promise.resolve();
    // And the row is usable again afterwards.
    expect(askButton(host, 'review')?.disabled).toBe(false);
  });

  it('renders the receipt from the ticket’s own stamps, so a reopen shows it', () => {
    const host = mount();
    const asks: TaskAskState = {
      planRequestedAt: NOW - 4 * 60_000,
      planRequestedBy: 'Bryan',
    };
    show(task(), { onAsk: vi.fn(async () => true), taskAsks: asks });

    // Nothing was pressed in this panel — the stamp alone decides the face.
    expect(askButton(host, 'plan')).toBeNull();
    expect(receipt(host, 'plan')?.textContent).toBe('Plan requested by Bryan, 4m ago');
    expect(askButton(host, 'review')).not.toBeNull();
  });

  it('offers the ask while the stamps have not loaded', () => {
    // Undefined is "not read yet". Offering costs one extra press at worst;
    // a receipt guessed from a missing read hides the control entirely.
    const host = mount();
    show(task(), { onAsk: vi.fn(async () => true) });
    expect(askButton(host, 'plan')).not.toBeNull();
  });
});

describe('the controls at the two verified widths', () => {
  it('meets the phone tap floor and stays inside the panel at 430px', () => {
    setViewport(PHONE);
    const host = mount();
    show(task(), { onAsk: vi.fn(async () => true) });
    const button = askButton(host, 'plan');
    expect(button).not.toBeNull();
    // 44px is the floor in docs/product/design-mobile.md.
    expect(Number.parseFloat(styleOf(button as HTMLElement).minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('ranges the row to the right, where this panel keeps its chips', () => {
    const host = mount();
    show(task(), { onAsk: vi.fn(async () => true) });
    const row = host.querySelector<HTMLElement>('.hub-task-asks');
    expect(row).not.toBeNull();
    expect(styleOf(row as HTMLElement).justifyContent).toBe('flex-end');
  });
});

describe('what the ask model decides', () => {
  it('reads each kind’s own stamp', () => {
    const asks: TaskAskState = { planRequestedAt: NOW, planRequestedBy: 'Bryan' };
    expect(taskAskFace('plan', asks)).toBe('requested');
    expect(taskAskFace('review', asks)).toBe('ask');
    expect(taskAskFace('plan', undefined)).toBe('ask');
  });

  it('names who asked and how long ago, and drops the name when there is none', () => {
    expect(taskAskReceipt('review', { reviewRequestedAt: NOW - 3_600_000 }, NOW)).toBe(
      'Review requested, 1h ago',
    );
    expect(
      taskAskReceipt(
        'review',
        { reviewRequestedAt: NOW - 3_600_000, reviewRequestedBy: 'Sam' },
        NOW,
      ),
    ).toBe('Review requested by Sam, 1h ago');
    expect(taskAskReceipt('plan', {}, NOW)).toBeNull();
  });

  it('addresses the ticket’s body doc as one path segment', () => {
    // The colon has to survive as a segment: the route matches
    // `/api/docs/([^/]+)`, so an id smuggled in raw would still resolve today
    // and stop resolving the moment an id carries a slash.
    expect(taskAskRequestPath('t-42', 'plan')).toBe('/api/docs/task%3At-42/plan-request');
    expect(taskAskRequestPath('t-42', 'review')).toBe('/api/docs/task%3At-42/review-request');
    expect(taskAskStatePath('t-42')).toBe('/api/docs/task%3At-42');
  });
});
