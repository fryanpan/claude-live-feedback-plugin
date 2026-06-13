import type { Thread, User } from '@feedback/core';

export type ThreadTab = 'open' | 'resolved' | 'all';

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
  private tab: ThreadTab = 'open';
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
    // Force re-render regardless of fingerprint match
    this.lastRenderKey = '';
    this.render();
  }

  /**
   * Bring a thread fully into the panel: switch to a tab that shows it (so
   * clicking a resolved highlight while on the 'open' tab still surfaces it),
   * mark it active, and scroll it into view. This is the doc→panel half of
   * "click a highlight, see its comment" — the editor scroll was already
   * wired; the panel scroll was not.
   */
  revealThread(id: string): void {
    const status = this.statusMap.get(id);
    if (status && this.tab !== 'all') {
      const wantTab: ThreadTab = status === 'resolved' ? 'resolved' : 'open';
      if (this.tab !== wantTab) this.tab = wantTab;
    }
    this.activeId = id;
    this.lastRenderKey = '';
    this.render();
    this.scrollActiveIntoView();
  }

  private scrollActiveIntoView(): void {
    if (!this.activeId) return;
    const sel =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(this.activeId) : this.activeId;
    const row = this.opts.container.querySelector<HTMLElement>(`.thread[data-thread-id="${sel}"]`);
    // 'start', not 'nearest': the active thread expands (comments + reply box)
    // and is often taller than the panel viewport — 'nearest' would land the
    // user on the reply box at the bottom. Align the top so they see the
    // comment from its start.
    row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  setTab(tab: ThreadTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.lastRenderKey = '';
    this.render();
  }

  getStatus(threadId: string): 'open' | 'resolved' | 'orphan' | undefined {
    return this.statusMap.get(threadId);
  }

  countByStatus(): { open: number; resolved: number; orphan: number } {
    let open = 0;
    let resolved = 0;
    let orphan = 0;
    for (const s of this.statusMap.values()) {
      if (s === 'open') open++;
      else if (s === 'resolved') resolved++;
      else if (s === 'orphan') orphan++;
    }
    return { open, resolved, orphan };
  }

  /** Cheap fingerprint used to short-circuit renders when nothing user-visible changed. */
  private computeKey(): string {
    const parts: string[] = [];
    for (const t of this.threads) {
      parts.push(`${t.id}:${this.statusMap.get(t.id)}:${t.commentCount}:${t.lastActivity}`);
    }
    return `${this.tab}|${this.activeId ?? ''}|${parts.join('|')}`;
  }

  private filtered(): Thread[] {
    if (this.tab === 'open') {
      return this.threads.filter(
        (t) => this.statusMap.get(t.id) === 'open' || this.statusMap.get(t.id) === 'orphan',
      );
    }
    if (this.tab === 'resolved') {
      return this.threads.filter((t) => this.statusMap.get(t.id) === 'resolved');
    }
    return this.threads;
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
    const visible = this.filtered();
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'threads-empty';
      empty.textContent =
        this.tab === 'open'
          ? 'No open comments. Select text in the doc to leave one.'
          : this.tab === 'resolved'
            ? 'Nothing resolved yet.'
            : 'No comments on this doc yet.';
      c.appendChild(empty);
      this.lastRenderKey = key;
      return;
    }

    // For the Open tab, split Open vs Orphaned as two sub-sections so the
    // user can see broken anchors distinctly. Otherwise flat list ordered
    // by most-recent activity.
    if (this.tab === 'open') {
      const open = visible.filter((t) => this.statusMap.get(t.id) === 'open');
      const orphan = visible.filter((t) => this.statusMap.get(t.id) === 'orphan');
      if (open.length > 0) {
        c.appendChild(this.heading(`Open (${open.length})`));
        for (const t of sortByActivity(open))
          c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
      }
      if (orphan.length > 0) {
        c.appendChild(this.heading(`Orphaned (${orphan.length}) — re-anchor needed`));
        for (const t of sortByActivity(orphan))
          c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
      }
    } else {
      for (const t of sortByActivity(visible))
        c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
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

    const snippet = document.createElement('div');
    snippet.className = 'snippet';
    snippet.textContent = snippetText(t);
    el.appendChild(snippet);

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

    // Reply area (shown only when this thread is active)
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

function sortByActivity(ts: Thread[]): Thread[] {
  return [...ts].sort((a, b) => b.lastActivity - a.lastActivity);
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
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
