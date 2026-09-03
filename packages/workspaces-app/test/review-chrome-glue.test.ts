import { type ReviewPayload, createThread, setCommentReview } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * The chrome↔server glue for answering in the doc — the seam whose ABSENCE
 * caused the original bug (every doc reply went to /comments while items sat
 * queued). The panel handing back answersCommentId/optionId is tested in
 * thread-answer.test.ts and the routes in the server suite, but nothing
 * exercised mountReviewChrome's own handlers: choosing `/answer` vs
 * `/comments`, forwarding commentId/optionId in the body, the failure toast,
 * the `/answer/undo` POST, and the deliberate swallow of the 'not-answered'
 * race. A regression in any of those passed every prior test.
 *
 * All fixtures synthetic.
 */

const bob = { id: 'u2', name: 'Bob', kind: 'known' as const, color: '#c0392b' };

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <aside id="set-pane"></aside>
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
            <button class="tab" data-tab="resolved">Resolved</button>
          </div>
          <ol id="threads-list"></ol>
        </aside>
      </main>
      <button id="toggle-threads">☰</button>
      <span id="threads-count"></span>
      <button id="close-threads">×</button>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <div id="composer" class="hidden">
        <div id="composer-avatar"></div>
        <div id="composer-quote"></div>
        <textarea id="composer-text"></textarea>
        <button id="composer-submit">Post</button>
      </div>
      <div id="composer-scrim" class="hidden"></div>
      <div id="thread-view" class="hidden">
        <button id="thread-view-close">×</button>
        <div id="thread-view-body"></div>
        <textarea id="thread-view-reply-text"></textarea>
        <button id="thread-view-reply-submit">Reply</button>
      </div>
      <div id="toast" class="hidden"></div>
    </div>`;
}

function fakeSurface(): ReviewSurface {
  return {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    destroy: () => {},
  };
}

function opts(extra?: Partial<ChromeOpts>): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope: new MountScope(),
    ...extra,
  };
}

const ask = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Read the stall rota',
  ...over,
});

interface Recorded {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Stub fetch, mount a doc with one thread, and hand back the recorded posts. */
function harness(review?: ReviewPayload) {
  const posts: Recorded[] = [];
  let status = 200;
  let responseBody = '{}';
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return Promise.resolve(new Response(responseBody, { status }));
  });
  mountChromeDom();
  const ydoc = new Y.Doc();
  createThread(ydoc, {
    threadId: 't1',
    anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: 'the anchor' } },
    createdBy: bob,
    firstComment: { id: 'c1', text: 'Please look.', ...(review ? { review } : {}) },
  });
  const chrome = mountReviewChrome(opts({ ydoc }));
  chrome.redrawThreads();
  return {
    posts,
    ydoc,
    setStatus: (s: number, body = '{}') => {
      status = s;
      responseBody = body;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function send(words: string): HTMLTextAreaElement {
  const ta = document.querySelector<HTMLTextAreaElement>('#threads-list .thread-reply textarea');
  if (!ta) throw new Error('no reply box rendered');
  ta.value = words;
  const button = document.querySelector<HTMLElement>('#threads-list .thread-actions button');
  if (!button) throw new Error('no primary control rendered');
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return ta;
}

const toast = () => document.getElementById('toast') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mountReviewChrome onReply — the /answer vs /comments fork', () => {
  it('routes a pending item’s reply to /answer with the declaring commentId', async () => {
    const { posts } = harness(ask());
    send('Alphabetical, please.');
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('/api/docs/d1/threads/t1/answer');
    expect(posts[0]?.body).toMatchObject({ text: 'Alphabetical, please.', commentId: 'c1' });
    expect(posts[0]?.body).not.toHaveProperty('optionId');
    // Landed: no failure toast.
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('routes an ordinary thread’s reply to /comments, with no commentId', async () => {
    const { posts } = harness();
    send('Agreed, rewriting it.');
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('/api/docs/d1/threads/t1/comments');
    expect(posts[0]?.body).toMatchObject({ text: 'Agreed, rewriting it.' });
    expect(posts[0]?.body).not.toHaveProperty('commentId');
  });

  it('a tapped option forwards its optionId as provenance', async () => {
    const { posts } = harness(
      ask({
        shape: 'decision',
        options: [
          { id: 'o1', label: 'Alphabetical' },
          { id: 'o2', label: 'By arrival' },
        ],
      }),
    );
    const option = document.querySelector<HTMLButtonElement>('#threads-list .thread-item-option');
    if (!option) throw new Error('no option button rendered');
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('/api/docs/d1/threads/t1/answer');
    expect(posts[0]?.body).toMatchObject({
      text: 'Alphabetical',
      commentId: 'c1',
      optionId: 'o1',
    });
  });

  it('a refused answer toasts AND the panel gets the words back', async () => {
    const { setStatus } = harness(ask());
    setStatus(500);
    const ta = send('Alphabetical, please.');
    await flush();
    expect(toast().textContent).toBe('Answer failed to post — try again');
    expect(toast().classList.contains('hidden')).toBe(false);
    // The chrome returned false, so the panel restored the words — the toast
    // must never point at an empty box.
    expect(ta.value).toBe('Alphabetical, please.');
  });
});

describe('mountReviewChrome onUndoAnswer — /answer/undo and the race swallow', () => {
  const settled = () =>
    ask({ answeredAt: 1_700_000_000_000, answeredBy: 'U', answerText: 'Alphabetical.' });

  function clickUndo(): void {
    const undo = document.querySelector<HTMLButtonElement>('#threads-list .thread-answer-undo');
    if (!undo) throw new Error('no Undo rendered on the answered record');
    undo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('POSTs the declaring comment to /answer/undo', async () => {
    const { posts } = harness(settled());
    clickUndo();
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe('/api/docs/d1/threads/t1/answer/undo');
    expect(posts[0]?.body).toMatchObject({ commentId: 'c1' });
  });

  it("swallows the 'not-answered' race — the live repaint already shows it", async () => {
    const { setStatus } = harness(settled());
    setStatus(409, '{"error":"not-answered"}');
    clickUndo();
    await flush();
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('toasts every OTHER undo failure', async () => {
    const { setStatus } = harness(settled());
    setStatus(500, '{"error":"boom"}');
    clickUndo();
    await flush();
    expect(toast().textContent).toBe('Undo failed — try again');
    expect(toast().classList.contains('hidden')).toBe(false);
  });

  /**
   * The undo has to LAND on the doc surface, not just on the wire.
   *
   * `onUndoAnswer` deliberately keeps no client state — the comment on it
   * says "the doc's own websocket repaint is what re-renders the thread as
   * pending again". That was true of the fetch and false of the render: an
   * undo un-stamps the declaration and touches nothing else, so the panel's
   * memo key (id, status, commentCount, lastActivity, summary) came out
   * IDENTICAL either side of it and `render()` short-circuited. Home
   * repainted (it refetches), the doc kept saying "Answered by you: …" until
   * a reload — the one surface where the reader had just pressed the button.
   */
  it('repaints the card as pending when the undo lands over the socket', () => {
    const { ydoc } = harness(settled());
    expect(document.querySelector('#threads-list .thread-answered')).not.toBeNull();
    // What the server writes on /answer/undo: the four stamps move into
    // answerHistory and the payload is unanswered again.
    setCommentReview(ydoc, 't1', 'c1', {
      ...ask(),
      answerHistory: [
        {
          answeredAt: 1_700_000_000_000,
          answeredBy: 'U',
          answerText: 'Alphabetical.',
          undoneAt: 1_700_000_001_000,
          undoneBy: 'U',
        },
      ],
    });
    expect(document.querySelector('#threads-list .thread-answered')).toBeNull();
    const control = document.querySelector<HTMLElement>('#threads-list .thread-actions button');
    expect((control?.textContent ?? '').trim()).toBe('Answer');
  });
});
