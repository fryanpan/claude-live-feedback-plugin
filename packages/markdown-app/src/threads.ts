import type { Thread, User } from '@feedback/core';

export interface ThreadPanelOpts {
  container: HTMLElement;
  currentUser: User;
  onThreadClick: (threadId: string) => void;
  onReply: (threadId: string, text: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
  onReanchor: (threadId: string) => void;
}

export class ThreadPanel {
  private activeId: string | null = null;
  private threads: Thread[] = [];
  private statusMap = new Map<string, 'open' | 'resolved' | 'orphan'>();
  /** Hash of what we last rendered. Skip re-render when nothing display-relevant changed. */
  private lastRenderKey = '';

  constructor(private opts: ThreadPanelOpts) {}

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    this.statusMap.clear();
    for (const t of threads) {
      const s =
        t.anchor.kind === 'orphan' ? 'orphan' : t.status === 'resolved' ? 'resolved' : 'open';
      this.statusMap.set(t.id, s);
    }
    this.render();
  }

  setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.render();
  }

  getStatus(threadId: string): 'open' | 'resolved' | 'orphan' | undefined {
    return this.statusMap.get(threadId);
  }

  /** Cheap fingerprint used to short-circuit renders when nothing user-visible changed. */
  private computeKey(): string {
    const parts: string[] = [];
    for (const t of this.threads) {
      parts.push(`${t.id}:${this.statusMap.get(t.id)}:${t.commentCount}:${t.lastActivity}`);
    }
    return `${this.activeId ?? ''}|${parts.join('|')}`;
  }

  private render(): void {
    const c = this.opts.container;
    const key = this.computeKey();
    if (key === this.lastRenderKey) return;

    // Preserve pending reply input so live edits elsewhere don't wipe it.
    const pendingReplies = new Map<string, string>();
    for (const existing of Array.from(c.querySelectorAll<HTMLElement>('.thread'))) {
      const id = existing.getAttribute('data-thread-id');
      const ta = existing.querySelector<HTMLTextAreaElement>('textarea');
      if (id && ta && ta.value) pendingReplies.set(id, ta.value);
    }

    c.innerHTML = '';

    const open = this.threads.filter((t) => this.statusMap.get(t.id) === 'open');
    const resolved = this.threads.filter((t) => this.statusMap.get(t.id) === 'resolved');
    const orphan = this.threads.filter((t) => this.statusMap.get(t.id) === 'orphan');

    if (open.length === 0 && resolved.length === 0 && orphan.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'section-heading';
      empty.textContent = 'No threads yet. Select text → leave a comment.';
      c.appendChild(empty);
      this.lastRenderKey = key;
      return;
    }

    if (open.length > 0) {
      c.appendChild(this.heading(`Open (${open.length})`));
      for (const t of open) c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
    }
    if (orphan.length > 0) {
      c.appendChild(this.heading(`Orphaned (${orphan.length})`));
      for (const t of orphan) c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
    }
    if (resolved.length > 0) {
      c.appendChild(this.heading(`Resolved (${resolved.length})`));
      for (const t of resolved) c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
    }
    this.lastRenderKey = key;
  }

  private heading(label: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = label;
    return h;
  }

  private renderThread(t: Thread, pendingReply?: string): HTMLElement {
    const status = this.statusMap.get(t.id) ?? 'open';
    const el = document.createElement('div');
    el.className = `thread status-${status}`;
    if (status === 'resolved') el.classList.add('resolved');
    if (status === 'orphan') el.classList.add('orphan');
    if (this.activeId === t.id) el.classList.add('active');
    el.setAttribute('data-thread-id', t.id);

    // Anchor snippet ("what you commented on") — thread's quote line
    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = snippetText(t);
    el.appendChild(snippet);

    // Comments list. The first comment's author row doubles as the thread
    // header: it owns the status dot so we don't repeat author/time
    // twice (Google Docs / Notion convention).
    const comments = document.createElement('div');
    comments.className = 'comments';
    t.comments.forEach((c, idx) => {
      const row = document.createElement('div');
      row.className = 'comment';
      if (idx === 0) row.classList.add('first');

      const authorRow = document.createElement('div');
      authorRow.className = 'author';
      if (idx === 0) {
        const dot = document.createElement('span');
        dot.className = 'status-dot';
        authorRow.appendChild(dot);
      }
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = c.author.color;
      authorRow.appendChild(swatch);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.author.name;
      authorRow.appendChild(name);
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(c.ts);
      authorRow.appendChild(time);

      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = c.text;

      row.appendChild(authorRow);
      row.appendChild(body);
      comments.appendChild(row);
    });
    el.appendChild(comments);

    // Reply area (shown when active)
    const reply = document.createElement('div');
    reply.className = 'thread-reply';
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = `Reply as ${this.opts.currentUser.name}…`;
    if (pendingReply) ta.value = pendingReply;
    const submitReply = () => {
      const text = ta.value.trim();
      if (!text) return;
      this.opts.onReply(t.id, text);
      ta.value = '';
    };
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        submitReply();
      }
    });
    reply.appendChild(ta);
    const actions = document.createElement('div');
    actions.className = 'thread-actions';
    actions.appendChild(btn('Reply', 'primary', submitReply));
    if (status === 'resolved') {
      actions.appendChild(btn('Reopen', '', () => this.opts.onReopen(t.id)));
    } else {
      actions.appendChild(btn('Resolve', '', () => this.opts.onResolve(t.id)));
    }
    if (status === 'orphan') {
      actions.appendChild(btn('Re-anchor…', '', () => this.opts.onReanchor(t.id)));
    }
    reply.appendChild(actions);
    el.appendChild(reply);

    el.addEventListener('click', (ev) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
      this.opts.onThreadClick(t.id);
    });

    return el;
  }
}

function btn(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', on);
  return b;
}

function snippetText(t: Thread): string {
  if (t.anchor.kind === 'orphan') {
    return t.anchor.original.snippet.text;
  }
  return t.anchor.snippet.text;
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d`;
  // Older: short month+day like "Apr 18" instead of a full datetime, which
  // is too noisy to squeeze next to an author name on mobile.
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
