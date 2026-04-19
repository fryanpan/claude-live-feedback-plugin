import { type Thread, type User, readDocMeta, resolveUser } from '@feedback/core';
import { connect } from './client.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import { ThreadPanel, type ThreadTab } from './threads.ts';

const DEFAULT_WS_PATH = (docId: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}?type=markdown`;

interface Selection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
}

function docIdFromPath(): string {
  const m = location.pathname.match(/^\/review\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1] ?? '') : 'default';
}

/**
 * iOS Safari puts `position:fixed` elements on the LAYOUT viewport, which
 * doesn't shrink when the keyboard appears — so bottom:16px ends up
 * behind the keyboard. Track the visual viewport and publish a
 * --kb-bottom CSS variable that every bottom-docked UI element rises by.
 */
function wireKeyboardInset(): void {
  const vv = window.visualViewport;
  const apply = () => {
    let kb = 0;
    if (vv) {
      kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    }
    document.documentElement.style.setProperty('--kb-bottom', `${Math.round(kb)}px`);
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('orientationchange', () => setTimeout(apply, 120));
}

async function boot(): Promise<void> {
  wireKeyboardInset();
  const docId = docIdFromPath();
  const url = new URL(location.href);
  const asParam = url.searchParams.get('as');
  const user: User = resolveUser(asParam, {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
  });
  renderMe(user);

  const client = connect(DEFAULT_WS_PATH(docId));
  const { ydoc, awareness } = client;
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  const editorMount = el<HTMLElement>('editor');
  const threadsListEl = el<HTMLElement>('threads-list');
  const docTitleEl = el<HTMLElement>('doc-title');
  const composer = el<HTMLElement>('composer');
  const composerText = el<HTMLTextAreaElement>('composer-text');
  const composerAvatar = el<HTMLElement>('composer-avatar');
  const composerScrim = el<HTMLElement>('composer-scrim');
  const selectionBar = el<HTMLElement>('selection-bar');
  const selectionSnippet = el<HTMLElement>('selection-bar-snippet');
  const selectionCommentBtn = el<HTMLButtonElement>('selection-comment');
  const formatBar = el<HTMLElement>('format-bar');
  const toggleFormat = el<HTMLButtonElement>('toggle-format');
  const toggleThreads = el<HTMLButtonElement>('toggle-threads');
  const threadsCount = el<HTMLElement>('threads-count');
  const closeThreads = el<HTMLButtonElement>('close-threads');
  const scrim = el<HTMLElement>('threads-scrim');
  const shell = document.getElementById('shell') as HTMLElement;

  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => refreshSelectionState(),
    onUpdate: () => redrawThreads(),
    user: { name: user.name, color: user.color },
  });

  const welcomeSeed = `# ${docId}\n\nWelcome. Select any text to leave a comment — the bar slides up from the bottom. Tap the 💬 in the top bar to see all threads. Tap "Aa" to show formatting.\n`;

  // =========================================================================
  // SELECTION → bottom action bar
  //   iOS-friendly: the bar is docked at the bottom of the visual viewport,
  //   which means it lands ABOVE Safari's chrome AND ABOVE the keyboard when
  //   we later raise it on focus. No per-selection positioning maths.
  // =========================================================================

  let selection: Selection | null = null;
  let selectionSettled = false;
  let isDragging = false;

  function refreshSelectionState(): void {
    const sel = editor.getSelectionRel();
    if (sel) selection = sel;
    if (!sel) {
      selectionSettled = false;
      hideSelectionBar();
    }
  }

  function showSelectionBar(snippet: string): void {
    selectionSnippet.textContent = snippet;
    selectionBar.classList.remove('hidden');
  }
  function hideSelectionBar(): void {
    selectionBar.classList.add('hidden');
  }

  selectionCommentBtn.addEventListener('click', () => {
    openComposerForSelection();
  });
  // preventDefault on touchstart/mousedown so tapping the bar doesn't blur
  // the editor before the click handler fires — otherwise selection collapses.
  for (const type of ['mousedown', 'touchstart']) {
    selectionBar.addEventListener(type, (ev) => {
      const t = (ev.target as HTMLElement).closest('button');
      if (t) ev.preventDefault();
    });
  }

  editor.editor.view.dom.addEventListener('pointerdown', () => {
    isDragging = true;
    selectionSettled = false;
    hideSelectionBar();
  });
  window.addEventListener('pointerup', () => {
    isDragging = false;
    // give the browser a tick to settle the selection (especially on iOS)
    setTimeout(() => {
      selectionSettled = true;
      const sel = editor.getSelectionRel();
      if (sel && !editor.editor.state.selection.empty) {
        selection = sel;
        showSelectionBar(sel.snippet);
      } else {
        hideSelectionBar();
      }
    }, 30);
  });
  editor.editor.view.dom.addEventListener('keyup', (ev) => {
    if (ev.shiftKey || ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') {
      selectionSettled = true;
      refreshSelectionState();
      if (selection && !editor.editor.state.selection.empty) showSelectionBar(selection.snippet);
    }
  });
  editor.editor.on('selectionUpdate', () => {
    if (editor.editor.state.selection.empty) {
      selectionSettled = false;
      hideSelectionBar();
    } else if (selectionSettled && !isDragging) {
      const sel = editor.getSelectionRel();
      if (sel) {
        selection = sel;
        showSelectionBar(sel.snippet);
      }
    }
  });

  // =========================================================================
  // COMPOSER (Notion-style slim sheet)
  //   The doc stays behind a dim scrim with the selection still visible
  //   (we do NOT re-quote the snippet inside the composer — the user sees
  //   what they're commenting on in place). On open we scroll the editor
  //   so the selection sits above the composer + keyboard.
  // =========================================================================

  // Seed the composer avatar with the current user's color + initial
  composerAvatar.style.background = user.color;
  composerAvatar.textContent = (user.name[0] ?? '?').toUpperCase();

  function openComposerForSelection(): void {
    const current = editor.getSelectionRel();
    const use = current ?? selection;
    if (!use || editor.editor.state.selection.empty) {
      showToast('Select some text first to leave a comment.');
      return;
    }
    selection = use;
    composer.classList.remove('hidden');
    composerScrim.classList.remove('hidden');
    document.body.classList.add('composer-open');
    hideSelectionBar();
    composerText.value = '';
    setTimeout(() => {
      composerText.focus();
      ensureSelectionVisible();
    }, 30);
  }
  function hideComposer(): void {
    composer.classList.add('hidden');
    composerScrim.classList.add('hidden');
    document.body.classList.remove('composer-open');
  }
  composerScrim.addEventListener('click', hideComposer);

  function ensureSelectionVisible(): void {
    // When the composer occupies the bottom ~200px of the viewport, we want
    // the selection to sit comfortably above it. Compute the selection's
    // screen rect and scroll the editor so it's roughly 35% from the top.
    try {
      const { from } = editor.editor.state.selection;
      const coords = editor.editor.view.coordsAtPos(from);
      const viewportH = window.visualViewport?.height ?? window.innerHeight;
      const desiredTop = viewportH * 0.25;
      const deltaY = coords.top - desiredTop;
      const editorScroll = document.getElementById('editor');
      if (editorScroll) editorScroll.scrollBy({ top: deltaY, behavior: 'smooth' });
    } catch {}
  }

  // =========================================================================
  // THREADS DRAWER
  //   Hidden by default on mobile. Opened via the 💬 button in the top bar,
  //   the tap-highlight handler, or automatically after posting a comment so
  //   the user can see their new thread in context.
  //   Tabs: Open (default) / Resolved / All.
  // =========================================================================

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
  function toggleDrawer(): void {
    if (shell.classList.contains('threads-open')) closeDrawer();
    else openDrawer();
  }
  toggleThreads.addEventListener('click', toggleDrawer);
  closeThreads.addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  // Desktop layout shows the drawer inline; open by default there
  if (window.matchMedia('(min-width: 901px)').matches) openDrawer();

  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.threads-tabs .tab'));
  tabButtons.forEach((b) => {
    b.addEventListener('click', () => {
      const tab = (b.getAttribute('data-tab') ?? 'open') as ThreadTab;
      threadsPanel.setTab(tab);
      for (const x of tabButtons) x.classList.toggle('active', x === b);
    });
  });

  const threadsPanel = new ThreadPanel({
    container: threadsListEl,
    currentUser: user,
    onThreadClick: (id) => {
      const range = resolveThreadRange(id);
      if (range) {
        editor.scrollToPos(range.from);
        editor.pulseRange(range.from, range.to);
      }
      threadsPanel.setActive(id);
      refreshThreadDecorations(id);
      // On mobile, close drawer to return to the doc after tapping
      if (!window.matchMedia('(min-width: 901px)').matches) closeDrawer();
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
      await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/resolve`,
        { method: 'POST' },
      );
    },
    onReopen: async (id) => {
      await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reopen`,
        { method: 'POST' },
      );
    },
    onReanchor: (id) => {
      const sel = editor.getSelectionRel();
      if (!sel) {
        showToast('Select new text first, then click Re-anchor.');
        return;
      }
      void fetch(
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
    },
  });

  // Tap-on-highlight in the editor → open the associated thread in the drawer.
  // ProseMirror handles the click itself (placing the cursor), so we attach a
  // document-level listener that inspects the event target.
  editorMount.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('.thread-range');
    if (!t) return;
    const threadId = t.getAttribute('data-thread-id');
    if (!threadId) return;
    ev.preventDefault();
    ev.stopPropagation();
    openDrawer();
    threadsPanel.setActive(threadId);
    refreshThreadDecorations(threadId);
    const range = resolveThreadRange(threadId);
    if (range) editor.pulseRange(range.from, range.to);
  });

  function resolveThreadRange(threadId: string): { from: number; to: number } | null {
    const doc = ydoc.getMap('threads').get(threadId) as import('yjs').Map<unknown> | undefined;
    if (!doc) return null;
    const anchor = doc.get('anchor') as
      | {
          kind: 'text-range';
          startRel: Uint8Array | number[];
          endRel: Uint8Array | number[];
        }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    const startRel =
      anchor.startRel instanceof Uint8Array ? anchor.startRel : new Uint8Array(anchor.startRel);
    const endRel =
      anchor.endRel instanceof Uint8Array ? anchor.endRel : new Uint8Array(anchor.endRel);
    return editor.resolveRel(startRel, endRel);
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
    editor.setThreadRanges(ranges, activeId);
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
        if (!r) {
          displayAnchor = { kind: 'orphan', original: anchorRaw, lastSeenAt: Date.now() };
        }
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

  ydoc.getMap('threads').observeDeep(() => redrawThreads());
  const meta = ydoc.getMap('meta');
  meta.observe(() => {
    const m = readDocMeta(ydoc);
    docTitleEl.textContent = m.title ?? m.docId;
  });
  client.onReady(() => {
    const m = readDocMeta(ydoc);
    docTitleEl.textContent = m.title ?? m.docId;
    editor.migrateLegacyIfNeeded();
    editor.seedIfEmpty(welcomeSeed);
    redrawThreads();
  });

  // =========================================================================
  // FORMATTING TOOLBAR — collapsed by default. Aa button toggles it.
  // =========================================================================
  toggleFormat.addEventListener('click', () => {
    const collapsed = formatBar.classList.toggle('is-collapsed');
    toggleFormat.setAttribute('aria-pressed', String(!collapsed));
  });
  wireFormatBar(editor);

  // =========================================================================
  // HOTKEYS
  // =========================================================================
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'm') {
      ev.preventDefault();
      openComposerForSelection();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.shiftKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      toggleFormat.click();
    }
    if (ev.key === 'Escape') {
      if (!composer.classList.contains('hidden')) hideComposer();
      else if (shell.classList.contains('threads-open')) closeDrawer();
    }
  });

  // =========================================================================
  // COMPOSER: submit / cancel, Enter-to-post, post-feedback pulse
  // =========================================================================
  // (No cancel button — tap the scrim or press Escape to dismiss.)
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
      const newId = body.thread.id;
      hideComposer();
      showToast('✓ Comment posted');
      // Post-feedback: wait for the Yjs update to land the highlight, then
      // scroll it into view + pulse so the user can see where it landed.
      setTimeout(() => {
        const r = resolveThreadRange(newId);
        if (r) {
          editor.scrollToPos(r.from);
          editor.pulseRange(r.from, r.to);
        }
      }, 150);
    } catch {
      showToast('Failed to post comment');
    } finally {
      submitBtn.disabled = false;
    }
  }

  addEventListener('beforeunload', () => {
    client.close();
    editor.destroy();
  });
}

