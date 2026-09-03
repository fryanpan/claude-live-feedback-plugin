import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { meetingPlatformOf } from '@feedback/core';
import {
  type FetchLike,
  type RecallRegion,
  clip,
  isRecallRegion,
  recallApiBase,
  resolveRecallKey,
} from './recall.ts';
import { readKeychainPassword } from './share/keychain.ts';

// ---------------------------------------------------------------------------
// Recall Calendar V2 client
// ---------------------------------------------------------------------------

export interface RecallCalendarEvent {
  id: string;
  /**
   * What the meeting is called, or null. Recall's own event object carries no
   * title; it lives in `raw`, the platform's record — `summary` on a Google
   * event, `subject` on an Outlook one. Read so the join surface can say
   * WHICH meeting a person is inviting a bot into; a list of bare times is
   * not something anybody can opt into responsibly.
   */
  title: string | null;
  /** ISO datetime from the vendor. */
  startTime: string;
  /**
   * ISO end, or null when the vendor record has none. The join offer lives
   * until the meeting ENDS, so a surface rendering the offer needs this, not
   * just the start.
   */
  endTime: string | null;
  meetingUrl: string | null;
  isDeleted: boolean;
  /** How many bots Recall currently has scheduled against this event. */
  botsScheduled: number;
}

export interface RecallCalendarClient {
  readonly region: RecallRegion;
  createCalendar(args: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ id: string; email: string | null }>;
  deleteCalendar(calendarId: string): Promise<void>;
  getEvent(eventId: string): Promise<RecallCalendarEvent | null>;
  /** Every event whose vendor record changed at or after `sinceIso`. */
  listEventsUpdatedSince(calendarId: string, sinceIso: string): Promise<RecallCalendarEvent[]>;
  /** Events that have not started yet, soonest first, deleted ones excluded. */
  listUpcoming(calendarId: string, nowIso: string): Promise<RecallCalendarEvent[]>;
  /**
   * Remove a VENDOR-SIDE scheduled bot. This integration no longer creates
   * them (joins go through the v1 invite path), so anything this finds is a
   * stray — a leftover from the retired auto-join draft, or something another
   * tool scheduled. An event with none is already the goal state.
   */
  unscheduleBot(eventId: string): Promise<void>;
}

/** Pages a runaway cursor chain is cut off at; each page is ~50 events. */
const MAX_LIST_PAGES = 20;

