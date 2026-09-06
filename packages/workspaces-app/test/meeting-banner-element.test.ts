import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarBannerEvent } from '../src/meeting-banner-model.ts';
import { MeetingBannerEl } from '../src/meeting-banner.ts';

const T0 = Date.parse('2026-09-01T14:00:00.000Z');

function ev(over: Partial<CalendarBannerEvent> = {}): CalendarBannerEvent {
  return {
    id: 'e1',
    title: 'Design sync',
    startTime: new Date(T0).toISOString(),
    endTime: new Date(T0 + 30 * 60_000).toISOString(),
    hasMeetingLink: true,
    joinable: true,
    joined: false,
    ...over,
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mapStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

/** Mount a banner with all seams faked; answers control every route. */
function mount(opts: {
  events?: unknown;
  eventsStatus?: number;
  join?: unknown;
  joinStatus?: number;
  now?: number;
}) {
  const calls: Call[] = [];
  const el = document.createElement('meeting-banner') as MeetingBannerEl;
  el.now = () => opts.now ?? T0 - 60_000;
  el.storage = mapStore();
  el.fetchImpl = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/calendar/events') {
      return Promise.resolve(jsonResponse(opts.eventsStatus ?? 200, { events: opts.events ?? [] }));
    }
    return Promise.resolve(jsonResponse(opts.joinStatus ?? 200, opts.join ?? {}));
  };
  const opened: Array<{ location: string | Location; closed: boolean; close(): void }> = [];
  el.openWindow = () => {
    const win = {
      location: '' as string | Location,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    opened.push(win);
    return win;
  };
  const navigations: string[] = [];
  el.navigate = (url) => navigations.push(url);
  document.body.append(el);
  return { el, calls, opened, navigations };
}

function shadowText(el: MeetingBannerEl): string {
  return el.shadowRoot?.textContent ?? '';
}

function button(el: MeetingBannerEl, label: string): HTMLButtonElement {
  const btn = [...(el.shadowRoot?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`no "${label}" button in ${shadowText(el)}`);
  return btn;
}

// Let the connectedCallback's refresh (and any handler's fetch) settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('<meeting-banner>', () => {
  it('renders the offer with title, countdown and both actions', async () => {
    const { el } = mount({ events: [ev()] });
    await settle();
    const text = shadowText(el);
    expect(text).toContain('Design sync');
    expect(text).toContain('Starts in 1 min');
    expect(button(el, 'Join + send bot')).toBeTruthy();
    expect(button(el, 'Not this one')).toBeTruthy();
  });

  it('names the destination workspace when the attribute says to', async () => {
    const { el } = mount({ events: [ev()] });
    el.setAttribute('workspace-name', 'Unfiled');
    await el.refresh();
    expect(shadowText(el)).toContain('notes land on the Unfiled board');
  });

  it('renders nothing on 503 (not configured) and stops polling', async () => {
    const { el, calls } = mount({ eventsStatus: 503 });
    await settle();
    expect(el.shadowRoot?.querySelector('.banner')).toBeNull();
    await el.refresh();
    expect(calls.length).toBe(1);
  });

  it('renders nothing when every event is outside its window', async () => {
    const { el } = mount({ events: [ev()], now: T0 + 31 * 60_000 });
    await settle();
    expect(el.shadowRoot?.querySelector('.banner')).toBeNull();
  });

  it('join opens the meeting in the pre-opened tab AND navigates to the doc', async () => {
    const { el, calls, opened, navigations } = mount({
      events: [ev()],
      join: {
        join: true,
        action: 'joined',
        meetingUrl: 'https://meet.example/abc',
        docId: 'd1',
        docUrl: '/workspaces/w1/docs/d1',
      },
    });
    el.setAttribute('workspace-id', 'w1');
    await settle();
    button(el, 'Join + send bot').click();
    await settle();
    const join = calls.find((c) => c.url.includes('/join'));
    // The board is in the ADDRESS since the canonical-routes cutover, not in
    // the body — that is what puts it in front of the server's one path
    // guard. Both halves are asserted: a path that gained the board while
    // the body kept it would be a half-done move that still passed.
    expect(join?.url).toBe('/workspaces/w1/calendar/events/e1/join');
    expect(JSON.parse(String(join?.init?.body))).toEqual({ join: true });
    expect(opened[0]?.location).toBe('https://meet.example/abc');
    expect(opened[0]?.closed).toBe(false);
    expect(navigations).toEqual(['/workspaces/w1/docs/d1']);
  });

  it('a refused join closes the blank tab and shows the server message', async () => {
    const { el, opened, navigations } = mount({
      events: [ev()],
      joinStatus: 400,
      join: { error: 'no_supported_link', message: 'That event has no link to join.' },
    });
    await settle();
    button(el, 'Join + send bot').click();
    await settle();
    expect(opened[0]?.closed).toBe(true);
    expect(navigations).toEqual([]);
    expect(shadowText(el)).toContain('That event has no link to join.');
  });

  it('dismiss hides this occurrence and persists across a repaint', async () => {
    const { el } = mount({ events: [ev()] });
    await settle();
    button(el, 'Not this one').click();
    expect(el.shadowRoot?.querySelector('.banner')).toBeNull();
    await el.refresh();
    expect(el.shadowRoot?.querySelector('.banner')).toBeNull();
  });

  it('a joined event shows the green state with only Pull bot out', async () => {
    const { el } = mount({
      events: [ev({ joined: true, docId: 'd1', docUrl: '/workspaces/w1/docs/d1' })],
    });
    await settle();
    expect(el.shadowRoot?.querySelector('.banner.joined')).toBeTruthy();
    expect(shadowText(el)).toContain('Bot in call');
    expect(button(el, 'Pull bot out')).toBeTruthy();
    // No open-notes BUTTON (approved mock) — but the title links to the
    // discussion doc, for a reader whose join click happened elsewhere.
    expect(el.shadowRoot?.querySelectorAll('button')).toHaveLength(1);
    const link = el.shadowRoot?.querySelector('a.title') as HTMLAnchorElement | null;
    expect(link?.getAttribute('href')).toBe('/workspaces/w1/docs/d1');
    expect(link?.textContent).toBe('Design sync');
  });

  it('a joined event with no docUrl renders the title as plain text', async () => {
    const { el } = mount({ events: [ev({ joined: true })] });
    await settle();
    expect(el.shadowRoot?.querySelector('.banner.joined')).toBeTruthy();
    expect(el.shadowRoot?.querySelectorAll('a')).toHaveLength(0);
  });

  it('Pull bot out posts join:false and falls back to the offer', async () => {
    const { el, calls } = mount({
      events: [ev({ joined: true })],
      join: { join: false, action: 'left' },
    });
    await settle();
    button(el, 'Pull bot out').click();
    await settle();
    const leave = calls.find((c) => c.url.includes('/join'));
    expect(JSON.parse(String(leave?.init?.body))).toEqual({ join: false });
    expect(button(el, 'Join + send bot')).toBeTruthy();
  });
});
