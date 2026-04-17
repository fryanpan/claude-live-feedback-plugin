import {
  type Thread,
  type User,
  anchors,
  getContent,
  listThreads,
  readDocMeta,
  resolveUser,
} from '@feedback/core';
import { connect } from './client.ts';
import { type EditorHandle, type ThreadRange, createEditor } from './editor.ts';
import { renderMarkdown } from './preview.ts';
import { ThreadPanel } from './threads.ts';

const DEFAULT_WS_PATH = (docId: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/y/${encodeURIComponent(docId)}`;

interface Selection {
  start: number;
  end: number;
  snippet: string;
}

function docIdFromPath(): string {
  // /review/<docId>
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
  const ytext = getContent(ydoc);
  awareness.setLocalStateField('user', { name: user.name, color: user.color });

  const editorMount = document.getElementById('editor') as HTMLElement;
  const preview = document.getElementById('preview') as HTMLElement;
  const threadsListEl = document.getElementById('threads-list') as HTMLElement;
  const docTitleEl = document.getElementById('doc-title') as HTMLElement;
  const composer = document.getElementById('composer') as HTMLElement;
  const composerText = document.getElementById('composer-text') as HTMLTextAreaElement;
  const composerSnippet = document.getElementById('composer-snippet') as HTMLElement;

  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    ytext,
    awareness,
    onSelectionChange: () => refreshComposerState(),
  });

  let selection: Selection | null = null;
  function refreshComposerState(): void {
    const sel = editor.getSelectionOffsets();
    if (!sel) {
      selection = null;
      hideComposer();
      return;
    }
    const snippet = editor.getText().slice(sel.start, sel.end);
    selection = { start: sel.start, end: sel.end, snippet };
  }

  function showComposerForSelection(): void {
    if (!selection || selection.start === selection.end) {
      showToast('Select some text first to leave a comment.');
      return;
    }
    composer.classList.remove('hidden');
    composerSnippet.textContent = truncate(selection.snippet, 160);
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
      const offsets = resolveThreadOffsets(id);
      if (offsets) editor.scrollToOffset(offsets.start);
      threadsPanel.setActive(id);
      editor.setActiveThread(id);
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
        {
          method: 'POST',
        },
      );
    },
    onReopen: async (id) => {
      await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reopen`,
        {
          method: 'POST',
        },
      );
    },
    onReanchor: (id) => {
      // For text-range orphans, prompt the user to select a new range and submit
      const sel = editor.getSelectionOffsets();
      if (!sel) {
        showToast('Select the new text, then click Re-anchor again.');
        return;
      }
      const anchor = anchors.TextRange.createFromOffsets(ytext, sel.start, sel.end);
      void fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reanchor`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ anchor }),
        },
      );
    },
  });

  function resolveThreadOffsets(threadId: string): { start: number; end: number } | null {
    const thread = listThreads(ydoc).find((t) => t.id === threadId);
    if (!thread) return null;
    if (thread.anchor.kind === 'text-range') {
      const r = anchors.TextRange.resolve(thread.anchor, { doc: ydoc, ytext });
      return r.ok ? { start: r.start, end: r.end } : null;
    }
    return null;
  }

  function computeRanges(): ThreadRange[] {
    const all = listThreads(ydoc);
    const out: ThreadRange[] = [];
    for (const t of all) {
      if (t.anchor.kind === 'text-range') {
        const r = anchors.TextRange.resolve(t.anchor, { doc: ydoc, ytext });
        if (r.ok) {
          out.push({
            threadId: t.id,
            start: r.start,
            end: r.end,
            status: t.status,
          });
        }
      }
    }
    return out;
  }

  function orphanSweep(): Thread[] {
    // If a text-range anchor's range is deleted, the server doesn't automatically
    // mark it orphan (threads only fire on explicit writes). We compute the
    // display-time status here and forward to the panel, but we also POST a
    // reanchor to convert the stored anchor for next session.
    const all = listThreads(ydoc);
    const annotated: Thread[] = all.map((t) => {
      if (t.anchor.kind === 'text-range') {
        const r = anchors.TextRange.resolve(t.anchor, { doc: ydoc, ytext });
        if (!r.ok) {
          return { ...t, anchor: { kind: 'orphan', original: t.anchor, lastSeenAt: Date.now() } };
        }
      }
      return t;
    });
    return annotated;
  }

  function redrawThreads(): void {
    const all = orphanSweep();
    threadsPanel.setThreads(all);
    editor.setThreadRanges(computeRanges());
  }

  async function renderPreview(): Promise<void> {
    const md = ytext.toString();
    await renderMarkdown(md, preview);
  }

  // Hook Yjs updates — debounce the expensive paths
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let threadsTimer: ReturnType<typeof setTimeout> | null = null;
  ytext.observe(() => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void renderPreview(), 150);
    if (threadsTimer) clearTimeout(threadsTimer);
    // Text-range anchors only shift under edits — we only need to refresh the
    // thread panel when anchor resolution might have flipped, which is at most
    // a couple of times per second of typing. setThreads() is now a no-op
    // when the fingerprint hasn't changed, so this is safe to call often.
    threadsTimer = setTimeout(() => redrawThreads(), 200);
  });
  ydoc.getMap('threads').observeDeep(() => {
    // Thread map changes (new thread, reply, status) — render immediately.
    redrawThreads();
  });
  const meta = ydoc.getMap('meta');
  meta.observe(() => {
    const m = readDocMeta(ydoc);
    docTitleEl.textContent = m.title ?? m.docId;
  });

  client.onReady(() => {
    const m = readDocMeta(ydoc);
    docTitleEl.textContent = m.title ?? m.docId;
    // If the doc is empty, seed with a helpful placeholder (once)
    if (ytext.length === 0 && !meta.get('seeded')) {
      ydoc.transact(() => {
        ytext.insert(
          0,
          `# ${m.title ?? m.docId}\n\nWelcome. Select any text and click **Comment** to leave a note.\n\n- Edits sync live between everyone on this link.\n- The agent can also observe events and post via MCP.\n\n\`\`\`mermaid\nflowchart LR\n  Bryan -- clicks --> Text\n  Agent -- edits --> Text\n  Text -- syncs --> Both\n\`\`\`\n`,
        );
        meta.set('seeded', true);
      });
    }
    void renderPreview();
    redrawThreads();
  });

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

  // Toolbar — mode toggle
  document.querySelectorAll<HTMLButtonElement>('.mode-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      const mode = b.getAttribute('data-mode') ?? 'split';
      const main = document.getElementById('main') as HTMLElement;
      main.className = `mode-${mode}`;
      document
        .querySelectorAll('.mode-toggle button')
        .forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  // Copy link buttons
  function copyLink(asName: string): void {
    const url = new URL(location.href);
    url.searchParams.set('as', asName);
    navigator.clipboard.writeText(url.toString()).then(
      () => showToast(`Link for ${asName} copied`),
      () => showToast('Could not copy — here it is: ' + url.toString()),
    );
  }
  document.getElementById('copy-bryan')?.addEventListener('click', () => copyLink('bryan'));
  document.getElementById('copy-agent')?.addEventListener('click', () => copyLink('agent'));

  // Composer controls
  document.getElementById('composer-cancel')?.addEventListener('click', hideComposer);
  document.getElementById('composer-submit')?.addEventListener('click', async () => {
    const text = composerText.value.trim();
    if (!text) return;
    if (!selection || selection.start === selection.end) {
      showToast('Lost the selection — try again.');
      return;
    }
    const anchor = anchors.TextRange.createFromOffsets(ytext, selection.start, selection.end);
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

  // A floating "Comment" button appears whenever there's a selection
  const floatBtn = document.createElement('button');
  floatBtn.type = 'button';
  floatBtn.textContent = 'Comment';
  floatBtn.className = 'primary';
  floatBtn.style.cssText =
    'position:fixed;z-index:900;padding:6px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;box-shadow:var(--shadow);font-size:13px;display:none;';
  document.body.appendChild(floatBtn);
  floatBtn.addEventListener('mousedown', (ev) => ev.preventDefault());
  floatBtn.addEventListener('click', () => showComposerForSelection());

  function positionFloatingButton(): void {
    const sel = editor.getSelectionOffsets();
    if (!sel) {
      floatBtn.style.display = 'none';
      return;
    }
    // anchor the button near the end of the selection using CodeMirror's coordsAtPos
    const view = editor.view;
    const coords = view.coordsAtPos(sel.end);
    if (!coords) {
      floatBtn.style.display = 'none';
      return;
    }
    floatBtn.style.display = 'block';
    floatBtn.style.left = `${Math.min(coords.right + 6, window.innerWidth - 110)}px`;
    floatBtn.style.top = `${Math.max(coords.top - 4, 60)}px`;
  }
  editor.view.dom.addEventListener('mouseup', () =>
    setTimeout(() => {
      refreshComposerState();
      positionFloatingButton();
    }, 0),
  );
  editor.view.dom.addEventListener('keyup', () =>
    setTimeout(() => {
      refreshComposerState();
      positionFloatingButton();
    }, 0),
  );

  document.addEventListener('selectionchange', () => positionFloatingButton());

  // Ensure cleanup on unload
  addEventListener('beforeunload', () => client.close());
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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

void boot();
