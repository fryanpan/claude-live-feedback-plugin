import { type Thread, formatTime, suggestOps, threadLines } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import type { MountScope } from '../mount-scope.ts';
import { type ReviewChrome, showToast } from '../review-chrome.ts';
import { isFoldingTap, sizeThreadSlots } from '../thread-morph.ts';
import { layoutBalloons } from './balloon-layout.ts';
import {
  type DeletionGroup,
  type RedlineDeletion,
  blockIndexForPos,
  groupDeletions,
} from './live-markup.ts';

// Re-exported for backward compatibility — the grouping algorithm lives in
// live-markup.ts now (it needs to be shared with the mobile chip decoration,
// which is built there), but this module is where callers/tests found it
// first.
export { groupDeletions };
export type { DeletionGroup };

/**
 * The markup margin: Word's balloon column for the redline surface — and,
 * since comment balloons are shared chrome, for plain markdown review docs
 * too (no deletions there; `getDeletions` returns `[]`).
 *
 * Owns a right-hand column next to the prose (`.redline-layout` grid on the
 * editor element — `minmax(0, 1fr) 300px`, the `minmax(0,…)` guarding against
 * the CSS Grid overflow trap in docs/process/learnings.md). Each deletion vs
 * base renders as a balloon (deleted markdown as plain text, clamped to ~6
 * lines with an expand toggle; consecutive deletions in the same paragraph
 * collapse into one balloon). Every OPEN comment thread with a resolvable
 * anchor renders as a balloon too — literally the same card the threads
 * drawer renders (`ThreadPanel.renderThread`, reused rather than
 * reimplemented, so reply/resolve/reopen/re-anchor behave identically
 * everywhere). Deletion and comment balloons share ONE `layoutBalloons` pass
 * sorted by anchor Y, so they stack against each other, not just within type.
 *
 * Anchor Y for a deletion comes from `view.coordsAtPos` on its live-doc
 * position; anchor Y for a comment comes from the live DOM position of its
 * `ThreadDecorations` highlight span (`.thread-range[data-thread-id]` —
 * thread-decorations.ts) — the rendered highlight IS the anchor, so reading
 * its own rect avoids re-deriving position math the decoration plugin
 * already did.
 *
 * Re-layout triggers: editor transactions (the mount forwards them, debounced
 * here — this also covers thread state changes, since posting/resolving/
 * activating a thread dispatches a decorations transaction), window resize,
 * and content-size changes via a ResizeObserver on the ProseMirror element —
 * mermaid diagrams render asynchronously with no completion event, and the
 * SVG landing changes the content height, which the observer sees.
 * Everything registers on the passed MountScope for teardown.
 *
 * Below 1100px the column is hidden via media query and the mobile fallback
 * takes over: each deletion group also renders as a compact "⌫ N lines" chip
 * decoration inline in the prose (built in live-markup.ts, alongside the
 * balloon so both agree on grouping), hidden ≥1100px via CSS the same way the
 * balloon column is hidden ≤1100px. Tapping a chip opens `mountDeletionSheet`
 * below — a bottom sheet built from the SAME DOM/CSS pattern as
 * review-chrome.ts's full-screen thread view (fixed slide-up sheet, drag
 * handle, close button), a distinct instance since it shows plain deleted
 * text rather than a thread. Comments keep review-chrome's existing
 * pill/drawer flow untouched — nothing here changes how a comment is created
 * or read on mobile.
 */

export interface MarkupMarginOpts {
  /** The scrollable editor mount (`#editor`) — becomes the layout grid. */
  editorEl: HTMLElement;
  /** The live ProseMirror view: maps deletion positions to anchor Y
   *  coordinates and paragraph keys. */
  view: EditorView;
  getDeletions: () => RedlineDeletion[];
  /** All threads on the doc (open + resolved) — filtered here to open ones
   *  with a resolvable anchor. Pass `chrome.collectThreads`. Omit (or pass
   *  without `chrome`) to render deletion balloons only. */
  threads?: () => Thread[];
  /** Thread actions for comment balloons — the margin calls into
   *  `chrome.threadsPanel.renderThread` (reply/resolve/reopen/re-anchor,
   *  active-state) rather than reimplementing the card. */
  chrome?: ReviewChrome | null;
  /** All pending suggestions in the doc — pass `() =>
   *  suggestOps.listSuggestions(ydoc)`. Recomputed every relayout, same
   *  pattern as `threads`. Requires `docId` (below) to render Accept/Reject;
   *  omit both to render no suggestion balloons. */
  getSuggestions?: () => suggestOps.SuggestionSummary[];
  /** Doc id for the suggestion accept/reject fetch calls. */
  docId?: string;
  scope: MountScope;
}

