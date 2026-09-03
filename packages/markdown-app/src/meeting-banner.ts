/**
 * <meeting-banner> — the calendar meeting offer, in flow at the top of a page.
 *
 * Two hosts, one element: the workspace board (first thing in the content
 * column, above the New task row) and the landing page (above the workspace
 * list). Shadow DOM like the widget's, not the hub's light-DOM classes,
 * because the landing page carries its own tiny inline stylesheet and must
 * not load the whole app CSS for one banner; the shadow styles read the
 * host page's tokens through custom properties with literal fallbacks.
 *
 * Two states (approved mockup, round 4):
 *  - OFFER: 📅 title, "Starts in N min · start–end", [Join + send bot]
 *    primary and [Not this one] quiet. Dismissal is per-occurrence and
 *    local to this browser.
 *  - JOINED: 📝 green tint, "Bot in call · transcribing to a new discussion
 *    doc", one quiet [Pull bot out]. Deliberately NO "open notes" button —
 *    the join click itself opened both the meeting (new tab) and the doc.
 *
 * Data is polled: calendar events live at the vendor and nothing on this
 * server pushes their changes (the board's ydoc projection carries tasks,
 * not calendars), so a 60s poll while the tab is visible is the honest
 * channel. A 503 (not configured) or 404 (not connected) answer stops the
 * poll — the feature is off, and the element stays empty.
 *
 * The join POST answers `{meetingUrl, docUrl}` and the click opens BOTH: the
 * meeting in a new tab — pre-opened synchronously so the popup blocker sees
 * a user gesture, then pointed once the response lands — and the discussion
 * doc in this one.
 */

import {
  type BannerPick,
  type CalendarBannerEvent,
  bannerTimeLine,
  pickBanner,
  readDismissed,
  writeDismissal,
} from './meeting-banner-model.ts';

/** Calendar events change at vendor pace; a minute keeps the countdown and
 *  the joined flag honest without hammering the vendor-backed route. */
export const POLL_MS = 60_000;

const STYLES = `
:host { display: block; }
.banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 10px 0;
  padding: 10px 14px;
  border: 1px solid var(--border, #e4e7eb);
  border-radius: 10px;
  background: var(--bg-raised, #f8f9fb);
  font: 14px/1.45 system-ui, -apple-system, sans-serif;
  color: var(--fg, #1b1f23);
}
.banner.joined {
  background: var(--ok-bg, #e8f5ed);
  border-color: var(--ok-border, #b7e0c4);
}
.glyph { flex-shrink: 0; font-size: 16px; }
.text { flex: 1; min-width: 180px; }
.title {
  display: block;
  font-weight: 650;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.title { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.caption { color: var(--fg-muted, #57606a); font-size: 12.5px; margin-top: 1px; }
.actions { display: flex; gap: 8px; flex-shrink: 0; }
button {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  min-height: 36px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border, #d6dade);
  background: var(--bg, #fff);
  color: inherit;
  cursor: pointer;
}
button.primary {
  background: var(--accent, #2e7dd7);
  border-color: var(--accent, #2e7dd7);
  color: #fff;
}
button:disabled { opacity: 0.6; cursor: default; }
.error { flex-basis: 100%; color: var(--danger, #b3261e); font-size: 12.5px; }
/* A phone: the actions become their own full-width row with thumb-sized
   targets (design-mobile.md's 44px floor for primary actions). */
@media (max-width: 640px) {
  .actions { flex-basis: 100%; }
  .actions button { flex: 1; min-height: 44px; }
}
`;

