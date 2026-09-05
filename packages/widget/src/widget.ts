import {
  type AnchorContext,
  type ElementAnchor,
  type FeedbackClient,
  STATUS_COLORS,
  type User,
  connect,
  resolveUser,
} from '@feedback/core';
import { widgetStyles } from './styles.ts';
import {
  askIfSignInRequired,
  authedPost,
  httpBase,
  loadStoredAuth,
  updateAuthUi,
  validateStoredAuth,
} from './widget-auth.ts';
import {
  IGNORE_ATTR,
  TAG,
  enterFeedbackMode,
  exitFeedbackMode,
  isInOwnChrome,
  toggleFeedbackMode,
} from './widget-picker.ts';
import { positionPins, renderThreadsInto } from './widget-threads.ts';

/**
 * <claude-feedback-widget> web component
 *
 * Usage:
 *   <script type="module" src="/widget.esm.js"></script>
 *   <script>
 *     FeedbackWidget.init({
 *       serverUrl: 'wss://host.example',  // optional; defaults to same host
 *       docId: 'my-mockup',
 *       user: null,                       // omit/null → resolved from the browser
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
  /**
   * Whose localStorage identity the widget adopts.
   *
   * `'widget'` (the default) namespaces the identity under `cfw:`, because on a
   * third-party page the widget is a guest and must not read or write the host
   * site's keys.
   *
   * `'host'` reads the UNPREFIXED keys — the ones `ensureUserIdentity` in the
   * workspaces-app/board uses. Set it only when the widget is embedded in one of
   * OUR OWN surfaces, where the page has already asked the person who they are:
   * there, two namespaces mean one page holds two identities for one human, and
   * the widget posts as "Anonymous <animal>" on a board that greets the same
   * person by name.
   */
  identityScope?: 'widget' | 'host';
  /**
   * Offer workspace sign-in on this embed EVEN WHEN the workspace does not
   * require it — attribute form `auth-offer`.
   *
   * Sign-in has two triggers, and this is the optional one. The other is
   * the workspace itself: when it refuses unsigned writes (the server's
   * `requireSignInToWrite`, on by default since the owner decision on the
   * security row, 2026-09-02) AND this browser cannot already make one,
   * the embed offers the popup-token handshake — asked once on load via
   * `GET /api/auth/session`, which answers both halves, and again as the
   * backstop when a write comes back `sign_in_required`. Both halves,
   * because a Cloudflare Access visitor passes the gate with no token at
   * all and must not be told to sign in. Without the
   * offer, flipping that flag would have silently refused every comment
   * from every mockup and dev page, with nothing on screen that could fix
   * it. `auth-offer` keeps meaning what it meant: on an OPEN workspace a
   * plain embed shows no auth UI and adopts no stored token, and this
   * attribute is how a dev server asks for the offer anyway, so comments
   * carry a real name rather than an anonymous one.
   *
   * The boundary that has not moved: the token the handshake mints is kept
   * in the HOST PAGE's localStorage (see AUTH_TOKEN_KEY), which every
   * script on that origin can read — a third-party tag, an XSS, an
   * extension scoped to the page. On a developer's own dev server and on a
   * mockup the workspace serves itself, those scripts are the developer's
   * own. On a page whose scripts are not all yours it is a bearer
   * credential handed to strangers: do not embed there, with or without
   * this attribute. A workspace that requires sign-in has chosen "every
   * comment names its author" over "any page can post"; this is the cost
   * of that choice, and it is documented in the embedding skill.
   */
  authOffer?: boolean;
}

/** One speech bubble, three uses: the FAB icon, the feedback-mode cursor. */
const BUBBLE_PATH =
  'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z';

// The host page and the claude-workspaces server normally live on different ports
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

