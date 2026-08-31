/**
 * The doc page's derived-work strip (src/plan-tasks.ts): tasks filed FROM
 * this doc as live chips, and the plan gate's Approve control.
 *
 * Driven entirely through the injected fetch/subscribe seams — no server, no
 * EventSource. Fixtures are synthetic (jordan@partner.example register).
 */
import type { User } from '@feedback/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type PlanTaskEntry, mountPlanTasks } from '../src/plan-tasks.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

interface DocAnswer {
  meta?: { planState?: string };
  tasks?: PlanTaskEntry[];
}

/** A fetch stub that answers the doc GET from `answers` in order (the last
 *  one repeats), records every call, and accepts the plan POST. */
function stubFetch(answers: DocAnswer[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reads = 0;
  const fetchJson = (url: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ url, init });
    if (init?.method === 'POST') return Promise.resolve({ ok: true });
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return Promise.resolve(answer);
  };
  return { fetchJson, calls };
}

const entry = (over: Partial<PlanTaskEntry> = {}): PlanTaskEntry => ({
  id: 't-1',
  title: 'Agent can build the slice',
  status: 'todo',
  assignee: 'Quill',
  workspaceId: 'w-test',
  ...over,
});

describe('mountPlanTasks', () => {
  it('stays hidden with nothing to show, and shows chips when the doc has derived rows', async () => {
    const empty = stubFetch([{ meta: {} }]);
    const bare = mountPlanTasks({
      docId: 'd-empty',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: empty.fetchJson,
      subscribe: () => () => {},
    });
    await bare.ready;
    expect(root.querySelector<HTMLElement>('.plan-tasks')?.hidden).toBe(true);
    bare.destroy();

    // The positive control: the same mount with rows is visible.
    const full = stubFetch([{ meta: {}, tasks: [entry()] }]);
    const strip = mountPlanTasks({
      docId: 'd-full',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: full.fetchJson,
      subscribe: () => () => {},
    });
    await strip.ready;
    const row = root.querySelector<HTMLElement>('.plan-tasks');
    expect(row?.hidden).toBe(false);
    const chip = root.querySelector<HTMLAnchorElement>('a.plan-task-chip');
    expect(chip?.getAttribute('href')).toBe('/workspaces/w-test?task=t-1');
    expect(chip?.querySelector('.plan-task-title')?.textContent).toBe('Agent can build the slice');
    expect(chip?.querySelector('.ws-status-chip')?.textContent).toBe('To do');
    strip.destroy();
  });

  it('marks a held draft and a possibly-stale row; a visitor chip with no workspaceId is not a link', async () => {
    const { fetchJson } = stubFetch([
      {
        meta: { planState: 'pending' },
        tasks: [
          entry({ id: 't-held', planHeld: true, status: 'triage' }),
          entry({ id: 't-stale', possiblyStale: true }),
          entry({ id: 't-bare', workspaceId: undefined }),
        ],
      },
    ]);
    const strip = mountPlanTasks({
      docId: 'd-plan',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson,
      subscribe: () => () => {},
    });
    await strip.ready;
    const chips = [...root.querySelectorAll<HTMLElement>('.plan-task-chip')];
    expect(chips).toHaveLength(3);
    const [held, stale, bare] = chips;
    expect(held?.classList.contains('is-draft')).toBe(true);
    // A held draft's status chip says what it IS, not "triage".
    expect(held?.querySelector('.ws-status-chip')?.textContent).toBe('Draft');
    expect(stale?.classList.contains('is-stale')).toBe(true);
    expect(stale?.querySelector('.plan-task-stale')?.textContent).toBe('plan edited');
    // Control both ways: the flagged row proves the mark CAN render, and the
    // unflagged siblings carry neither mark.
    expect(held?.querySelector('.plan-task-stale')).toBeNull();
    expect(bare?.tagName).toBe('SPAN');
    strip.destroy();
  });

  it('offers Approve only to a writer on a pending plan, and the press posts and reloads', async () => {
    const stub = stubFetch([
      { meta: { planState: 'pending' }, tasks: [entry({ planHeld: true, status: 'triage' })] },
      { meta: { planState: 'approved' }, tasks: [entry({ status: 'todo' })] },
    ]);
    const strip = mountPlanTasks({
      docId: 'd-gate',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      subscribe: () => () => {},
    });
    await strip.ready;
    const approve = root.querySelector<HTMLButtonElement>('.plan-tasks-approve');
    expect(approve?.hidden).toBe(false);
    approve?.click();
    await vi.waitFor(() => expect(strip.planState()).toBe('approved'));
    const post = stub.calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/docs/d-gate/plan');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ state: 'approved', author: JORDAN });
    // Approved: the button is gone and the chip moved with the reload.
    expect(root.querySelector<HTMLButtonElement>('.plan-tasks-approve')?.hidden).toBe(true);
    expect(root.querySelector('.ws-status-chip')?.textContent).toBe('To do');
    strip.destroy();
  });

  it('a reader without write access sees the drafts but no Approve', async () => {
    const { fetchJson } = stubFetch([
      { meta: { planState: 'pending' }, tasks: [entry({ planHeld: true })] },
    ]);
    const strip = mountPlanTasks({
      docId: 'd-ro',
      root,
      user: JORDAN,
      canWrite: false,
      fetchJson,
      subscribe: () => () => {},
    });
    await strip.ready;
    expect(root.querySelector<HTMLElement>('.plan-tasks')?.hidden).toBe(false); // control
    expect(root.querySelector<HTMLButtonElement>('.plan-tasks-approve')?.hidden).toBe(true);
    strip.destroy();
  });

  it('subscribes once per board, refetches on a task event, and closes streams on destroy', async () => {
    const stub = stubFetch([
      { meta: {}, tasks: [entry({ id: 't-a' }), entry({ id: 't-b', workspaceId: 'w-test' })] },
      { meta: {}, tasks: [entry({ id: 't-a', status: 'done' })] },
    ]);
    const stops: string[] = [];
    const live: { poke?: () => void } = {};
    const subscribe = vi.fn((wsId: string, onEvent: () => void) => {
      live.poke = onEvent;
      return () => stops.push(wsId);
    });
    const strip = mountPlanTasks({
      docId: 'd-live',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      subscribe,
    });
    await strip.ready;
    // Two rows on ONE board: one stream, not one per chip.
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('w-test', expect.any(Function));
    live.poke?.();
    await vi.waitFor(() => expect(root.querySelector('.ws-status-chip')?.textContent).toBe('Done'));
    strip.destroy();
    expect(stops).toEqual(['w-test']);
  });
});
