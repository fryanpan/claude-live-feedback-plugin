/**
 * Recall.ai's bot status-change webhook, and the calendar sync events that
 * ride the same signed endpoint.
 *
 * One route, its own file, because of where it has to SIT. It lives under
 * `/recall/` with the per-bot websocket upgrade and IMMEDIATELY above it:
 * one prefix is the whole bot surface, which is what the dedicated callback
 * hostname admits and what a tunnel rule can be written against, and the
 * upgrade's own test is `startsWith('/recall/')`, so a status POST reaching
 * it first would be answered `404 unknown endpoint` by the token lookup.
 * That adjacency is behaviour. `createServer` calls this from the position
 * the block held, directly above `serveUpgradeAndStreamRoutes`, and the two
 * comments say so on both sides.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import { RECALL_STATUS_PATH } from '../middleware/recall-callback-gate.ts';
import type { CalendarSyncConsumer } from '../recall-calendar.ts';
import { parseCalendarSyncWebhook } from '../recall-calendar.ts';
import type { RecallMeetingRelay } from '../recall-meeting.ts';
import { parseBotStatusWebhook } from '../recall-status.ts';
import type { WebhookReplayGuard } from '../recall-webhook-auth.ts';
import { svixHeadersFrom, verifySvixSignature } from '../recall-webhook-auth.ts';

/** The long-lived collaborators this route needs, built once per server. */
export interface RecallWebhookRoutesContext {
  /** The bot relay the parsed status event is handed to. */
  recallRelay: RecallMeetingRelay;
  /** The calendar consumer, or null when no calendar bot is configured. */
  calendarSync: CalendarSyncConsumer | null;
  /** Svix ids already delivered inside the replay window. */
  webhookReplayGuard: WebhookReplayGuard;
  /** The shared webhook secret, or undefined when none is configured — the
   *  state that disarms this route entirely. */
  meetingBotWebhookSecret: string | undefined;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
}

/** What only this request knows. */
export interface RecallWebhookRouteRequest {
  req: Request;
  pathname: string;
}

/**
 * `POST /recall/status`. `undefined` means it did not match and the caller's
 * chain continues — into the `/recall/` websocket upgrade directly below.
 */
export async function handleRecallWebhookRoute(
  ctx: RecallWebhookRoutesContext,
  rq: RecallWebhookRouteRequest,
): Promise<Response | undefined> {
  const { recallRelay, calendarSync, webhookReplayGuard, j } = ctx;
  const { req, pathname } = rq;

  // --- Recall's bot status-change webhook ---
  //
  // Workspace-level at the vendor, so it carries no token of ours and
  // arrives for every bot this account creates; the relay ignores bot
  // ids it does not know. Answered 200 even for an event we do not
  // model — a non-2xx makes the vendor retry, and retrying will not
  // make an unmodelled code become one.
  //
  // It lives under `/recall/` with the websocket upgrade below, and
  // IMMEDIATELY above it, both on purpose. One prefix is the whole bot
  // surface, which is what the dedicated callback hostname admits and
  // what a tunnel rule can be written against; and the upgrade's own
  // test is `startsWith('/recall/')`, so a status POST reaching it
  // first would be answered `404 unknown endpoint` by the token
  // lookup. Order is load-bearing — keep these two adjacent.
  if (pathname === RECALL_STATUS_PATH && req.method === 'POST') {
    const secret = ctx.meetingBotWebhookSecret;
    // ARMED ONLY WHILE ITS CREDENTIAL IS CONFIGURED — on every host,
    // not just the dedicated callback one.
    //
    // `recallCallbackAllows` already closes this path on the callback
    // hostname when `RECALL_WEBHOOK_SECRET` is unset, precisely because
    // an unset secret used to mean "accept unsigned bodies". But the
    // route is reachable on every other admitting host class too, and
    // there the whole signature-and-replay block sat inside `if
    // (secret)`: an unauthenticated non-browser caller on the LAN or the
    // tailnet could inject arbitrary bot-status and calendar-sync
    // events, unsigned and unbounded by the replay guard. Unset is the
    // DEFAULT (`bin.ts` warns rather than refuses), so that was the
    // shipped state.
    //
    // 404 rather than 401: without a secret there is no credential this
    // route could check, so it is not a door that can be knocked on.
    if (!secret) return j(404, { error: 'not_found' });
    const raw = await req.text();
    {
      const svix = svixHeadersFrom(req.headers);
      const signed = await verifySvixSignature({ secret, body: raw, headers: svix });
      if (!signed) return j(401, { error: 'bad signature' });
      // Signed, so the id is the vendor's — and a repeat of it inside
      // the window is a captured request played back, not a delivery.
      // 409 rather than a quiet 200: the ticket asks that a replay be
      // REJECTED, and a rejection is what an operator reading the log
      // can act on. The cost is that a genuine at-least-once duplicate
      // from the vendor is retried against this 409 for a while; that
      // is noise, and it is the rarer of the two cases by far.
      // (Urgent-fixes ticket, 2026-09-02.)
      if (!webhookReplayGuard.admit(svix.id ?? '')) {
        return j(409, { error: 'replayed webhook', id: svix.id });
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return j(400, { error: 'bad json' });
    }
    const event = parseBotStatusWebhook(parsed);
    if (event) recallRelay.onStatus(event);
    // The same Svix-signed endpoint carries the CALENDAR webhooks —
    // webhooks are workspace-level at the vendor — so a body that is
    // not a bot status may be a `calendar.sync_events`. Consumed after
    // the 200 is decided: the vendor's contract is "you got it", and a
    // list-and-reconcile that takes seconds must not make it retry.
    if (!event && calendarSync) {
      const sync = parseCalendarSyncWebhook(parsed);
      if (sync) {
        calendarSync.onSync(sync).catch((err: unknown) => {
          console.error('[calendar] sync_events consume failed:', err);
        });
      }
    }
    return j(200, { ok: true });
  }

  return undefined;
}
