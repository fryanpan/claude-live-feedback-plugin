import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { mountDocSetNav } from '../src/doc/doc-set-nav.ts';
import { MountScope } from '../src/mount-scope.ts';
import { resetSidebarSignature } from '../src/sidebar-nav-key.ts';

/**
 * The set navigation a document carries (doc/doc-set-nav.ts): the sidebar
 * list and the topbar dropdown for its siblings.
 *
 * The column is committed from the LIST, never from the metadata — a doc that
 * names a set is not a doc whose set has anything in it, and a labelled empty
 * panel is width taken from the prose for nothing. Both halves are driven
 * here, plus the teardown of the ~30s workspace heartbeat.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  resetSidebarSignature();
});

beforeEach(() => {
  document.body.innerHTML = `
    <aside id="set-pane"><ol id="set-pane-list"></ol></aside>
    <button id="doc-switcher"></button>
    <div id="doc-menu" class="hidden"></div>`;
});

const list = () => document.getElementById('set-pane-list') as HTMLElement;
const menu = () => document.getElementById('doc-menu') as HTMLElement;

function mount(meta: Record<string, string> = {}, docId = 'd1') {
  const ydoc = new Y.Doc();
  for (const [k, v] of Object.entries(meta)) ydoc.getMap('meta').set(k, v);
  const scope = new MountScope();
  const nav = mountDocSetNav({ docId, navDocId: docId, ydoc, scope });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, nav };
}

/** A stub `/api/docs` answer, and the URLs it was asked for. */
function stubDocs(docs: unknown[]) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      // The workspace renderers ask for the review's grouped model and its
      // file list; empty ones are enough to make them draw nothing and return.
      const u = String(url);
      const body = u.includes('/grouped')
        ? { groups: [] }
        : u.includes('/files')
          ? { files: [] }
          : { docs };
      return { ok: true, json: async () => body } as Response;
    }),
  );
  return calls;
}

describe('a document that belongs to no set', () => {
  it('gives the column back instead of showing an empty panel', async () => {
    document.body.classList.add('has-set');
    list().innerHTML = '<li>left over from the last document</li>';
    const { nav } = mount();
    await nav.render();
    expect(document.body.classList.contains('has-set')).toBe(false);
    expect(list().innerHTML).toBe('');
    expect(menu().innerHTML).toBe('');
  });
});

describe('a legacy hand-grouped set', () => {
  it('lists the markdown siblings in both the sidebar and the dropdown', async () => {
    const calls = stubDocs([
      { docId: 'd1', setId: 's1', type: 'markdown', title: 'Alpha' },
      { docId: 'd2', setId: 's1', type: 'markdown', title: 'Beta' },
      // Not markdown, and not this set: neither belongs in the list.
      { docId: 'd3', setId: 's1', type: 'code', title: 'Gamma' },
      { docId: 'd4', setId: 's2', type: 'markdown', title: 'Delta' },
    ]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();

    expect(calls).toEqual(['/api/docs?setId=s1']);
    const labels = [...list().querySelectorAll('a')].map((a) => a.textContent);
    expect(labels).toEqual(['Alpha', 'Beta']);
    expect(menu().querySelectorAll('a')).toHaveLength(2);
    expect(document.body.classList.contains('has-set')).toBe(true);
    // The doc being read is marked as the current page, for a screen reader
    // as much as for the eye.
    const active = list().querySelector('a.active') as HTMLAnchorElement;
    expect(active.textContent).toBe('Alpha');
    expect(active.getAttribute('aria-current')).toBe('page');
  });

  it('takes the column back when the set turns out to hold nothing listable', async () => {
    document.body.classList.add('has-set');
    stubDocs([{ docId: 'd9', setId: 's1', type: 'code', title: 'Only code' }]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();
    expect(document.body.classList.contains('has-set')).toBe(false);
    expect(list().innerHTML).toBe('');
  });

  it('escapes a title rather than letting it write markup into the sidebar', async () => {
    stubDocs([{ docId: 'd1', setId: 's1', type: 'markdown', title: '<img src=x>Alpha' }]);
    const { nav } = mount({ setId: 's1' });
    await nav.render();
    expect(list().querySelectorAll('img')).toHaveLength(0);
    expect(list().querySelector('a')?.textContent).toBe('<img src=x>Alpha');
  });

  it('leaves the sidebar alone when the mount was torn down mid-fetch', async () => {
    stubDocs([{ docId: 'd1', setId: 's1', type: 'markdown', title: 'Alpha' }]);
    const { nav, scope } = mount({ setId: 's1' });
    const pending = nav.render();
    scope.dispose();
    await pending;
    expect(list().innerHTML).toBe('');
  });
});

describe('the workspace heartbeat', () => {
  it('refreshes the tree on focus and on its timer, and stops on teardown', async () => {
    vi.useFakeTimers();
    const calls = stubDocs([]);
    const { scope } = mount({ workspaceId: 'w-1' });
    // Mounting alone asks for nothing: the first paint is the navigation's.
    expect(calls).toHaveLength(0);

    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    const afterFocus = calls.length;
    expect(afterFocus).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThan(afterFocus);

    const beforeDispose = calls.length;
    scope.dispose();
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(beforeDispose);
  });
});
