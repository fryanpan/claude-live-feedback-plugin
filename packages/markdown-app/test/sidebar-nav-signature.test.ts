import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiffNav, resetDiffNavViewMemory } from '../src/diff-nav.ts';
import { beginSidebarRender, resetSidebarSignature } from '../src/sidebar-nav-key.ts';
import { renderWorkspaceTree } from '../src/workspace-tree.ts';

/**
 * Regression coverage for the SPA-nav sidebar findings (#4, #5, #7): the shared
 * signature governs when the sidebar rebuilds. Same signature → no rebuild
 * (scroll preserved, marker moves); a changed file set or a different renderer →
 * rebuild in place; the view toggle marks the CURRENT file, not a stale one.
 */

interface GFile {
  docId: string;
  name: string;
  relPath: string;
  openCount?: number;
  reviewUrl?: string;
  diffStatus?: 'added' | 'modified' | 'deleted' | 'renamed';
}
type Routes = Record<string, unknown>;

/** Mock fetch: match the request path against the longest registered key. */
function mockFetch(routes: Routes): void {
  vi.stubGlobal('fetch', (input: string) => {
    const url = String(input);
    const key = Object.keys(routes)
      .filter((k) => url.includes(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key == null) return Promise.resolve({ ok: false, json: async () => ({}) });
    return Promise.resolve({ ok: true, json: async () => routes[key] });
  });
}

function grouped(files: GFile[]): Routes {
  return {
    '/grouped': {
      groups: [{ title: 'Group', openCount: 0, files: files.map((f) => ({ openCount: 0, ...f })) }],
    },
  };
}

function dom(): { list: HTMLElement; menu: HTMLElement } {
  document.body.innerHTML =
    '<aside id="set-pane"><ol id="set-pane-list"></ol></aside><div id="doc-menu"></div>';
  return {
    list: document.getElementById('set-pane-list') as HTMLElement,
    menu: document.getElementById('doc-menu') as HTMLElement,
  };
}

beforeEach(() => {
  resetSidebarSignature();
  resetDiffNavViewMemory();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  resetSidebarSignature();
});

describe('sidebar shared render signature', () => {
  it('same workspace + same file list → no DOM rebuild (scroll preserved)', async () => {
    const { list } = dom();
    mockFetch(grouped([{ docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' }]));

    await renderDiffNav('a', 'W');
    const firstNode = list.querySelector('.diff-file a');
    expect(firstNode).not.toBeNull();

    // Navigate to a sibling in the SAME workspace with an unchanged file list.
    await renderDiffNav('a', 'W');
    // The original node survives — the list was not re-innerHTML'd.
    expect(list.contains(firstNode)).toBe(true);
  });

  it('a newly changed file (#7) changes the signature → rebuild in place', async () => {
    const { list } = dom();
    mockFetch(grouped([{ docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' }]));
    await renderDiffNav('a', 'W');
    const firstNode = list.querySelector('.diff-file a');

    // Agent edits add b.ts to the changed set; a plain nav must surface it.
    mockFetch(
      grouped([
        { docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' },
        { docId: 'b', name: 'b.ts', relPath: 'b.ts', reviewUrl: '/review/b' },
      ]),
    );
    await renderDiffNav('a', 'W');
    // Rebuilt: old node replaced, b.ts now present.
    expect(list.contains(firstNode)).toBe(false);
    expect(list.querySelector('a[href="/review/b"]')).not.toBeNull();
  });

  it('cross-renderer (#4): diff-nav after a folder tree rebuilds, not left stale', async () => {
    const { list } = dom();
    // Workspace T rendered as a folder tree.
    mockFetch({
      '/tree': {
        tree: {
          type: 'dir',
          name: '',
          openCount: 0,
          children: [
            { type: 'file', docId: 't', name: 't.ts', relPath: 't.ts', reviewUrl: '/review/t' },
          ],
        },
      },
    });
    await renderWorkspaceTree('t', 'T');
    expect(list.querySelector('a[href="/review/t"]')).not.toBeNull();

    // Back to a diff workspace W: must rebuild (different renderer + workspace),
    // not leave T's tree on screen because a per-renderer key still matched.
    mockFetch(grouped([{ docId: 'w', name: 'w.ts', relPath: 'w.ts', reviewUrl: '/review/w' }]));
    await renderDiffNav('w', 'W');
    expect(list.querySelector('a[href="/review/t"]')).toBeNull();
    expect(list.querySelector('a[href="/review/w"]')).not.toBeNull();
  });

  it('view toggle (#5) marks the CURRENT file after an in-place navigation', async () => {
    const { list } = dom();
    const files: GFile[] = [
      { docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' },
      { docId: 'b', name: 'b.ts', relPath: 'b.ts', reviewUrl: '/review/b' },
    ];
    mockFetch({
      ...grouped(files),
      '/files': {
        files: [
          {
            relPath: 'a.ts',
            changed: true,
            docId: 'a',
            reviewUrl: '/review/a',
            status: 'modified',
          },
          {
            relPath: 'b.ts',
            changed: true,
            docId: 'b',
            reviewUrl: '/review/b',
            status: 'modified',
          },
        ],
      },
    });

    // Open A, then SPA-navigate to B (setActiveFile is what the router calls,
    // and it also happens inside the same-signature fast path).
    await renderDiffNav('a', 'W');
    await renderDiffNav('b', 'W'); // same file list → fast path, marker moves to B

    // Now toggle to "Show All Files": the re-render must mark B (current), not A.
    const toggle = list.querySelector<HTMLButtonElement>('.diff-nav-toggle button[data-nav="all"]');
    expect(toggle).not.toBeNull();
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    const aAnchor = list.querySelector('a[href="/review/a"]');
    const bAnchor = list.querySelector('a[href="/review/b"]');
    expect(bAnchor?.classList.contains('active')).toBe(true);
    expect(aAnchor?.classList.contains('active')).toBe(false);
  });

  it('browse mode (#2): a file added to /files changes the signature → rebuild', async () => {
    const { list } = dom();
    // Browse workspace: no grouped diffs, tree comes from /files.
    const files = (paths: string[]) => ({
      '/grouped': { groups: [] },
      '/files': {
        files: paths.map((p) => ({
          relPath: p,
          changed: false,
          docId: p,
          reviewUrl: `/review/${p}`,
        })),
      },
    });
    mockFetch(files(['a.ts']));
    await renderDiffNav('a.ts', 'B');
    const firstNode = list.querySelector('.tree-file a');
    expect(firstNode).not.toBeNull();

    // Unchanged /files → fast path, no rebuild (browse signature is now derived
    // from /files, not the empty grouped model).
    await renderDiffNav('a.ts', 'B');
    expect(list.contains(firstNode)).toBe(true);

    // A new file appears in the folder → signature changes → rebuild in place.
    mockFetch(files(['a.ts', 'b.ts']));
    await renderDiffNav('a.ts', 'B');
    expect(list.contains(firstNode)).toBe(false);
    expect(list.querySelector('a[href="/review/b.ts"]')).not.toBeNull();
  });

  it('view toggle (#2) still works after nav though its wiring mount is disposed', async () => {
    const { list } = dom();
    const files: GFile[] = [
      { docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' },
      { docId: 'b', name: 'b.ts', relPath: 'b.ts', reviewUrl: '/review/b' },
    ];
    mockFetch({
      ...grouped(files),
      '/files': {
        files: [
          {
            relPath: 'a.ts',
            changed: true,
            docId: 'a',
            reviewUrl: '/review/a',
            status: 'modified',
          },
          {
            relPath: 'b.ts',
            changed: true,
            docId: 'b',
            reviewUrl: '/review/b',
            status: 'modified',
          },
        ],
      },
    });
    const scopeA = { disposed: false };
    const scopeB = { disposed: false };
    // Mount A fully renders and wires the toggle buttons (closing over scopeA).
    await renderDiffNav('a', 'W', false, scopeA);
    // Navigate to B: same file list → fast path, buttons are NOT re-wired, so
    // they still reference scopeA's render closure.
    await renderDiffNav('b', 'W', false, scopeB);
    // A's mount is now torn down.
    scopeA.disposed = true;

    const toggle = list.querySelector<HTMLButtonElement>('.diff-nav-toggle button[data-nav="all"]');
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    // The toggle still switched to the all-files tree — not silently dead.
    expect(list.querySelector('.tree-root')).not.toBeNull();
    expect(list.querySelector('.diff-group')).toBeNull();
  });

  it('view choice (round-4) survives a heartbeat when localStorage throws', async () => {
    const { list } = dom();
    // Safari private mode: setItem throws, getItem returns null.
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    const files: GFile[] = [{ docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' }];
    mockFetch({
      ...grouped(files),
      '/files': {
        files: [
          {
            relPath: 'a.ts',
            changed: true,
            docId: 'a',
            reviewUrl: '/review/a',
            status: 'modified',
          },
        ],
      },
    });
    // Unique workspace id so the module-level in-memory mirror can't be
    // contaminated by another test's toggle.
    await renderDiffNav('a', 'WP'); // default grouped (localStorage empty)
    expect(list.querySelector('.diff-group')).not.toBeNull();

    // Toggle to all-files: the write can't persist (throws) but the in-memory
    // mirror records the choice.
    const toggle = list.querySelector<HTMLButtonElement>('.diff-nav-toggle button[data-nav="all"]');
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(list.querySelector('.tree-root')).not.toBeNull();

    // A heartbeat force-refresh re-reads the view. Without the in-memory mirror
    // it would fall back to grouped (localStorage empty), dropping the toggle;
    // with it, the all-files view persists.
    await renderDiffNav('a', 'WP', true);
    expect(list.querySelector('.tree-root')).not.toBeNull();
    expect(list.querySelector('.diff-group')).toBeNull();
  });

  it('epoch (round-3): a toggle superseded mid-fetch does not clobber the new sidebar', async () => {
    const { list } = dom();
    const files: GFile[] = [
      { docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' },
      { docId: 'b', name: 'b.ts', relPath: 'b.ts', reviewUrl: '/review/b' },
    ];
    mockFetch({
      ...grouped(files),
      '/files': {
        files: [
          {
            relPath: 'a.ts',
            changed: true,
            docId: 'a',
            reviewUrl: '/review/a',
            status: 'modified',
          },
        ],
      },
    });
    await renderDiffNav('a', 'W'); // grouped view; toggle buttons wired
    const groupedNode = list.querySelector('.diff-group');
    expect(groupedNode).not.toBeNull();

    // Click "Show All Files": render('all') claims a token, then awaits
    // fetchFiles. Before it resolves, a NEWER render claims the sidebar
    // (simulating a navigation to a different doc landing during the fetch).
    const toggle = list.querySelector<HTMLButtonElement>('.diff-nav-toggle button[data-nav="all"]');
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    beginSidebarRender(); // supersede the in-flight toggle
    await new Promise((r) => setTimeout(r, 0));

    // The stale toggle bailed: it did NOT overwrite the sidebar with the
    // all-files tree; the grouped list is still on screen.
    expect(list.querySelector('.tree-root')).toBeNull();
    expect(list.contains(groupedNode)).toBe(true);
  });

  it('disposed guard (#3/#4): a superseded render does not move the marker', async () => {
    const { list } = dom();
    mockFetch(
      grouped([
        { docId: 'a', name: 'a.ts', relPath: 'a.ts', reviewUrl: '/review/a' },
        { docId: 'b', name: 'b.ts', relPath: 'b.ts', reviewUrl: '/review/b' },
      ]),
    );
    // Establish the sidebar with B active (the current document).
    await renderDiffNav('b', 'W');
    expect(list.querySelector('a[href="/review/b"]')?.classList.contains('active')).toBe(true);

    // A stale render for A whose navigation was superseded (scope disposed
    // during its fetch) must NOT re-mark A active over the live B.
    await renderDiffNav('a', 'W', false, { disposed: true });
    expect(list.querySelector('a[href="/review/a"]')?.classList.contains('active')).toBe(false);
    expect(list.querySelector('a[href="/review/b"]')?.classList.contains('active')).toBe(true);
  });
});
