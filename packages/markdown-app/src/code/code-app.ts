import { type Thread, type User, readDocMeta } from '@feedback/core';
import type { FeedbackClient } from '../client.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { ThreadPanel, type ThreadTab } from '../threads.ts';
import { renderWorkspaceTree, wireWorkspaceTreeRefresh } from '../workspace-tree.ts';
import { createCodeEditor } from './code-editor.ts';

/**
 * Boot the read-only code review surface. Reuses the entire thread/comment
 * stack (`ThreadPanel`, the REST thread routes, the text-range anchor wire
 * shape) — only the editor surface differs from markdown. The format bar,
 * edit-mode toggle, and comment pill (all Tiptap/ProseMirror-specific) are
 * not wired here; `body.code-mode` hides them in CSS.
 *
 * The create-comment flow is selection-driven: select whole lines in the
 * CodeMirror surface, then hit the comment button (or ⌘M) to open the
 * composer. Clicking a gutter dot or a panel thread reveals + scrolls +
 * pulses the anchored lines, mirroring the markdown path.
 */
export async function bootCode(opts: {
  docId: string;
  client: FeedbackClient;
  user: User;
  sourceUrl?: string;
  workspaceId?: string;
  /** 'diff' boots the same surface in unified-diff mode with a view toggle. */
  docType?: 'code' | 'diff';
  /** Path relative to the repo root — language detection + doc label for
   *  diff docs, which have no sourceUrl (content comes from git, not disk). */
  relPath?: string;
}): Promise<void> {
  const { docId, client, user } = opts;
  const isDiff = opts.docType === 'diff';
  // A code file bound via bind_folder belongs to a workspace — render the
  // shared file tree so the reviewer can navigate the folder (same as the
  // markdown surface; code docs skip app.ts's renderSetNav by booting here).
  if (opts.workspaceId) {
    void renderWorkspaceTree(docId, opts.workspaceId);
    wireWorkspaceTreeRefresh(docId, opts.workspaceId);
  }
  const { ydoc } = client;
  document.body.classList.add('code-mode');
  if (isDiff) document.body.classList.add('diff-mode');

  // Diff rendering data: the base-commit text this file is compared against.
  // Fetched before mounting so the surface can boot straight into diff mode.
  // When it's unavailable (repo worktree pruned), fall back to the whole-file
  // view — that needs nothing beyond the ydoc content.
  interface DiffInfo {
    baseText: string | null;
    status?: 'added' | 'modified' | 'deleted' | 'renamed';
    oldPath?: string;
    error?: string;
  }
  let diffInfo: DiffInfo | null = null;
  if (isDiff) {
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/diff`);
      if (res.ok) diffInfo = (await res.json()) as DiffInfo;
    } catch {
      // fall through to whole-file mode
    }
  }

  const editorMount = el<HTMLElement>('editor');
  const threadsListEl = el<HTMLElement>('threads-list');
  const docTitleEl = el<HTMLElement>('doc-title');
  const composer = el<HTMLElement>('composer');
  const composerText = el<HTMLTextAreaElement>('composer-text');
  const composerAvatar = el<HTMLElement>('composer-avatar');
  const composerScrim = el<HTMLElement>('composer-scrim');
  const commentPill = el<HTMLButtonElement>('comment-pill');
  const threadView = el<HTMLElement>('thread-view');
  const threadViewBody = el<HTMLElement>('thread-view-body');
  const threadViewClose = el<HTMLButtonElement>('thread-view-close');
  const threadViewReplyText = el<HTMLTextAreaElement>('thread-view-reply-text');
  const threadViewReplySubmit = el<HTMLButtonElement>('thread-view-reply-submit');
  const toggleThreads = el<HTMLButtonElement>('toggle-threads');
  const threadsCount = el<HTMLElement>('threads-count');
  const closeThreads = el<HTMLButtonElement>('close-threads');
  const scrim = el<HTMLElement>('threads-scrim');
  const shell = document.getElementById('shell') as HTMLElement;

  // Prefer the sourceUrl from the REST meta (available immediately) over the
  // Yjs meta map, which hasn't synced yet at boot — otherwise the language
  // extension is chosen from an empty path and the file renders unhighlighted.
  // Diff docs have no sourceUrl; their relPath serves the same purpose.
  const sourceUrl = opts.sourceUrl || opts.relPath || (readDocMeta(ydoc).sourceUrl ?? '');

  let selection: { start: Uint8Array; end: Uint8Array; snippet: string } | null = null;

  const surface = createCodeEditor({
    parent: editorMount,
    ydoc,
    sourceUrl,
    diff: diffInfo?.baseText != null ? { baseText: diffInfo.baseText } : undefined,
    onSelectionChange: () => {
      const sel = surface.getSelectionRel();
      if (sel) {
        selection = sel;
        positionPill();
      } else {
        hidePill();
      }
    },
    onMarkerClick: (id) => revealThread(id),
  });

  // --- diff ↔ whole-file toggle ---------------------------------------------
  if (isDiff) {
    const toggle = document.getElementById('view-toggle');
    const btnDiff = document.getElementById('view-diff') as HTMLButtonElement | null;
    const btnFile = document.getElementById('view-file') as HTMLButtonElement | null;
    if (diffInfo?.baseText != null && toggle && btnDiff && btnFile) {
      toggle.classList.remove('hidden');
      const applyMode = (mode: 'diff' | 'file') => {
        surface.setViewMode(mode);
        btnDiff.classList.toggle('active', mode === 'diff');
        btnDiff.setAttribute('aria-pressed', String(mode === 'diff'));
        btnFile.classList.toggle('active', mode === 'file');
        btnFile.setAttribute('aria-pressed', String(mode === 'file'));
      };
      btnDiff.addEventListener('click', () => applyMode('diff'));
      btnFile.addEventListener('click', () => applyMode('file'));
    }
    if (diffInfo?.status === 'deleted') {
      showBanner('This file was deleted in this diff — the content shown is the base version.');
    } else if (diffInfo?.baseText == null) {
      showBanner(
        `Diff unavailable (${diffInfo?.error ?? 'no diff data'}) — showing the whole file at the target commit.`,
      );
    } else if (diffInfo.status === 'renamed' && diffInfo.oldPath) {
      showBanner(`Renamed from ${diffInfo.oldPath}`);
    }
  }

  // Interaction-bounded reading-session capture (doc_open + read_session).
  // CodeMirror manages its own scroller inside #editor; the tracker reads
  // scroll depth from editorMount and listens for interaction at the window.
  startReadingTracker({ docId, user, scrollEl: editorMount });

  // --- comment affordance: a pill anchored to the selection -----------------
  function positionPill(): void {
    if (!composer.classList.contains('hidden')) {
      hidePill();
      return;
    }
    const winSel = window.getSelection();
    if (!winSel || winSel.rangeCount === 0 || winSel.isCollapsed) {
      hidePill();
      return;
    }
    try {
      const rects = winSel.getRangeAt(0).getClientRects();
      const last = rects.length > 0 ? rects[rects.length - 1] : null;
      if (!last) {
        hidePill();
        return;
      }
      const gap = 8;
      const pillW = 36;
      const viewportW = window.innerWidth;
      let left = last.right + gap;
      const top = Math.max(8, last.top - 2);
      if (left + pillW > viewportW - 8) left = Math.max(8, last.right - pillW);
      commentPill.style.left = `${Math.max(8, left)}px`;
      commentPill.style.top = `${top}px`;
      commentPill.classList.remove('hidden');
    } catch {
      hidePill();
    }
  }
  function hidePill(): void {
    commentPill.classList.add('hidden');
  }
  commentPill.addEventListener('mousedown', (ev) => ev.preventDefault());
  commentPill.addEventListener('click', () => openComposerForSelection());

  // --- composer -------------------------------------------------------------
  composerAvatar.style.background = user.color;
  composerAvatar.textContent = (user.name[0] ?? '?').toUpperCase();

  function openComposerForSelection(): void {
    const use = surface.getSelectionRel() ?? selection;
    if (!use) {
      showToast('Select some lines first to leave a comment.');
      return;
    }
    selection = use;
    el<HTMLElement>('composer-quote').textContent = use.snippet;
    composer.classList.remove('hidden');
    composerScrim.classList.remove('hidden');
    document.body.classList.add('composer-open');
    hidePill();
    composerText.value = '';
    setTimeout(() => composerText.focus({ preventScroll: true }), 30);
  }
  function hideComposer(): void {
    composer.classList.add('hidden');
    composerScrim.classList.add('hidden');
    document.body.classList.remove('composer-open');
  }
  composerScrim.addEventListener('click', hideComposer);
  composerText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submitComposer();
    }
    if (ev.key === 'Escape') hideComposer();
  });
  el<HTMLButtonElement>('composer-submit').addEventListener('click', () => void submitComposer());

  async function submitComposer(): Promise<void> {
    const text = composerText.value.trim();
    if (!text) return;
    if (!selection) {
      showToast('Lost the selection — try again.');
      return;
    }
    const anchor = {
      kind: 'text-range' as const,
      startRel: Array.from(selection.start),
      endRel: Array.from(selection.end),
      snippet: { text: selection.snippet },
    };
    const submitBtn = el<HTMLButtonElement>('composer-submit');
    submitBtn.disabled = true;
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text, anchor }),
      });
      if (!res.ok) throw new Error('post failed');
      const body = (await res.json()) as { thread: { id: string } };
      hideComposer();
      showToast('✓ Comment posted');
      setTimeout(() => {
        const r = resolveThreadRange(body.thread.id);
        if (r) {
          surface.scrollToPos(r.from);
          surface.pulseRange(r.from, r.to);
        }
      }, 150);
    } catch {
      showToast('Failed to post comment');
    } finally {
      submitBtn.disabled = false;
    }
  }

  // --- threads drawer -------------------------------------------------------
  function openDrawer(): void {
    shell.classList.add('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'true');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer(): void {
    shell.classList.remove('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'false');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'true');
  }
  toggleThreads.addEventListener('click', () =>
    shell.classList.contains('threads-open') ? closeDrawer() : openDrawer(),
  );
  closeThreads.addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  if (window.matchMedia('(min-width: 901px)').matches) openDrawer();

  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.threads-tabs .tab'));
  for (const b of tabButtons) {
    b.addEventListener('click', () => {
      const tab = (b.getAttribute('data-tab') ?? 'open') as ThreadTab;
      threadsPanel.setTab(tab);
      for (const x of tabButtons) x.classList.toggle('active', x === b);
    });
  }

  const threadsPanel = new ThreadPanel({
    container: threadsListEl,
    currentUser: user,
    onThreadClick: (id) => {
      const range = resolveThreadRange(id);
      if (range) {
        surface.scrollToPos(range.from);
        surface.pulseRange(range.from, range.to);
      }
      threadsPanel.setActive(id);
      refreshThreadDecorations(id);
      if (isMobile()) {
        closeDrawer();
        openThreadView(id);
      }
    },
    onReply: async (id, text) => {
      await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/comments`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: user, text }),
        },
      );
    },
    onResolve: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/resolve`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Resolved');
      } catch {
        showToast('Failed to resolve — try again');
      }
    },
    onReopen: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reopen`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Reopened');
      } catch {
        showToast('Failed to reopen — try again');
      }
    },
    onReanchor: async (id) => {
      const sel = surface.getSelectionRel();
      if (!sel) {
        showToast('Select new lines first, then click Re-anchor.');
        return;
      }
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reanchor`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              anchor: {
                kind: 'text-range',
                startRel: Array.from(sel.start),
                endRel: Array.from(sel.end),
                snippet: { text: sel.snippet },
              },
            }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Re-anchored');
      } catch {
        showToast('Failed to re-anchor — try again');
      }
    },
  });

  function revealThread(id: string): void {
    refreshThreadDecorations(id);
    const range = resolveThreadRange(id);
    if (range) {
      surface.scrollToPos(range.from);
      surface.pulseRange(range.from, range.to);
    }
    if (isMobile()) {
      threadsPanel.setActive(id);
      openThreadView(id);
    } else {
      openDrawer();
      requestAnimationFrame(() => threadsPanel.revealThread(id));
    }
  }

  function resolveThreadRange(threadId: string): { from: number; to: number } | null {
    const doc = ydoc.getMap('threads').get(threadId) as import('yjs').Map<unknown> | undefined;
    if (!doc) return null;
    const anchor = doc.get('anchor') as
      | { kind: 'text-range'; startRel: Uint8Array | number[]; endRel: Uint8Array | number[] }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    const startRel =
      anchor.startRel instanceof Uint8Array ? anchor.startRel : new Uint8Array(anchor.startRel);
    const endRel =
      anchor.endRel instanceof Uint8Array ? anchor.endRel : new Uint8Array(anchor.endRel);
    return surface.resolveRel(startRel, endRel);
  }

  let activeThreadId: string | null = null;
  function redrawThreads(): void {
    const all = collectThreads();
    threadsPanel.setThreads(all);
    refreshThreadDecorations(activeThreadId);
    const counts = threadsPanel.countByStatus();
    const openCount = counts.open + counts.orphan;
    threadsCount.textContent = String(openCount);
    threadsCount.classList.toggle('has-count', openCount > 0);
  }
  function refreshThreadDecorations(activeId: string | null): void {
    activeThreadId = activeId;
    const ranges = collectThreads()
      .filter((t) => t.anchor.kind === 'text-range')
      .map((t) => {
        const r = resolveThreadRange(t.id);
        if (!r) return null;
        return { id: t.id, from: r.from, to: r.to, status: t.status };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    surface.setThreadRanges(ranges, activeId);
  }

  function collectThreads(): Thread[] {
    const threadsMap = ydoc.getMap('threads');
    const out: Thread[] = [];
    threadsMap.forEach((entry, id) => {
      const threadMap = entry as import('yjs').Map<unknown>;
      const anchorRaw = threadMap.get('anchor') as Thread['anchor'] | undefined;
      const status = threadMap.get('status') as Thread['status'] | undefined;
      const createdBy = threadMap.get('createdBy') as User | undefined;
      const commentsArr = threadMap.get('comments') as
        | import('yjs').Array<import('yjs').Map<unknown>>
        | undefined;
      if (!anchorRaw || !status || !createdBy) return;
      const comments = [];
      if (commentsArr) {
        for (const c of commentsArr) {
          const cid = c.get('id') as string | undefined;
          const author = c.get('author') as User | undefined;
          const text = c.get('text') as string | undefined;
          const ts = c.get('ts') as number | undefined;
          if (cid && author && text != null && ts != null)
            comments.push({ id: cid, author, text, ts });
        }
      }
      let displayAnchor: Thread['anchor'] = anchorRaw;
      if (anchorRaw.kind === 'text-range') {
        const r = resolveThreadRange(id);
        if (!r) displayAnchor = { kind: 'orphan', original: anchorRaw, lastSeenAt: Date.now() };
      }
      out.push({
        id,
        status,
        anchor: displayAnchor,
        createdBy,
        commentCount: comments.length,
        lastActivity: comments.length > 0 ? (comments[comments.length - 1]?.ts ?? 0) : 0,
        comments,
      });
    });
    return out;
  }

  // --- full-screen thread view (mobile) -------------------------------------
  let threadViewId: string | null = null;
  function isMobile(): boolean {
    return !window.matchMedia('(min-width: 901px)').matches;
  }
  function renderThreadView(id: string): void {
    const t = collectThreads().find((x) => x.id === id);
    if (!t) return;
    const anchorText =
      t.anchor.kind === 'orphan' ? t.anchor.original.snippet.text : t.anchor.snippet.text;
    threadViewBody.innerHTML = '';
    const anchor = document.createElement('div');
    anchor.className = 'thread-anchor';
    anchor.textContent = anchorText;
    threadViewBody.appendChild(anchor);
    for (const c of t.comments) {
      const row = document.createElement('div');
      row.className = 'comment';
      const a = document.createElement('div');
      a.className = 'author';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c.author.color;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = c.author.name;
      const tm = document.createElement('span');
      tm.className = 'time';
      tm.textContent = formatTs(c.ts);
      a.append(sw, nm, tm);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'body';
      bodyEl.textContent = c.text;
      row.append(a, bodyEl);
      threadViewBody.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'thread-view-actions';
    const isResolved = t.status === 'resolved';
    const action = isResolved ? 'reopen' : 'resolve';
    actions.appendChild(
      makeBtn(isResolved ? 'Reopen' : 'Resolve', async () => {
        try {
          const res = await fetch(
            `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(t.id)}/${action}`,
            { method: 'POST' },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showToast(isResolved ? '✓ Reopened' : '✓ Resolved');
          if (!isResolved) closeThreadView();
        } catch {
          showToast(`Failed to ${action} — try again`);
        }
      }),
    );
    threadViewBody.appendChild(actions);
  }
  function openThreadView(id: string): void {
    threadViewId = id;
    threadsPanel.setActive(id);
    refreshThreadDecorations(id);
    renderThreadView(id);
    hidePill();
    threadView.classList.remove('hidden');
    threadView.setAttribute('aria-hidden', 'false');
    document.body.classList.add('thread-view-open');
    const range = resolveThreadRange(id);
    if (range) surface.scrollToPos(range.from);
  }
  function closeThreadView(): void {
    threadViewId = null;
    threadView.classList.add('hidden');
    threadView.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('thread-view-open');
    threadViewReplyText.value = '';
  }
  threadViewClose.addEventListener('click', closeThreadView);
  async function submitThreadReply(): Promise<void> {
    if (!threadViewId) return;
    const text = threadViewReplyText.value.trim();
    if (!text) return;
    const id = threadViewId;
    threadViewReplyText.value = '';
    await fetch(
      `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text }),
      },
    );
  }
  threadViewReplySubmit.addEventListener('click', () => void submitThreadReply());
  threadViewReplyText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submitThreadReply();
    }
  });

  // --- doc label ------------------------------------------------------------
  function renderDocLabel(): void {
    const m = readDocMeta(ydoc);
    const full = m.sourceUrl ?? m.title ?? m.docId;
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    docTitleEl.textContent = mobile ? mobileLabel(full) : full;
    docTitleEl.title = full;
  }
  window.matchMedia('(max-width: 720px)').addEventListener('change', () => renderDocLabel());

  ydoc.getMap('threads').observeDeep(() => {
    redrawThreads();
    if (threadViewId) renderThreadView(threadViewId);
  });
  ydoc.getMap('meta').observe(() => renderDocLabel());

  client.onReady(() => {
    renderDocLabel();
    redrawThreads();
  });

  // --- hotkeys --------------------------------------------------------------
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'm') {
      ev.preventDefault();
      openComposerForSelection();
    }
    if (ev.key === 'Escape') {
      if (!composer.classList.contains('hidden')) hideComposer();
      else if (!threadView.classList.contains('hidden')) closeThreadView();
      else if (shell.classList.contains('threads-open')) closeDrawer();
    }
  });

  addEventListener('beforeunload', () => {
    client.close();
    surface.destroy();
  });
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

/** Persistent one-line notice above the editor (rename origin, deleted file,
 *  diff-unavailable fallback). Distinct from the transient toast. */
function showBanner(msg: string): void {
  const pane = document.getElementById('editor-pane');
  if (!pane) return;
  let b = document.getElementById('diff-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'diff-banner';
    b.className = 'diff-banner';
    pane.insertBefore(b, pane.firstChild);
  }
  b.textContent = msg;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function mobileLabel(full: string): string {
  let s = full;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const parts = s.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? s;
  return base.length <= 32 ? base : `…${base.slice(-31)}`;
}

function formatTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function makeBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