function wireFormatBar(editor: EditorHandle): void {
  const bar = document.getElementById('format-bar');
  if (!bar) return;
  const chain = () => editor.editor.chain().focus();
  const handlers: Record<string, () => void> = {
    bold: () => chain().toggleBold().run(),
    italic: () => chain().toggleItalic().run(),
    h1: () => chain().toggleHeading({ level: 1 }).run(),
    h2: () => chain().toggleHeading({ level: 2 }).run(),
    h3: () => chain().toggleHeading({ level: 3 }).run(),
    bulletList: () => chain().toggleBulletList().run(),
    orderedList: () => chain().toggleOrderedList().run(),
    blockquote: () => chain().toggleBlockquote().run(),
    code: () => chain().toggleCode().run(),
    codeBlock: () => chain().toggleCodeBlock().run(),
    hr: () => chain().setHorizontalRule().run(),
    link: () => {
      const existing = editor.editor.getAttributes('link').href as string | undefined;
      const href = prompt('Link URL', existing ?? 'https://');
      if (href === null) return;
      if (href === '') chain().unsetLink().run();
      else chain().setLink({ href }).run();
    },
  };
  bar.addEventListener('mousedown', (ev) => {
    const t = (ev.target as HTMLElement).closest('button');
    if (t) ev.preventDefault();
  });
  bar.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('button');
    if (!t) return;
    const cmd = t.getAttribute('data-cmd');
    if (cmd && handlers[cmd]) handlers[cmd]();
  });

  const refresh = () => {
    for (const btn of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) {
      const cmd = btn.getAttribute('data-cmd');
      let active = false;
      switch (cmd) {
        case 'bold':
          active = editor.editor.isActive('bold');
          break;
        case 'italic':
          active = editor.editor.isActive('italic');
          break;
        case 'h1':
          active = editor.editor.isActive('heading', { level: 1 });
          break;
        case 'h2':
          active = editor.editor.isActive('heading', { level: 2 });
          break;
        case 'h3':
          active = editor.editor.isActive('heading', { level: 3 });
          break;
        case 'bulletList':
          active = editor.editor.isActive('bulletList');
          break;
        case 'orderedList':
          active = editor.editor.isActive('orderedList');
          break;
        case 'blockquote':
          active = editor.editor.isActive('blockquote');
          break;
        case 'code':
          active = editor.editor.isActive('code');
          break;
        case 'codeBlock':
          active = editor.editor.isActive('codeBlock');
          break;
        case 'link':
          active = editor.editor.isActive('link');
          break;
      }
      btn.classList.toggle('active', active);
    }
  };
  editor.editor.on('selectionUpdate', refresh);
  editor.editor.on('transaction', refresh);
}

function renderMe(user: User): void {
  const me = document.getElementById('me');
  if (!me) return;
  me.innerHTML = `<span class="swatch" style="background:${user.color}"></span>${user.name}`;
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

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

void boot();
