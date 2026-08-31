/**
 * The doc page's plan gate (src/plan-gate.ts): one quiet line with the
 * Approve control, shown only while the plan is pending. The derived-work
 * chips strip it replaced is asserted GONE — links in the prose carry the
 * status now (task-link-chips), so nothing above the prose may spend height
 * on an ordinary doc.
 *
 * Driven entirely through the injected fetch seam — no server. Fixtures are
 * synthetic (jordan@partner.example register).
 */
import type { User } from '@feedback/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPlanGate } from '../src/plan-gate.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

interface DocAnswer {
  meta?: { planState?: string };
  tasks?: Array<{ id: string; planHeld?: boolean }>;
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

describe('mountPlanGate', () => {
  it('renders nothing for an ordinary doc — even one with derived rows', async () => {
    const gate = mountPlanGate({
      docId: 'd-plain',
      root,
      user: JORDAN,
      canWrite: true,
      // Rows but no pending plan: the old strip showed chips here; the gate
      // must not — the prose's own links carry that now.
      fetchJson: stubFetch([{ meta: {}, tasks: [{ id: 't-1' }] }]).fetchJson,
    });
    await gate.ready;
    expect(root.querySelector<HTMLElement>('.plan-gate')?.hidden).toBe(true);
    expect(root.querySelector('.plan-task-chip')).toBeNull();
    gate.destroy();
  });

  it('shows the pending line with the held-draft count, for writers with Approve', async () => {
    const gate = mountPlanGate({
      docId: 'd-plan',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([
        {
          meta: { planState: 'pending' },
          tasks: [{ id: 't-a', planHeld: true }, { id: 't-b', planHeld: true }, { id: 't-c' }],
        },
      ]).fetchJson,
    });
    await gate.ready;
    const row = root.querySelector<HTMLElement>('.plan-gate');
    expect(row?.hidden).toBe(false);
    expect(row?.querySelector('.plan-gate-label')?.textContent).toBe(
      'Plan pending — 2 draft tasks held',
    );
    expect(row?.querySelector<HTMLButtonElement>('.plan-gate-approve')?.hidden).toBe(false);
    gate.destroy();
  });

  it('a reader without write access sees the pending line but no Approve', async () => {
    const gate = mountPlanGate({
      docId: 'd-ro',
      root,
      user: JORDAN,
      canWrite: false,
      fetchJson: stubFetch([
        { meta: { planState: 'pending' }, tasks: [{ id: 't-a', planHeld: true }] },
      ]).fetchJson,
    });
    await gate.ready;
    expect(root.querySelector<HTMLElement>('.plan-gate')?.hidden).toBe(false); // control
    expect(root.querySelector('.plan-gate-label')?.textContent).toBe(
      'Plan pending — 1 draft task held',
    );
    expect(root.querySelector<HTMLButtonElement>('.plan-gate-approve')?.hidden).toBe(true);
    gate.destroy();
  });

  it('Approve posts, reloads, and the whole line disappears', async () => {
    const stub = stubFetch([
      { meta: { planState: 'pending' }, tasks: [{ id: 't-a', planHeld: true }] },
      { meta: { planState: 'approved' }, tasks: [{ id: 't-a' }] },
    ]);
    const gate = mountPlanGate({
      docId: 'd-gate',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
    });
    await gate.ready;
    root.querySelector<HTMLButtonElement>('.plan-gate-approve')?.click();
    await vi.waitFor(() => expect(gate.planState()).toBe('approved'));
    const post = stub.calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/docs/d-gate/plan');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ state: 'approved', author: JORDAN });
    // Approved: not a changed label — no row at all.
    expect(root.querySelector<HTMLElement>('.plan-gate')?.hidden).toBe(true);
    gate.destroy();
  });
});
