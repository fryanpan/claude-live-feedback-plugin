/**
 * The meeting-offer banner's headless half — which event to offer, for how
 * long, and what the caption says. No DOM: the custom element in
 * `meeting-banner.ts` renders whatever this module picks, and the tests here
 * never need a browser.
 *
 * The window rule is the server's own (`/api/calendar/events` route header):
 * an offer lives from 15 minutes before `startTime` until `endTime` — or
 * until `startTime` + 60 minutes when the vendor record carries no end.
 * After that the banner is simply gone; a meeting nobody joined needs no
 * epilogue.
 */

/** One event as `GET /api/calendar/events` answers it. */
export interface CalendarBannerEvent {
  id: string;
  title: string | null;
  /** ISO datetime from the vendor. */
  startTime: string;
  /** ISO end, or null when the vendor record has none. */
  endTime: string | null;
  hasMeetingLink: boolean;
  /** The server's verdict on whether a bot COULD join this event. */
  joinable: boolean;
  /** A bot was asked into this event and the join record stands. */
  joined: boolean;
  docId?: string;
  docUrl?: string;
}

/** The offer appears this long before the meeting starts. */
export const OFFER_LEAD_MS = 15 * 60_000;

/** How long a meeting with no vendor end time is assumed to run. */
export const FALLBACK_DURATION_MS = 60 * 60_000;

/**
 * A dismissal is per OCCURRENCE, not per event id: a recurring event keeps
 * its id across weeks, and "Not this one" must not silence next Tuesday's.
 */
export function occurrenceKey(event: Pick<CalendarBannerEvent, 'id' | 'startTime'>): string {
  return `${event.id}@${event.startTime}`;
}

/** The banner's lifetime for one event, or null when the start is garbage. */
export function bannerWindow(
  event: Pick<CalendarBannerEvent, 'startTime' | 'endTime'>,
): { from: number; until: number } | null {
  const start = Date.parse(event.startTime);
  if (Number.isNaN(start)) return null;
  const end = event.endTime === null ? Number.NaN : Date.parse(event.endTime);
  const until = Number.isNaN(end) ? start + FALLBACK_DURATION_MS : end;
  return { from: start - OFFER_LEAD_MS, until };
}

export function eventInWindow(
  event: Pick<CalendarBannerEvent, 'startTime' | 'endTime'>,
  now: number,
): boolean {
  const w = bannerWindow(event);
  // `>=` on the near edge: exactly 15 minutes out is the moment the offer is
  // FOR. `<` on the far edge: a meeting is over at its end, not a tick past.
  return w !== null && now >= w.from && now < w.until;
}

export interface BannerPick {
  kind: 'joined' | 'offer';
  event: CalendarBannerEvent;
}

/**
 * The one banner to show, or null.
 *
 * A JOINED meeting in its window wins outright, dismissed or not — a bot is
 * in a call spending money, and the surface that says so is also the only
 * way to pull it out. Otherwise the soonest-starting offer the server calls
 * joinable that this browser has not dismissed. One banner, never a stack:
 * dismissing the front one reveals the next candidate on the next render,
 * which is what "Not this one" is for.
 */
export function pickBanner(
  events: readonly CalendarBannerEvent[],
  dismissed: ReadonlySet<string>,
  now: number,
): BannerPick | null {
  const inWindow = events.filter((e) => eventInWindow(e, now));
  const byStart = (a: CalendarBannerEvent, b: CalendarBannerEvent) =>
    Date.parse(a.startTime) - Date.parse(b.startTime);
  const joined = inWindow.filter((e) => e.joined).sort(byStart)[0];
  if (joined) return { kind: 'joined', event: joined };
  const offer = inWindow
    .filter((e) => e.joinable && !e.joined && !dismissed.has(occurrenceKey(e)))
    .sort(byStart)[0];
  return offer ? { kind: 'offer', event: offer } : null;
}

/**
 * "Starts in 12 min · 2:00–2:30 PM". Minute-grained on purpose — the element
 * repaints on a coarse tick, and a seconds countdown would be wrong most of
 * the time it was on screen. `locale` is a test seam; production passes
 * nothing and gets the browser's own.
 */
export function bannerTimeLine(
  event: Pick<CalendarBannerEvent, 'startTime' | 'endTime'>,
  now: number,
  locale?: string,
): string {
  const start = Date.parse(event.startTime);
  if (Number.isNaN(start)) return '';
  const diff = start - now;
  const phase =
    diff > 30_000
      ? `Starts in ${Math.max(1, Math.round(diff / 60_000))} min`
      : now - start < 60_000
        ? 'Starting now'
        : `Started ${Math.max(1, Math.floor((now - start) / 60_000))} min ago`;
  const fmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const end = event.endTime === null ? Number.NaN : Date.parse(event.endTime);
  const range = Number.isNaN(end)
    ? fmt.format(start)
    : fmt.formatRange(start, Math.max(start, end));
  return `${phase} · ${range}`;
}

/** The storage half of "per-occurrence, local". Structural so tests hand in
 *  a Map-backed fake instead of a browser's localStorage. */
export interface DismissalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DISMISSED_KEY = 'meeting-banner-dismissed';

/** Read the dismissed occurrence keys, dropping any whose window has passed —
 *  the store would otherwise grow one line per meeting forever. */
export function readDismissed(store: DismissalStore, now: number): Set<string> {
  let raw: Record<string, number>;
  try {
    raw = JSON.parse(store.getItem(DISMISSED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    raw = {};
  }
  const live = new Set<string>();
  for (const [key, until] of Object.entries(raw)) {
    if (typeof until === 'number' && until > now) live.add(key);
  }
  return live;
}

/** Record one dismissal, expiring when the event's window does. */
export function writeDismissal(
  store: DismissalStore,
  event: CalendarBannerEvent,
  now: number,
): void {
  let raw: Record<string, number>;
  try {
    raw = JSON.parse(store.getItem(DISMISSED_KEY) ?? '{}') as Record<string, number>;
  } catch {
    raw = {};
  }
  const next: Record<string, number> = {};
  for (const [key, until] of Object.entries(raw)) {
    if (typeof until === 'number' && until > now) next[key] = until;
  }
  const w = bannerWindow(event);
  next[occurrenceKey(event)] = w ? w.until : now;
  store.setItem(DISMISSED_KEY, JSON.stringify(next));
}
