/**
 * A generated summary has to survive the markdown app's OWN thread reader.
 *
 * This surface does not use core's `readThread`: `collectThreads` in
 * review-chrome hand-builds each `Thread` so it can swap in an orphan anchor
 * for a range that no longer resolves. It is the sole source of threads for
 * the drawer, the margin balloons and the mobile cards — and it listed every
 * field except the new `summary` one, so the server could generate a summary,
 * write it into the ydoc, sync it to the browser, and the card would still
 * render its deterministic lines forever. The widget was unaffected (it goes
 * through `readThread`), which is what made it look like the feature worked.
 *
 * Same class as "the route layer silently drops params" in
 * docs/process/learnings.md: the loss is one layer away from the code that
 * consumes it, and every unit test of `threadLines` passes because they hand
 * it objects that already have the field.
 */

import { createThread, postReply, setThreadSummary, summaryHash } from '@feedback/core';
import type { Thread } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

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

const fakeSurface = (): ReviewSurface => ({
  getSelectionRel: () => null,
  resolveRel: () => null,
  scrollToPos: () => {},
  pulseRange: () => {},
  setThreadRanges: () => {},
  destroy: () => {},
});

function opts(ydoc: Y.Doc): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc,
    surface: fakeSurface(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope: new MountScope(),
  };
}

const ANCHOR_TEXT = 'catch (e) {}';
const OPENING = 'Why is this swallowed?';
const REPLY = 'Because the retry wrapper eats it — fix not started.';

/** A doc with one thread that has a reply, so the discussion line is live. */
function docWithThread(): Y.Doc {
  const ydoc = new Y.Doc();
  createThread(ydoc, {
    threadId: 't1',
    anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: ANCHOR_TEXT } },
    createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
    firstComment: { id: 'c1', text: OPENING },
  });
  postReply(ydoc, 't1', {
    id: 'c2',
    author: { id: 'u3', name: 'Ann', kind: 'known', color: '#2e7dd7' },
    text: REPLY,
  });
  return ydoc;
}

function lines(): { topic: string; discussion: string } {
  const card = document.querySelector('#threads-list .thread') as HTMLElement;
  expect(card).not.toBeNull(); // positive control: there IS a card
  return {
    topic: (card.querySelector('.thread-topic') as HTMLElement).textContent ?? '',
    discussion: (card.querySelector('.thread-discussion') as HTMLElement).textContent ?? '',
  };
}

describe('the markdown app renders a generated summary', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows the stored lines on the drawer card', () => {
    const ydoc = docWithThread();
    mountChromeDom();
    const chrome = mountReviewChrome(opts(ydoc));
    chrome.redrawThreads();

    // Baseline: the deterministic lines, so the values below are shown to be
    // a change rather than a coincidence.
    expect(lines()).toEqual({ topic: ANCHOR_TEXT, discussion: REPLY });

    const t = readThreadFromDoc(ydoc);
    setThreadSummary(ydoc, 't1', {
      topic: 'retry wrapper swallows the error',
      discussion: 'reproduced; fix not started',
      hash: summaryHash(t),
    });
    chrome.redrawThreads();

    expect(lines()).toEqual({
      topic: 'retry wrapper swallows the error',
      discussion: 'reproduced; fix not started',
    });
  });

  it('falls back to the deterministic lines when the summary has gone stale', () => {
    const ydoc = docWithThread();
    mountChromeDom();
    const chrome = mountReviewChrome(opts(ydoc));
    setThreadSummary(ydoc, 't1', {
      topic: 'a summary of an older thread',
      discussion: 'about a state that has passed',
      hash: 'not-the-current-hash',
    });
    chrome.redrawThreads();
    expect(lines()).toEqual({ topic: ANCHOR_TEXT, discussion: REPLY });
  });
});

/** The thread as core sees it — used only to compute the hash to store. */
function readThreadFromDoc(ydoc: Y.Doc): Thread {
  const map = ydoc.getMap('threads').get('t1') as Y.Map<unknown>;
  const comments = (map.get('comments') as Y.Array<Y.Map<unknown>>).map((c) => ({
    id: c.get('id') as string,
    author: c.get('author') as Thread['createdBy'],
    text: c.get('text') as string,
    ts: c.get('ts') as number,
  }));
  return {
    id: 't1',
    status: 'open',
    anchor: map.get('anchor') as Thread['anchor'],
    createdBy: map.get('createdBy') as Thread['createdBy'],
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? 0,
    comments,
  };
}
