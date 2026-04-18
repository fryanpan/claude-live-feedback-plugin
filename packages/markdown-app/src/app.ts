import { type Thread, type User, readDocMeta, resolveUser } from '@feedback/core';
import { connect } from './client.ts';
import { type EditorHandle, createEditor } from './editor.ts';
import { ThreadPanel } from './threads.ts';

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

async function boot(): Promise<void> {
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

  const editorMount = document.getElementById('editor') as HTMLElement;
  const threadsListEl = document.getElementById('threads-list') as HTMLElement;
  const docTitleEl = document.getElementById('doc-title') as HTMLElement;
  const composer = document.getElementById('composer') as HTMLElement;
  const composerText = document.getElementById('composer-text') as HTMLTextAreaElement;
  const composerSnippet = document.getElementById('composer-snippet') as HTMLElement;

  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness,
    onSelectionChange: () => refreshComposerState(),
    onUpdate: () => redrawThreads(),
    user: { name: user.name, color: user.color },
  });
  const welcomeSeed = `# ${docId}\n\nWelcome to live feedback. Select any text and click **Comment** to leave a note.\n\n- Edits sync live between everyone on this link.\n- Keyboard: **⌘B** bold · **⌘I** italic · **⌘⌥1-3** headings · **⌘K** link · **⌘E** inline code.\n- Lists: type \`- \` or \`1. \` and press Enter. Tab to indent.\n`;

  let selection: Selection | null = null;
  function refreshComposerState(): void {
    const sel = editor.getSelectionRel();
    // Only *update* from a non-null selection; keep the last non-empty
    // selection around so the Comment toolbar button still has a valid
    // snapshot even if a stray selection update fires between mouseup
    // and click.
    if (sel) selection = sel;
  }

  function showComposerForSelection(): void {
    // Always re-read from the editor so we capture the latest selection,
    // but fall back to the last remembered one if the current state lost
    // the selection (e.g. toolbar click blurred it).
    const current = editor.getSelectionRel();
    const use = current ?? selection;
    if (!use) {
      showToast('Select some text first to leave a comment.');
      return;
    }
    selection = use;
    composer.classList.remove('hidden');
    composerSnippet.textContent = use.snippet;
    composerText.value = '';
    setTimeout(() => composerText.focus(), 0);
  }
  function hideComposer(): void {
    composer.classList.add('hidden');
  }

  const threadsPanel = new ThreadPanel({
    container: threadsListEl,
    currentUser: user,
    onThreadClick: (id) => {
      const range = resolveThreadRange(id);
      if (range) editor.scrollToPos(range.from);
      threadsPanel.setActive(id);
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

  function redrawThreads(): void {
    const all = collectThreads();
    threadsPanel.setThreads(all);
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
      // For text-range anchors, compute display status: orphan if resolveRel fails
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
    // Order matters: migrate any legacy Y.Text content first, then seed a
    // welcome message only if the doc is still empty.
    editor.migrateLegacyIfNeeded();
    editor.seedIfEmpty(welcomeSeed);
    redrawThreads();
  });

  // Formatting toolbar
  wireFormatBar(editor, showComposerForSelection);

  // Global hotkeys
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'm') {
      ev.preventDefault();
      showComposerForSelection();
    }
    if (ev.key === 'Escape' && !composer.classList.contains('hidden')) {
      hideComposer();
    }
  });

  // Copy link buttons
  function copyLink(asName: string): void {
    const u = new URL(location.href);
    u.searchParams.set('as', asName);
    navigator.clipboard.writeText(u.toString()).then(
      () => showToast(`Link for ${asName} copied`),
      () => showToast(`Could not copy — here it is: ${u.toString()}`),
    );
  }
  document.getElementById('copy-bryan')?.addEventListener('click', () => copyLink('bryan'));
  document.getElementById('copy-agent')?.addEventListener('click', () => copyLink('agent'));

  // Composer controls
  document.getElementById('composer-cancel')?.addEventListener('click', hideComposer);
  document.getElementById('composer-submit')?.addEventListener('click', async () => {
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
    const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: user, text, anchor }),
    });
    if (res.ok) {
      hideComposer();
      showToast('Comment posted');
    } else {
      showToast('Failed to post comment');
    }
  });

  // Floating Comment button near selection
  const floatBtn = document.createElement('button');
  floatBtn.type = 'button';
  floatBtn.textContent = 'Comment';
  floatBtn.className = 'floating-comment';
  floatBtn.style.display = 'none';
  document.body.appendChild(floatBtn);
  floatBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
  floatBtn.addEventListener('click', () => showComposerForSelection());

  function positionFloatingButton(): void {
    const sel = editor.getSelectionRel();
    if (!sel) {
      floatBtn.style.display = 'none';
      return;
    }
    const pmSel = editor.editor.state.selection;
    try {
      const end = editor.editor.view.coordsAtPos(pmSel.to);
      floatBtn.style.display = 'block';
      floatBtn.style.left = `${Math.min(end.right + 6, window.innerWidth - 110)}px`;
      floatBtn.style.top = `${Math.max(end.top - 4, 60)}px`;
    } catch {
      floatBtn.style.display = 'none';
    }
  }
  editor.editor.view.dom.addEventListener('mouseup', () =>
    setTimeout(() => {
      refreshComposerState();
      positionFloatingButton();
    }, 0),
  );
  editor.editor.view.dom.addEventListener('keyup', () =>
    setTimeout(() => {
      refreshComposerState();
      positionFloatingButton();
    }, 0),
  );
  document.addEventListener('selectionchange', () => positionFloatingButton());

  addEventListener('beforeunload', () => {
    client.close();
    editor.destroy();
  });
}

function wireFormatBar(editor: EditorHandle, onComment: () => void): void {
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
    undo: () => chain().undo().run(),
    redo: () => chain().redo().run(),
    comment: onComment,
    link: () => {
      const existing = editor.editor.getAttributes('link').href as string | undefined;
      const href = prompt('Link URL', existing ?? 'https://');
      if (href === null) return;
      if (href === '') chain().unsetLink().run();
      else chain().setLink({ href }).run();
    },
  };
  // preventDefault on mousedown so clicking a toolbar button doesn't
  // blur the editor and collapse the selection. This is what made the
  // Comment button think there was no selection on click.
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

  // Reflect active state in the toolbar
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
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

void boot();
