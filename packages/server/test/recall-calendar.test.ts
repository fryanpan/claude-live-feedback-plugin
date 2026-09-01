/**
 * Calendar meeting-join, without a vendor: the OAuth URL and token calls, the
 * Calendar V2 request shapes, the sync-webhook parse, and the scheduler's
 * reconcile decisions — above all THE DEFAULT: no event gets a bot unless a
 * person explicitly joined it. Every credential here is a literal this test
 * invents; every fetch is a fake — a real schedule call spends money when the
 * bot joins. Fixture emails and hosts are fictional.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CalendarAutoScheduler,
  CalendarConnectionStore,
  type RecallCalendarClient,
  type RecallCalendarEvent,
  createGoogleOauthApp,
  createRecallCalendarClient,
  deduplicationKeyFor,
  eligibleForBot,
  parseCalendarEvent,
  parseCalendarSyncWebhook,
  resolveGoogleOauthCreds,
} from '../src/recall-calendar.ts';
import type { FetchLike } from '../src/recall.ts';

const CREDS = { clientId: 'fake-client-id', clientSecret: 'fake-client-secret' };
const REDIRECT = 'https://ops.example.com/api/calendar/google/callback';

/** A fetch that answers from a script and records what it was asked. */
const scriptedFetch = (
  script: (url: string, init: RequestInit) => { status: number; body?: unknown },
): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const answer = script(url, init);
      return new Response(answer.body !== undefined ? JSON.stringify(answer.body) : null, {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  };
};

describe('resolveGoogleOauthCreds', () => {
  it('reads env first, then the account-scoped Keychain entries', () => {
    expect(
      resolveGoogleOauthCreds({
        GOOGLE_OAUTH_CLIENT_ID: 'env-id',
        GOOGLE_OAUTH_CLIENT_SECRET: 'env-secret',
      }),
    ).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });

    const run = (args: string[]) =>
      args.includes('client-id')
        ? { status: 0, stdout: 'kc-id\n' }
        : { status: 0, stdout: 'kc-secret\n' };
    expect(resolveGoogleOauthCreds({}, run)).toEqual({
      clientId: 'kc-id',
      clientSecret: 'kc-secret',
    });
  });

  it('is null when either half is missing — an id alone starts a flow it cannot finish', () => {
    const idOnly = (args: string[]) =>
      args.includes('client-id') ? { status: 0, stdout: 'kc-id' } : { status: 1, stdout: '' };
    expect(resolveGoogleOauthCreds({}, idOnly)).toBeNull();
    expect(
      resolveGoogleOauthCreds({ GOOGLE_OAUTH_CLIENT_ID: 'env-id' }, () => ({
        status: 1,
        stdout: '',
      })),
    ).toBeNull();
  });
});

