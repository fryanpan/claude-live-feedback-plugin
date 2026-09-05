import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
/**
 * The meeting, transcript and calendar REST block, in the order it is
 * matched.
 *
 * These routes were written as one long if-chain inside `createServer` and
 * the sequence was kept exactly through the move. Order is behaviour here in
 * one specific way, and it is the reason the whole family sits where it does:
 * every `/api/docs/<id>/meetings...` pattern must be tried BEFORE the
 * `/api/docs/<id>/...` catch-all in `routes/docs.ts`, which would otherwise
 * swallow all of them. That is why this handler is called from the chain
 * position the block occupied — above the doc resource block, below the
 * agent, plugin and deploy routes — and not merged into either neighbour.
 *
 * Nothing here writes or deletes a transcript. A transcript is the least
 * reconstructible thing this server holds, because the audio is already gone.
 *
 * The guard against reordering is the per-route HTTP suite —
 * `meetings-*.test.ts`, `calendar-*.test.ts`, `meeting-bot*.test.ts` — each
 * of which fails if its path starts reaching a different handler.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import { MAX_SPEAKER_NAME, speakerDisplayName } from '@feedback/core';
import { meetingDocAlias, meetingDocFilePath, meetingDocTitle } from '../huddle.ts';
import type { MeetingRelay } from '../meeting-protocol.ts';
import type { MeetingStore } from '../meetings.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import {
  type CalendarConnectionStore,
  type CalendarSyncConsumer,
  type RecallCalendarEvent,
  eligibleForBot,
} from '../recall-calendar.ts';

import type { RecallMeetingRelay } from '../recall-meeting.ts';
import type { Rooms } from '../rooms.ts';
import type { ServerOptions } from '../server.ts';
import type { TaskStore } from '../tasks.ts';

/** The long-lived collaborators these routes need, built once per server. */
export interface MeetingCalendarRoutesContext {
  /** Doc rooms — a meeting is always a meeting ON a doc. */
  rooms: Rooms;
  /** The hub task store, for the board a newly created huddle is filed on. */
  taskStore: TaskStore;
  /** The append-only transcript store. A transcript outlives its room, so
   *  these routes deliberately do not require the room to still exist. */
  meetingStore: MeetingStore;
  /** The live meeting relay — which docs have a meeting running. */
  meetingRelay: MeetingRelay;
  /** The vendor bot relay, or its no-bot form. */
  recallRelay: RecallMeetingRelay;
  /** The calendar connection record, or null when no calendar bot is wired. */
  calendarStore: CalendarConnectionStore | null;
  /** The calendar → bot sync, or null for the same reason. */
  calendarSync: CalendarSyncConsumer | null;
  /** The calendar bot's client, OAuth app and token vault. Passed whole
   *  rather than unpacked: the routes read four of its members and every one
   *  of them is a constructed adapter this layer must never build itself. */
  calendarBot: ServerOptions['calendarBot'];
  /** Outstanding Google OAuth `state` values and when each was minted. */
  calendarOauthStates: Map<string, number>;
  /** The data directory — a newly created huddle doc is written under it. */
  dataDir: string;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Whether a string may be used as a doc id at all. */
  isValidDocId: (s: string) => boolean;
  /** File a loose attachment under a hub board, minting Unfiled if needed. */
  fileUnderHubWorkspace: (attachmentId: string, requested?: string) => string | undefined;
}

/** What only this request knows. */
export interface MeetingCalendarRouteRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/**
 * The meeting, transcript and calendar routes, tried in source order.
 * `undefined` means none of them matched and the caller's chain continues.
 */
