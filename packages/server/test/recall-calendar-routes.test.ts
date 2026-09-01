/**
 * The calendar connect / disconnect / opt-out routes and the sync-webhook
 * consumer, over a real server. The route layer is the part nothing
 * type-checks — a predicate wired into the wrong branch is invisible to every
 * unit test.
 *
 * Every credential is a literal this suite invents; the Google flow and the
 * Recall client are fakes, because the real ones spend money. Fixture names
 * and hosts are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GoogleOauthApp,
  type RecallCalendarClient,
  type RecallCalendarEvent,
  type RefreshTokenVault,
} from '../src/recall-calendar.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const REDIRECT = 'https://ops.example.com/api/calendar/google/callback';

interface Fakes {
  google: GoogleOauthApp;
  client: RecallCalendarClient;
  vault: RefreshTokenVault & { value: string | null };
  calls: {
    exchanged: string[];
    revoked: string[];
    calendarsCreated: number;
    calendarsDeleted: string[];
    scheduled: { eventId: string; deduplicationKey: string }[];
    unscheduled: string[];
  };
  events: RecallCalendarEvent[];
}

const makeFakes = (): Fakes => {
  const calls: Fakes['calls'] = {
    exchanged: [],
    revoked: [],
    calendarsCreated: 0,
    calendarsDeleted: [],
    scheduled: [],
    unscheduled: [],
  };
  const events: RecallCalendarEvent[] = [];
  return {
    calls,
    events,
    google: {
      clientId: 'fake-client-id',
      clientSecret: 'fake-client-secret',
      redirectUri: REDIRECT,
      consentUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      exchange: async (code) => {
        calls.exchanged.push(code);
        return { refreshToken: 'fake-refresh-token' };
      },
      revoke: async (token) => {
        calls.revoked.push(token);
      },
    },
    client: {
      region: 'us-east-1',
      createCalendar: async () => {
        calls.calendarsCreated += 1;
        return { id: 'cal-1', email: 'casey@example.com' };
      },
      deleteCalendar: async (id) => {
        calls.calendarsDeleted.push(id);
      },
      getEvent: async (id) => events.find((e) => e.id === id) ?? null,
      listEventsUpdatedSince: async () => events,
      listUpcoming: async () => events,
      scheduleBot: async (eventId, args) => {
        calls.scheduled.push({ eventId, deduplicationKey: args.deduplicationKey });
      },
      unscheduleBot: async (eventId) => {
        calls.unscheduled.push(eventId);
      },
    },
    vault: {
      value: null,
      save(token) {
        this.value = token;
      },
      load() {
        return this.value;
      },
      clear() {
        this.value = null;
      },
    },
  };
};

/** Poll until `check` passes — the webhook consumer is fire-and-forget. */
const eventually = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(check()).toBe(true);
};