describe('google oauth app', () => {
  it('builds a consent URL that can actually yield a refresh token', () => {
    const app = createGoogleOauthApp({ creds: CREDS, redirectUri: REDIRECT });
    const url = new URL(app.consentUrl('state-123'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('fake-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
    // Both required for a refresh token: offline asks for one, and
    // prompt=consent forces a re-grant to carry one on a reconnect.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
  });

  it('exchanges the code as a form post and returns the refresh token', async () => {
    const { fetch, calls } = scriptedFetch(() => ({
      status: 200,
      body: { access_token: 'fake-access', refresh_token: 'fake-refresh' },
    }));
    const app = createGoogleOauthApp({ creds: CREDS, redirectUri: REDIRECT, fetch });
    const { refreshToken } = await app.exchange('code-abc');
    expect(refreshToken).toBe('fake-refresh');
    const call = calls[0];
    expect(call?.url).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(String(call?.init.body));
    expect(form.get('code')).toBe('code-abc');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(REDIRECT);
  });

  it('a token answer with no refresh_token is an error a person can act on', async () => {
    const { fetch } = scriptedFetch(() => ({ status: 200, body: { access_token: 'only' } }));
    const app = createGoogleOauthApp({ creds: CREDS, redirectUri: REDIRECT, fetch });
    await expect(app.exchange('code-abc')).rejects.toThrow(/refresh_token/);
  });

  it('revoke treats an already-revoked token (400) as done', async () => {
    const { fetch } = scriptedFetch(() => ({ status: 400, body: { error: 'invalid_token' } }));
    const app = createGoogleOauthApp({ creds: CREDS, redirectUri: REDIRECT, fetch });
    await expect(app.revoke('fake-refresh')).resolves.toBeUndefined();
  });
});

describe('calendar sync webhook parse', () => {
  it('reads calendar.sync_events and nothing else', () => {
    expect(
      parseCalendarSyncWebhook({
        event: 'calendar.sync_events',
        data: { calendar_id: 'cal-1', last_updated_ts: '2026-08-31T10:00:00Z' },
      }),
    ).toEqual({ calendarId: 'cal-1', lastUpdatedTs: '2026-08-31T10:00:00Z' });
    // A bot status webhook is the OTHER parse's business; this one says null.
    expect(
      parseCalendarSyncWebhook({
        event: 'bot.in_call_recording',
        data: { data: { code: 'in_call_recording' }, bot: { id: 'bot-1' } },
      }),
    ).toBeNull();
    expect(parseCalendarSyncWebhook({ event: 'calendar.sync_events', data: {} })).toBeNull();
    expect(parseCalendarSyncWebhook(null)).toBeNull();
  });
});

describe('event mapping and decisions', () => {
  const event = (over: Partial<RecallCalendarEvent> = {}): RecallCalendarEvent => ({
    id: 'evt-1',
    title: 'Design sync',
    startTime: '2026-09-01T15:00:00Z',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    isDeleted: false,
    botsScheduled: 0,
    ...over,
  });

  it('maps the vendor shape, reading the title from the platform raw record', () => {
    expect(
      parseCalendarEvent({
        id: 'evt-9',
        start_time: '2026-09-02T09:00:00Z',
        meeting_url: 'https://zoom.us/j/1234567890',
        is_deleted: false,
        bots: [{ bot_id: 'b1' }],
        // Recall's own event carries no title; Google's raw record says
        // `summary`, Outlook's says `subject`.
        raw: { summary: 'Quarterly review' },
      }),
    ).toEqual({
      id: 'evt-9',
      title: 'Quarterly review',
      startTime: '2026-09-02T09:00:00Z',
      meetingUrl: 'https://zoom.us/j/1234567890',
      isDeleted: false,
      botsScheduled: 1,
    });
    expect(parseCalendarEvent({ id: 'evt-8', raw: { subject: 'Outlook one' } })?.title).toBe(
      'Outlook one',
    );
    expect(parseCalendarEvent({ id: 'evt-7' })?.title).toBeNull();
    expect(parseCalendarEvent({ start_time: 'x' })).toBeNull();
  });

  it('dedup key is the docs\' "deduplicate all" strategy: start time + URL', () => {
    expect(deduplicationKeyFor(event())).toBe(
      '2026-09-01T15:00:00Z-https://meet.google.com/abc-defg-hij',
    );
  });

  it('joinable = live event with a link the bot relay could join — not a decision to join it', () => {
    expect(eligibleForBot(event())).toBe(true);
    expect(eligibleForBot(event({ meetingUrl: 'https://zoom.us/j/1234567890' }))).toBe(true);
    expect(eligibleForBot(event({ meetingUrl: null }))).toBe(false);
    expect(eligibleForBot(event({ meetingUrl: 'https://example.com/not-a-meeting' }))).toBe(false);
    expect(eligibleForBot(event({ isDeleted: true }))).toBe(false);
  });
});

describe('recall calendar client', () => {
  const KEY = 'fake-recall-key';

  it('speaks v2 with the Token-prefixed header and sends the connect triple', async () => {
    const { fetch, calls } = scriptedFetch(() => ({
      status: 201,
      body: { id: 'cal-1', platform_email: 'casey@example.com' },
    }));
    const client = createRecallCalendarClient({ apiKey: KEY, env: {}, fetch });
    expect(client).not.toBeNull();
    const created = await client?.createCalendar({
      refreshToken: 'fake-refresh',
      clientId: CREDS.clientId,
      clientSecret: CREDS.clientSecret,
    });
    expect(created).toEqual({ id: 'cal-1', email: 'casey@example.com' });
    const call = calls[0];
    expect(call?.url).toBe('https://us-east-1.recall.ai/api/v2/calendars/');
    // v2 documents `Token <key>`, unlike the v1 bot API's bare key. Both are
    // the vendor's own shapes; neither should be "fixed" to the other.
    expect((call?.init.headers as Record<string, string>).Authorization).toBe(`Token ${KEY}`);
    expect(JSON.parse(String(call?.init.body))).toEqual({
      platform: 'google_calendar',
      oauth_client_id: 'fake-client-id',
      oauth_client_secret: 'fake-client-secret',
      oauth_refresh_token: 'fake-refresh',
    });
  });

  it('follows the list cursor and filters by updated_at__gte', async () => {
    const page2 = 'https://us-east-1.recall.ai/api/v2/calendar-events/?cursor=p2';
    const { fetch, calls } = scriptedFetch((url) =>
      url.includes('cursor=p2')
        ? { status: 200, body: { results: [{ id: 'evt-2', start_time: 't2' }], next: null } }
        : { status: 200, body: { results: [{ id: 'evt-1', start_time: 't1' }], next: page2 } },
    );
    const client = createRecallCalendarClient({ apiKey: KEY, env: {}, fetch });
    const events = await client?.listEventsUpdatedSince('cal-1', '2026-08-31T10:00:00Z');
    expect(events?.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    const first = new URL(calls[0]?.url ?? '');
    expect(first.searchParams.get('calendar_id')).toBe('cal-1');
    expect(first.searchParams.get('updated_at__gte')).toBe('2026-08-31T10:00:00Z');
  });

  it('schedules with a complete bot_config and the dedup key', async () => {
    const { fetch, calls } = scriptedFetch(() => ({ status: 200, body: {} }));
    const client = createRecallCalendarClient({ apiKey: KEY, env: {}, fetch });
    await client?.scheduleBot('evt-1', { deduplicationKey: 'k1', botName: 'Meeting Assistant' });
    expect(calls[0]?.url).toBe('https://us-east-1.recall.ai/api/v2/calendar-events/evt-1/bot/');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      deduplication_key: 'k1',
      bot_config: { bot_name: 'Meeting Assistant' },
    });
  });

  it('unschedule and calendar delete treat 404 as the goal state', async () => {
    const { fetch } = scriptedFetch(() => ({ status: 404, body: { detail: 'not found' } }));
    const client = createRecallCalendarClient({ apiKey: KEY, env: {}, fetch });
    await expect(client?.unscheduleBot('evt-1')).resolves.toBeUndefined();
    await expect(client?.deleteCalendar('cal-1')).resolves.toBeUndefined();
  });

  it('is null with no key — the documented not-configured state', () => {
    expect(createRecallCalendarClient({ apiKey: null, env: {} })).toBeNull();
  });
});

describe('connection store', () => {
  it('persists the connection and joins across instances, and clears joins on disconnect', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-store-'));
    try {
      const store = new CalendarConnectionStore(dir);
      expect(store.connection()).toBeNull();
      expect(store.isOptedIn('evt-1')).toBe(false);
      store.setConnection({ calendarId: 'cal-1', email: 'casey@example.com', connectedAt: 5 });
      store.setOptIn('evt-1', true);

      const reread = new CalendarConnectionStore(dir);
      expect(reread.connection()?.calendarId).toBe('cal-1');
      expect(reread.isOptedIn('evt-1')).toBe(true);

      // Joins are per-calendar permissions; a new connection starts with none
      // granted, never with a stale grant nobody remembers.
      reread.setConnection(null);
      expect(new CalendarConnectionStore(dir).isOptedIn('evt-1')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scheduler — the default is NO bot', () => {
  const fakeClient = (events: RecallCalendarEvent[]) => {
    const scheduled: { eventId: string; deduplicationKey: string; botName: string }[] = [];
    const unscheduled: string[] = [];
    const client: RecallCalendarClient = {
      region: 'us-east-1',
      createCalendar: async () => ({ id: 'cal-1', email: null }),
      deleteCalendar: async () => {},
      getEvent: async (id) => events.find((e) => e.id === id) ?? null,
      listEventsUpdatedSince: async () => events,
      listUpcoming: async () => events,
      scheduleBot: async (eventId, args) => {
        scheduled.push({ eventId, ...args });
      },
      unscheduleBot: async (eventId) => {
        unscheduled.push(eventId);
      },
    };
    return { client, scheduled, unscheduled };
  };

  const connectedStore = (dir: string): CalendarConnectionStore => {
    const store = new CalendarConnectionStore(dir);
    store.setConnection({ calendarId: 'cal-1', email: null, connectedAt: 1 });
    return store;
  };

  const meet = (id: string, over: Partial<RecallCalendarEvent> = {}): RecallCalendarEvent => ({
    id,
    title: 'Weekly huddle',
    startTime: '2026-09-01T15:00:00Z',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    isDeleted: false,
    botsScheduled: 0,
    ...over,
  });

  it("a sync for somebody else's calendar does nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const { client, scheduled } = fakeClient([meet('evt-1')]);
      const scheduler = new CalendarAutoScheduler({ client, store: connectedStore(dir) });
      const outcomes = await scheduler.onSync({ calendarId: 'cal-OTHER', lastUpdatedTs: 't' });
      expect(outcomes).toEqual([]);
      expect(scheduled).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('THE DEFAULT: an event with a Zoom/Meet link gets NO bot unless explicitly joined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const { client, scheduled, unscheduled } = fakeClient([
        meet('evt-meet'),
        meet('evt-zoom', { meetingUrl: 'https://zoom.us/j/1234567890' }),
      ]);
      const scheduler = new CalendarAutoScheduler({ client, store: connectedStore(dir) });
      const outcomes = await scheduler.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(scheduled).toEqual([]);
      expect(unscheduled).toEqual([]);
      expect(outcomes.map((o) => o.reason)).toEqual(['not_joined', 'not_joined']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only joined events are scheduled, under the dedup key; leftover bots come off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const events = [
        meet('evt-joined'),
        // A bot on an un-joined event — a withdrawn join, or a leftover from
        // before no-bot became the default — is actively removed.
        meet('evt-leftover', { botsScheduled: 1 }),
        // Cancelled: Recall unschedules an unjoined bot itself and refuses
        // writes on a deleted event, so the right move is no move — but the
        // join permission dies with the meeting.
        meet('evt-cancelled', { isDeleted: true, botsScheduled: 1 }),
      ];
      const { client, scheduled, unscheduled } = fakeClient(events);
      const store = connectedStore(dir);
      store.setOptIn('evt-joined', true);
      store.setOptIn('evt-cancelled', true);
      const scheduler = new CalendarAutoScheduler({
        client,
        store,
        botName: 'Meeting Assistant',
      });
      const outcomes = await scheduler.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(scheduled).toEqual([
        {
          eventId: 'evt-joined',
          deduplicationKey: '2026-09-01T15:00:00Z-https://meet.google.com/abc-defg-hij',
          botName: 'Meeting Assistant',
        },
      ]);
      expect(unscheduled).toEqual(['evt-leftover']);
      expect(outcomes.map((o) => o.action)).toEqual(['scheduled', 'unscheduled', 'skipped']);
      expect(store.isOptedIn('evt-cancelled')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a moved joined event is simply re-scheduled — the re-POST carries the new timing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const moved = meet('evt-moved', { startTime: '2026-09-01T16:00:00Z', botsScheduled: 1 });
      const { client, scheduled } = fakeClient([moved]);
      const store = connectedStore(dir);
      store.setOptIn('evt-moved', true);
      const scheduler = new CalendarAutoScheduler({ client, store });
      await scheduler.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(scheduled[0]?.deduplicationKey).toBe(
        '2026-09-01T16:00:00Z-https://meet.google.com/abc-defg-hij',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('one refused schedule does not stop the rest of the batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const { client, scheduled } = fakeClient([meet('evt-stale'), meet('evt-fine')]);
      const refuse = client.scheduleBot;
      client.scheduleBot = async (eventId, args) => {
        if (eventId === 'evt-stale') throw new Error('recall-calendar: event already ended');
        return refuse(eventId, args);
      };
      const store = connectedStore(dir);
      store.setOptIn('evt-stale', true);
      store.setOptIn('evt-fine', true);
      const scheduler = new CalendarAutoScheduler({ client, store, log: () => {} });
      const outcomes = await scheduler.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(outcomes.map((o) => o.action)).toEqual(['skipped', 'scheduled']);
      expect(scheduled.map((s) => s.eventId)).toEqual(['evt-fine']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('join schedules the bot now, and un-join removes it now', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const { client, scheduled, unscheduled } = fakeClient([meet('evt-1')]);
      const store = connectedStore(dir);
      const scheduler = new CalendarAutoScheduler({ client, store });

      const joined = await scheduler.setJoin('evt-1', true);
      expect(joined?.action).toBe('scheduled');
      expect(scheduled.map((s) => s.eventId)).toEqual(['evt-1']);
      expect(store.isOptedIn('evt-1')).toBe(true);

      // The fake now reports a bot on the event, as the vendor would.
      const { client: client2, unscheduled: unscheduled2 } = fakeClient([
        meet('evt-1', { botsScheduled: 1 }),
      ]);
      const scheduler2 = new CalendarAutoScheduler({ client: client2, store });
      const left = await scheduler2.setJoin('evt-1', false);
      expect(left?.action).toBe('unscheduled');
      expect(left?.reason).toBe('not_joined');
      expect(unscheduled2).toEqual(['evt-1']);
      expect(store.isOptedIn('evt-1')).toBe(false);
      expect(unscheduled).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a join on an event the vendor does not know grants nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sched-'));
    try {
      const { client, scheduled } = fakeClient([]);
      const store = connectedStore(dir);
      const scheduler = new CalendarAutoScheduler({ client, store });
      const outcome = await scheduler.setJoin('evt-ghost', true);
      expect(outcome?.reason).toBe('unknown_event');
      expect(scheduled).toEqual([]);
      // The flag is taken back off — no permission floats on an unknown id.
      expect(store.isOptedIn('evt-ghost')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