export function createRecallCalendarClient(
  opts: {
    apiKey?: string | null;
    env?: Record<string, string | undefined>;
    readKey?: (service: string) => string | null;
    fetch?: FetchLike;
  } = {},
): RecallCalendarClient | null {
  const env = opts.env ?? process.env;
  const key = resolveRecallKey(opts.apiKey, env, opts.readKey ?? readKeychainPassword);
  if (!key) return null;
  const apiKey: string = key;
  const rawRegion = env.RECALL_REGION?.trim() ?? '';
  const region: RecallRegion = isRecallRegion(rawRegion) ? rawRegion : 'us-east-1';
  const base = recallApiBase(region);
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  /**
   * One request. `Token <key>` — the v2 reference's documented header shape,
   * distinct from the v1 bot API's bare key on purpose; see the file header.
   * Nothing thrown here has been near the key.
   */
  async function send(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(url, {
      ...init,
      headers: {
        Authorization: `Token ${apiKey}`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const path = url.startsWith(base) ? url.slice(base.length) : url;
      throw new Error(
        `recall-calendar: ${init.method ?? 'GET'} ${path} failed (${res.status})${clip(detail)}` +
          (res.status === 401 ? ` — is RECALL_REGION=${region} the key's region?` : ''),
      );
    }
    return res;
  }

  async function listPage(
    url: string,
  ): Promise<{ events: RecallCalendarEvent[]; next: string | null }> {
    const res = await send(url);
    const body = (await res.json()) as Record<string, unknown>;
    const results = Array.isArray(body.results) ? body.results : [];
    const events: RecallCalendarEvent[] = [];
    for (const raw of results) {
      const event = parseCalendarEvent(raw);
      if (event) events.push(event);
    }
    return { events, next: typeof body.next === 'string' && body.next ? body.next : null };
  }

  async function listAll(firstUrl: string): Promise<RecallCalendarEvent[]> {
    const out: RecallCalendarEvent[] = [];
    let url: string | null = firstUrl;
    for (let page = 0; url && page < MAX_LIST_PAGES; page++) {
      const { events, next } = await listPage(url);
      out.push(...events);
      url = next;
    }
    return out;
  }

  return {
    region,
    async createCalendar(args): Promise<{ id: string; email: string | null }> {
      const res = await send(`${base}/v2/calendars/`, {
        method: 'POST',
        body: JSON.stringify({
          platform: 'google_calendar',
          oauth_client_id: args.clientId,
          oauth_client_secret: args.clientSecret,
          oauth_refresh_token: args.refreshToken,
        }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) throw new Error('recall-calendar: calendar create returned no id');
      return {
        id,
        email: typeof body.platform_email === 'string' ? body.platform_email : null,
      };
    },
    async deleteCalendar(calendarId: string): Promise<void> {
      try {
        await send(`${base}/v2/calendars/${encodeURIComponent(calendarId)}/`, {
          method: 'DELETE',
        });
      } catch (err) {
        // A calendar already gone at the vendor is the state a disconnect
        // wants; any other failure is real and the caller decides.
        if (err instanceof Error && err.message.includes('(404)')) return;
        throw err;
      }
    },
    async getEvent(eventId: string): Promise<RecallCalendarEvent | null> {
      let res: Response;
      try {
        res = await send(`${base}/v2/calendar-events/${encodeURIComponent(eventId)}/`);
      } catch (err) {
        if (err instanceof Error && err.message.includes('(404)')) return null;
        throw err;
      }
      return parseCalendarEvent((await res.json()) as unknown);
    },
    async listEventsUpdatedSince(calendarId, sinceIso): Promise<RecallCalendarEvent[]> {
      const url = new URL(`${base}/v2/calendar-events/`);
      url.searchParams.set('calendar_id', calendarId);
      url.searchParams.set('updated_at__gte', sinceIso);
      return listAll(url.toString());
    },
    async listUpcoming(calendarId, nowIso): Promise<RecallCalendarEvent[]> {
      const url = new URL(`${base}/v2/calendar-events/`);
      url.searchParams.set('calendar_id', calendarId);
      url.searchParams.set('start_time__gte', nowIso);
      url.searchParams.set('is_deleted', 'false');
      return listAll(url.toString());
    },
    async unscheduleBot(eventId): Promise<void> {
      try {
        await send(`${base}/v2/calendar-events/${encodeURIComponent(eventId)}/bot/`, {
          method: 'DELETE',
        });
      } catch (err) {
        // No bot scheduled is the goal state of an unschedule.
        if (err instanceof Error && err.message.includes('(404)')) return;
        throw err;
      }
    },
  };
}

export function parseCalendarEvent(raw: unknown): RecallCalendarEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id) return null;
  const platformRaw =
    typeof rec.raw === 'object' && rec.raw !== null ? (rec.raw as Record<string, unknown>) : null;
  const title =
    typeof platformRaw?.summary === 'string' && platformRaw.summary
      ? platformRaw.summary
      : typeof platformRaw?.subject === 'string' && platformRaw.subject
        ? platformRaw.subject
        : null;
  return {
    id: rec.id,
    title,
    startTime: typeof rec.start_time === 'string' ? rec.start_time : '',
    endTime: typeof rec.end_time === 'string' && rec.end_time ? rec.end_time : null,
    meetingUrl: typeof rec.meeting_url === 'string' && rec.meeting_url ? rec.meeting_url : null,
    isDeleted: rec.is_deleted === true,
    botsScheduled: Array.isArray(rec.bots) ? rec.bots.length : 0,
  };
}

/**
 * The `calendar.sync_events` webhook, or null for any other event.
 *
 * It arrives on the SAME Svix-signed endpoint as the bot status webhooks —
 * webhooks are workspace-level at the vendor — so the status route tries the
 * bot parse first and this one second, and answers 200 either way.
 */
export function parseCalendarSyncWebhook(
  raw: unknown,
): { calendarId: string; lastUpdatedTs: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const top = raw as Record<string, unknown>;
  if (top.event !== 'calendar.sync_events') return null;
  const data =
    typeof top.data === 'object' && top.data !== null
      ? (top.data as Record<string, unknown>)
      : null;
  if (!data) return null;
  const calendarId = typeof data.calendar_id === 'string' ? data.calendar_id : '';
  const lastUpdatedTs = typeof data.last_updated_ts === 'string' ? data.last_updated_ts : '';
  if (!calendarId || !lastUpdatedTs) return null;
  return { calendarId, lastUpdatedTs };
}

// ---------------------------------------------------------------------------
// Connection + opt-in persistence
// ---------------------------------------------------------------------------

export interface CalendarConnection {
  calendarId: string;
  email: string | null;
  connectedAt: number;
}

/** What a taken join offer left behind: the discussion doc the bot reports to. */
export interface CalendarJoinRecord {
  docId: string;
  joinedAt: number;
}

interface CalendarStateFile {
  connection: CalendarConnection | null;
  /**
   * Vendor event id → the join somebody explicitly took. THE MAP IS THE
   * PERMISSION: no event outside it ever gets a bot (owner's call,
   * 2026-09-01, flipping the original auto-join default — a bot appearing in
   * a meeting nobody asked it into is the failure this field exists to make
   * impossible, and it fails toward absent). The doc id rides along so a
   * repeat join answers the SAME doc, the events list can link to it, and a
   * cancellation knows which doc's bot to send home.
   */
  joins: Record<string, CalendarJoinRecord>;
}

/**
 * One small JSON file under the data dir. Survives a restart because the
 * webhook consumer must know which calendar is ours after one, and because a
 * join that lasted only until the next deploy would silently drop the bot
 * from a meeting somebody asked it into. Configuration, not user content, so
 * overwriting in place is fine under the soft-delete rule.
 */
export class CalendarConnectionStore {
  private readonly path: string;
  private state: CalendarStateFile;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'calendar', 'google.json');
    this.state = { connection: null, joins: {} };
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CalendarStateFile>;
        const joins: Record<string, CalendarJoinRecord> = {};
        if (raw.joins && typeof raw.joins === 'object') {
          for (const [eventId, rec] of Object.entries(raw.joins)) {
            if (rec && typeof rec.docId === 'string' && rec.docId) {
              joins[eventId] = {
                docId: rec.docId,
                joinedAt: typeof rec.joinedAt === 'number' ? rec.joinedAt : 0,
              };
            }
          }
        }
        this.state = {
          connection:
            raw.connection && typeof raw.connection.calendarId === 'string'
              ? {
                  calendarId: raw.connection.calendarId,
                  email: typeof raw.connection.email === 'string' ? raw.connection.email : null,
                  connectedAt:
                    typeof raw.connection.connectedAt === 'number' ? raw.connection.connectedAt : 0,
                }
              : null,
          joins,
        };
      } catch {
        // An unreadable state file means "not connected" and "nothing
        // joined" — both fail toward no bot going anywhere, the cheap
        // direction.
      }
    }
  }

  connection(): CalendarConnection | null {
    return this.state.connection;
  }

  setConnection(connection: CalendarConnection | null): void {
    this.state.connection = connection;
    // Joins are per-calendar facts: event ids from the old connection can
    // never match the new calendar's, and a stale one carried over would be
    // a standing permission nobody remembers granting. The docs the joins
    // opened are user content and are untouched.
    if (connection === null) this.state.joins = {};
    this.flush();
  }

  joinRecord(eventId: string): CalendarJoinRecord | null {
    return this.state.joins[eventId] ?? null;
  }

  setJoinRecord(eventId: string, record: CalendarJoinRecord | null): void {
    if (record) this.state.joins[eventId] = record;
    else delete this.state.joins[eventId];
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    // Holds no secret — the refresh token lives in the Keychain vault — but a
    // calendar id is still nobody else's business on a multi-user box.
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

// ---------------------------------------------------------------------------
// The sync consumer
// ---------------------------------------------------------------------------

/**
 * COULD this event carry a bot — not whether it should. The same platform
 * test the invite route runs (`meetingPlatformOf`): a link the relay could
 * not join by hand is not one to join from a calendar either. Whether a bot
 * actually joins is the person's explicit join click, handled by the route;
 * this predicate is what the events list exposes as `joinable`.
 */
export function eligibleForBot(event: RecallCalendarEvent): boolean {
  if (event.isDeleted) return false;
  if (!event.meetingUrl) return false;
  return meetingPlatformOf(event.meetingUrl) !== null;
}

export interface CalendarSyncConsumerDeps {
  client: RecallCalendarClient;
  store: CalendarConnectionStore;
  /**
   * A joined meeting was cancelled — send its doc's bot home. Wired to
   * `RecallMeetingRelay.leave` by the server; the seam exists so this module
   * never imports the relay and a test can assert the call without one.
   */
  onCancelledJoin?: (eventId: string, docId: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface ReconcileOutcome {
  eventId: string;
  action: 'left' | 'unscheduled' | 'skipped';
  reason?: string;
}

/**
 * Consumes `calendar.sync_events` webhooks. THE DEFAULT IS NO BOT (owner's
 * call, 2026-09-01), and joins do not go through the vendor's scheduler at
 * all (see the file header), so a sync never CREATES anything. What it does:
 *
 *  - a cancelled event somebody had joined sends that doc's bot home and
 *    retires the join — the permission dies with the meeting it named;
 *  - a vendor-side scheduled bot, which nothing creates on purpose any more,
 *    is removed wherever it turns up (a leftover from the retired auto-join
 *    draft, or another tool's doing);
 *  - a moved event needs nothing: the join offer surfaces the CURRENT vendor
 *    timing, and a bot already in a call does not care what the calendar
 *    says. Everything else is tracking data the events list reads live.
 *
 * Idempotent: re-leaving a left bot and re-DELETEing nothing are both no-ops,
 * so a replayed webhook is harmless.
 */
export class CalendarSyncConsumer {
  constructor(private readonly deps: CalendarSyncConsumerDeps) {}

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }

  /** The webhook consumer. Ignores calendars that are not the connected one. */
  async onSync(sync: { calendarId: string; lastUpdatedTs: string }): Promise<ReconcileOutcome[]> {
    const connection = this.deps.store.connection();
    if (!connection || connection.calendarId !== sync.calendarId) return [];
    const events = await this.deps.client.listEventsUpdatedSince(
      sync.calendarId,
      sync.lastUpdatedTs,
    );
    const outcomes: ReconcileOutcome[] = [];
    for (const event of events) {
      outcomes.push(await this.reconcile(event));
    }
    return outcomes;
  }

  /** One event, driven to the state it should be in. */
  async reconcile(event: RecallCalendarEvent): Promise<ReconcileOutcome> {
    const join = this.deps.store.joinRecord(event.id);
    if (event.isDeleted) {
      if (join) {
        try {
          await this.deps.onCancelledJoin?.(event.id, join.docId);
        } catch (err) {
          // The join still retires below: the meeting is gone either way,
          // and a leave that failed here can be repeated by hand from the
          // doc, whose bot row is still showing.
          this.log(`[calendar] leave on cancelled event ${event.id} failed: ${message(err)}`);
        }
        this.deps.store.setJoinRecord(event.id, null);
        return { eventId: event.id, action: 'left', reason: 'cancelled' };
      }
      return { eventId: event.id, action: 'skipped', reason: 'deleted' };
    }
    if (event.botsScheduled > 0) {
      await this.deps.client.unscheduleBot(event.id);
      return { eventId: event.id, action: 'unscheduled', reason: 'stray_vendor_bot' };
    }
    return {
      eventId: event.id,
      action: 'skipped',
      reason: join ? 'joined' : 'not_joined',
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
