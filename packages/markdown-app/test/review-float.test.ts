/**
 * The Review float (src/review-float.ts): the meeting's second one-tap ask,
 * docked beside Make Plan. Two faces — Review on a huddle doc a writer can
 * press, Review requested while the ask thread it filed is still open — and
 * the receipt goes back to an offer when that thread resolves, because a
 * review is asked for more than once in a meeting.
 *
 * Driven through the injected seams: no server, no Yjs. Fixtures synthetic.
 */
import type { LeadPresence, User } from '@feedback/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { mountPlanGate } from '../src/plan-gate.ts';
import { mountReviewFloat } from '../src/review-float.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

interface DocAnswer {
  meta?: {
    huddle?: boolean;
    huddleKind?: string;
    reviewRequestedAt?: number;
    reviewRequestedBy?: string;
    reviewThreadId?: string;
  };
  leadAgentId?: string;
}

/** A fetch stub answering the doc GET from `answers` in order (the last one
 *  repeats), recording every call, and accepting every POST. */
function stubFetch(answers: DocAnswer[], post: unknown = { threadId: 't-ask' }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let reads = 0;
  const fetchJson = (url: string, init?: RequestInit): Promise<unknown> => {
    calls.push({ url, init });
    if (init?.method === 'POST') {
      return post instanceof Error ? Promise.reject(post) : Promise.resolve(post);
    }
    const answer = answers[Math.min(reads, answers.length - 1)];
    reads += 1;
    return Promise.resolve(answer);
  };
  return { fetchJson, calls };
}

/** A hand-cranked watcher: the test fires it, the float re-reads. */
function stubWatch() {
  let fn: (() => void) | null = null;
  let stopped = 0;
  return {
    watch: (onChange: () => void) => {
      fn = onChange;
      return () => {
        stopped += 1;
      };
    },
    fire: () => fn?.(),
    stopped: () => stopped,
  };
}

function btn(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('.review-float');
}
function label(): string | undefined {
  return btn()?.querySelector('.plan-float-label')?.textContent ?? undefined;
}
function sub(): string | undefined {
  return btn()?.querySelector('.plan-float-sub')?.textContent ?? undefined;
}

const HUDDLE: DocAnswer = { meta: { huddle: true, huddleKind: 'discussion' } };

/** A hand-cranked lead-presence feed, the shape `lead-banner.ts` exposes. */
function stubPresence() {
  let fn: ((p: LeadPresence | null) => void) | null = null;
  let stopped = 0;
  return {
    watch: (onChange: (p: LeadPresence | null) => void) => {
      fn = onChange;
      return () => {
        stopped += 1;
      };
    },
    push: (p: LeadPresence | null) => fn?.(p),
    stopped: () => stopped,
  };
}
const PRESENCE = (live: boolean): LeadPresence => ({
  event: 'lead.presence',
  docId: 'd-h',
  workspaceId: 'w-1',
  live,
});

