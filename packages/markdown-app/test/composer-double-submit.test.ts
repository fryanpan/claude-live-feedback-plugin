import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * A double submit on the doc's new-comment composer must yield ONE thread,
 * not two. Measured: a double submit created two thread ids ~340ms apart,
 * identical text, identical anchor — a tap plus a keyboard Enter (or two
 * Enters before the first request lands) both firing `submitComposer`,
 * which had no in-flight guard.
 */

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
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
        <div id="composer-quote" class="composer-quote"></div>
        <div class="composer-inner">
          <div id="composer-avatar" class="composer-avatar"></div>
          <textarea id="composer-text" placeholder="Add a comment…" rows="1"></textarea>
          <button id="composer-submit" class="submit-arrow">↑</button>
        </div>
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

const selection = () => ({
  start: new Uint8Array([1]),
  end: new Uint8Array([2]),
  snippet: 'the anchored words',
});

function opts(extra?: Partial<ChromeOpts>): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => selection(),
    scope: new MountScope(),
    ...extra,
  };
}

interface Recorded {
  url: string;
  body: Record<string, unknown> | undefined;
}

/** Stub fetch with a controllable resolve — lets a test hold the first POST
 *  open while a second submit attempt fires, the way a slow network does. */
function harness() {
  const posts: Recorded[] = [];
  const resolvers: Array<(r: Response) => void> = [];
  vi.stubGlobal('fetch', (url: unknown, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    return new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    });
  });
  mountChromeDom();
  const chrome = mountReviewChrome(opts());
  return {
    posts,
    chrome,
    resolveNext: (threadId: string) => {
      const resolve = resolvers.shift();
      if (!resolve) throw new Error('no pending fetch to resolve');
      resolve(new Response(JSON.stringify({ thread: { id: threadId } }), { status: 200 }));
    },
  };
}

const composerText = () => document.getElementById('composer-text') as HTMLTextAreaElement;
const composerSubmit = () => document.getElementById('composer-submit') as HTMLButtonElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

function pressEnter(ta: HTMLTextAreaElement): void {
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the doc composer refuses a double submit', () => {
  it('two Enters before the first request lands post exactly once', async () => {
    const { posts, chrome } = harness();
    chrome.openComposer();
    composerText().value = 'Please look at this.';
    pressEnter(composerText());
    // A second Enter arrives while the first POST is still in flight — no
    // setTimeout needed, the mocked fetch never resolves on its own.
    pressEnter(composerText());
    await flush();
    expect(posts).toHaveLength(1);
  });

  it('a click while a keyboard Enter is in flight also posts once', async () => {
    const { posts, chrome } = harness();
    chrome.openComposer();
    composerText().value = 'Please look at this.';
    pressEnter(composerText());
    composerSubmit().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(posts).toHaveLength(1);
  });

  it('positive control: two genuinely distinct comments both post', async () => {
    const { posts, chrome, resolveNext } = harness();
    chrome.openComposer();
    composerText().value = 'First comment.';
    pressEnter(composerText());
    resolveNext('t1');
    await flush();

    chrome.openComposer();
    composerText().value = 'Second, different comment.';
    pressEnter(composerText());
    resolveNext('t2');
    await flush();

    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toMatchObject({ text: 'First comment.' });
    expect(posts[1]?.body).toMatchObject({ text: 'Second, different comment.' });
  });
});