export class MeetingBannerEl extends HTMLElement {
  /** Test seams — a test replaces these before the element connects. */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init);
  openWindow: (url?: string) => { location: string | Location; close(): void } | null = (url) =>
    window.open(url ?? '', '_blank');
  navigate: (url: string) => void = (url) => location.assign(url);
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } =
    localStorage;
  now: () => number = () => Date.now();

  private shadow!: ShadowRoot;
  private events: CalendarBannerEvent[] = [];
  private stopped = false;
  private disabled = false;
  private busy = false;
  private error: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  connectedCallback(): void {
    this.shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    this.shadow.append(style);
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.refresh();
    // The hub mounts one instance per pane and only one pane shows at a
    // time, so a hidden instance skips its ticks — every poll is a vendor
    // list call. It catches up on its next tick once shown, the same ≤60s
    // freshness the visible one has. `checkVisibility` is absent in the
    // test DOM; absent means poll.
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && (this.checkVisibility?.() ?? true)) {
        void this.refresh();
      }
    }, POLL_MS);
  }

  disconnectedCallback(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /** Exposed so a test can drive a poll without faking timers. */
  async refresh(): Promise<void> {
    if (this.stopped || this.disabled) return;
    try {
      const res = await this.fetchImpl('/api/calendar/events');
      if (res.status === 503 || res.status === 404) {
        // No calendar feature, or no Google account connected. Settled, not
        // an error: stop asking until the next page load.
        this.disabled = true;
        this.events = [];
        this.render();
        return;
      }
      if (!res.ok) return; // Transient; keep what we have, retry on the tick.
      const body = (await res.json()) as { events?: CalendarBannerEvent[] };
      this.events = Array.isArray(body.events) ? body.events : [];
    } catch {
      return; // Network blip — same policy as any poll: try again later.
    }
    this.render();
  }

  private pick(): BannerPick | null {
    const now = this.now();
    return pickBanner(this.events, readDismissed(this.storage, now), now);
  }

  private render(): void {
    for (const el of [...this.shadow.children]) {
      if (el.tagName !== 'STYLE') el.remove();
    }
    const pick = this.pick();
    if (!pick) return;
    const { kind, event } = pick;

    const banner = document.createElement('div');
    banner.className = kind === 'joined' ? 'banner joined' : 'banner';
    banner.setAttribute('role', 'status');

    const glyph = document.createElement('span');
    glyph.className = 'glyph';
    glyph.textContent = kind === 'joined' ? '📝' : '📅';

    const text = document.createElement('div');
    text.className = 'text';
    // A joined meeting's title is the way back to its discussion doc — the
    // join click opened it once, but a person arriving from another device
    // needs a path of their own (UX review on PR #555).
    const title = document.createElement(kind === 'joined' && event.docUrl ? 'a' : 'div');
    title.className = 'title';
    title.textContent = event.title ?? 'Untitled meeting';
    if (title instanceof HTMLAnchorElement && event.docUrl) title.href = event.docUrl;
    const caption = document.createElement('div');
    caption.className = 'caption';
    if (kind === 'joined') {
      caption.textContent = 'Bot in call · transcribing to a new meeting notes doc';
    } else {
      const workspace = this.getAttribute('workspace-name');
      const line = bannerTimeLine(event, this.now());
      // The landing page is outside any workspace, so its offer says where
      // the notes doc will be filed — named as a place, not a lost state.
      caption.textContent = workspace ? `${line} · notes land on the ${workspace} board` : line;
    }
    text.append(title, caption);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (kind === 'joined') {
      const out = document.createElement('button');
      out.type = 'button';
      out.textContent = 'Pull bot out';
      out.disabled = this.busy;
      out.addEventListener('click', () => void this.pullOut(event));
      actions.append(out);
    } else {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'primary';
      join.textContent = this.busy ? 'Joining…' : 'Join + send bot';
      join.disabled = this.busy;
      join.addEventListener('click', () => void this.join(event));
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.textContent = 'Not this one';
      dismiss.disabled = this.busy;
      dismiss.addEventListener('click', () => {
        writeDismissal(this.storage, event, this.now());
        this.render();
      });
      actions.append(join, dismiss);
    }
    banner.append(glyph, text, actions);
    if (this.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = this.error;
      banner.append(err);
    }
    this.shadow.append(banner);
  }

  private async join(event: CalendarBannerEvent): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.render();
    // Opened NOW, empty, so the popup blocker attributes it to the click;
    // the fetch below would otherwise cost the gesture.
    const win = this.openWindow();
    try {
      const workspaceId = this.getAttribute('workspace-id');
      const res = await this.fetchImpl(
        `/api/calendar/events/${encodeURIComponent(event.id)}/join`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ join: true, ...(workspaceId ? { workspaceId } : {}) }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        meetingUrl?: string;
        docUrl?: string;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        win?.close();
        this.error = body.message ?? body.error ?? `Join failed (${res.status})`;
        return;
      }
      // Both at once, per the approved design: the call in the tab we
      // already hold, the discussion doc in this one.
      if (win && body.meetingUrl) win.location = body.meetingUrl;
      else win?.close();
      event.joined = true; // Optimistic; the next poll confirms.
      if (body.docUrl) this.navigate(body.docUrl);
    } catch {
      win?.close();
      this.error = 'Join failed — network error.';
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async pullOut(event: CalendarBannerEvent): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.render();
    try {
      const res = await this.fetchImpl(
        `/api/calendar/events/${encodeURIComponent(event.id)}/join`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ join: false }),
        },
      );
      if (res.ok) event.joined = false;
      else {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        this.error = body.message ?? body.error ?? `Could not pull the bot out (${res.status})`;
      }
    } catch {
      this.error = 'Could not pull the bot out — network error.';
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

if (!customElements.get('meeting-banner')) {
  customElements.define('meeting-banner', MeetingBannerEl);
}
