/**
 * The doc page's plan gate (src/plan-gate.ts): a floating "Approve Plan"
 * button, shown only while the plan is pending. The one-line bar and the
 * derived-work chip strip it replaced are asserted GONE — links in the prose
 * carry task status now (task-link-chips), so nothing renders above the
 * prose on an ordinary doc.
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
  tasks?: Array<{ id: string; planHeld?: boolean; workspaceId?: string }>;
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

function approveBtn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.plan-approve-float');
}

describe('mountPlanGate', () => {
  it('renders nothing for an ordinary doc — even one with derived rows', async () => {
    const gate = mountPlanGate({
      docId: 'd-plain',
      root,
      user: JORDAN,
      canWrite: true,
      // Rows but no pending plan: the old strip showed chips here; the
      // float must not — the prose's own links carry that now.
      fetchJson: stubFetch([{ meta: {}, tasks: [{ id: 't-1' }] }]).fetchJson,
    });
    await gate.ready;
    expect(approveBtn()?.hidden).toBe(true);
    expect(document.querySelector('.plan-task-chip')).toBeNull();
    gate.destroy();
  });

  it('shows the floating Approve button for writers on a pending plan', async () => {
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
    const btn = approveBtn();
    expect(btn?.hidden).toBe(false);
    // Just the label — no held-drafts count, no checkmark (Bryan, on the
    // mock): the button is loud enough by being the only floating thing.
    expect(btn?.textContent).toBe('Approve Plan');
    gate.destroy();
  });

  it('a reader without write access sees no Approve button', async () => {
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
    expect(approveBtn()?.hidden).toBe(true);
    gate.destroy();
  });

  it('anchors to #editor-pane when present, so it pins to the visible pane', async () => {
    const pane = document.createElement('section');
    pane.id = 'editor-pane';
    const editorEl = document.createElement('div');
    editorEl.id = 'editor';
    pane.append(editorEl);
    document.body.replaceChildren(pane);
    const gate = mountPlanGate({
      docId: 'd-anchor',
      root: editorEl,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([{ meta: { planState: 'pending' }, tasks: [] }]).fetchJson,
    });
    await gate.ready;
    expect(approveBtn()?.parentElement).toBe(pane);
    gate.destroy();
  });

  it('Approve posts, reloads, and the button disappears', async () => {
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
    approveBtn()?.click();
    await vi.waitFor(() => expect(gate.planState()).toBe('approved'));
    const post = stub.calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/docs/d-gate/plan');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ state: 'approved', author: JORDAN });
    expect(approveBtn()?.hidden).toBe(true);
    gate.destroy();
  });

  it('a refused Approve stays visible with the reason, floating above the button', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const fetchJson = (_url: string, init?: RequestInit): Promise<unknown> => {
      calls.push(init);
      if (init?.method === 'POST') return Promise.reject(new Error('Plan already approved.'));
      return Promise.resolve({ meta: { planState: 'pending' }, tasks: [] });
    };
    const gate = mountPlanGate({
      docId: 'd-refuse',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson,
    });
    await gate.ready;
    approveBtn()?.click();
    await vi.waitFor(() => expect(calls.some((c) => c?.method === 'POST')).toBe(true));
    await vi.waitFor(() => {
      const err = document.querySelector<HTMLElement>('.plan-gate-error');
      expect(err?.hidden).toBe(false);
      expect(err?.textContent).toBe('Plan already approved.');
    });
    expect(approveBtn()?.hidden).toBe(false);
    gate.destroy();
  });

  it('an approval from ANYWHERE reaches it: a board task event reloads, then closes the stream', async () => {
    const stub = stubFetch([
      {
        meta: { planState: 'pending' },
        tasks: [{ id: 't-a', planHeld: true, workspaceId: 'w-test' }],
      },
      { meta: { planState: 'approved' }, tasks: [{ id: 't-a', workspaceId: 'w-test' }] },
    ]);
    const stops: string[] = [];
    const live: { poke?: () => void } = {};
    const subscribe = vi.fn((wsId: string, onEvent: () => void) => {
      live.poke = onEvent;
      return () => stops.push(wsId);
    });
    const gate = mountPlanGate({
      docId: 'd-remote',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      subscribe,
    });
    await gate.ready;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith('w-test', expect.any(Function));
    expect(approveBtn()?.hidden).toBe(false); // control
    // The release's transition event lands: no press happened HERE, yet the
    // stale Approve must go away…
    live.poke?.();
    await vi.waitFor(() => expect(approveBtn()?.hidden).toBe(true));
    expect(gate.planState()).toBe('approved');
    // …and an approved plan needs no stream any more.
    expect(stops).toEqual(['w-test']);
    gate.destroy();
  });
});
