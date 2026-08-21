import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getMeta } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { hubTabTitle } from '../src/hub/hub-model.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { SITE_NAME, tabName, tabTitle } from '../src/tab-title.ts';

/**
 * Every tab opened the same word first. A reader with a board, three review
 * docs and a diff open saw "Workspaces …" five times over and had to click to
 * find out which was which — a tab strip gives each title roughly twenty
 * characters, and all twenty were being spent on the half that never varies.
 *
 * So the specific name leads and the product name trails, on every surface
 * that has a name to lead with.
 */

describe('tabTitle', () => {
  it('puts the specific name first and the product name last', () => {
    expect(tabTitle('Launch plan')).toBe('Launch plan · Workspaces');
  });

  it('falls back to the product name alone when nothing is named yet', () => {
    expect(tabTitle()).toBe(SITE_NAME);
    expect(tabTitle('')).toBe(SITE_NAME);
    expect(tabTitle('   ')).toBe(SITE_NAME);
    expect(tabTitle(undefined, null)).toBe(SITE_NAME);
  });

  it('keeps the order it is given and drops the empty parts between', () => {
    expect(tabTitle('search-revamp', 'Home')).toBe('search-revamp · Home · Workspaces');
    // The empty middle must not leave a stray separator behind.
    expect(tabTitle('search-revamp', '')).toBe('search-revamp · Workspaces');
  });
});

describe('tabName', () => {
  it('keeps a plain title whole', () => {
    expect(tabName('Launch plan')).toBe('Launch plan');
  });

  it('keeps a repo-relative diff path whole', () => {
    // `src/a.ts` and `test/a.ts` are two files in one diff review; the
    // directory is what tells their tabs apart, so it stays.
    expect(tabName('src/a.ts')).toBe('src/a.ts');
  });

  it('drops the leading directories of an absolute path', () => {
    // A tab truncates from the right, so an absolute path would spend the
    // whole title on `/Volumes/Data/Users/…` and never reach the filename.
    expect(tabName('/Volumes/Data/repo/docs/notes.md')).toBe('notes.md');
  });

  it('drops the origin and directories of a URL', () => {
    expect(tabName('http://example.test/deep/path/notes.md')).toBe('notes.md');
  });

  it('answers empty for an unnamed doc, so the caller falls back', () => {
    expect(tabName('')).toBe('');
  });
});

describe('hubTabTitle', () => {
  it('leads with the workspace name on the board', () => {
    expect(hubTabTitle('search-revamp', 'tasks')).toBe('search-revamp · Workspaces');
  });

  it('names the pane after the workspace, so SPA nav is visible in the tab', () => {
    expect(hubTabTitle('search-revamp', 'home')).toBe('search-revamp · Home · Workspaces');
    expect(hubTabTitle('search-revamp', 'mine')).toBe('search-revamp · My Tasks · Workspaces');
    expect(hubTabTitle('search-revamp', 'activity')).toBe('search-revamp · Activity · Workspaces');
  });

  it('falls back to the product name when the workspace has no name yet', () => {
    expect(hubTabTitle('', 'tasks')).toBe(SITE_NAME);
  });
});

/** The pre-JS shell. It is what shows while the bundle loads, and it is the
 *  fallback for a doc whose name has not arrived — so it carries the product
 *  name alone rather than a second, competing word order. */
describe('the review app shell', () => {
  it('titles itself with the product name alone', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
    expect(html).toContain('<title>Workspaces</title>');
  });
});

// --- the review surfaces (markdown / code / diff / redline) ------------------
//
// All three boots mount the same chrome, and the chrome is the one place that
// resolves a doc's label — so it is also the one place that names the tab.

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <aside id="set-pane"></aside>
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

function chromeOpts(extra?: Partial<ChromeOpts>): ChromeOpts {
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

/** Mount the chrome and let it name itself, the way every surface does:
 *  `renderDocLabel` is what resolves a doc's label, and each boot calls it once
 *  the doc has synced and again whenever the meta changes. */
function nameTab(extra?: Partial<ChromeOpts>): void {
  mountChromeDom();
  mountReviewChrome(chromeOpts(extra)).renderDocLabel();
}

describe('a review doc names its own tab', () => {
  it('leads with the doc title', () => {
    const ydoc = new Y.Doc();
    getMeta(ydoc).set('title', 'Launch plan');
    nameTab({ ydoc });
    expect(document.title).toBe('Launch plan · Workspaces');
  });

  it('leads with the file name for a file-backed doc, not its full path', () => {
    const ydoc = new Y.Doc();
    getMeta(ydoc).set('type', 'markdown');
    nameTab({ ydoc, labelHint: '/Volumes/Data/repo/docs/notes.md' });
    expect(document.title).toBe('notes.md · Workspaces');
  });

  it('leads with the repo-relative path for a diff doc', () => {
    const ydoc = new Y.Doc();
    getMeta(ydoc).set('type', 'diff');
    getMeta(ydoc).set('relPath', 'packages/server/src/server.ts');
    nameTab({ ydoc, labelHint: '/Volumes/Data/repo/packages/server/src/server.ts' });
    expect(document.title).toBe('packages/server/src/server.ts · Workspaces');
  });

  it('re-titles the tab when the router swaps in another doc', () => {
    // The regression this guards: a title set once at boot leaves every
    // in-place navigation — the sidebar, the doc switcher, back/forward —
    // showing the doc the reader arrived on. The chrome remounts per
    // navigation, so the second mount must win.
    const first = new Y.Doc();
    getMeta(first).set('title', 'Launch plan');
    nameTab({ ydoc: first });
    expect(document.title).toBe('Launch plan · Workspaces');

    const second = new Y.Doc();
    getMeta(second).set('title', 'Stall rota');
    nameTab({ ydoc: second, docId: 'd2' });
    expect(document.title).toBe('Stall rota · Workspaces');
  });

  it('shows the product name alone until the doc has any name at all', () => {
    document.title = 'stale';
    nameTab({ ydoc: new Y.Doc() });
    expect(document.title).toBe(SITE_NAME);
  });
});