describe('calendar routes', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let fakes: Fakes;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'calendar-routes-'));
    fakes = makeFakes();
    handle = createServer({
      port: 0,
      dataDir,
      calendarBot: { client: fakes.client, google: fakes.google, vault: fakes.vault },
    });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports its configuration before anything is connected', async () => {
    const res = await fetch(`${base}/api/calendar`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: true,
      googleConfigured: true,
      connection: null,
    });
  });

  it('opt-out and events answer not_connected until a calendar exists', async () => {
    const events = await fetch(`${base}/api/calendar/events`);
    expect(events.status).toBe(404);
    const optOut = await fetch(`${base}/api/calendar/events/evt-1/opt-out`, { method: 'POST' });
    expect((await optOut.json()).error).toBe('not_connected');
  });

  it('connect redirects to the consent screen with a one-shot state', async () => {
    const res = await fetch(`${base}/api/calendar/google/connect`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://accounts.google.com/')).toBe(true);
    expect(new URL(location).searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the callback refuses a state it never minted', async () => {
    const res = await fetch(`${base}/api/calendar/google/callback?code=x&state=forged`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_state');
  });

  it('a real state exchanges the code, connects the calendar at Recall, vaults the token', async () => {
    const connect = await fetch(`${base}/api/calendar/google/connect`, { redirect: 'manual' });
    const state = new URL(connect.headers.get('location') ?? '').searchParams.get('state');
    const res = await fetch(`${base}/api/calendar/google/callback?code=code-abc&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(fakes.calls.exchanged).toEqual(['code-abc']);
    expect(fakes.calls.calendarsCreated).toBe(1);
    expect(fakes.vault.load()).toBe('fake-refresh-token');

    // ...and the state is SPENT: replaying the same callback is refused.
    const replay = await fetch(`${base}/api/calendar/google/callback?code=code-abc&state=${state}`);
    expect(replay.status).toBe(400);

    const status = (await (await fetch(`${base}/api/calendar`)).json()) as {
      connection: { email: string } | null;
    };
    expect(status.connection?.email).toBe('casey@example.com');
  });

  it('a calendar.sync_events webhook drives schedule and unschedule', async () => {
    fakes.events.length = 0;
    fakes.events.push(
      {
        id: 'evt-meet',
        startTime: '2026-09-02T15:00:00Z',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        isDeleted: false,
        botsScheduled: 0,
      },
      {
        id: 'evt-lunch',
        startTime: '2026-09-02T12:00:00Z',
        meetingUrl: null,
        isDeleted: false,
        botsScheduled: 1,
      },
    );
    // No webhook secret is configured on this handle, so the route accepts
    // the body unsigned — the same mode the bot status tests rely on.
    const res = await fetch(`${base}/recall/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'calendar.sync_events',
        data: { calendar_id: 'cal-1', last_updated_ts: '2026-09-01T00:00:00Z' },
      }),
    });
    expect(res.status).toBe(200);
    await eventually(() => fakes.calls.scheduled.length === 1);
    expect(fakes.calls.scheduled[0]).toEqual({
      eventId: 'evt-meet',
      deduplicationKey: '2026-09-02T15:00:00Z-https://meet.google.com/abc-defg-hij',
    });
    await eventually(() => fakes.calls.unscheduled.includes('evt-lunch'));
  });

  it('lists upcoming events with their bot + opt-out flags', async () => {
    const res = await fetch(`${base}/api/calendar/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { id: string; optedOut: boolean }[] };
    expect(body.events.map((e) => e.id)).toEqual(['evt-meet', 'evt-lunch']);
    expect(body.events.every((e) => e.optedOut === false)).toBe(true);
  });

  it('opt-out removes the bot from that event immediately, opt-in restores it', async () => {
    fakes.calls.unscheduled.length = 0;
    fakes.calls.scheduled.length = 0;
    const out = await fetch(`${base}/api/calendar/events/evt-meet/opt-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optOut: true }),
    });
    expect(out.status).toBe(200);
    // The fake reports 0 bots on evt-meet, so the reconcile records the
    // opt-out and has nothing to remove; the flag is the durable part.
    const listed = (await (await fetch(`${base}/api/calendar/events`)).json()) as {
      events: { id: string; optedOut: boolean }[];
    };
    expect(listed.events.find((e) => e.id === 'evt-meet')?.optedOut).toBe(true);

    const back = await fetch(`${base}/api/calendar/events/evt-meet/opt-out`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optOut: false }),
    });
    expect(back.status).toBe(200);
    expect(fakes.calls.scheduled.map((s) => s.eventId)).toEqual(['evt-meet']);
  });

  it('disconnect deletes the Recall calendar, revokes at Google, clears the vault', async () => {
    const res = await fetch(`${base}/api/calendar/google`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: true });
    expect(fakes.calls.calendarsDeleted).toEqual(['cal-1']);
    expect(fakes.calls.revoked).toEqual(['fake-refresh-token']);
    expect(fakes.vault.load()).toBeNull();
    const status = (await (await fetch(`${base}/api/calendar`)).json()) as {
      connection: unknown;
    };
    expect(status.connection).toBeNull();

    // A second disconnect has nothing to disconnect.
    const again = await fetch(`${base}/api/calendar/google`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

describe('calendar routes without the feature', () => {
  it('every calendar verb answers not_configured on a server with no calendarBot', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'calendar-off-'));
    const handle = createServer({ port: 0, dataDir });
    try {
      const base = `http://localhost:${handle.port}`;
      const status = (await (await fetch(`${base}/api/calendar`)).json()) as {
        configured: boolean;
      };
      expect(status.configured).toBe(false);
      expect((await fetch(`${base}/api/calendar/google/connect`)).status).toBe(503);
      expect((await fetch(`${base}/api/calendar/events`)).status).toBe(503);
      expect(
        (await fetch(`${base}/api/calendar/events/evt-1/opt-out`, { method: 'POST' })).status,
      ).toBe(503);
      expect((await fetch(`${base}/api/calendar/google`, { method: 'DELETE' })).status).toBe(503);
    } finally {
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
