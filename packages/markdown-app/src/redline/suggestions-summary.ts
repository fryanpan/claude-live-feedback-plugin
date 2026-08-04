import { suggestOps } from '@feedback/core';
import type * as Y from 'yjs';
import type { MountScope } from '../mount-scope.ts';
import { el, showToast } from '../review-chrome.ts';

/**
 * The doc-level "N pending suggestions" affordance (redline-suggestions
 * Phase 2, commit 5c): a topbar badge that mirrors `#toggle-threads` /
 * `#threads-count` — the SAME `.icon-btn` / `.badge` classes, already
 * proven to fit the 430px toolbar in earlier commits (see
 * docs/product/design-mobile.md) — plus a small anchored menu (positioned
 * like `.doc-menu`) offering Accept all / Reject all across every author.
 *
 * Per-suggestion Accept/Reject lives in the balloon/chip card
 * (markup-margin.ts, buildSuggestionBalloon) — this module is doc-level
 * only. Mounted once per document by BOTH the plain markdown surface
 * (app.ts) and the editable redline surface (redline-app.ts); the code
 * surface never mounts it, so the shared topbar element simply stays in its
 * initial `hidden` state there.
 *
 * Live updates: `suggestOps.listSuggestions(ydoc)` is recomputed from
 * scratch on every `refresh()` — the caller wires `scheduleRefresh` to the
 * editor's own 'transaction' event (same signal markup-margin.ts's balloon
 * relayout already reacts to), so an agent's suggestion — created via a
 * plain Yjs mutation that syncs to this browser like any other edit —
 * updates the badge without a page reload and without a second,
 * independent SSE listener (the doc channel's suggestion.* events exist for
 * agent-side `watch_doc` consumers, not the browser, which already sees the
 * mark change through the same Yjs sync as everything else).
 */

export interface SuggestionsSummaryOpts {
  docId: string;
  ydoc: Y.Doc;
  scope: MountScope;
}

export interface SuggestionsSummaryHandle {
  /** Synchronous recount + re-render. */
  refresh: () => void;
  /** Debounced refresh — wire this to editor transactions. */
  scheduleRefresh: () => void;
}

const REFRESH_DEBOUNCE_MS = 150;

export function mountSuggestionsSummary(opts: SuggestionsSummaryOpts): SuggestionsSummaryHandle {
  const { docId, ydoc, scope } = opts;
  const toggle = el<HTMLButtonElement>('toggle-suggestions');
  const countEl = el<HTMLElement>('suggestions-count');
  const menu = el<HTMLElement>('suggestions-menu');
  const acceptAllBtn = el<HTMLButtonElement>('suggestions-accept-all');
  const rejectAllBtn = el<HTMLButtonElement>('suggestions-reject-all');

  function closeMenu(): void {
    menu.classList.add('hidden');
    menu.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
  }
  function openMenu(): void {
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
  }
  scope.listen(toggle, 'click', () => {
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });
  // Outside click closes the menu — same pattern as the doc-switcher
  // dropdown (app.ts's wireDocMenu), reimplemented locally so this module
  // has no dependency on that shell-level wiring.
  scope.listen(document, 'click', (ev) => {
    if (menu.classList.contains('hidden')) return;
    const t = ev.target as HTMLElement;
    if (t === toggle || toggle.contains(t) || menu.contains(t)) return;
    closeMenu();
  });

  function refresh(): void {
    if (scope.disposed) return;
    const count = suggestOps.listSuggestions(ydoc).length;
    countEl.textContent = String(count);
    countEl.classList.toggle('has-count', count > 0);
    toggle.classList.toggle('hidden', count === 0);
    if (count === 0) closeMenu();
  }

  async function resolveAll(action: 'accept' | 'reject'): Promise<void> {
    closeMenu();
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/suggestions/resolve_all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(action === 'accept' ? '✓ Accepted all' : '✓ Rejected all');
    } catch {
      showToast(`Failed to ${action === 'accept' ? 'accept' : 'reject'} all — try again`);
    }
    // The mutation (or the toast-only no-op on failure) may already be
    // reflected via the caller's own transaction-driven scheduleRefresh by
    // the time this resolves; refreshing again here is a harmless no-op in
    // that case and the only signal in a test that stubs fetch without
    // touching the ydoc at all.
    refresh();
  }
  scope.listen(acceptAllBtn, 'click', () => void resolveAll('accept'));
  scope.listen(rejectAllBtn, 'click', () => void resolveAll('reject'));

  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(): void {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }
  scope.onCleanup(() => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    closeMenu();
  });

  refresh();
  return { refresh, scheduleRefresh };
}