export class FeedbackWidgetEl extends HTMLElement {
  shadow: ShadowRoot;
  client: FeedbackClient | null = null;
  user: User | null = null;
  private initialized = false;
  opts: WidgetOpts & { serverUrl: string; user: string | null } = {
    serverUrl: '',
    docId: '',
    user: null,
  };
  currentContext: AnchorContext = {};
  private historyPatched = false;
  feedbackMode = false;
  modeCleanup: (() => void) | null = null;
  hoverEl: HTMLElement | null = null;
  private overlay: HTMLDivElement | null = null;
  pinLayer: HTMLDivElement | null = null;
  private panelOpen = false;
  activeThread: string | null = null;
  threadPositions = new Map<string, { el: HTMLElement; status: 'open' | 'resolved' | 'orphan' }>();
  private observer: MutationObserver | null = null;
  private statusEl: HTMLElement | null = null;
  private rafId: number | null = null;
  private resizeHandler: (() => void) | null = null;
  private scrollHandler: (() => void) | null = null;
  private vvHandler: (() => void) | null = null;
  showResolved = false;
  /** The popup-token, when this embed offers auth and a person signed in. */
  authToken: string | null = null;
  /** This browser must sign in before it can write — learned on load (the
   *  workspace refuses unsigned writes and does not already accept this
   *  browser's) or from a 401. */
  signInToWrite = false;
  /** The post that sign-in interrupted, re-run once the token arrives. */
  retryAfterSignIn: (() => void) | null = null;
  authUser: User | null = null;
  /** The identity the browser had before sign-in — restored on sign-out. */
  anonUser: User | null = null;
  authPopup: Window | null = null;
  authMsgHandler: ((ev: MessageEvent) => void) | null = null;

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    // Keyboard events are `composed`: a keystroke typed into the shadow-DOM
    // composer bubbles OUT of the shadow root and reaches host-page document
    // listeners — and a page that preventDefaults ' ' for a play/pause
    // shortcut (media players, slide decks, most dev servers) then cancels
    // every space typed into a comment. Stop key events that originate in the
    // widget's own editable controls at the shadow boundary. Scoped to those
    // controls only: with feedback mode armed but nothing focused, the host
    // keeps all its shortcuts. The widget's own Escape handler still runs —
    // it captures on window, upstream of this bubble-phase stop.
    const shieldKeys = (ev: Event) => {
      const t = ev.target;
      if (t instanceof HTMLElement && t.matches('input, textarea, select')) ev.stopPropagation();
    };
    for (const type of ['keydown', 'keypress', 'keyup'] as const) {
      this.shadow.addEventListener(type, shieldKeys);
    }
  }

  init(opts: WidgetOpts): void {
    if (this.initialized) return;
    this.initialized = true;
    this.opts.docId = opts.docId;
    this.opts.user = opts.user ?? null;
    this.opts.serverUrl = opts.serverUrl ?? defaultServerUrl();
    // Identity keys only. `cfw:showResolved` is a widget-local UI preference
    // and stays namespaced in both scopes — sharing it would let the widget
    // collide with a host key that means something else.
    const idPrefix = opts.identityScope === 'host' ? '' : 'cfw:';
    this.user = resolveUser(this.opts.user ?? null, {
      get: (k) => localStorage.getItem(`${idPrefix}${k}`),
      set: (k, v) => localStorage.setItem(`${idPrefix}${k}`, v),
    });
    this.anonUser = this.user;
    this.opts.authOffer = opts.authOffer === true;
    if (this.opts.authOffer) loadStoredAuth(this);
    this.showResolved = localStorage.getItem('cfw:showResolved') === '1';
    this.currentContext = {
      url: currentUrl(),
      ...(opts.context?.view ? { view: opts.context.view } : {}),
    };
    this.wireHistoryListeners();
    this.wireVisualViewport();
    this.renderShell();
    this.connect();
    this.startObserver();
    if (this.opts.authOffer) void validateStoredAuth(this);
    void askIfSignInRequired(this);
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
    // `identity-scope="host"` — see WidgetOpts.identityScope. Short version for
    // whoever lands here debugging a namespace collision: the `cfw:` prefix
    // exists because the widget is normally a GUEST on someone else's page and
    // must not read or write their keys. Our own board is the one surface where
    // it isn't a guest, and there the prefix splits one human into two
    // identities on a single page.
    //
    // Opt-in rather than "detect our own origin", deliberately: an embed that
    // does not ask for it keeps the `cfw:` namespace byte-for-byte, so no page
    // already running the widget can have its identity change underneath it.
    if (this.getAttribute('identity-scope') === 'host') opts.identityScope = 'host';
    // Presence-only, like every boolean HTML attribute. See WidgetOpts.
    if (this.hasAttribute('auth-offer')) opts.authOffer = true;
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
      this.style.setProperty('--cw-vv-bottom', `${Math.round(overlap)}px`);
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
      exitFeedbackMode(this);
    } catch {}
    try {
      this.client?.close();
    } catch {}
    // None of these throw on a live window, so they run bare — every
    // try/catch here shipped in the bundle, against a hard byte budget.
    this.observer?.disconnect();
    this.overlay?.remove();
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.scrollHandler) window.removeEventListener('scroll', this.scrollHandler);
    if (this.authMsgHandler) {
      window.removeEventListener('message', this.authMsgHandler);
      this.authMsgHandler = null;
    }
    const vv = window.visualViewport;
    if (this.vvHandler && vv) {
      vv.removeEventListener('resize', this.vvHandler);
      vv.removeEventListener('scroll', this.vvHandler);
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

    // Above the FAB: the way into the thread list, now that the FAB itself
    // arms feedback mode instead of opening a panel.
    const listBtn = document.createElement('button');
    listBtn.className = 'fab-list';
    listBtn.title = 'Comment threads';
    listBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>' +
      '<span class="count" hidden></span>';
    listBtn.addEventListener('click', () => this.togglePanel());
    this.shadow.appendChild(listBtn);

    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.title = 'Give feedback — click anything to comment';
    fab.setAttribute('aria-pressed', 'false');
    fab.innerHTML =
      `<svg class="fab-icon fab-icon-bubble" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${BUBBLE_PATH}"/></svg>` +
      '<span class="fab-icon fab-icon-close">×</span>';
    fab.addEventListener('click', () => toggleFeedbackMode(this));
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
    updateAuthUi(this);

    panel.querySelector('.close-panel')?.addEventListener('click', () => this.togglePanel(false));
    panel.querySelector('.pick-btn')?.addEventListener('click', () => enterFeedbackMode(this));

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

  togglePanel(force?: boolean): void {
    const panel = this.shadow.querySelector('.panel') as HTMLElement | null;
    if (!panel) return;
    const open = force ?? !this.panelOpen;
    this.panelOpen = open;
    panel.classList.toggle('open', open);
  }

  /** `false` when the server refused it — the caller keeps the composer, and
   *  the typed comment, so signing in and pressing Post again is all it takes.
   *  Discarding it on a refusal would lose the very thing the sign-in prompt
   *  is asking the person to come back and finish. */
  async postNewThread(anchor: ElementAnchor, text: string): Promise<boolean> {
    const res = await authedPost(
      this,
      `${httpBase(this)}/api/docs/${encodeURIComponent(this.opts.docId)}/threads`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: this.user, text, anchor }),
      }),
    );
    return res.ok;
  }

  /** `false` when the server refused it — see `postNewThread`. */
  async postReply(threadId: string, text: string): Promise<boolean> {
    const res = await authedPost(
      this,
      `${httpBase(this)}/api/docs/${encodeURIComponent(this.opts.docId)}/threads/${encodeURIComponent(threadId)}/comments`,
      () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: this.user, text }),
      }),
    );
    return res.ok;
  }

  async setStatus(threadId: string, status: 'open' | 'resolved'): Promise<void> {
    const action = status === 'resolved' ? 'resolve' : 'reopen';
    await authedPost(
      this,
      `${httpBase(this)}/api/docs/${encodeURIComponent(this.opts.docId)}/threads/${encodeURIComponent(threadId)}/${action}`,
      () => ({ method: 'POST' }),
    );
  }

  // --- Light-DOM styles (pins, overlay) ---

  private injectLightStyles(): void {
    if (document.getElementById('cfw-light-styles')) return;
    const s = document.createElement('style');
    s.id = 'cfw-light-styles';
    s.setAttribute(IGNORE_ATTR, '');
    // The cursor is the mode indicator (a speech bubble, tail on the pointer
    // tip). `!important` on every element so the host page's own cursor
    // styles — pointer on links, text on inputs — don't flicker it away.
    const bubbleCursor = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="${BUBBLE_PATH}" fill="%232e7dd7" stroke="white" stroke-width="1.5"/></svg>') 3 21`;
    s.textContent = `
      .cfw-pin:hover { transform: translate(-50%,-100%) scale(1.08); }
      .cfw-pin[data-status="resolved"] { background: ${STATUS_COLORS.resolved} !important; }
      .cfw-pin[data-status="orphan"] { background: ${STATUS_COLORS.orphan} !important; }
      body.cfw-feedback-mode, body.cfw-feedback-mode * { cursor: ${bubbleCursor}, crosshair !important; }
    `;
    document.head.appendChild(s);
  }

  // --- DOM observer to reposition / reresolve pins ---

  private pendingRender = false;

  /**
   * The render loop's one entry point. Kept as a method after
   * `widget-threads.ts` was extracted, because the element is the surface
   * everything the widget does is still reachable through — the panel test
   * drives a render by calling it.
   */
  renderThreads(): void {
    renderThreadsInto(this);
  }

  scheduleRender(): void {
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
    this.resizeHandler = () => positionPins(this);
    this.scrollHandler = () => positionPins(this);
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('scroll', this.scrollHandler, { passive: true, capture: true });
    // A gentle rAF loop keeps pins attached during layout animations where
    // MutationObserver doesn't fire (e.g. CSS transitions, scroll in
    // overflow containers). Position-only, no render.
    const tick = () => {
      positionPins(this);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
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

function currentUrl(): string {
  return location.pathname + location.search + location.hash;
}
