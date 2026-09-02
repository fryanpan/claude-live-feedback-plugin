/**
 * The calendar connect / disconnect / join routes and the sync-webhook
 * consumer, over a real server. The route layer is the part nothing
 * type-checks — a predicate wired into the wrong branch is invisible to every
 * unit test. The load-bearing claims throughout: NO event gets a bot from a
 * sync alone, and a taken join does three things at once — answers the
 * meeting URL, sends the bot in through the relay's invite path, and opens a
 * discussion doc wired for the transcript.
 *
 * Every credential is a literal this suite invents; the Google flow, the
 * Recall calendar client and the bot relay's client are fakes, because the
 * real ones spend money. Fixture names and hosts are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GoogleOauthApp,
  RecallCalendarClient,
  RecallCalendarEvent,
  RefreshTokenVault,
} from '../src/recall-calendar.ts';
import type { CreateBotArgs, RecallClient } from '../src/recall.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const REDIRECT = 'https://ops.example.com/api/calendar/google/callback';

interface Fakes {
  google: GoogleOauthApp;
  client: RecallCalendarClient;
  relayClient: RecallClient;
  vault: RefreshTokenVault & { value: string | null };
  calls: {
    exchanged: string[];
    revoked: string[];
    calendarsCreated: number;
    calendarsDeleted: string[];
    unscheduled: string[];
    botsCreated: CreateBotArgs[];
    botsLeft: string[];
  };
  events: RecallCalendarEvent[];
}

const makeFakes = (): Fakes => {
  const calls: Fakes['calls'] = {
    exchanged: [],
    revoked: [],
    calendarsCreated: 0,
    calendarsDeleted: [],
    unscheduled: [],
    botsCreated: [],
    botsLeft: [],
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
      listUpcoming: async () => events.filter((e) => !e.isDeleted),
      unscheduleBot: async (eventId) => {
        calls.unscheduled.push(eventId);
      },
    },
    // The bot relay's v1 client — the join goes through the SAME invite path
    // a pasted URL takes, so a configured relay is part of this suite's rig.
    relayClient: {
      config: {
        region: 'us-east-1',
        publicWsBase: 'wss://recall.example.com',
        retentionHours: 24,
        separateStreams: true,
        botName: 'Meeting Assistant',
      },
      createBot: async (args: CreateBotArgs) => {
        calls.botsCreated.push(args);
        return { id: `bot-${calls.botsCreated.length}` };
      },
      getBot: async () => {
        throw new Error('not asked in this suite');
      },
      leaveCall: async (botId: string) => {
        calls.botsLeft.push(botId);
      },
      requestRecordingPermission: async () => false,
      checkKeyRegion: async () => ({ ok: true as const, region: 'us-east-1' as const }),
    } as RecallClient,
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

/**
 * A signing secret this suite invents. `POST /recall/status` is armed only
 * while its credential is configured — with the secret unset the route is a
 * 404 on every host, not an unsigned-accept path — so the sync webhook below
 * has to be signed the way Recall's backend signs one.
 */
const WEBHOOK_SECRET = `whsec_${btoa('claude-workspaces-calendar-test')}`;

/** Svix headers for a body, signed the way Recall's backend signs one. */
const signBody = async (body: string, id: string): Promise<Record<string, string>> => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = WEBHOOK_SECRET.slice('whsec_'.length);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  };
};

/** Each delivery needs its own id — a repeat inside the window is a replay
 *  and answers 409, which would read here as a route that stopped working. */
let syncDelivery = 0;

