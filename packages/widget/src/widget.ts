import {
  type AnchorContext,
  type ElementAnchor,
  type Thread,
  type User,
  anchors,
  listThreads,
  resolveUser,
} from '@feedback/core';

const { contextMatches, hasContext } = anchors;
import { type WidgetClient, connect } from './client.ts';
import { widgetStyles } from './styles.ts';

/**
 * <claude-feedback-widget> web component
 *
 * Usage:
 *   <script type="module" src="/widget.esm.js"></script>
 *   <script>
 *     FeedbackWidget.init({
 *       serverUrl: 'wss://host.example',  // optional; defaults to same host
 *       docId: 'my-mockup',
 *       user: 'bryan' | 'agent' | null,   // null → anonymous
 *     });
 *   </script>
 */

export interface WidgetOpts {
  serverUrl?: string;
  docId: string;
  user?: string | null;
  /**
   * Initial page/view context. If omitted, the widget auto-captures
   * `location.pathname + location.search + location.hash` and updates
   * it on history navigation. Pass an explicit `view` to declare
   * dynamic UI state ("modal=settings", "tab=billing") so comments
   * anchored in that view don't leak onto the base page.
   */
  context?: AnchorContext;
}

const TAG = 'claude-feedback-widget';
const IGNORE_ATTR = 'data-feedback-widget';

// The host page and the live-feedback server normally live on different ports
// (e.g. Astro dev :4321 vs LF :8788). The widget bundle is served by the LF
// server, so its script origin is the right default for the WS server URL.
// Captured at top-level evaluation time, when document.currentScript still
// points at the loading <script> tag.
const BUNDLE_ORIGIN: string | null = (() => {
  try {
    const s = document.currentScript as HTMLScriptElement | null;
    if (s?.src) return new URL(s.src).origin;
  } catch {}
  return null;
})();