export interface MarkupMarginHandle {
  /** Synchronous re-render + re-measure + re-stack. */
  relayout: () => void;
  /** Debounced relayout — wire this to editor transactions. */
  scheduleRelayout: () => void;
  /**
   * Scroll a thread's balloon into view and pulse it — the balloon-side half
   * of "click an anchored range, see its comment" (the editor-side click
   * already highlights via `refreshThreadDecorations`). Returns false when
   * the thread has no rendered balloon (resolved, orphaned, or the column is
   * hidden below 1100px) so the caller can fall back to the drawer.
   */
  revealThreadBalloon: (id: string) => boolean;
}

const GAP = 8;
const RELAYOUT_DEBOUNCE_MS = 100;
const CLAMP_LINES = 6;
const CLAMP_CHARS = 480;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Mirrors the styles.css breakpoint that hides `.markup-margin` (and the
 *  leader overlay) — `rendered[]` is populated regardless of viewport, so
 *  anything answering "is this balloon actually visible?" must consult this,
 *  not the DOM. Same query app.ts uses for its mobile checks. */
const MARGIN_HIDDEN_QUERY = '(max-width: 1100px)';

function marginHidden(): boolean {
  return window.matchMedia(MARGIN_HIDDEN_QUERY).matches;
}

/** Long enough to clamp? Text-based so the decision is testable without
 *  layout; the CSS line-clamp does the visual truncation. */
function needsClamp(md: string): boolean {
  return md.split('\n').length > CLAMP_LINES || md.length > CLAMP_CHARS;
}

/** `CSS.escape` guarded — happy-dom (and very old browsers) may not have it. */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

interface RenderedDelBalloon {
  kind: 'del';
  key: string;
  group: DeletionGroup;
  el: HTMLElement;
}

interface RenderedCommentBalloon {
  kind: 'comment';
  key: string;
  thread: Thread;
  el: HTMLElement;
}

interface RenderedSuggestionBalloon {
  kind: 'suggestion';
  key: string;
  summary: suggestOps.SuggestionSummary;
  el: HTMLElement;
}

type RenderedBalloon = RenderedDelBalloon | RenderedCommentBalloon | RenderedSuggestionBalloon;

/** `authorColor` round-trips through an inline `style` attribute (the same
 *  guard suggest-marks.ts applies to the live-doc marks) — only a literal
 *  hex color is allowed through so an arbitrary string can't smuggle extra
 *  CSS declarations into the card. */
function suggestColorStyle(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? `--lf-suggest-color: ${color}` : '';
}

/**
 * The mobile fallback for a deletion balloon: a bottom sheet showing the
 * deleted markdown, opened by tapping a `.lf-del-chip` (live-markup.ts).
 *
 * Built from the SAME DOM structure and CSS classes as review-chrome.ts's
 * full-screen thread view (`.thread-view` / `.thread-view-header` /
 * `.thread-view-body` — fixed slide-up sheet, drag handle, close button) so
 * it looks and animates identically to the mobile comment drawer Bryan
 * already knows. A distinct element rather than the literal `#thread-view`
 * singleton: that element's state machine (`threadViewId`, the reply bar,
 * resolve/reopen) is thread-specific, and overloading it for plain deleted
 * text would tangle two unrelated concerns. `.lf-del-sheet` is the only
 * extra class — every positioning/animation rule comes from `.thread-view`
 * for free.
 */
