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
  it('intercepts a sidebar file click, pushes state, and swaps without reload', async () => {
    sidebar('<li><a href="/review/a">a</a></li><li><a href="/review/b">b</a></li>');
    const mounted: string[] = [];
    const disposed: string[] = [];
    stop = startRouter({
      user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
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
});
