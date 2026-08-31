import type { FeedbackClient } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocMeta, MountContext } from '../src/mount-context.ts';
import { startRouter } from '../src/router.ts';

// A stub client — the router registers close() on the scope; nothing here
// touches a real socket.
function stubClient(): FeedbackClient {
  return {
    close: () => {},
    ydoc: {},
    awareness: {},
    onReady: () => {},
    onStatus: () => {},
    ws: {},
    status: 'connecting',
  } as unknown as FeedbackClient;
}

const meta: DocMeta = {
  docType: 'diff',
  sourceUrl: '',
  workspaceId: 'w',
  relPath: 'b.md',
  diffTarget: '',
};

function sidebar(html: string): void {
  document.body.innerHTML = `<aside id="set-pane"><ol id="set-pane-list">${html}</ol></aside>`;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = '';
});
beforeEach(() => {
  history.replaceState(null, '', '/review/a');
});

describe('router', () => {
  /**
   * The session answer reaches every mount as a VALUE.
   *
   * `main()` awaits `/api/auth/session` before starting the router, and the
   * surfaces used to throw that away and re-ask for themselves — which left
   * each one editable for the length of its own round trip. The answer riding
   * on the MountContext, exactly like `user`, is what closes that: a mount
   * cannot be constructed without it, and by the time one runs the question
   * has already been answered.
   */
  it('hands the awaited session answer to every mount, including one reached by navigating', async () => {
    sidebar('<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>');
    const seen: Array<{ docId: string; canWrite: boolean }> = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: false,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: (ctx: MountContext) => {
        seen.push({ docId: ctx.docId, canWrite: ctx.canWrite });
      },
    });
    await flush();
    document
      .querySelector('a[href="/review/b"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();

    expect(seen).toEqual([
      { docId: 'a', canWrite: false },
      { docId: 'b', canWrite: false },
    ]);
  });

  it('carries a yes the same way', async () => {
    sidebar('<li><a href="/review/a">a</a></li>');
    const seen: boolean[] = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: (ctx: MountContext) => void seen.push(ctx.canWrite),
    });
    await flush();
    expect(seen).toEqual([true]);
  });

  it('intercepts a sidebar file click, pushes state, and swaps without reload', async () => {
    sidebar('<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>');
    const mounted: string[] = [];
    const disposed: string[] = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: (ctx: MountContext) => {
        mounted.push(ctx.docId);
        ctx.scope.onCleanup(() => disposed.push(ctx.docId));
      },
    });
    await flush();
    expect(mounted).toEqual(['a']);

    document
      .querySelector('a[href="/review/b"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(location.pathname).toBe('/review/b');
    expect(mounted).toEqual(['a', 'b']);
    expect(disposed).toContain('a'); // old mount torn down
  });

  it('lets a ⌘-click through to the browser (open in new tab)', async () => {
    sidebar('<li><a href="/review/b">b</a></li>');
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: () => {},
    });
    await flush();
    const a = document.querySelector('a[href="/review/b"]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    a.dispatchEvent(ev);
    // The router must NOT intercept a modified click — the browser handles it
    // (opens a new tab). We can only assert non-interception here; happy-dom's
    // default anchor action still mutates location, unlike a real new-tab open.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('swaps for an absolute cross-origin sidebar href (pushes same-origin path)', async () => {
    // Sidebar reviewUrls can be absolute + a different host than the browsing
    // origin; navigateTo must push only the path so pushState doesn't reject it.
    sidebar('<li><a href="http://other-host:8796/review/x?u=1">x</a></li>');
    const mounted: string[] = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: (ctx) => void mounted.push(ctx.docId),
    });
    await flush();
    document
      .querySelector('a[href^="http://other-host"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    expect(mounted).toContain('x');
    expect(location.pathname).toBe('/review/x');
  });

  it('handles popstate (back button) by swapping to the URL docId', async () => {
    sidebar('<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>');
    const mounted: string[] = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      fetchMeta: async () => meta,
      connectFor: () => stubClient(),
      mountFor: (ctx) => void mounted.push(ctx.docId),
    });
    await flush();
    // Navigate a → b, then simulate Back to a.
    document
      .querySelector('a[href="/review/b"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    history.replaceState(null, '', '/review/a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await flush();
    expect(mounted).toEqual(['a', 'b', 'a']);
  });

  it('last click wins under rapid navigation (no half-mounted surface)', async () => {
    sidebar(
      '<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li><li><a href="/review/c">c</a></li>',
    );
    const mounted: string[] = [];
    let delay = 0;
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
      canWrite: true,
      // Stagger the meta fetch so the first click's swap is still awaiting when
      // the second fires — the token guard must make the last one win.
      fetchMeta: async () => {
        const d = delay;
        delay = 0;
        await new Promise((r) => setTimeout(r, d));
        return meta;
      },
      connectFor: () => stubClient(),
      mountFor: (ctx) => void mounted.push(ctx.docId),
    });
    await flush();
    mounted.length = 0;

    delay = 20; // b's fetch is slow
    document
      .querySelector('a[href="/review/b"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    document
      .querySelector('a[href="/review/c"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
    // b's swap was superseded before it connected/mounted; only c mounted.
    expect(mounted).toEqual(['c']);
    expect(location.pathname).toBe('/review/c');
  });

  /**
   * The back arrow is SHELL chrome, so it belongs to the router rather than
   * to any per-doc mount: navigation is in-place and the shell is reused, so
   * whoever owns the swap has to own the arrow too.
   */
  describe('back arrow', () => {
    const crumb = () =>
      '<div class="doc-crumb"><a href="/" class="back-link" title="All review docs" aria-label="Back to all review docs">←</a></div>';
    const backHref = () =>
      document.querySelector('.doc-crumb .back-link')?.getAttribute('href') ?? null;

    it('points at the board the doc belongs to once its meta arrives', async () => {
      document.body.innerHTML = `${crumb()}<aside id="set-pane"><ol id="set-pane-list"></ol></aside>`;
      // Presence of the pre-change state, so "it changed" is a claim about
      // this navigation rather than about a fixture that was already right.
      expect(backHref()).toBe('/');
      stop = startRouter({
        user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
        canWrite: true,
        fetchMeta: async () => ({
          ...meta,
          backTo: { workspaceId: 'w-abc', name: 'search-revamp' },
        }),
        connectFor: () => stubClient(),
        mountFor: () => {},
      });
      await flush();
      expect(backHref()).toBe('/workspaces/w-abc');
    });

    it('returns to the index when the next doc has no board', async () => {
      document.body.innerHTML = `${crumb()}<aside id="set-pane"><ol id="set-pane-list"><li><a href="/review/b">b</a></li></ol></aside>`;
      let backTo: { workspaceId: string; name: string } | undefined = {
        workspaceId: 'w-abc',
        name: 'search-revamp',
      };
      stop = startRouter({
        user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
        canWrite: true,
        fetchMeta: async () => ({ ...meta, ...(backTo ? { backTo } : {}) }),
        connectFor: () => stubClient(),
        mountFor: () => {},
      });
      await flush();
      expect(backHref()).toBe('/workspaces/w-abc'); // presence

      backTo = undefined;
      document
        .querySelector('a[href="/review/b"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flush();
      expect(backHref()).toBe('/');
    });
  });
  /**
   * The "Huddle" word in the crumb is shell chrome for the same reason the
   * arrow is: a doc opened in place after a huddle would otherwise keep the
   * word, and a huddle opened after a plain doc would never get it.
   */
  describe('huddle crumb', () => {
    const crumb = () =>
      '<div class="doc-crumb"><a href="/" class="back-link">←</a><span class="doc-label">Editing:</span></div>';
    const label = () => document.querySelector('.doc-crumb .doc-label') as HTMLElement;

    it('names a huddle doc once its meta arrives, and unnames the next doc', async () => {
      document.body.innerHTML = `${crumb()}<aside id="set-pane"><ol id="set-pane-list"><li><a href="/review/b">b</a></li></ol></aside>`;
      let huddle = true;
      stop = startRouter({
        user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
        canWrite: true,
        fetchMeta: async () => ({ ...meta, ...(huddle ? { huddle: true } : {}) }),
        connectFor: () => stubClient(),
        mountFor: () => {},
      });
      await flush();
      expect(label().textContent).toBe('Huddle');
      expect(label().classList.contains('doc-label-huddle')).toBe(true);

      huddle = false;
      document
        .querySelector('a[href="/review/b"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await flush();
      expect(label().textContent).toBe('Editing:');
      expect(label().classList.contains('doc-label-huddle')).toBe(false);
    });
  });
});
