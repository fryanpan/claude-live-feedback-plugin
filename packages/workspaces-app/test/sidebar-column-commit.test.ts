import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderDiffNav, resetDiffNavViewMemory } from '../src/diff-nav.ts';
import { commitSidebarColumn, resetSidebarSignature } from '../src/sidebar-nav-key.ts';
import { renderWorkspaceTree } from '../src/workspace-tree.ts';

/**
 * The sidebar column is committed when the list is known to have rows — never
 * when the doc merely names a set.
 *
 * Reported 2026-08-19 on an iPad over the tailnet: *"an empty 'In this review'
 * left panel that still takes up space but has nothing in it"*, then a minute
 * later *"in this review loaded in eventually"*. `has-set` went on the body
 * synchronously from doc meta and every failure mode of the fetch behind it
 * left the same artifact — a slow fetch flashed an empty column, a failed one
 * left it there for good, and a set whose members are all non-markdown
 * rendered it with zero rows. The panel was committed to before anything knew
 * it could be filled.
 *
 * The rule that replaces it, and the reason it needs no retract-on-failure
 * branch: commit on a known-non-empty list, retract on a known-EMPTY one, and
 * leave a failure alone. A first load that fails never committed, so nothing
 * shows; a refresh that fails keeps the rows already on screen instead of
 * collapsing the column under the reviewer.
 */

type Routes = Record<string, unknown>;

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

const treeWith = (files: string[]) => ({
  '/tree': {
    tree: {
      type: 'dir',
      name: '',
      openCount: 0,
      children: files.map((f) => ({
        type: 'file',
        docId: f,
        name: f,
        relPath: f,
        reviewUrl: `/review/${f}`,
      })),
    },
  },
});

const groupedWith = (files: string[]) => ({
  '/grouped': {
    groups: [
      {
        title: 'Group',
        openCount: 0,
        files: files.map((f) => ({
          docId: f,
          name: f,
          relPath: f,
          openCount: 0,
          reviewUrl: `/review/${f}`,
          diffStatus: 'modified' as const,
        })),
      },
    ],
  },
});

function dom(): HTMLElement {
  document.body.innerHTML =
    '<aside id="set-pane"><ol id="set-pane-list"></ol></aside><div id="doc-menu"></div>';
  return document.getElementById('set-pane-list') as HTMLElement;
}

const columnShown = () => document.body.classList.contains('has-set');
const paneHidden = () => document.getElementById('set-pane')?.getAttribute('aria-hidden');

beforeEach(() => {
  resetSidebarSignature();
  resetDiffNavViewMemory();
  localStorage.clear();
  document.body.className = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.className = '';
  resetSidebarSignature();
});

describe('commitSidebarColumn', () => {
  it('reserves the column and unhides the pane when there are rows', () => {
    dom();
    commitSidebarColumn(true);
    expect(columnShown()).toBe(true);
    expect(paneHidden()).toBe('false');
  });

  it('gives the width back when the list turns out empty', () => {
    dom();
    commitSidebarColumn(true);
    commitSidebarColumn(false);
    expect(columnShown()).toBe(false);
    expect(paneHidden()).toBe('true');
  });
});

describe('the workspace tree only reserves a column it can fill', () => {
  it('does not reserve the column while the fetch is still in flight', async () => {
    dom();
    // The reported symptom, stated directly: a slow link must not produce a
    // labelled empty column that "eventually" fills.
    let release: ((v: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = renderWorkspaceTree('a', 'W');
    await Promise.resolve();
    expect(columnShown()).toBe(false);

    release?.({ ok: true, json: async () => treeWith(['a'])['/tree'] });
    await pending;
    expect(columnShown()).toBe(true);
  });

  it('reserves it once the tree arrives with files in it', async () => {
    const list = dom();
    mockFetch(treeWith(['a.ts']));
    await renderWorkspaceTree('a.ts', 'W');
    expect(columnShown()).toBe(true);
    expect(list.querySelector('a[href="/review/a.ts"]')).not.toBeNull();
  });

  it('leaves it unreserved when the tree comes back empty', async () => {
    dom();
    mockFetch(treeWith([]));
    await renderWorkspaceTree('a', 'W');
    expect(columnShown()).toBe(false);
    expect(paneHidden()).toBe('true');
  });

  it('leaves it unreserved when the fetch fails outright', async () => {
    dom();
    mockFetch({}); // every path answers !ok
    await renderWorkspaceTree('a', 'W');
    expect(columnShown()).toBe(false);
  });

  it('keeps rows already on screen when a REFRESH fails', async () => {
    const list = dom();
    mockFetch(treeWith(['a.ts']));
    await renderWorkspaceTree('a.ts', 'W');
    expect(columnShown()).toBe(true);

    // A transient failure on the ~30s heartbeat must not collapse the column
    // out from under the reviewer — retracting is for a KNOWN-empty list.
    mockFetch({});
    await renderWorkspaceTree('a.ts', 'W', true);
    expect(columnShown()).toBe(true);
    expect(list.querySelector('a[href="/review/a.ts"]')).not.toBeNull();
  });
});

describe('the diff nav only reserves a column it can fill', () => {
  it('reserves it when the review has changed files', async () => {
    dom();
    mockFetch(groupedWith(['a.ts']));
    await renderDiffNav('a.ts', 'W');
    expect(columnShown()).toBe(true);
  });

  it('leaves it unreserved when the review has no navigable files', async () => {
    dom();
    // No grouped diff and no /files — `renderDiffNav` returns false here, and
    // app.ts falls through to the folder tree, which must not have been handed
    // a column already reserved on its behalf.
    mockFetch({ '/grouped': { groups: [] } });
    const ok = await renderDiffNav('a', 'W');
    expect(ok).toBe(false);
    expect(columnShown()).toBe(false);
  });
});
