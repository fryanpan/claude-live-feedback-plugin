import { describe, expect, it } from 'vitest';
import {
  type CalendarBannerEvent,
  FALLBACK_DURATION_MS,
  OFFER_LEAD_MS,
  bannerTimeLine,
  bannerWindow,
  eventInWindow,
  occurrenceKey,
  pickBanner,
  readDismissed,
  writeDismissal,
} from '../src/meeting-banner-model.ts';

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

function mapStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe('bannerWindow / eventInWindow', () => {
  it('opens exactly 15 minutes before start, inclusive', () => {
    const e = ev();
    expect(eventInWindow(e, T0 - OFFER_LEAD_MS - 1)).toBe(false);
    expect(eventInWindow(e, T0 - OFFER_LEAD_MS)).toBe(true);
  });

  it('closes at endTime, exclusive', () => {
    const e = ev();
    const end = T0 + 30 * 60_000;
    expect(eventInWindow(e, end - 1)).toBe(true);
    expect(eventInWindow(e, end)).toBe(false);
  });

  it('a null endTime runs start + 60 minutes', () => {
    const e = ev({ endTime: null });
    expect(bannerWindow(e)?.until).toBe(T0 + FALLBACK_DURATION_MS);
    expect(eventInWindow(e, T0 + FALLBACK_DURATION_MS - 1)).toBe(true);
    expect(eventInWindow(e, T0 + FALLBACK_DURATION_MS)).toBe(false);
  });

  it('an unparseable start has no window at all', () => {
    expect(bannerWindow(ev({ startTime: 'not-a-date' }))).toBeNull();
    expect(eventInWindow(ev({ startTime: 'not-a-date' }), T0)).toBe(false);
  });
});

describe('pickBanner', () => {
  it('offers the soonest joinable event in window', () => {
    const later = ev({ id: 'e2', startTime: new Date(T0 + 5 * 60_000).toISOString() });
    const pick = pickBanner([later, ev()], new Set(), T0 - 60_000);
    expect(pick).toEqual({ kind: 'offer', event: expect.objectContaining({ id: 'e1' }) });
  });

  it('skips a dismissed occurrence and reveals the next candidate', () => {
    const next = ev({ id: 'e2', startTime: new Date(T0 + 5 * 60_000).toISOString() });
    const dismissed = new Set([occurrenceKey(ev())]);
    expect(pickBanner([ev(), next], dismissed, T0)?.event.id).toBe('e2');
  });

  it('a dismissal is per occurrence: the same id at a new start still offers', () => {
    const nextWeek = ev({
      startTime: new Date(T0 + 7 * 86_400_000).toISOString(),
      endTime: null,
    });
    const dismissed = new Set([occurrenceKey(ev())]);
    expect(pickBanner([nextWeek], dismissed, Date.parse(nextWeek.startTime))?.event).toBe(nextWeek);
  });

  it('never offers an event the server calls unjoinable', () => {
    expect(pickBanner([ev({ joinable: false })], new Set(), T0)).toBeNull();
  });

  it('a joined meeting wins over any offer, even a dismissed one', () => {
    const joined = ev({ id: 'e2', joined: true });
    const pick = pickBanner([ev(), joined], new Set([occurrenceKey(joined)]), T0);
    expect(pick?.kind).toBe('joined');
    expect(pick?.event.id).toBe('e2');
  });

  it('shows nothing outside every window', () => {
    expect(pickBanner([ev()], new Set(), T0 + 31 * 60_000)).toBeNull();
    expect(pickBanner([ev({ joined: true })], new Set(), T0 + 31 * 60_000)).toBeNull();
  });
});

describe('bannerTimeLine', () => {
  it('counts down before the start', () => {
    expect(bannerTimeLine(ev(), T0 - 12 * 60_000, 'en-US')).toBe(
      `Starts in 12 min · ${new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }).formatRange(T0, T0 + 30 * 60_000)}`,
    );
  });

  it('says so once the meeting has started', () => {
    expect(bannerTimeLine(ev(), T0 + 3 * 60_000, 'en-US')).toMatch(/^Started 3 min ago · /);
    expect(bannerTimeLine(ev(), T0, 'en-US')).toMatch(/^Starting now · /);
  });

  it('a null end shows the start time alone', () => {
    const line = bannerTimeLine(ev({ endTime: null }), T0 - 60_000, 'en-US');
    expect(line).toMatch(/^Starts in 1 min · /);
    expect(line).not.toContain('–');
  });
});

describe('dismissal storage', () => {
  it('round-trips a dismissal and prunes it after the window', () => {
    const store = mapStore();
    writeDismissal(store, ev(), T0);
    expect(readDismissed(store, T0).has(occurrenceKey(ev()))).toBe(true);
    // The meeting ended; the key expires with its window.
    expect(readDismissed(store, T0 + 31 * 60_000).size).toBe(0);
  });

  it('keeps other live dismissals when adding one', () => {
    const store = mapStore();
    const other = ev({ id: 'e2' });
    writeDismissal(store, other, T0);
    writeDismissal(store, ev(), T0);
    const live = readDismissed(store, T0);
    expect(live.has(occurrenceKey(other))).toBe(true);
    expect(live.has(occurrenceKey(ev()))).toBe(true);
  });

  it('survives a corrupted store', () => {
    const store = mapStore();
    store.setItem('meeting-banner-dismissed', '{nope');
    expect(readDismissed(store, T0).size).toBe(0);
    writeDismissal(store, ev(), T0);
    expect(readDismissed(store, T0).has(occurrenceKey(ev()))).toBe(true);
  });
});