describe('mountReviewFloat', () => {
  it('an ordinary doc gets no float, and neither does a reader on a huddle', async () => {
    const plain = mountReviewFloat({
      docId: 'd-plain',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([{ meta: {} }]).fetchJson,
    });
    await plain.ready;
    expect(plain.face()).toBe('none');
    expect(btn()?.hidden).toBe(true);
    plain.destroy();

    const reader = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: false,
      fetchJson: stubFetch([HUDDLE]).fetchJson,
    });
    await reader.ready;
    expect(reader.face()).toBe('none');
    reader.destroy();
  });

  it('a writer on a huddle doc — plan or discussion — sees Review, naming the lead', async () => {
    const stub = stubFetch([{ ...HUDDLE, leadAgentId: 'Workspaces' }]);
    const float = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
    });
    await float.ready;
    expect(float.face()).toBe('ask');
    expect(btn()?.hidden).toBe(false);
    expect(btn()?.disabled).toBe(false);
    expect(label()).toBe('Review');
    expect(sub()).toBe('Ask Workspaces to review the notes');
    float.destroy();

    // A plan doc offers it too — and with no lead, the fallback name.
    const plan = mountReviewFloat({
      docId: 'd-p',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([{ meta: { huddle: true, huddleKind: 'plan' } }]).fetchJson,
    });
    await plan.ready;
    expect(plan.face()).toBe('ask');
    expect(sub()).toBe('Ask your agent to review the notes');
    plan.destroy();
  });

  it('a press posts the ask as the presser, re-reads, and shows the receipt', async () => {
    const stub = stubFetch([
      HUDDLE,
      {
        meta: {
          huddle: true,
          reviewRequestedAt: 1_700_000_000_000,
          reviewRequestedBy: 'Jordan',
          reviewThreadId: 't-ask',
        },
        leadAgentId: 'Workspaces',
      },
    ]);
    const float = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stub.fetchJson,
      // The thread is not in the local map yet: unknown reads as open.
      threadOpen: () => undefined,
    });
    await float.ready;
    btn()?.click();
    await new Promise((r) => setTimeout(r, 0));
    const post = stub.calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe('/api/docs/d-h/review-request');
    expect(JSON.parse(String(post?.init?.body)).author.name).toBe('Jordan');
    expect(float.face()).toBe('requested');
    expect(btn()?.disabled).toBe(true);
    expect(label()).toBe('Review requested');
    expect(sub()).toBe('Asked by Jordan — waiting for Workspaces');
    // Pressing the receipt files nothing — one ask, one thread.
    btn()?.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stub.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1);
    float.destroy();
  });

  it('the receipt becomes an offer again once the ask thread is resolved', async () => {
    let open: boolean | undefined = true;
    const threads = stubWatch();
    const float = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([
        {
          meta: {
            huddle: true,
            reviewRequestedAt: 1,
            reviewRequestedBy: 'Sam',
            reviewThreadId: 't-1',
          },
        },
      ]).fetchJson,
      threadOpen: (id) => (id === 't-1' ? open : undefined),
      watchThreads: threads.watch,
    });
    await float.ready;
    expect(float.face()).toBe('requested');
    // The agent resolves the thread: the map changes, no fetch happens.
    open = false;
    threads.fire();
    expect(float.face()).toBe('ask');
    expect(btn()?.disabled).toBe(false);
    expect(label()).toBe('Review');
    // Negative control: a change that leaves the thread open changes nothing.
    open = true;
    threads.fire();
    expect(float.face()).toBe('requested');
    float.destroy();
    expect(threads.stopped()).toBe(1);
  });

  it("another tab's press reaches this one through the meta watch", async () => {
    const meta = stubWatch();
    const float = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([
        HUDDLE,
        {
          meta: {
            huddle: true,
            reviewRequestedAt: 2,
            reviewRequestedBy: 'Sam',
            reviewThreadId: 't-2',
          },
        },
      ]).fetchJson,
      watchDocMeta: meta.watch,
    });
    await float.ready;
    expect(float.face()).toBe('ask');
    meta.fire();
    await new Promise((r) => setTimeout(r, 0));
    expect(float.face()).toBe('requested');
    expect(sub()).toBe('Asked by Sam — waiting for your agent');
    float.destroy();
    expect(meta.stopped()).toBe(1);
  });

  it('a refused press puts the reason beside the button and keeps the offer', async () => {
    const float = mountReviewFloat({
      docId: 'd-h',
      root,
      user: JORDAN,
      canWrite: true,
      fetchJson: stubFetch([HUDDLE], new Error('author required')).fetchJson,
    });
    await float.ready;
    btn()?.click();
    await new Promise((r) => setTimeout(r, 0));
    const err = document.querySelector<HTMLElement>('.plan-gate-error');
    expect(err?.hidden).toBe(false);
    expect(err?.textContent).toBe('author required');
    expect(float.face()).toBe('ask');
    expect(btn()?.disabled).toBe(false);
    float.destroy();
  });

  it('docks beside Make Plan in one row on the pane, plan first', async () => {
    const pane = document.createElement('div');
    pane.id = 'editor-pane';
    const editorEl = document.createElement('div');
    editorEl.id = 'editor';
    pane.append(editorEl);
    document.body.replaceChildren(pane);
    const gate = mountPlanGate({
      docId: 'd-both',
      root: editorEl,
      user: JORDAN,
      canWrite: true,
      fetchJson: () => Promise.resolve({ meta: { huddle: true, huddleKind: 'plan' }, tasks: [] }),
    });
    const review = mountReviewFloat({
      docId: 'd-both',
      root: editorEl,
      user: JORDAN,
      canWrite: true,
      fetchJson: () => Promise.resolve({ meta: { huddle: true, huddleKind: 'plan' } }),
    });
    await Promise.all([gate.ready, review.ready]);
    const docks = pane.querySelectorAll('.doc-floats');
    expect(docks).toHaveLength(1);
    const row = Array.from(docks[0]!.children).map((c) => c.className.split(' ')[0]);
    expect(row).toEqual(['plan-float', 'plan-float']);
    expect(docks[0]!.children[0]!.classList.contains('review-float')).toBe(false);
    expect(docks[0]!.children[1]!.classList.contains('review-float')).toBe(true);
    expect(gate.face()).toBe('make');
    expect(review.face()).toBe('ask');
    gate.destroy();
    review.destroy();
    // Both gone; the dock is a row with nothing in it, not a second row.
    expect(pane.querySelectorAll('.plan-float')).toHaveLength(0);
  });
  describe('the receipt says when nobody is listening', () => {
    // Bryan pressed Review on prod with the agent offline: "Review requested
    // and no agent answered". The float read "waiting for your agent" as if
    // one were coming. The receipt now takes the lead banner's own answer
    // and says so — an unanswered ask that explains itself.
    const REQUESTED: DocAnswer = {
      meta: {
        huddle: true,
        reviewRequestedAt: 1e12,
        reviewRequestedBy: 'Sam',
        reviewThreadId: 't',
      },
      leadAgentId: 'Workspaces',
    };

    it('reads "no lead agent attached" while the seat is empty, and flips back live', async () => {
      const feed = stubPresence();
      const float = mountReviewFloat({
        docId: 'd-h',
        root,
        user: JORDAN,
        canWrite: true,
        fetchJson: stubFetch([REQUESTED]).fetchJson,
        threadOpen: () => true,
        watchLeadPresence: feed.watch,
      });
      await float.ready;
      expect(float.face()).toBe('requested');
      expect(sub()).toBe('Asked by Sam — waiting for Workspaces');
      feed.push(PRESENCE(false));
      expect(sub()).toBe(
        'Asked by Sam — no lead agent attached, it will be answered when one attaches',
      );
      feed.push(PRESENCE(true));
      expect(sub()).toBe('Asked by Sam — waiting for Workspaces');
      float.destroy();
      expect(feed.stopped()).toBe(1);
    });

    it('a presence that arrives BEFORE the doc loads is applied on load', async () => {
      const feed = stubPresence();
      let resolve: (v: unknown) => void = () => {};
      const float = mountReviewFloat({
        docId: 'd-h',
        root,
        user: JORDAN,
        canWrite: true,
        fetchJson: () => new Promise((r) => (resolve = r)),
        threadOpen: () => true,
        watchLeadPresence: feed.watch,
      });
      feed.push(PRESENCE(false));
      resolve(REQUESTED);
      await float.ready;
      expect(sub()).toContain('no lead agent attached');
      float.destroy();
    });

    it('with nobody named as the asker the line still starts as a sentence', async () => {
      const feed = stubPresence();
      const float = mountReviewFloat({
        docId: 'd-h',
        root,
        user: JORDAN,
        canWrite: true,
        fetchJson: stubFetch([{ meta: { huddle: true, reviewRequestedAt: 1e12 } }]).fetchJson,
        watchLeadPresence: feed.watch,
      });
      await float.ready;
      feed.push(PRESENCE(false));
      expect(sub()).toBe('No lead agent attached, it will be answered when one attaches');
      float.destroy();
    });

    it('the offer face is untouched — only the receipt explains a wait', async () => {
      const feed = stubPresence();
      const float = mountReviewFloat({
        docId: 'd-h',
        root,
        user: JORDAN,
        canWrite: true,
        fetchJson: stubFetch([{ ...HUDDLE, leadAgentId: 'Workspaces' }]).fetchJson,
        watchLeadPresence: feed.watch,
      });
      await float.ready;
      feed.push(PRESENCE(false));
      expect(float.face()).toBe('ask');
      expect(sub()).toBe('Ask Workspaces to review the notes');
      float.destroy();
    });
  });
});
