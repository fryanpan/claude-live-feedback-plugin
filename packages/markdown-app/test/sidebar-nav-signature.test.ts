import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiffNav } from '../src/diff-nav.ts';
import { resetSidebarSignature } from '../src/sidebar-nav-key.ts';
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
});