export async function handleMeetingCalendarRoutes(
  ctx: MeetingCalendarRoutesContext,
  rq: MeetingCalendarRouteRequest,
): Promise<Response | undefined> {
  const {
    rooms,
    taskStore,
    meetingStore,
    meetingRelay,
    recallRelay,
    calendarStore,
    calendarSync,
    calendarBot,
    calendarOauthStates,
    dataDir,
    j,
    isValidDocId,
    fileUnderHubWorkspace,
  } = ctx;
  const { req, url, pathname, visitor } = rq;

  // --- A doc's meetings (read-only) ---
  //
  // Ahead of the `/api/docs/<id>/...` catch-all below, which would
  // otherwise swallow both. Deliberately NOT gated on the doc's room
  // existing: a transcript outlives the meeting and the notes agent
  // that reads it arrives afterwards, sometimes after the room has been
  // evicted. There is no write and no delete here — a transcript is the
  // least reconstructible thing this server holds, because the audio is
  // already gone.
  const meetingsMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meetings$/);
  if (meetingsMatch && req.method === 'GET') {
    const addressed = decodeURIComponent(meetingsMatch[1] ?? '');
    if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
    // Same canonicalization the `/audio/` upgrade does, and for the same
    // reason: a doc is reachable by a readable alias, and the meetings
    // are filed under its own id. Reading by alias must find them.
    const docId = rooms.get(addressed)?.docId ?? addressed;
    const meetings = meetingStore.list(docId);
    const live = meetingStore.active(docId);
    return j(200, {
      docId,
      meetings,
      ...(live ? { recording: live.meetingId } : {}),
    });
  }
  const meetingMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meetings\/([^/]+)$/);
  if (meetingMatch && req.method === 'GET') {
    const addressed = decodeURIComponent(meetingMatch[1] ?? '');
    const meetingId = decodeURIComponent(meetingMatch[2] ?? '');
    if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
    const docId = rooms.get(addressed)?.docId ?? addressed;
    const record = meetingStore.list(docId).find((m) => m.meetingId === meetingId);
    if (!record) return j(404, { error: 'meeting not found' });
    // `turns` stays the COUNT the index recorded; the settled lines are
    // their own field, so a caller reading one is never reading the
    // other by accident.
    return j(200, { ...record, transcript: meetingStore.transcript(docId, meetingId) });
  }
  // --- Naming a voice AFTER the meeting ---
  //
  // During a meeting the audio socket carries `name_speaker`; this is
  // the same verb for a meeting whose socket is gone — which is exactly
  // when a person on the recording device gets around to the names. It
  // writes the same index line and routes the same backwards rewrite
  // into notes already written. A LIVE meeting is refused (409): its
  // rename must also rewrite the composer's memory of what it wrote,
  // which only the session on the socket can do.
  const lateNameMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meetings\/([^/]+)\/speakers$/);
  if (lateNameMatch && req.method === 'POST') {
    // A durable write to the meeting record plus a rewrite of the doc's
    // notes: owner-side only, like every other mutating route here.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const addressed = decodeURIComponent(lateNameMatch[1] ?? '');
    const meetingId = decodeURIComponent(lateNameMatch[2] ?? '');
    if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
    const docId = rooms.get(addressed)?.docId ?? addressed;
    const body = (await req.json().catch(() => null)) as {
      speaker?: unknown;
      name?: unknown;
    } | null;
    const speaker = typeof body?.speaker === 'string' ? body.speaker : '';
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    // The caps the socket's parser enforces by dropping the frame;
    // refused out loud here, because HTTP can.
    if (!speaker || speaker.length > 16 || !name || name.length > MAX_SPEAKER_NAME) {
      return j(400, {
        error: `speaker and name required; name at most ${MAX_SPEAKER_NAME} chars`,
      });
    }
    const result = meetingStore.nameSpeakerLater({ docId, meetingId, speaker, name });
    if (!result.ok) {
      if (result.reason === 'unknown_meeting') return j(404, { error: 'meeting not found' });
      if (result.reason === 'recording') {
        return j(409, { error: 'meeting is live — rename it over the audio socket' });
      }
      return j(400, { error: 'that speaker is not in this meeting' });
    }
    // The rename reaches backwards, exactly as a live one does — same
    // relabel, same sink. `from` is what the composer actually wrote
    // (the prior name, or the placeholder), read BEFORE the map moved.
    const names = result.speakers;
    const from = speakerDisplayName(speaker, result.priorNames);
    const to = speakerDisplayName(speaker, names);
    const notes = meetingRelay.notesDeps;
    if (from !== to && notes?.onRelabel) {
      // Two voices can collide on one name; then the words in the notes
      // do not say which voice they were, and only tagged mentions —
      // which carry the label — are rewritten. Same narrowing, same
      // reason as the live session's.
      const labels = new Set([
        ...meetingStore.transcript(docId, meetingId).flatMap((t) => (t.speaker ? [t.speaker] : [])),
        ...Object.keys(names),
      ]);
      const ambiguous = [...labels].some(
        (label) => label !== speaker && speakerDisplayName(label, names) === from,
      );
      notes.onRelabel({
        docId,
        meetingId,
        label: speaker,
        from,
        to,
        rewriteUntagged: !ambiguous,
      });
    }
    return j(200, { docId, meetingId, speakers: names });
  }

  // --- Calendar: connect a Google Calendar, join meetings one click ---
  //
  // No bot joins anything by default — the connection tracks upcoming
  // meetings so an explicit per-event join is one click instead of a
  // pasted URL. Taking the join does three things at once: hands back
  // the meeting URL to open, sends the bot into the call, and opens a
  // discussion doc the transcript lands in.
  //
  // Where a calendar meeting's doc opens: the board it was filed on
  // when the join minted it, or the bare review route for one that
  // somehow is not filed. Board-relative like the huddle route's URL.
  const docUrlFor = (docId: string): string => {
    const ws = taskStore.workspaceOfDoc(docId);
    return ws
      ? `/workspaces/${encodeURIComponent(ws)}/docs/${encodeURIComponent(docId)}`
      : `/review/${encodeURIComponent(docId)}`;
  };
  //
  // All on the operator's surface — these are a PERSON's verbs, so they
  // go through the same host/Access gating as every other /api route.
  // The vendor's inbound half (`calendar.sync_events`) arrives on the
  // Svix-signed status webhook above, on the callback hostname.
  if (pathname === '/api/calendar' && req.method === 'GET') {
    const google = calendarBot?.google ?? null;
    const connection = calendarStore?.connection() ?? null;
    return j(200, {
      configured: calendarSync !== null,
      googleConfigured: google !== null,
      connection: connection
        ? { email: connection.email, connectedAt: connection.connectedAt }
        : null,
    });
  }
  if (pathname === '/api/calendar/google/connect' && req.method === 'GET') {
    const google = calendarBot?.google;
    if (!google) {
      return j(503, {
        error: 'not_configured',
        message:
          'Google Calendar connect needs the OAuth app credentials (Keychain ' +
          'service claude-workspaces-google-oauth, accounts client-id and ' +
          'client-secret) and a Recall API key.',
      });
    }
    // One-shot CSRF state, spent (or expired) at the callback. Expired
    // entries are swept here rather than on a timer: this map only
    // grows when somebody clicks Connect.
    const now = Date.now();
    for (const [state, expires] of calendarOauthStates) {
      if (expires < now) calendarOauthStates.delete(state);
    }
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    const state = [...stateBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    calendarOauthStates.set(state, now + 10 * 60_000);
    return new Response(null, {
      status: 302,
      headers: { location: google.consentUrl(state) },
    });
  }
  if (pathname === '/api/calendar/google/callback' && req.method === 'GET') {
    const google = calendarBot?.google;
    if (!google || !calendarStore) return j(503, { error: 'not_configured' });
    // Google reports a refused consent screen as ?error=access_denied.
    const denied = url.searchParams.get('error');
    if (denied) return j(400, { error: 'consent_refused', message: denied });
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const expires = calendarOauthStates.get(state);
    calendarOauthStates.delete(state);
    if (!code || expires === undefined || expires < Date.now()) {
      return j(400, { error: 'bad_state', message: 'Start again from Connect.' });
    }
    try {
      const { refreshToken } = await google.exchange(code);
      // Recall owns the sync from here: it holds the app credentials
      // and the refresh token and refreshes on its own schedule.
      const calendar = await calendarBot?.client.createCalendar({
        refreshToken,
        clientId: google.clientId,
        clientSecret: google.clientSecret,
      });
      if (!calendar) return j(503, { error: 'not_configured' });
      // Vaulted ONLY so disconnect can revoke the grant at Google; see
      // RefreshTokenVault. Saved after the vendor accepted it, so a
      // failed connect leaves no credential behind.
      calendarBot?.vault?.save(refreshToken);
      calendarStore.setConnection({
        calendarId: calendar.id,
        email: calendar.email,
        connectedAt: Date.now(),
      });
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Connected</title>' +
          '<p>Google Calendar connected. No bot joins anything on its own — ' +
          'upcoming meetings can now be given a bot with one click. ' +
          'You can close this tab.</p>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : 'connect_failed';
      return j(502, { error });
    }
  }
  if (pathname === '/api/calendar/google' && req.method === 'DELETE') {
    if (!calendarStore || !calendarBot) return j(503, { error: 'not_configured' });
    const connection = calendarStore.connection();
    if (!connection) return j(404, { error: 'not_connected' });
    // Order matters: the vendor's copy of the grant dies first (the
    // calendar delete), then the grant itself (the revoke), then our
    // record. A failure mid-way leaves MORE revoked than the record
    // says, which is the safe direction.
    await calendarBot.client.deleteCalendar(connection.calendarId);
    let revoked = false;
    const token = calendarBot.vault?.load() ?? null;
    if (token) {
      try {
        await calendarBot.google?.revoke(token);
        revoked = true;
      } catch (err) {
        console.error('[calendar] google revoke failed:', err);
      }
      calendarBot.vault?.clear();
    }
    calendarStore.setConnection(null);
    return j(200, { ok: true, revoked });
  }
  if (pathname === '/api/calendar/events' && req.method === 'GET') {
    if (!calendarSync || !calendarStore || !calendarBot) {
      return j(503, { error: 'not_configured' });
    }
    const connection = calendarStore.connection();
    if (!connection) return j(404, { error: 'not_connected' });
    try {
      const events = await calendarBot.client.listUpcoming(
        connection.calendarId,
        new Date().toISOString(),
      );
      // The shape a join surface (the coming workspace banner) needs:
      // which meeting, when it starts AND when it ends (the offer
      // lives from 15 minutes before start until the end), whether a
      // bot COULD join it, whether one was asked to, and — for a taken
      // join — where its discussion doc is. The meeting URL itself
      // stays server-side: presence is what the offer needs, and the
      // join RESPONSE hands the URL to the click that earned it.
      return j(200, {
        events: events.map((event) => {
          const joinRec = calendarStore.joinRecord(event.id);
          return {
            id: event.id,
            title: event.title,
            startTime: event.startTime,
            endTime: event.endTime,
            hasMeetingLink: event.meetingUrl !== null,
            joinable: eligibleForBot(event),
            joined: joinRec !== null,
            ...(joinRec ? { docId: joinRec.docId, docUrl: docUrlFor(joinRec.docId) } : {}),
          };
        }),
      });
    } catch (err) {
      return j(502, { error: err instanceof Error ? err.message : 'list_failed' });
    }
  }
  const calendarJoin = pathname.match(/^\/api\/calendar\/events\/([^/]+)\/join$/);
  if (calendarJoin) {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    if (!calendarSync || !calendarStore || !calendarBot) {
      return j(503, { error: 'not_configured' });
    }
    if (!calendarStore.connection()) return j(404, { error: 'not_connected' });
    const eventId = decodeURIComponent(calendarJoin[1] ?? '');
    const body = (await req.json().catch(() => null)) as {
      join?: unknown;
      workspaceId?: unknown;
    } | null;
    // Absent means "join" — the button this backs is the explicit
    // opt-IN (bots join nothing by default), and withdrawing it is the
    // explicit `join: false`.
    const join = body?.join !== false;

    if (!join) {
      const joinRec = calendarStore.joinRecord(eventId);
      if (!joinRec) return j(200, { join, action: 'skipped', reason: 'not_joined' });
      // The bot goes home; the doc and whatever it heard stay.
      await recallRelay.leave(joinRec.docId);
      calendarStore.setJoinRecord(eventId, null);
      return j(200, { join, action: 'left', eventId, docId: joinRec.docId });
    }

    // The join does three things at once: answers the meeting URL so
    // the client can open it, sends the bot into the call, and opens a
    // discussion doc with the transcript pipeline already listening —
    // the invite below is the SAME path a pasted URL takes, realtime
    // socket and notes included.
    let event: RecallCalendarEvent | null;
    try {
      event = await calendarBot.client.getEvent(eventId);
    } catch (err) {
      return j(502, { error: err instanceof Error ? err.message : 'join_failed' });
    }
    if (!event) return j(404, { error: 'unknown_event' });
    if (!eligibleForBot(event) || !event.meetingUrl) {
      return j(400, {
        error: 'no_supported_link',
        message: 'That event has no Zoom, Google Meet or Teams link to join.',
      });
    }

    // A repeat join answers the SAME doc — the click is idempotent,
    // not a doc factory. The doc is only minted on the first take.
    const existing = calendarStore.joinRecord(eventId);
    let docId: string;
    if (existing) {
      docId = existing.docId;
    } else {
      const now = Date.now();
      const title = meetingDocTitle(event.title, now);
      let created = rooms.createForCaller(meetingDocAlias(now), {
        type: 'markdown',
        title,
      });
      if (created.ok && !created.minted) {
        created = rooms.createForCaller(meetingDocAlias(now), {
          type: 'markdown',
          title,
        });
      }
      if (!created.ok || !created.minted) return j(500, { error: 'doc-not-minted' });
      docId = created.room.docId;
      // The file first, then the bind — same order and reason as the
      // huddle route: the doc is a record on disk before the first word.
      const file = meetingDocFilePath(dataDir, docId);
      try {
        mkdirSync(dirname(file), { recursive: true });
        if (!existsSync(file)) writeFileSync(file, `# ${title}\n`);
      } catch (err) {
        console.error(`[calendar] could not write ${file}:`, err);
        return j(500, { error: 'doc-file-failed' });
      }
      const attached = await rooms.attachFileAsync(docId, file);
      if (!attached.ok) return j(409, { error: 'attach_failed', attached });
      const requestedWs = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
      fileUnderHubWorkspace(docId, requestedWs);
    }

    const invited = await recallRelay.invite({
      docId,
      meetingUrl: event.meetingUrl,
      ...(event.title ? { botName: `Meeting Assistant (${event.title.slice(0, 60)})` } : {}),
    });
    if (!invited.ok && invited.reason !== 'already_recording') {
      // The join is only a join once the bot is actually going: no
      // record is written on a refusal, so the offer stays takeable.
      // A doc minted just above stays — it is empty, harmless, and
      // deleting user-visible content on an error path is how records
      // get eaten.
      const status =
        invited.reason === 'not_configured' ? 503 : invited.reason === 'vendor_error' ? 502 : 400;
      return j(status, { error: invited.reason, message: invited.message });
    }
    // `already_recording` on the SAME doc is a repeat click while the
    // bot is live — the state the click wanted.
    calendarStore.setJoinRecord(eventId, { docId, joinedAt: Date.now() });
    return j(200, {
      join,
      action: 'joined',
      eventId,
      // What the client opens for the person...
      meetingUrl: event.meetingUrl,
      // ...and where the meeting's words are landing.
      docId,
      docUrl: docUrlFor(docId),
      ...(invited.ok ? { bot: invited.status } : {}),
    });
  }

  // --- A doc's meeting bot: invite one, read its state, send it home ---
  if (pathname === '/api/meeting-engines') {
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    // Which engines a `start` frame may name on THIS server, default
    // first — server-global, because keys are. It is why a chooser can
    // hide an engine whose key is absent instead of offering a button
    // that answers `unavailable`. Names only; nothing about keys
    // beyond their existence leaves the machine.
    const engines = meetingRelay.engineNames();
    return j(200, { engines, default: engines[0] ?? null });
  }

  const botMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meeting-bot$/);
  if (botMatch) {
    const addressed = decodeURIComponent(botMatch[1] ?? '');
    if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
    const docId = rooms.get(addressed)?.docId ?? addressed;
    if (req.method === 'GET') {
      // `configured` is why the UI can say "meeting bots are not set up
      // on this server" instead of offering a button that always fails.
      return j(200, {
        docId,
        configured: recallRelay.configured(),
        bot: recallRelay.status(docId),
      });
    }
    if (req.method === 'POST') {
      // A bot costs money the moment it is created, so unlike the
      // read above this one insists the doc actually exists.
      if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
      const body = (await req.json().catch(() => null)) as {
        meetingUrl?: unknown;
        botName?: unknown;
      } | null;
      const meetingUrl = typeof body?.meetingUrl === 'string' ? body.meetingUrl : '';
      if (!meetingUrl) return j(400, { error: 'meetingUrl required' });
      // Optional — the old payload stays accepted. Clipped rather than
      // refused: a long name is a preference, not an error, and the
      // vendor truncates what its UI cannot show anyway.
      const rawBotName = typeof body?.botName === 'string' ? body.botName.trim() : '';
      const botName = rawBotName ? rawBotName.slice(0, 100) : undefined;
      const result = await recallRelay.invite({
        docId,
        meetingUrl,
        ...(botName !== undefined ? { botName } : {}),
      });
      if (result.ok) return j(200, { bot: result.status });
      const status =
        result.reason === 'not_configured'
          ? 503
          : result.reason === 'already_recording'
            ? 409
            : result.reason === 'vendor_error'
              ? 502
              : 400;
      return j(status, { error: result.reason, message: result.message });
    }
    if (req.method === 'DELETE') {
      const left = await recallRelay.leave(docId);
      return left ? j(200, { ok: true }) : j(404, { error: 'no bot on this doc' });
    }
    return j(405, { error: 'method not allowed' });
  }

  return undefined;
}