function mountDeletionSheet(scope: MountScope): { open: (text: string) => void } {
  const sheet = document.createElement('div');
  sheet.className = 'thread-view lf-del-sheet hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Deleted text');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <header class="thread-view-header">
      <span class="drag-handle" aria-hidden="true"></span>
      <h2 class="thread-view-title">Deleted</h2>
      <button type="button" class="icon-btn thread-view-close" aria-label="Close" title="Close">×</button>
    </header>
    <div class="thread-view-body"><div class="lf-del-sheet-text"></div></div>
  `;
  document.body.appendChild(sheet);
  const textEl = sheet.querySelector('.lf-del-sheet-text') as HTMLElement;

  function close(): void {
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }
  function open(text: string): void {
    // Plain text, never HTML: deleted markdown is untrusted doc content —
    // same rule buildDelBalloon follows below.
    textEl.textContent = text;
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }
  scope.listen(sheet.querySelector('.thread-view-close') as HTMLElement, 'click', close);
  scope.onCleanup(() => sheet.remove());
  return { open };
}

/**
 * The mobile fallback for a suggestion balloon: a bottom sheet showing the
 * SAME card the balloon renders (author, age, "replace X with Y", Accept /
 * Reject), opened by tapping a `.lf-suggest-chip` (suggestion-chips.ts).
 * `render` builds that card — passed in rather than duplicated, so
 * accept/reject wire to the identical fetch calls the balloon uses.
 * Structurally identical to `mountDeletionSheet` above.
 */
function mountSuggestionSheet(
  scope: MountScope,
  render: (s: suggestOps.SuggestionSummary) => HTMLElement,
): { open: (s: suggestOps.SuggestionSummary) => void; closeIfShowing: (sid: string) => void } {
  const sheet = document.createElement('div');
  sheet.className = 'thread-view lf-suggest-sheet hidden';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Suggested edit');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.innerHTML = `
    <header class="thread-view-header">
      <span class="drag-handle" aria-hidden="true"></span>
      <h2 class="thread-view-title">Suggestion</h2>
      <button type="button" class="icon-btn thread-view-close" aria-label="Close" title="Close">×</button>
    </header>
    <div class="thread-view-body"><div class="lf-suggest-sheet-body"></div></div>
  `;
  document.body.appendChild(sheet);
  const bodyEl = sheet.querySelector('.lf-suggest-sheet-body') as HTMLElement;

  let openSid: string | null = null;
  function close(): void {
    openSid = null;
    sheet.classList.add('hidden');
    sheet.setAttribute('aria-hidden', 'true');
  }
  function open(s: suggestOps.SuggestionSummary): void {
    openSid = s.sid;
    bodyEl.textContent = '';
    bodyEl.appendChild(render(s));
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
  }
  function closeIfShowing(sid: string): void {
    if (openSid === sid) close();
  }
  scope.listen(sheet.querySelector('.thread-view-close') as HTMLElement, 'click', close);
  scope.onCleanup(() => sheet.remove());
  return { open, closeIfShowing };
}

export function mountMarkupMargin(opts: MarkupMarginOpts): MarkupMarginHandle {
  const { editorEl, view, getDeletions, scope } = opts;

  editorEl.classList.add('redline-layout');

  const marginEl = document.createElement('div');
  marginEl.className = 'markup-margin';
  editorEl.appendChild(marginEl);

  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.setAttribute('class', 'lf-leader-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  editorEl.appendChild(overlay);

  let rendered: RenderedBalloon[] = [];

  /**
   * Word-style collapsed balloons: every balloon renders as a one-line
   * summary until clicked; at most ONE is expanded at a time (expanding
   * another collapses the current one). Keyed by stable identity —
   * `c:<threadId>` / `s:<sid>` / `d:<blockKey>` — so the expanded card
   * survives rebuilds triggered by unrelated edits.
   */
  let expandedKey: string | null = null;
  const isExpanded = (k: string): boolean => expandedKey === k;

  /**
   * A COMMENT balloon's expand state is not kept here — it is the drawer's
   * active thread, and nothing else.
   *
   * The margin balloon and the drawer row are literally the same card, so two
   * separate authorities would let a drawer click leave the balloon folded
   * (or vice versa) and, worse, would put `expanded` back in the render key —
   * which rebuilds the card, and a rebuilt node cannot morph. `expandedKey`
   * still owns deletions and suggestions, which have no drawer counterpart.
   */
  const commentExpanded = (id: string): boolean => opts.chrome?.threadsPanel.getActive() === id;

  function expandBalloon(key: string): void {
    if (key.startsWith('c:')) {
      // One card open at a time across all three kinds: a comment opening
      // folds any expanded deletion/suggestion back down.
      if (expandedKey) {
        expandedKey = null;
        relayout();
      }
      const id = key.slice(2);
      // setActive folds the card in place (no rebuild) on every copy.
      opts.chrome?.threadsPanel.setActive(id);
      opts.chrome?.refreshThreadDecorations(id);
      // Heights changed without a rebuild, so the column still has to restack.
      positionBalloons();
      return;
    }
    expandedKey = key;
    // …and symmetrically, a deletion/suggestion opening folds the comment.
    opts.chrome?.threadsPanel.setActive(null);
    relayout();
  }

  const blockKeyForPos = (pos: number): number => blockIndexForPos(view.state.doc, pos);

  // Mobile fallback: the chip decoration (live-markup.ts) is grouped and
  // built inside the editor's own decorations; this margin only owns what
  // happens when one is tapped — a small bottom sheet showing the deleted
  // text, built once per mount and reused across taps.
  const deletionSheet = mountDeletionSheet(scope);
  scope.listen(editorEl, 'click', (ev) => {
    const chip = (ev.target as HTMLElement).closest?.('.lf-del-chip');
    if (!chip) return;
    ev.preventDefault();
    deletionSheet.open((chip as HTMLElement).dataset.lfDelText ?? '');
  });

  // Mobile fallback for suggestions: same pattern, a distinct sheet (the
  // deletion sheet shows plain text; this one shows the full accept/reject
  // card — see mountSuggestionSheet above).
  const suggestionSheet = mountSuggestionSheet(scope, buildSuggestionBalloon);
  scope.listen(editorEl, 'click', (ev) => {
    const chip = (ev.target as HTMLElement).closest?.('.lf-suggest-chip');
    if (!chip) return;
    ev.preventDefault();
    const sid = (chip as HTMLElement).dataset.lfSuggestSid ?? '';
    const summary = eligibleSuggestions().find((s) => s.sid === sid);
    if (summary) suggestionSheet.open(summary);
  });

  /** A suggestion's live-doc anchor + reveal target — the mark's own
   *  rendered span already carries `data-sid` (suggest-marks.ts), so no
   *  separate position bookkeeping is needed (mirrors `threadSpan` below). A
   *  "replace" proposal has two spans (del + ins) sharing one sid; either is
   *  fine as the anchor/reveal target — `querySelector` returns the first. */
  function suggestionSpan(sid: string): Element | null {
    return view.dom.querySelector(`[data-sid="${cssEscape(sid)}"]`);
  }

  /** Pending proposals with a resolvable anchor, minus ones this client has
   *  already optimistically resolved (see `resolveSuggestion`) — a real
   *  accept/reject also removes the mark from the doc, which would drop the
   *  sid here on its own once Yjs sync lands; the local set just makes the
   *  card disappear immediately instead of waiting for the round trip (and
   *  covers the case where the server call actually failed). */
  const dismissedSids = new Set<string>();
  function eligibleSuggestions(): suggestOps.SuggestionSummary[] {
    if (!opts.getSuggestions || !opts.docId) return [];
    return opts
      .getSuggestions()
      .filter((s) => !dismissedSids.has(s.sid) && suggestionSpan(s.sid) != null);
  }

  async function resolveSuggestion(sid: string, action: 'accept' | 'reject'): Promise<void> {
    const docId = opts.docId;
    if (!docId) return;
    // Optimistic: the card disappears on click, not on the round trip —
    // both because that's the responsive thing to do, and because it's the
    // only way to make a `{ ok:false, error:'not-found' }` response (someone
    // else already resolved it) actually clear the stale card, since the
    // server made no doc change for THIS client to sync.
    dismissedSids.add(sid);
    suggestionSheet.closeIfShowing(sid);
    relayout();
    try {
      const res = await fetch(
        `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/${action}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        showToast('That suggestion is no longer available');
        return;
      }
      showToast(action === 'accept' ? '✓ Suggestion accepted' : '✓ Suggestion rejected');
    } catch {
      showToast(`Failed to ${action} — try again`);
    }
  }

  function buildSuggestionBalloon(s: suggestOps.SuggestionSummary): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lf-balloon lf-balloon-suggestion';
    el.dataset.sid = s.sid;
    const style = suggestColorStyle(s.author.color);
    if (style) el.setAttribute('style', style);

    const header = document.createElement('div');
    header.className = 'lf-suggest-header';
    const swatch = document.createElement('span');
    swatch.className = 'lf-suggest-swatch';
    swatch.style.background = s.author.color;
    const authorEl = document.createElement('span');
    authorEl.className = 'lf-suggest-author';
    // Plain text, never HTML: an author name is untrusted (agent-supplied).
    authorEl.textContent = s.author.name;
    const ageEl = document.createElement('span');
    ageEl.className = 'lf-suggest-age';
    ageEl.textContent = formatTime(s.ts);
    header.append(swatch, authorEl, ageEl);
    el.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'lf-balloon-text lf-suggest-preview';
    // Old struck / new underlined — plain textContent on each span, never
    // innerHTML interpolation (both are untrusted doc/agent content).
    if (s.kind === 'delete' || s.kind === 'replace') {
      const oldEl = document.createElement('span');
      oldEl.className = 'lf-suggest-old';
      oldEl.textContent = s.deletedText;
      preview.appendChild(oldEl);
    }
    if (s.kind === 'insert' || s.kind === 'replace') {
      if (s.kind === 'replace') preview.appendChild(document.createTextNode(' → '));
      const newEl = document.createElement('span');
      newEl.className = 'lf-suggest-new';
      newEl.textContent = s.insertedText;
      preview.appendChild(newEl);
    }
    el.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'lf-suggest-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'lf-suggest-accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'accept'));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'lf-suggest-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'reject'));
    actions.append(acceptBtn, rejectBtn);
    el.appendChild(actions);
    return el;
  }

  /** Small "collapse back to one line" button, top-right of expanded cards. */
  function addCollapseButton(el: HTMLElement): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lf-balloon-collapse';
    b.setAttribute('aria-label', 'Collapse');
    b.title = 'Collapse';
    b.textContent = '−';
    el.appendChild(b);
  }

  /** Swatch + name prefix shared by every collapsed builder. */
  function collapsedIdentity(el: HTMLElement, name: string, color: string): void {
    const swatch = document.createElement('span');
    swatch.className = 'lf-collapsed-swatch';
    swatch.style.background = color;
    const nameEl = document.createElement('span');
    nameEl.className = 'lf-collapsed-name';
    // Plain text, never HTML: names are untrusted (agent-supplied).
    nameEl.textContent = name;
    el.append(swatch, nameEl);
  }

  function buildCollapsedSuggestion(s: suggestOps.SuggestionSummary): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lf-balloon lf-balloon-suggestion lf-balloon-collapsed';
    el.dataset.expandKey = `s:${s.sid}`;
    el.dataset.sid = s.sid;
    const style = suggestColorStyle(s.author.color);
    if (style) el.setAttribute('style', style);
    collapsedIdentity(el, s.author.name, s.author.color);
    const preview = document.createElement('span');
    preview.className = 'lf-collapsed-preview';
    // Same old-struck / new-underlined classes as the full card — plain
    // textContent on each span, never innerHTML (untrusted content).
    if (s.kind === 'delete' || s.kind === 'replace') {
      const oldEl = document.createElement('span');
      oldEl.className = 'lf-suggest-old';
      oldEl.textContent = s.deletedText;
      preview.appendChild(oldEl);
    }
    if (s.kind === 'insert' || s.kind === 'replace') {
      if (s.kind === 'replace') preview.appendChild(document.createTextNode(' → '));
      const newEl = document.createElement('span');
      newEl.className = 'lf-suggest-new';
      newEl.textContent = s.insertedText;
      preview.appendChild(newEl);
    }
    el.appendChild(preview);
    // Accept/Reject stay one click away without expanding — the compact ✓/✕
    // wire to the SAME resolveSuggestion the full card uses.
    const actions = document.createElement('span');
    actions.className = 'lf-collapsed-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'lf-suggest-accept';
    acceptBtn.textContent = '✓';
    acceptBtn.setAttribute('aria-label', 'Accept suggestion');
    acceptBtn.title = 'Accept';
    acceptBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'accept'));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'lf-suggest-reject';
    rejectBtn.textContent = '✕';
    rejectBtn.setAttribute('aria-label', 'Reject suggestion');
    rejectBtn.title = 'Reject';
    rejectBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'reject'));
    actions.append(acceptBtn, rejectBtn);
    el.appendChild(actions);
    return el;
  }

  function buildCollapsedDel(group: DeletionGroup): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lf-balloon lf-balloon-del lf-balloon-collapsed';
    el.dataset.expandKey = `d:${group.blockKey}`;
    const label = document.createElement('span');
    label.className = 'lf-balloon-label';
    label.textContent = 'Deleted';
    const preview = document.createElement('span');
    preview.className = 'lf-collapsed-preview';
    // First non-empty line only; plain text (untrusted doc content). A
    // multi-line deletion (a whole table, a section) shows how much more is
    // behind the click — without it, a clamped first row reads as though
    // only that fragment was deleted.
    const lines = group.deletedMarkdown.split('\n').filter((l) => l.trim() !== '');
    preview.textContent = lines[0] ?? '';
    el.append(label, preview);
    if (lines.length > 1) {
      const count = document.createElement('span');
      count.className = 'lf-collapsed-count';
      count.textContent = `+${lines.length - 1}`;
      count.title = `${lines.length - 1} more line${lines.length === 2 ? '' : 's'}`;
      el.appendChild(count);
    }
    return el;
  }

  function buildDelBalloon(group: DeletionGroup): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lf-balloon lf-balloon-del';
    const label = document.createElement('div');
    label.className = 'lf-balloon-label';
    label.textContent = 'Deleted';
    el.appendChild(label);
    const text = document.createElement('div');
    text.className = 'lf-balloon-text';
    // Plain text, never HTML: deleted markdown is untrusted doc content.
    text.textContent = group.deletedMarkdown;
    el.appendChild(text);
    if (needsClamp(group.deletedMarkdown)) {
      text.classList.add('is-clamped');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lf-balloon-expand';
      toggle.textContent = 'Show more';
      el.appendChild(toggle);
    }
    return el;
  }

  /** A thread's live-doc anchor position, from its own rendered highlight —
   *  the ThreadDecorations plugin already stamped `data-thread-id` on the
   *  span it decorated (thread-decorations.ts). Absent for resolved/orphaned
   *  threads, which don't get a decoration span at all. */
  function threadSpan(id: string): Element | null {
    return view.dom.querySelector(`.thread-range[data-thread-id="${cssEscape(id)}"]`);
  }

  /** Open threads with a resolvable, currently-decorated anchor — resolved
   *  and orphaned threads have nowhere to anchor a balloon. */
  function eligibleThreads(): Thread[] {
    if (!opts.threads || !opts.chrome) return [];
    return opts.threads().filter((t) => t.status === 'open' && threadSpan(t.id) != null);
  }

  function buildCommentBalloon(thread: Thread, pendingReply?: string): HTMLElement {
    // Reuse the drawer's own card verbatim — reply/resolve/reopen/re-anchor
    // are ITS click handlers dispatching to the chrome's fetch calls, not a
    // second implementation. Positioning classes are additive.
    const el = opts.chrome?.threadsPanel.renderThread(thread, pendingReply);
    if (!el) throw new Error('buildCommentBalloon requires opts.chrome');
    el.classList.add('lf-balloon', 'lf-balloon-comment');
    // This is the ONLY comment builder: collapsed and expanded are the same
    // node in two states, because the morph cross-fades between two faces
    // that must both already exist. `renderThread` has already put the card
    // in the right state — the drawer's active thread is the expand state.
    return el;
  }

  /** Rebuild the balloon list only when the underlying data actually
   *  changed, so expand/reply state and DOM focus survive relayouts
   *  triggered by unrelated activity (typing elsewhere in the doc dispatches
   *  a transaction on every keystroke). */
  function renderBalloons(
    delGroups: DeletionGroup[],
    openThreads: Thread[],
    suggestions: suggestOps.SuggestionSummary[],
  ): void {
    // Expanded state is part of the render key for deletions and suggestions,
    // which still swap between two builders, so toggling rebuilds those cards.
    const delKeys = delGroups.map(
      (g) => `del|${g.blockKey}|${g.deletedMarkdown}|${isExpanded(`d:${g.blockKey}`)}`,
    );
    // The topic line comes from the anchor snippet, which moves whenever the
    // doc is edited — independently of every other term here. Without it, an
    // edited anchor keeps a stale topic on the card until some unrelated
    // change forces a repaint. Key on the line the card actually shows.
    //
    // Deliberately ABSENT: expanded/active. A comment card folds in place, so
    // a rebuild on expand would destroy the very node the morph is animating.
    // The key carries what the card DISPLAYS and not what it merely animates.
    const commentKeys = openThreads.map(
      (t) =>
        `comment|${t.id}|${t.status}|${t.commentCount}|${t.lastActivity}|${threadLines(t).topic}`,
    );
    const suggestionKeys = suggestions.map(
      (s) => `suggest|${s.sid}|${s.kind}|${isExpanded(`s:${s.sid}`)}`,
    );
    const keys = [...delKeys, ...commentKeys, ...suggestionKeys];
    if (keys.length === rendered.length && keys.every((k, i) => k === rendered[i].key)) {
      // Nothing display-relevant changed — refresh the live refs (an anchor
      // position may have moved) without touching any DOM. Both kinds that
      // hold one: a retained `thread` object goes stale exactly as a `group`
      // does, and anything reading `r.thread` later would get old data.
      let di = 0;
      let ci = 0;
      for (const r of rendered) {
        if (r.kind === 'del') r.group = delGroups[di++];
        else if (r.kind === 'comment') r.thread = openThreads[ci++] ?? r.thread;
      }
      return;
    }

    // Preserve in-progress reply drafts across the rebuild — the same trick
    // ThreadPanel.render() uses for the drawer, needed here because the
    // margin can rebuild far more often (any editor transaction).
    const pendingReplies = new Map<string, string>();
    for (const r of rendered) {
      if (r.kind !== 'comment') continue;
      const ta = r.el.querySelector<HTMLTextAreaElement>('textarea');
      if (ta?.value) pendingReplies.set(r.thread.id, ta.value);
    }

    marginEl.textContent = '';
    const nextDel: RenderedDelBalloon[] = delGroups.map((group, i) => {
      const expanded = isExpanded(`d:${group.blockKey}`);
      const el = expanded ? buildDelBalloon(group) : buildCollapsedDel(group);
      if (expanded) addCollapseButton(el);
      marginEl.appendChild(el);
      return { kind: 'del', key: delKeys[i], group, el };
    });
    const nextComments: RenderedCommentBalloon[] = openThreads.map((thread, i) => {
      // No collapse button: the whole card is the tap target now, and
      // `✓ Resolve` is the only control in the footer.
      const el = buildCommentBalloon(thread, pendingReplies.get(thread.id));
      marginEl.appendChild(el);
      return { kind: 'comment', key: commentKeys[i], thread, el };
    });
    const nextSuggestions: RenderedSuggestionBalloon[] = suggestions.map((summary, i) => {
      const expanded = isExpanded(`s:${summary.sid}`);
      const el = expanded ? buildSuggestionBalloon(summary) : buildCollapsedSuggestion(summary);
      if (expanded) addCollapseButton(el);
      marginEl.appendChild(el);
      return { kind: 'suggestion', key: suggestionKeys[i], summary, el };
    });
    rendered = [...nextDel, ...nextComments, ...nextSuggestions];
    // A card's folding slots have no intrinsic height — measure them now the
    // balloons are in the document, BEFORE layoutBalloons reads `offsetHeight`
    // off the cards, or every comment balloon stacks as a header and a footer.
    sizeThreadSlots(marginEl);
  }

  /** Y of a client-rect top in the editor's scrolled content space. */
  function contentY(clientTop: number, editorRect: DOMRect): number {
    return clientTop - editorRect.top + editorEl.scrollTop;
  }

  /**
   * Content-space floor keeping balloons clear of the floating view toggle.
   * `body.diff-mode #view-toggle` is absolutely positioned over the editor
   * pane's top-right at z-index 5 (opaque, non-scrolling) — exactly where
   * the margin column's grid track starts — so a balloon anchored at the top
   * of the doc would render underneath it. Measured live (not hardcoded) so
   * format-bar height and toggle wrapping can't drift out of sync. The
   * clearance is viewport-relative to the editor's top, which equals content
   * space at scroll-top — the only scroll position where the floor matters;
   * scrolled content passing under the pill is normal floating-control UX.
   */
  function toggleClearanceY(editorRect: DOMRect): number {
    const toggle = document.getElementById('view-toggle');
    if (!toggle || toggle.classList.contains('hidden')) return 0;
    const r = toggle.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= editorRect.top) return 0;
    return r.bottom - editorRect.top + GAP;
  }

  function positionBalloons(): void {
    const editorRect = editorEl.getBoundingClientRect();
    const marginRect = marginEl.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const proseRect = view.dom.getBoundingClientRect();
    const marginOffsetY = contentY(marginRect.top, editorRect);
    const doc = view.state.doc;

    const items = rendered.map((b) => {
      let anchorY = 0;
      try {
        if (b.kind === 'del') {
          const pos = Math.max(0, Math.min(b.group.pos, doc.content.size));
          anchorY = contentY(view.coordsAtPos(pos).top, editorRect);
        } else if (b.kind === 'comment') {
          const span = threadSpan(b.thread.id);
          if (span) anchorY = contentY(span.getBoundingClientRect().top, editorRect);
        } else {
          const span = suggestionSpan(b.summary.sid);
          if (span) anchorY = contentY(span.getBoundingClientRect().top, editorRect);
        }
      } catch {
        // happy-dom / positions without layout info — stack from the top.
      }
      return { anchorY: Math.max(0, anchorY), height: b.el.offsetHeight };
    });
    // Floor stacking positions below the floating toggle, but keep the TRUE
    // anchor for the leader lines — the line should still point at the
    // deletion/highlight, only the card slides down. max() is monotonic, so
    // the anchor-sorted stacking order is preserved.
    const minY = toggleClearanceY(editorRect);
    const ys = layoutBalloons(
      items.map((it) => ({ anchorY: Math.max(minY, it.anchorY), height: it.height })),
      GAP,
    );

    // Size the overlay to the scrolled content so lines aren't clipped.
    overlay.setAttribute('width', String(Math.max(0, editorEl.scrollWidth)));
    overlay.setAttribute('height', String(Math.max(0, editorEl.scrollHeight)));
    overlay.textContent = '';
    const overlayOffsetY = contentY(overlayRect.top, editorRect);
    const overlayOffsetX = overlayRect.left - editorRect.left;
    const anchorX = proseRect.right - editorRect.left - overlayOffsetX;
    const balloonX = marginRect.left - editorRect.left - overlayOffsetX + 4;

    let maxBottom = 0;
    for (let i = 0; i < rendered.length; i++) {
      const y = Math.max(0, ys[i]);
      rendered[i].el.style.top = `${y - marginOffsetY}px`;
      maxBottom = Math.max(maxBottom, y + items[i].height);

      const leaderKind = rendered[i].kind;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute(
        'class',
        leaderKind === 'comment'
          ? 'lf-leader lf-leader-comment'
          : leaderKind === 'suggestion'
            ? 'lf-leader lf-leader-suggestion'
            : 'lf-leader',
      );
      line.setAttribute('x1', String(anchorX));
      line.setAttribute('y1', String(items[i].anchorY - overlayOffsetY));
      line.setAttribute('x2', String(balloonX));
      line.setAttribute('y2', String(y - overlayOffsetY + 12));
      overlay.appendChild(line);
    }
    // Balloons are absolutely positioned and add no flow height; stretch the
    // margin so the shared scroll container reaches the last balloon.
    marginEl.style.minHeight = `${Math.max(0, maxBottom - marginOffsetY)}px`;
  }

  function relayout(): void {
    if (scope.disposed) return;
    renderBalloons(
      groupDeletions(getDeletions(), blockKeyForPos),
      eligibleThreads(),
      eligibleSuggestions(),
    );
    positionBalloons();
  }

  function revealThreadBalloon(id: string): boolean {
    // Below the breakpoint the column is display:none — the balloon exists
    // in `rendered[]` but the user can't see it, and a silent scrollIntoView
    // no-op would eat the caller's drawer/thread-view fallback (the 901–
    // 1100px gap is a real iPad-portrait width, not an edge case).
    if (marginHidden()) return false;
    let found = rendered.find(
      (r): r is RenderedCommentBalloon => r.kind === 'comment' && r.thread.id === id,
    );
    if (!found) return false;
    // Revealing means engaging — expand the balloon. The card folds in place,
    // but a deletion/suggestion giving up the open slot still rebuilds
    // `rendered`, so re-find the element before scrolling to it.
    if (!commentExpanded(id)) {
      expandBalloon(`c:${id}`);
      found =
        rendered.find(
          (r): r is RenderedCommentBalloon => r.kind === 'comment' && r.thread.id === id,
        ) ?? found;
    }
    try {
      found.el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // scrollIntoView can throw in some test/embedded environments — the
      // highlight in the editor already happened, this is a nice-to-have.
    }
    return true;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRelayout(): void {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      relayout();
    }, RELAYOUT_DEBOUNCE_MS);
  }

  // Balloon expand/collapse (the Word-style one-at-a-time state) via one
  // delegated listener — balloons rebuild on content changes, so per-balloon
  // listeners would leak or vanish.
  scope.listen(marginEl, 'click', (ev) => {
    const target = ev.target as HTMLElement;
    // A comment card toggles ITSELF — the card's own handler (the whole card
    // is the tap target) has already folded every copy in place by the time
    // this bubbles up. All the column owes it is a restack: a card that just
    // grew or shrank moves every card below it.
    if (target.closest?.('.lf-balloon-comment')) {
      // …but only when the tap actually folded something. The same exclusion
      // list the card itself uses, shared rather than copied.
      if (!isFoldingTap(target)) return;
      if (expandedKey) {
        // The comment took the one open slot from a deletion/suggestion.
        expandedKey = null;
        relayout();
      } else {
        positionBalloons();
      }
      return;
    }
    if (target.closest?.('.lf-balloon-collapse')) {
      expandedKey = null;
      relayout();
      return;
    }
    const collapsed = target.closest?.('.lf-balloon-collapsed') as HTMLElement | null;
    if (!collapsed) return;
    // The compact ✓/✕ on a collapsed suggestion act without expanding.
    if (target.closest('button')) return;
    const key = collapsed.dataset.expandKey;
    if (key) expandBalloon(key);
  });

  // "Show more" toggle inside an expanded deletion balloon (text clamp).
  scope.listen(marginEl, 'click', (ev) => {
    const toggle = (ev.target as HTMLElement).closest?.('.lf-balloon-expand');
    if (!toggle) return;
    const balloon = toggle.closest('.lf-balloon');
    const text = balloon?.querySelector('.lf-balloon-text');
    if (!balloon || !text) return;
    const expanded = balloon.classList.toggle('is-expanded');
    text.classList.toggle('is-clamped', !expanded);
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    positionBalloons(); // heights changed — restack without rebuilding
  });

  scope.listen(window, 'resize', scheduleRelayout);

  // Mermaid renders complete asynchronously with no event; the injected SVG
  // resizes the prose element, which this observer sees (and it doubles as
  // the catch-all for images/fonts landing late).
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(scheduleRelayout);
    ro.observe(view.dom);
    scope.onCleanup(() => ro.disconnect());
  }

  scope.onCleanup(() => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    overlay.remove();
    marginEl.remove();
    editorEl.classList.remove('redline-layout');
  });

  relayout();
  return { relayout, scheduleRelayout, revealThreadBalloon };
}
