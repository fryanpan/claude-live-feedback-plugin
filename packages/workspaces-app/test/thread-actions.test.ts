/**
 * The five server writes a comment card can make — driven directly, with the
 * network stubbed.
 *
 * The routing and the failure contract are the whole content of this module,
 * and both have shipped wrong before. Every doc reply once went to
 * `/comments`, so a review item could be read in the doc, answered in the
 * person's own words, and stay on the Home queue — four times on
 * `board-review-2026-08-19`. And a refused answer once cleared the textarea
 * before toasting "try again", so the words the reader had typed were gone by
 * the time they were told to try again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadActions } from '../src/doc/thread-actions.ts';
import type { ChromeSelection } from '../src/review-chrome.ts';

const USER = { id: 'u1', name: 'Ann', kind: 'known', color: '#2e7dd7' } as const;

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Stub `fetch` and record what went out. `reply` decides each call's answer. */
function stubFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return Promise.resolve(reply(url));
  });
  return calls;
}

const ok = () => new Response('{}', { status: 200 });
const boom = () => new Response('{}', { status: 500 });

/** The words the toast is currently showing, or null when none is up. */
function toast(): string | null {
  const t = document.getElementById('toast');
  return t && !t.classList.contains('hidden') ? t.textContent : null;
}

const SELECTION: ChromeSelection = {
  start: new Uint8Array([1]),
  end: new Uint8Array([4]),
  snippet: 'the words pointed at',
};

function actions(getSelection: () => ChromeSelection | null = () => SELECTION) {
  return createThreadActions({
    docId: 'doc/one',
    user: USER,
    getSelection,
    reanchorHint: 'Select some text first',
  });
}

describe('the writes a comment card can make', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast" class="hidden"></div>';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('posts a plain reply to /comments and an answer to /answer', async () => {
    const calls = stubFetch(ok);
    const a = actions();

    await a.reply('t1', 'just talking');
    await a.reply('t1', 'Thursday works', 'c9', 'opt-2');

    expect(calls[0]?.url).toBe('/api/docs/doc%2Fone/threads/t1/comments');
    expect(calls[0]?.body).toEqual({ author: USER, text: 'just talking' });

    // The `/answer` route is what stamps `answeredAt` and takes the item off
    // the Home queue; the optionId is provenance for a TAPPED answer.
    expect(calls[1]?.url).toBe('/api/docs/doc%2Fone/threads/t1/answer');
    expect(calls[1]?.body).toEqual({
      author: USER,
      text: 'Thursday works',
      commentId: 'c9',
      optionId: 'opt-2',
    });
  });

  it('never sends an optionId without a declaring comment to answer', async () => {
    const calls = stubFetch(ok);
    await actions().reply('t1', 'typed', undefined, 'opt-2');
    expect(calls[0]?.body).not.toHaveProperty('optionId');
  });

  it('says a refused answer did not land, so the typed words can come back', async () => {
    stubFetch(boom);
    await expect(actions().reply('t1', 'Thursday works', 'c9')).resolves.toBe(false);
    expect(toast()).toBe('Answer failed to post — try again');
  });

  it('says the same when the network never answered at all', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(actions().reply('t1', 'Thursday works', 'c9')).resolves.toBe(false);
    expect(toast()).toBe('Answer failed to post — try again');
  });

  it('reports a refused plain reply, and only an ANSWER gets a toast', async () => {
    stubFetch(boom);
    // The asymmetry is deliberate and this pins it: a refused reply is
    // reported by the `false` alone, which is what puts the words back in the
    // box (thread-card.ts). Only an answer additionally toasts, because an
    // answer that did not land leaves an item on the Home queue and nothing
    // else on screen would say so.
    await expect(actions().reply('t1', 'just talking')).resolves.toBe(false);
    expect(toast()).toBeNull();
  });

  it('stays quiet when an undo loses to somebody else’s undo', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ error: 'not-answered' }), { status: 409 })),
    );
    await actions().undoAnswer('t1', 'c9');
    // The live repaint already shows the item back on the queue — "try again"
    // over an already-done undo reads as a broken button.
    expect(toast()).toBeNull();
  });

  it('tells the reader when an undo failed for any other reason', async () => {
    stubFetch(boom);
    await actions().undoAnswer('t1', 'c9');
    expect(toast()).toBe('Undo failed — try again');
  });

  it('resolves and reopens, and names the failure when the route refuses', async () => {
    const calls = stubFetch(ok);
    const a = actions();

    await a.resolve('t1');
    expect(calls[0]?.url).toBe('/api/docs/doc%2Fone/threads/t1/resolve');
    expect(toast()).toBe('✓ Resolved');

    await a.reopen('t1');
    expect(calls[1]?.url).toBe('/api/docs/doc%2Fone/threads/t1/reopen');
    expect(toast()).toBe('✓ Reopened');

    vi.unstubAllGlobals();
    stubFetch(boom);
    await a.resolve('t1');
    expect(toast()).toBe('Failed to resolve — try again');
    await a.reopen('t1');
    expect(toast()).toBe('Failed to reopen — try again');
  });

  it('re-anchors to the current selection, and asks for one when there is none', async () => {
    const calls = stubFetch(ok);

    await actions(() => null).reanchor('t1');
    expect(calls).toHaveLength(0);
    expect(toast()).toBe('Select some text first');

    await actions().reanchor('t1');
    expect(calls[0]?.url).toBe('/api/docs/doc%2Fone/threads/t1/reanchor');
    expect(calls[0]?.body).toEqual({
      anchor: {
        kind: 'text-range',
        startRel: [1],
        endRel: [4],
        snippet: { text: 'the words pointed at' },
      },
    });
    expect(toast()).toBe('✓ Re-anchored');
  });
});