const syncWebhook = async (base: string): Promise<Response> => {
  const body = JSON.stringify({
    event: 'calendar.sync_events',
    data: { calendar_id: 'cal-1', last_updated_ts: '2026-09-01T00:00:00Z' },
  });
  const headers = await signBody(body, `msg_calendar_sync_${++syncDelivery}`);
  return fetch(`${base}/recall/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
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
      meetingBot: fakes.relayClient,
      meetingBotWebhookSecret: WEBHOOK_SECRET,
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

  it('join and events answer not_connected until a calendar exists', async () => {
    const events = await fetch(`${base}/api/calendar/events`);
    expect(events.status).toBe(404);
    const joinRes = await fetch(`${base}/api/calendar/events/evt-1/join`, { method: 'POST' });
    expect(joinRes.status).toBe(404);
    expect((await joinRes.json()).error).toBe('not_connected');
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

  it('THE DEFAULT: a sync sends NO bot anywhere, and removes a stray scheduled one', async () => {
    fakes.events.length = 0;
    fakes.events.push(
      {
        id: 'evt-meet',
        title: 'Design sync',
        startTime: '2026-09-02T15:00:00Z',
        endTime: '2026-09-02T15:30:00Z',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        isDeleted: false,
        botsScheduled: 0,
      },
      // A vendor-side scheduled bot nothing creates on purpose any more.
      {
        id: 'evt-stray',
        title: 'Vendor call',
        startTime: '2026-09-02T12:00:00Z',
        endTime: '2026-09-02T13:00:00Z',
        meetingUrl: 'https://zoom.us/j/1234567890',
        isDeleted: false,
        botsScheduled: 1,
      },
      // A meeting with no link at all — listed, but not joinable.
      {
        id: 'evt-lunch',
        title: 'Team lunch',
        startTime: '2026-09-02T18:00:00Z',
        endTime: null,
        meetingUrl: null,
        isDeleted: false,
        botsScheduled: 0,
      },
    );
    // No webhook secret is configured on this handle, so the route accepts
    // the body unsigned — the same mode the bot status tests rely on.
    const res = await syncWebhook(base);
    expect(res.status).toBe(200);
    // The stray's removal proves the consumer RAN; only then is the absence
    // of created bots a real negative and not a consumer that never fired
    // (a zero needs its positive control).
    await eventually(() => fakes.calls.unscheduled.includes('evt-stray'));
    expect(fakes.calls.botsCreated).toEqual([]);
  });

  it('lists upcoming events with what the join offer needs — start AND end, no URL', async () => {
    const res = await fetch(`${base}/api/calendar/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Record<string, unknown>[] };
    expect(body.events).toEqual([
      {
        id: 'evt-meet',
        title: 'Design sync',
        startTime: '2026-09-02T15:00:00Z',
        endTime: '2026-09-02T15:30:00Z',
        hasMeetingLink: true,
        joinable: true,
        joined: false,
      },
      {
        id: 'evt-stray',
        title: 'Vendor call',
        startTime: '2026-09-02T12:00:00Z',
        endTime: '2026-09-02T13:00:00Z',
        hasMeetingLink: true,
        joinable: true,
        joined: false,
      },
      {
        id: 'evt-lunch',
        title: 'Team lunch',
        startTime: '2026-09-02T18:00:00Z',
        endTime: null,
        hasMeetingLink: false,
        joinable: false,
        joined: false,
      },
    ]);
  });

  it('a taken join answers the meeting URL, sends the bot in, and opens a live doc', async () => {
    const joinRes = await fetch(`${base}/api/calendar/events/evt-meet/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join: true }),
    });
    expect(joinRes.status).toBe(200);
    const joined = (await joinRes.json()) as {
      action: string;
      meetingUrl: string;
      docId: string;
      docUrl: string;
    };
    expect(joined.action).toBe('joined');
    // The three things at once: the URL for the person...
    expect(joined.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    // ...the bot into the call, through the same invite path a pasted URL
    // takes — realtime endpoint wired, so the transcript pipeline is live...
    expect(fakes.calls.botsCreated).toHaveLength(1);
    expect(fakes.calls.botsCreated[0]?.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(fakes.calls.botsCreated[0]?.realtimeUrl).toMatch(
      /^wss:\/\/recall\.example\.com\/recall\/[0-9a-f]{32}$/,
    );
    // ...and a discussion doc, real enough to fetch, titled by the event.
    expect(joined.docId).toBeTruthy();
    expect(joined.docUrl).toContain(encodeURIComponent(joined.docId));
    const doc = (await (await fetch(`${base}/api/docs/${joined.docId}`)).json()) as {
      meta: { title?: string };
    };
    expect(doc.meta.title).toBe('Design sync');
    // The doc's bot row shows the invite this join made.
    const bot = (await (await fetch(`${base}/api/docs/${joined.docId}/meeting-bot`)).json()) as {
      bot: { state: string } | null;
    };
    expect(bot.bot).not.toBeNull();

    const listed = (await (await fetch(`${base}/api/calendar/events`)).json()) as {
      events: { id: string; joined: boolean; docId?: string }[];
    };
    const row = listed.events.find((e) => e.id === 'evt-meet');
    expect(row?.joined).toBe(true);
    expect(row?.docId).toBe(joined.docId);

    // A repeat take is idempotent: the SAME doc answers, no second doc.
    const again = (await (
      await fetch(`${base}/api/calendar/events/evt-meet/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ join: true }),
      })
    ).json()) as { docId: string };
    expect(again.docId).toBe(joined.docId);
    expect(fakes.calls.botsCreated).toHaveLength(1);

    // Un-join sends the bot home and clears the join; the doc stays.
    const leave = await fetch(`${base}/api/calendar/events/evt-meet/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join: false }),
    });
    expect(leave.status).toBe(200);
    expect(((await leave.json()) as { action: string }).action).toBe('left');
    expect(fakes.calls.botsLeft).toEqual(['bot-1']);
    const after = (await (await fetch(`${base}/api/calendar/events`)).json()) as {
      events: { id: string; joined: boolean }[];
    };
    expect(after.events.find((e) => e.id === 'evt-meet')?.joined).toBe(false);
    expect((await fetch(`${base}/api/docs/${joined.docId}`)).status).toBe(200);
  });

  it("a joined meeting's cancellation sends the bot home through the sync", async () => {
    const rejoin = (await (
      await fetch(`${base}/api/calendar/events/evt-meet/join`, { method: 'POST' })
    ).json()) as { docId: string };
    expect(fakes.calls.botsCreated).toHaveLength(2);
    const meetEvent = fakes.events.find((e) => e.id === 'evt-meet');
    if (meetEvent) meetEvent.isDeleted = true;
    fakes.calls.botsLeft.length = 0;
    expect((await syncWebhook(base)).status).toBe(200);
    await eventually(() => fakes.calls.botsLeft.includes('bot-2'));
    const listed = (await (await fetch(`${base}/api/calendar/events`)).json()) as {
      events: { id: string }[];
    };
    expect(listed.events.some((e) => e.id === 'evt-meet')).toBe(false);
    // The doc outlives the meeting that cancelled — it is user content.
    expect((await fetch(`${base}/api/docs/${rejoin.docId}`)).status).toBe(200);
  });

  it('a join on an unknown or linkless event grants nothing', async () => {
    const ghost = await fetch(`${base}/api/calendar/events/evt-ghost/join`, { method: 'POST' });
    expect(ghost.status).toBe(404);
    expect((await ghost.json()).error).toBe('unknown_event');
    const lunch = await fetch(`${base}/api/calendar/events/evt-lunch/join`, { method: 'POST' });
    expect(lunch.status).toBe(400);
    expect((await lunch.json()).error).toBe('no_supported_link');
    expect(fakes.calls.botsCreated).toHaveLength(2);
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
        (await fetch(`${base}/api/calendar/events/evt-1/join`, { method: 'POST' })).status,
      ).toBe(503);
      expect((await fetch(`${base}/api/calendar/google`, { method: 'DELETE' })).status).toBe(503);
    } finally {
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