function defaultServerUrl(): string {
  if (BUNDLE_ORIGIN) return BUNDLE_ORIGIN.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

class FeedbackWidgetEl extends HTMLElement {
  private shadow: ShadowRoot;
  private client: WidgetClient | null = null;
  private user: User | null = null;
  private initialized = false;
  private opts: WidgetOpts & { serverUrl: string; user: string | null } = {
    serverUrl: '',
    docId: '',
    user: null,
  };
  private currentContext: AnchorContext = {};
  private historyPatched = false;
  private pickerActive = false;
  private hoverEl: HTMLElement | null = null;
  private overlay: HTMLDivElement | null = null;
  private pinLayer: HTMLDivElement | null = null;
  private panelOpen = false;
  private activeThread: string | null = null;
  private threadPositions = new Map<
    string,
    { el: HTMLElement; status: 'open' | 'resolved' | 'orphan' }
  >();
  private observer: MutationObserver | null = null;
  private statusEl: HTMLElement | null = null;
  private rafId: number | null = null;
  private resizeHandler: (() => void) | null = null;
  private scrollHandler: (() => void) | null = null;
  private vvHandler: (() => void) | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
  }

  init(opts: WidgetOpts): void {
    if (this.initialized) return;
    this.initialized = true;
    this.opts.docId = opts.docId;
    this.opts.user = opts.user ?? null;
    this.opts.serverUrl = opts.serverUrl ?? defaultServerUrl();
    this.user = resolveUser(this.opts.user ?? null, {
      get: (k) => localStorage.getItem(`cfw:${k}`),
      set: (k, v) => localStorage.setItem(`cfw:${k}`, v),
    });
    this.currentContext = {
      url: currentUrl(),
      ...(opts.context?.view ? { view: opts.context.view } : {}),
    };
    this.wireHistoryListeners();
    this.wireVisualViewport();
    this.renderShell();
    this.connect();
    this.startObserver();
  }

  // Auto-initialize from HTML attributes. Lets the canonical "drop in a tag +
  // a script" pattern just work without a separate init() call. The element
  // upgrades on parse, connectedCallback fires once the parser has set
  // attributes, and we derive opts from them. Programmatic FeedbackWidget.init
  // remains supported and is idempotent thanks to the flag in init().
  connectedCallback(): void {
    if (this.initialized) return;
    const docId = this.getAttribute('doc-id');
    if (!docId) return;
    const opts: WidgetOpts = { docId };
    const user = this.getAttribute('user');
    if (user !== null) opts.user = user;
    const serverUrl = this.getAttribute('server-url');
    if (serverUrl) opts.serverUrl = serverUrl;
    const view = this.getAttribute('view');
    if (view) opts.context = { view };
    this.init(opts);
  }

  /**
   * Update the current page/view context at runtime. Merges into the
   * existing context — pass `{ view: undefined }` to clear the view.
   * Call this:
   *   - when opening/closing a modal, drawer, or other transient surface
   *   - when your SPA changes "mode" in a way pathname doesn't capture
   *   - after a route change if your router doesn't use pushState
   * The `url` field is auto-managed from `location`; you normally only
   * need to touch `view`.
   */
  setContext(partial: Partial<AnchorContext>): void {
    const next: AnchorContext = {};
    const url = 'url' in partial ? partial.url : this.currentContext.url;
    const view = 'view' in partial ? partial.view : this.currentContext.view;
    if (url) next.url = url;
    if (view) next.view = view;
    this.currentContext = next;
    this.scheduleRender();
  }

  getContext(): AnchorContext {
    return { ...this.currentContext };
  }

  // Mobile Safari overlays the URL bar on top of `position: fixed` content
  // when the layout viewport is taller than the visual viewport. Without this
  // the FAB hides behind the URL bar on first paint until the user scrolls.
  // The same fix handles iOS keyboard pop-up moving the visual viewport up.
  private wireVisualViewport(): void {
    if (this.vvHandler) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      this.style.setProperty('--lf-vv-bottom', `${Math.round(overlap)}px`);
    };
    this.vvHandler = update;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }

  private wireHistoryListeners(): void {
    if (this.historyPatched) return;
    this.historyPatched = true;
    const emit = () => {
      this.currentContext = {
        ...this.currentContext,
        url: currentUrl(),
      };
      this.scheduleRender();
    };
    window.addEventListener('popstate', emit);
    window.addEventListener('hashchange', emit);
    // Patch pushState/replaceState so SPAs that change routes without
    // firing popstate still refresh context.
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = history[name].bind(history);
      history[name] = (...args: [unknown, string, string | URL | null | undefined]) => {
        const ret = orig(...args);
        emit();
        return ret;
      };
    }
  }

  disconnectedCallback(): void {
    try {
      this.client?.close();
    } catch {}
    try {
      this.observer?.disconnect();
    } catch {}
    try {
      this.overlay?.remove();
    } catch {}
    if (this.rafId != null) {
      try {
        cancelAnimationFrame(this.rafId);
      } catch {}
      this.rafId = null;
    }
    if (this.resizeHandler) {
      try {
        window.removeEventListener('resize', this.resizeHandler);
      } catch {}
    }
    if (this.scrollHandler) {
      try {
        window.removeEventListener('scroll', this.scrollHandler);
      } catch {}
    }
    if (this.vvHandler && window.visualViewport) {
      try {
        window.visualViewport.removeEventListener('resize', this.vvHandler);
        window.visualViewport.removeEventListener('scroll', this.vvHandler);
      } catch {}
    }
  }

  // --- Connect ---

  private connect(): void {
    // The server seeds meta (type, sourceUrl) before the WS upgrade, so the
    // widget never needs to write meta itself — avoids the multi-client race
    // where two widgets both observe an empty meta and both transact.
    const qs = new URLSearchParams({
      type: 'mockup',
      sourceUrl: location.href,
    });
    const url = `${this.opts.serverUrl}/y/${encodeURIComponent(this.opts.docId)}?${qs.toString()}`;
    this.client = connect(url);
    this.client.onStatus((s) => {
      if (this.statusEl) {
        this.statusEl.textContent =
          s === 'open' ? 'online' : s === 'connecting' ? 'connecting…' : 'offline';
        this.statusEl.className = `status status-${s}`;
      }
    });
    const threadsMap = this.client.ydoc.getMap('threads');
    threadsMap.observeDeep(() => this.scheduleRender());
    this.client.onReady(() => this.scheduleRender());
  }

  // --- Shell UI (Shadow DOM) ---

  private renderShell(): void {
    const style = document.createElement('style');
    style.textContent = widgetStyles;
    this.shadow.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.type = 'button';
    fab.title = 'Feedback';
    fab.innerHTML = '<span class="fab-icon">✎</span>';
    fab.addEventListener('click', () => this.togglePanel());
    this.shadow.appendChild(fab);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <header class="panel-header">
        <div class="title">Feedback</div>
        <span class="status status-connecting">connecting…</span>
        <button class="icon-btn close-panel" title="Close">×</button>
      </header>
      <div class="panel-actions">
        <button class="primary pick-btn">Comment on element…</button>
        <div class="me"></div>
      </div>
      <div class="panel-threads"></div>
    `;
    this.shadow.appendChild(panel);

    this.statusEl = panel.querySelector('.status') as HTMLElement;
    const me = panel.querySelector('.me') as HTMLElement;
    if (this.user) {
      me.innerHTML = `<span class="swatch" style="background:${this.user.color}"></span>${escape(this.user.name)}`;
    }

    panel.querySelector('.close-panel')?.addEventListener('click', () => this.togglePanel(false));
    panel.querySelector('.pick-btn')?.addEventListener('click', () => this.startPicker());

    // Make the pin overlay in the light DOM so pins can use page coords
    this.overlay = document.createElement('div');
    this.overlay.setAttribute(IGNORE_ATTR, '');
    this.overlay.className = 'cfw-overlay';
    this.overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(this.overlay);

    this.pinLayer = document.createElement('div');
    this.pinLayer.setAttribute(IGNORE_ATTR, '');
    this.pinLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    this.overlay.appendChild(this.pinLayer);

    this.injectLightStyles();
  }

  private togglePanel(force?: boolean): void {
    const panel = this.shadow.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    const open = force ?? !this.panelOpen;
    this.panelOpen = open;
    panel.classList.toggle('open', open);
    const fab = this.shadow.querySelector('.fab') as HTMLElement | null;
    fab?.classList.toggle('open', open);
  }

  // --- Element picker ---

  private startPicker(): void {
    if (this.pickerActive) return;
    this.pickerActive = true;
    document.body.style.cursor = 'crosshair';
    this.togglePanel(false);

    // Show a banner so the user knows picker mode is on and how to exit.
    const banner = document.createElement('div');
    banner.className = 'picker-banner';
    banner.innerHTML = `
      <span>Click any element to leave a comment.</span>
      <button type="button" class="picker-cancel">Cancel (Esc)</button>
    `;
    this.shadow.appendChild(banner);

    const onMove = (ev: MouseEvent) => {
      const t = this.hitTest(ev);
      if (this.hoverEl && this.hoverEl !== t) this.unhighlight(this.hoverEl);
      this.hoverEl = t;
      if (t) this.highlight(t);
    };
    const onClick = (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const t = this.hitTest(ev);
      if (t) this.openComposerForElement(t, ev.clientX, ev.clientY);
      cleanup();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup();
    };
    const cleanup = () => {
      this.pickerActive = false;
      document.body.style.cursor = '';
      if (this.hoverEl) this.unhighlight(this.hoverEl);
      this.hoverEl = null;
      banner.remove();
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
    };
    banner.querySelector('.picker-cancel')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      cleanup();
    });
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
  }

  private hitTest(ev: MouseEvent): HTMLElement | null {
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    if (!el) return null;
    // skip widget chrome
    if (el.closest(`[${IGNORE_ATTR}]`) || el.tagName === TAG.toUpperCase()) return null;
    return el;
  }

  private highlight(el: HTMLElement): void {
    el.dataset.cfwPrevOutline = el.style.outline;
    el.style.outline = '2px solid #2e7dd7';
  }
  private unhighlight(el: HTMLElement): void {
    el.style.outline = el.dataset.cfwPrevOutline ?? '';
    delete el.dataset.cfwPrevOutline;
  }

  // --- Composer ---

  private openComposerForElement(el: HTMLElement, cx: number, cy: number): void {
    const anchor: ElementAnchor = {
      ...anchors.Element.createAnchor(el),
      ...(hasContext(this.currentContext) ? { context: { ...this.currentContext } } : {}),
    };
    this.showComposer(anchor, cx, cy, null);
  }

  private showComposer(
    anchor: ElementAnchor,
    cx: number,
    cy: number,
    replyTo: string | null,
  ): void {
    const existing = this.shadow.querySelector('.composer') as HTMLElement | null;
    existing?.remove();
    const composer = document.createElement('div');
    composer.className = 'composer';
    composer.style.left = `${Math.min(cx + 12, window.innerWidth - 320)}px`;
    composer.style.top = `${Math.min(cy + 12, window.innerHeight - 200)}px`;
    composer.innerHTML = `
      <div class="composer-snippet">${escape(anchor.snippet.text)}</div>
      <textarea placeholder="${replyTo ? 'Reply…' : 'Comment on this element…'}" rows="3"></textarea>
      <div class="composer-actions">
        <button class="cancel" type="button">Cancel</button>
        <button class="primary submit" type="button">Post</button>
      </div>
    `;
    this.shadow.appendChild(composer);
    const ta = composer.querySelector('textarea') as HTMLTextAreaElement;
    ta.focus();
    composer.querySelector('.cancel')?.addEventListener('click', () => composer.remove());
    composer.querySelector('.submit')?.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text || !this.user) return;
      if (replyTo) {
        await this.postReply(replyTo, text);
      } else {
        await this.postNewThread(anchor, text);
      }
      composer.remove();
    });
  }

  private async postNewThread(anchor: ElementAnchor, text: string): Promise<void> {
    const base = this.opts.serverUrl.replace(/^ws/, 'http');
    await fetch(`${base}/api/docs/${encodeURIComponent(this.opts.docId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: this.user, text, anchor }),
    });
  }

  private async postReply(threadId: string, text: string): Promise<void> {
    const base = this.opts.serverUrl.replace(/^ws/, 'http');
    await fetch(
      `${base}/api/docs/${encodeURIComponent(this.opts.docId)}/threads/${encodeURIComponent(threadId)}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: this.user, text }),
      },
    );
  }

  private async setStatus(threadId: string, status: 'open' | 'resolved'): Promise<void> {
    const base = this.opts.serverUrl.replace(/^ws/, 'http');
    const action = status === 'resolved' ? 'resolve' : 'reopen';
    await fetch(
      `${base}/api/docs/${encodeURIComponent(this.opts.docId)}/threads/${encodeURIComponent(threadId)}/${action}`,
      { method: 'POST' },
    );
  }

  // --- Threads / pins ---

  private renderThreads(): void {
    if (!this.client) return;
    const threads = listThreads(this.client.ydoc);
    // pin layer
    this.threadPositions.clear();
    const pinLayer = this.pinLayer;
    if (!pinLayer) return; // disconnectedCallback fired between schedule and render
    pinLayer.innerHTML = '';
    const annotated: {
      thread: Thread;
      status: 'open' | 'resolved' | 'orphan';
      el: HTMLElement | null;
    }[] = [];
    for (const t of threads) {
      if (t.anchor.kind !== 'element' && t.anchor.kind !== 'orphan') continue;
      const statusBase: 'open' | 'resolved' | 'orphan' =
        t.status === 'resolved' ? 'resolved' : 'open';
      if (t.anchor.kind === 'orphan') {
        annotated.push({ thread: t, status: 'orphan', el: null });
        continue;
      }
      // Pin only when the anchor's captured context matches the current
      // page / view. Legacy anchors with no context show everywhere
      // (back-compat). Off-context threads still flow into the side
      // panel via listThreads — they're just not overlaid on the doc.
      if (!contextMatches(t.anchor.context, this.currentContext)) {
        annotated.push({ thread: t, status: statusBase, el: null });
        continue;
      }
      const res = anchors.Element.resolve(t.anchor, { root: document });
      if (!res.ok) {
        annotated.push({ thread: t, status: 'orphan', el: null });
        continue;
      }
      annotated.push({ thread: t, status: statusBase, el: res.element });
      const pin = document.createElement('div');
      pin.setAttribute(IGNORE_ATTR, '');
      pin.className = 'cfw-pin';
      pin.dataset.threadId = t.id;
      pin.dataset.status = statusBase;
      pin.style.cssText = [
        'position:absolute',
        'pointer-events:auto',
        'width:24px',
        'height:24px',
        'border-radius:50%',
        `background:${statusBase === 'resolved' ? '#2da44e' : '#e36f1e'}`,
        'color:#fff',
        'font:600 12px system-ui',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'cursor:pointer',
        'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
        'transform:translate(-50%,-100%)',
      ].join(';');
      const idx = annotated.filter((a) => a.status !== 'orphan').length;
      pin.textContent = String(idx);
      pin.title = t.comments[0]?.text ?? 'open thread';
      pin.addEventListener('click', (ev) => {
        this.showThreadPopover(t, ev.clientX, ev.clientY);
      });
      pinLayer.appendChild(pin);
      this.threadPositions.set(t.id, { el: res.element, status: statusBase });
    }
    this.positionPins();
    this.renderPanelList(annotated);
  }

  private positionPins(): void {
    if (!this.pinLayer) return;
    for (const pin of Array.from(this.pinLayer.children)) {
      const id = (pin as HTMLElement).dataset.threadId;
      if (!id) continue;
      const pos = this.threadPositions.get(id);
      if (!pos) continue;
      const rect = pos.el.getBoundingClientRect();
      (pin as HTMLElement).style.left = `${rect.right - 6}px`;
      (pin as HTMLElement).style.top = `${rect.top + 6}px`;
    }
  }

  private renderPanelList(
    entries: { thread: Thread; status: 'open' | 'resolved' | 'orphan' }[],
  ): void {
    const list = this.shadow.querySelector('.panel-threads') as HTMLElement | null;
    if (!list) return;
    list.innerHTML = '';
    const groups: Record<'open' | 'orphan' | 'resolved', typeof entries> = {
      open: entries.filter((e) => e.status === 'open'),
      orphan: entries.filter((e) => e.status === 'orphan'),
      resolved: entries.filter((e) => e.status === 'resolved'),
    };
    if (entries.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No threads yet. Click “Comment on element…” to start.';
      list.appendChild(e);
      return;
    }
    for (const key of ['open', 'orphan', 'resolved'] as const) {
      const group = groups[key];
      if (!group.length) continue;
      const h = document.createElement('div');
      h.className = 'section-heading';
      h.textContent = `${capitalize(key)} (${group.length})`;
      list.appendChild(h);
      for (const { thread, status } of group) {
        list.appendChild(this.renderThreadRow(thread, status));
      }
    }
  }

  private renderThreadRow(t: Thread, status: 'open' | 'resolved' | 'orphan'): HTMLElement {
    const row = document.createElement('div');
    row.className = `thread status-${status}`;
    if (this.activeThread === t.id) row.classList.add('active');

    const snippet =
      t.anchor.kind === 'orphan'
        ? t.anchor.original.snippet.text
        : (t.anchor as ElementAnchor).snippet.text;
    const last = t.comments[t.comments.length - 1];
    row.innerHTML = `
      <div class="meta">
        <span class="dot"></span>
        <span class="author-name">${escape(t.createdBy.name)}</span>
        <span class="time">${formatTime(last?.ts ?? 0)}</span>
      </div>
      <div class="snippet">${escape(snippet)}</div>
      <div class="last">${escape(last?.text ?? '')}</div>
    `;
    row.addEventListener('click', () => {
      const pos = this.threadPositions.get(t.id);
      if (pos?.el) pos.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.activeThread = t.id;
      this.showThreadPopoverForThread(t);
    });
    return row;
  }

  private showThreadPopoverForThread(t: Thread): void {
    if (t.anchor.kind === 'element') {
      const res = anchors.Element.resolve(t.anchor, { root: document });
      if (res.ok) {
        const r = res.element.getBoundingClientRect();
        this.showThreadPopover(t, r.right, r.top);
        return;
      }
    }
    this.showThreadPopover(t, window.innerWidth / 2, 80);
  }

  private showThreadPopover(t: Thread, cx: number, cy: number): void {
    const existing = this.shadow.querySelector('.thread-popover');
    existing?.remove();
    const pop = document.createElement('div');
    pop.className = 'thread-popover';
    pop.style.left = `${Math.min(cx + 6, window.innerWidth - 340)}px`;
    pop.style.top = `${Math.min(cy + 6, window.innerHeight - 240)}px`;
    const snippet =
      t.anchor.kind === 'orphan'
        ? t.anchor.original.snippet.text
        : (t.anchor as ElementAnchor).snippet.text;
    const status = t.anchor.kind === 'orphan' ? 'orphan' : t.status;
    pop.innerHTML = `
      <header>
        <span class="tag tag-${status}">${status}</span>
        <button class="icon-btn close">×</button>
      </header>
      <div class="snippet">${escape(snippet)}</div>
      <div class="comments"></div>
      <div class="actions">
        <textarea rows="2" placeholder="Reply as ${escape(this.user?.name ?? 'Anon')}…"></textarea>
        <button class="primary submit">Reply</button>
        ${
          status === 'resolved'
            ? `<button class="reopen">Reopen</button>`
            : status === 'open'
              ? `<button class="resolve">Resolve</button>`
              : ''
        }
      </div>
    `;
    const cList = pop.querySelector('.comments') as HTMLElement;
    for (const c of t.comments) {
      const row = document.createElement('div');
      row.className = 'comment';
      row.innerHTML = `
        <div class="author"><span class="swatch" style="background:${c.author.color}"></span>${escape(c.author.name)} <span class="time">${formatTime(c.ts)}</span></div>
        <div class="body">${escape(c.text)}</div>
      `;
      cList.appendChild(row);
    }
    this.shadow.appendChild(pop);
    pop.querySelector('.close')?.addEventListener('click', () => pop.remove());
    pop.querySelector('.submit')?.addEventListener('click', async () => {
      const ta = pop.querySelector('textarea') as HTMLTextAreaElement;
      const text = ta.value.trim();
      if (!text) return;
      await this.postReply(t.id, text);
      pop.remove();
    });
    pop.querySelector('.resolve')?.addEventListener('click', async () => {
      await this.setStatus(t.id, 'resolved');
      pop.remove();
    });
    pop.querySelector('.reopen')?.addEventListener('click', async () => {
      await this.setStatus(t.id, 'open');
      pop.remove();
    });
  }

  // --- Light-DOM styles (pins, overlay) ---

  private injectLightStyles(): void {
    if (document.getElementById('cfw-light-styles')) return;
    const s = document.createElement('style');
    s.id = 'cfw-light-styles';
    s.setAttribute(IGNORE_ATTR, '');
    s.textContent = `
      .cfw-pin:hover { transform: translate(-50%,-100%) scale(1.08); }
      .cfw-pin[data-status="resolved"] { background: #2da44e !important; }
      .cfw-pin[data-status="orphan"] { background: #bf8700 !important; }
    `;
    document.head.appendChild(s);
  }

  // --- DOM observer to reposition / reresolve pins ---

  private pendingRender = false;

  private scheduleRender(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.renderThreads();
    });
  }

  private startObserver(): void {
    this.observer = new MutationObserver((records) => {
      // Skip records that originated inside our own chrome (overlay, pin layer,
      // injected style tag, the host element itself). Otherwise the widget's
      // own writes re-enter renderThreads → infinite loop on any host that
      // also mutates the DOM (HMR, animations, etc).
      for (const r of records) {
        const target = r.target as Node;
        if (!target) continue;
        if (isInOwnChrome(target)) continue;
        this.scheduleRender();
        return;
      }
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      // NOTE: attributes are deliberately OFF — class/style flips on the host
      // page don't change anchor resolvability. Enable only if we find a real
      // case where it matters.
      attributes: false,
      characterData: false,
    });
    this.resizeHandler = () => this.positionPins();
    this.scrollHandler = () => this.positionPins();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('scroll', this.scrollHandler, { passive: true, capture: true });
    // A gentle rAF loop keeps pins attached during layout animations where
    // MutationObserver doesn't fire (e.g. CSS transitions, scroll in
    // overflow containers). Position-only, no render.
    const tick = () => {
      this.positionPins();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}

function isInOwnChrome(node: Node): boolean {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as Element;
      if (
        e.hasAttribute?.(IGNORE_ATTR) ||
        e.tagName === TAG.toUpperCase() ||
        e.id === 'cfw-light-styles'
      ) {
        return true;
      }
    }
    el = el.parentNode;
  }
  return false;
}

// --- Public FeedbackWidget global ---

declare global {
  interface Window {
    FeedbackWidget?: typeof FeedbackWidget;
  }
}

// Register the custom element on bundle load — independent of any init() call.
// This way an HTML-author who drops `<claude-feedback-widget doc-id="...">`
// into a page gets the element upgraded immediately; connectedCallback then
// auto-inits from attributes. The script-tag-plus-init pattern still works.
if (!customElements.get(TAG)) customElements.define(TAG, FeedbackWidgetEl);

const FeedbackWidget = {
  /** Install + start the widget. Safe to call multiple times (idempotent). */
  init(opts: WidgetOpts): FeedbackWidgetEl {
    const existing = document.querySelector(TAG) as FeedbackWidgetEl | null;
    if (existing) {
      existing.init(opts);
      return existing;
    }
    const el = document.createElement(TAG) as FeedbackWidgetEl;
    el.setAttribute(IGNORE_ATTR, '');
    document.body.appendChild(el);
    el.init(opts);
    return el;
  },
  version: '0.0.1',
} as const;

if (typeof window !== 'undefined') {
  window.FeedbackWidget = FeedbackWidget;
}

export { FeedbackWidget };
export default FeedbackWidget;

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}

function formatTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
  return new Date(ts).toLocaleDateString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function currentUrl(): string {
  return location.pathname + location.search + location.hash;
}
