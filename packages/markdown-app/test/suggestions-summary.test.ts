import { prose, suggestOps } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { mountSuggestionsSummary } from '../src/redline/suggestions-summary.ts';

/**
 * The doc-level "N pending suggestions" affordance (redline-suggestions
 * Phase 2, commit 5c). A topbar badge — same `.icon-btn`/`.badge` classes as
 * `#toggle-threads`/`#threads-count`, already proven to fit the 430px
 * toolbar — that shows/hides with the pending count, and a small anchored
 * menu offering Accept all / Reject all across every author (not
 * per-suggestion — that lives in the balloon/chip card, markup-margin.ts).
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
});

const author = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

function docFrom(md: string): Y.Doc {
  const doc = new Y.Doc();
  prose.getProseFragment(doc).push(prose.parseMarkdownBlocks(md));
  return doc;
}

function mountTopbarDom(): void {
  document.body.innerHTML = `
    <button
      type="button"
      id="toggle-suggestions"
      class="icon-btn suggestions-toggle hidden"
      aria-haspopup="true"
      aria-expanded="false"
    >
      ✎
      <span id="suggestions-count" class="badge">0</span>
    </button>
    <div id="suggestions-menu" class="suggestions-menu hidden" aria-hidden="true">
      <button type="button" id="suggestions-accept-all">Accept all</button>
      <button type="button" id="suggestions-reject-all">Reject all</button>
    </div>
  `;
}

function mount(ydoc: Y.Doc) {
  mountTopbarDom();
  const scope = new MountScope();
  const handle = mountSuggestionsSummary({ docId: 'd1', ydoc, scope });
  open.push(() => scope.dispose());
  return { scope, handle };
}

describe('mountSuggestionsSummary — badge visibility + count', () => {
  it('stays hidden with count 0 when the doc has no pending suggestions', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    mount(ydoc);
    const toggle = document.getElementById('toggle-suggestions') as HTMLElement;
    const count = document.getElementById('suggestions-count') as HTMLElement;
    expect(toggle.classList.contains('hidden')).toBe(true);
    expect(count.textContent).toBe('0');
  });

  it('shows the badge with the pending count once suggestions exist, hides again once resolved', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    const { handle } = mount(ydoc);
    handle.refresh();

    const toggle = document.getElementById('toggle-suggestions') as HTMLElement;
    const count = document.getElementById('suggestions-count') as HTMLElement;
    expect(toggle.classList.contains('hidden')).toBe(false);
    expect(count.textContent).toBe('1');
    expect(count.classList.contains('has-count')).toBe(true);

    suggestOps.resolveAllSuggestions(ydoc, { action: 'accept' });
    handle.refresh();
    expect(toggle.classList.contains('hidden')).toBe(true);
    expect(count.textContent).toBe('0');
  });
});

describe('mountSuggestionsSummary — the menu', () => {
  it('opens on click, closes on an outside click', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    mount(ydoc);
    const toggle = document.getElementById('toggle-suggestions') as HTMLElement;
    const menu = document.getElementById('suggestions-menu') as HTMLElement;

    toggle.click();
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    document.body.click();
    expect(menu.classList.contains('hidden')).toBe(true);
  });
});

describe('mountSuggestionsSummary — Accept all / Reject all', () => {
  it('Accept all posts { action: "accept" } to resolve_all', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    mount(ydoc);
    document.getElementById('toggle-suggestions')?.click();

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    (document.getElementById('suggestions-accept-all') as HTMLButtonElement).click();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/docs/d1/suggestions/resolve_all',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
  });

  it('Reject all posts { action: "reject" } and closes the menu', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    mount(ydoc);
    document.getElementById('toggle-suggestions')?.click();
    const menu = document.getElementById('suggestions-menu') as HTMLElement;

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    (document.getElementById('suggestions-reject-all') as HTMLButtonElement).click();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/docs/d1/suggestions/resolve_all',
      expect.objectContaining({ body: JSON.stringify({ action: 'reject' }) }),
    );
    expect(menu.classList.contains('hidden')).toBe(true);
  });
});

describe('mountSuggestionsSummary — live updates via scheduleRefresh', () => {
  it('scheduleRefresh recomputes the count after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const ydoc = docFrom('Alpha bravo gamma.\n');
      const { handle } = mount(ydoc);
      suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
      handle.scheduleRefresh();
      const toggle = document.getElementById('toggle-suggestions') as HTMLElement;
      expect(toggle.classList.contains('hidden')).toBe(true); // not yet
      vi.runAllTimers();
      expect(toggle.classList.contains('hidden')).toBe(false);
      expect(document.getElementById('suggestions-count')?.textContent).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mountSuggestionsSummary — teardown', () => {
  it('scope.dispose() closes the menu and stops reacting to further refreshes', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    const { scope, handle } = mount(ydoc);
    handle.refresh();
    document.getElementById('toggle-suggestions')?.click();
    const menu = document.getElementById('suggestions-menu') as HTMLElement;
    expect(menu.classList.contains('hidden')).toBe(false);

    scope.dispose();
    expect(menu.classList.contains('hidden')).toBe(true);
    // Post-dispose refresh must not throw (fetch/timer callbacks racing
    // navigation) and must not touch the DOM further.
    expect(() => handle.refresh()).not.toThrow();
  });
});
