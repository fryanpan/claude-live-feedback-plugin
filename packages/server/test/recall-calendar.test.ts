/**
 * Calendar meeting-join, without a vendor: the OAuth URL and token calls, the
 * Calendar V2 request shapes, the sync-webhook parse, and the sync consumer's
 * decisions — above all THE DEFAULT: no event gets a bot unless a person
 * explicitly joined it, and even then the bot goes through the relay's invite
 * path, never a vendor-side schedule. Every credential here is a literal this
 * test invents; every fetch is a fake — a real bot spends money when it
 * joins. Fixture emails and hosts are fictional.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoogleOauthApp, resolveGoogleOauthCreds } from '../src/google-oauth.ts';
import {
  CalendarConnectionStore,
  CalendarSyncConsumer,
  type RecallCalendarClient,
  type RecallCalendarEvent,
  createRecallCalendarClient,
  eligibleForBot,
  parseCalendarEvent,
  parseCalendarSyncWebhook,
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
    endTime: '2026-09-01T15:30:00Z',
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
        end_time: '2026-09-02T09:45:00Z',
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
      endTime: '2026-09-02T09:45:00Z',
      meetingUrl: 'https://zoom.us/j/1234567890',
      isDeleted: false,
      botsScheduled: 1,
    });
    expect(parseCalendarEvent({ id: 'evt-8', raw: { subject: 'Outlook one' } })?.title).toBe(
      'Outlook one',
    );
    // An event with no end still parses — the offer surface treats a null
    // end as "unknown", never as a reason to hide the meeting.
    expect(parseCalendarEvent({ id: 'evt-7' })?.endTime).toBeNull();
    expect(parseCalendarEvent({ id: 'evt-7' })?.title).toBeNull();
    expect(parseCalendarEvent({ start_time: 'x' })).toBeNull();
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
      expect(store.joinRecord('evt-1')).toBeNull();
      store.setConnection({ calendarId: 'cal-1', email: 'casey@example.com', connectedAt: 5 });
      store.setJoinRecord('evt-1', { docId: 'd-meet1', joinedAt: 7 });

      const reread = new CalendarConnectionStore(dir);
      expect(reread.connection()?.calendarId).toBe('cal-1');
      // The doc rides with the join, so a repeat join after a restart still
      // answers the same doc.
      expect(reread.joinRecord('evt-1')).toEqual({ docId: 'd-meet1', joinedAt: 7 });

      reread.setJoinRecord('evt-1', null);
      expect(new CalendarConnectionStore(dir).joinRecord('evt-1')).toBeNull();

      // Joins are per-calendar permissions; a new connection starts with none
      // granted, never with a stale grant nobody remembers.
      reread.setJoinRecord('evt-2', { docId: 'd-meet2', joinedAt: 8 });
      reread.setConnection(null);
      expect(new CalendarConnectionStore(dir).joinRecord('evt-2')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sync consumer — the default is NO bot, and syncs never create one', () => {
  // The client type itself is half the proof: `RecallCalendarClient` has no
  // way to CREATE a bot any more — joins go through the relay's invite, and
  // the only bot verb a sync holds is the removal of a stray.
  const fakeClient = (events: RecallCalendarEvent[]) => {
    const unscheduled: string[] = [];
    const client: RecallCalendarClient = {
      region: 'us-east-1',
      createCalendar: async () => ({ id: 'cal-1', email: null }),
      deleteCalendar: async () => {},
      getEvent: async (id) => events.find((e) => e.id === id) ?? null,
      listEventsUpdatedSince: async () => events,
      listUpcoming: async () => events,
      unscheduleBot: async (eventId) => {
        unscheduled.push(eventId);
      },
    };
    return { client, unscheduled };
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
    endTime: '2026-09-01T15:30:00Z',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    isDeleted: false,
    botsScheduled: 0,
    ...over,
  });

  it("a sync for somebody else's calendar does nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      const { client, unscheduled } = fakeClient([meet('evt-1')]);
      const consumer = new CalendarSyncConsumer({ client, store: connectedStore(dir) });
      const outcomes = await consumer.onSync({ calendarId: 'cal-OTHER', lastUpdatedTs: 't' });
      expect(outcomes).toEqual([]);
      expect(unscheduled).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('THE DEFAULT: linked events nobody joined produce no action at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      const { client, unscheduled } = fakeClient([
        meet('evt-meet'),
        meet('evt-zoom', { meetingUrl: 'https://zoom.us/j/1234567890' }),
      ]);
      const consumer = new CalendarSyncConsumer({ client, store: connectedStore(dir) });
      const outcomes = await consumer.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(unscheduled).toEqual([]);
      expect(outcomes.map((o) => o.action)).toEqual(['skipped', 'skipped']);
      expect(outcomes.map((o) => o.reason)).toEqual(['not_joined', 'not_joined']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stray vendor-side scheduled bot is removed wherever the sync finds one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      // Nothing creates these on purpose any more — this is the leftover
      // from the retired auto-join draft, or another tool's doing. It is
      // also this suite's positive control: the removal proves the consumer
      // actually reconciled the batch the empty default rode in.
      const { client, unscheduled } = fakeClient([
        meet('evt-meet'),
        meet('evt-stray', { botsScheduled: 1 }),
      ]);
      const consumer = new CalendarSyncConsumer({ client, store: connectedStore(dir) });
      const outcomes = await consumer.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(unscheduled).toEqual(['evt-stray']);
      expect(outcomes.map((o) => o.action)).toEqual(['skipped', 'unscheduled']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a cancelled joined meeting sends its doc's bot home and retires the join", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      const { client } = fakeClient([meet('evt-gone', { isDeleted: true })]);
      const store = connectedStore(dir);
      store.setJoinRecord('evt-gone', { docId: 'd-meet1', joinedAt: 3 });
      const left: [string, string][] = [];
      const consumer = new CalendarSyncConsumer({
        client,
        store,
        onCancelledJoin: async (eventId, docId) => {
          left.push([eventId, docId]);
        },
      });
      const outcomes = await consumer.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(left).toEqual([['evt-gone', 'd-meet1']]);
      expect(outcomes).toEqual([{ eventId: 'evt-gone', action: 'left', reason: 'cancelled' }]);
      // The permission dies with the meeting it named.
      expect(store.joinRecord('evt-gone')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed leave still retires the join — the meeting is gone either way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      const { client } = fakeClient([meet('evt-gone', { isDeleted: true })]);
      const store = connectedStore(dir);
      store.setJoinRecord('evt-gone', { docId: 'd-meet1', joinedAt: 3 });
      const consumer = new CalendarSyncConsumer({
        client,
        store,
        onCancelledJoin: async () => {
          throw new Error('relay is having a day');
        },
        log: () => {},
      });
      const outcomes = await consumer.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(outcomes[0]?.action).toBe('left');
      expect(store.joinRecord('evt-gone')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a cancelled meeting nobody joined needs nothing from us', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-sync-'));
    try {
      const { client, unscheduled } = fakeClient([
        // Recall unschedules its own unjoined bots on cancellation and
        // refuses writes on deleted events — the right move is no move.
        meet('evt-gone', { isDeleted: true, botsScheduled: 1 }),
      ]);
      const consumer = new CalendarSyncConsumer({ client, store: connectedStore(dir) });
      const outcomes = await consumer.onSync({ calendarId: 'cal-1', lastUpdatedTs: 't' });
      expect(outcomes).toEqual([{ eventId: 'evt-gone', action: 'skipped', reason: 'deleted' }]);
      expect(unscheduled).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
