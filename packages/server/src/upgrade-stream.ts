/**
 * ── Upgrade and stream: this request wants a connection, not a response ──
 *
 * Six blocks answering one question. Three websocket upgrades — Recall
 * dialling us with a bot's words, a doc's live meeting audio, and `/y/`
 * editing — and three SSE openers — one agent's whole watch set, one
 * workspace's thread events, one doc's. Every one of them ends with a
 * long-lived connection rather than a body, and every one of them has to
 * decide at the handshake what that connection is allowed to do, because
 * there is no second chance: a websocket is authorized ONCE, at its upgrade.
 *
 * That is why the gates are in here rather than left behind. `shareId`,
 * `shareMember` and `readOnly` are stamped onto the socket at the upgrade so
 * the revocation sweeps can find an open connection later and close it —
 * see the comments on the `/audio/` upgrade, which is the one that spends
 * money while it is open. Moving a gate out of this file, or above the
 * upgrade it guards, breaks that.
 *
 * Composed the way A18 was: a factory of long-lived values, with the address
 * and the admitted visitor passed per call. Nothing the handlers read per
 * request is hoisted to factory time — `rooms`, the meeting sessions and the
 * SSE hub are all read through their stores on each call, and
 * `browserProvedNobody` arrives per request because it closes over the
 * request that is being decided.
 *
 * ── The return contract: three outcomes, not two ──
 *
 * A18 could return `Response | null` because every one of its blocks either
 * answered or declined. This run has a third outcome that Bun spells as a
 * hole in the type system: **a successful upgrade returns `undefined` from
 * `fetch`**, because the socket has taken the connection over and there is
 * no response to send. So `Response | undefined | null` would have three
 * meanings across two nullish values, and the obvious `if (answered) return
 * answered;` at the call site would silently treat a live socket as a
 * fall-through and answer the 404.
 *
 * `StreamOutcome` makes that a compile error instead. Null still means "no
 * block here claimed this address", exactly as it did in place; the other
 * two outcomes are named, and `createServer` is the one place that turns
 * `upgraded` into the `undefined` Bun wants. The run itself is unchanged —
 * it still returns a `Response`, or `undefined` for an upgrade, inside the
 * wrapper below.
 */
import type { DocType } from '@feedback/core';
import {
  type AgentWatches,
  SHARED_AGENT_IDS,
  SHARED_IDENTITY_ERROR,
  SHARED_IDENTITY_MESSAGE,
  isValidAgentId,
} from './agent-watches.ts';
import { authorizeAgentCaller } from './auth/agent-token.ts';
import type { OriginPolicy } from './middleware/browser-origin.ts';
import { isAllowedBrowserOrigin } from './middleware/browser-origin.ts';
import type { ShareTarget } from './middleware/host-guard.ts';
import { signInRequiredBody } from './middleware/write-gate.ts';
import { parseMuxCursor } from './mux-cursor.ts';
import type { RecallMeetingRelay } from './recall-meeting.ts';
import type { Rooms } from './rooms.ts';
import { redactHubEventForVisitor } from './share/redact-hub-events.ts';
import { channelForWatchKey, openAgentMuxStream } from './sse-mux.ts';
import { type SseHub, openSseStream } from './sse.ts';
import type { TaskStore } from './tasks.ts';

/**
 * What an upgrade attaches to a socket, for every socket this server opens.
 *
 * `kind` is what the ONE websocket handler branches on: Bun routes every
 * upgraded path into the same `open`/`message`/`close`, so the audio socket
 * and the editing socket are told apart by what the upgrade attached. Absent
 * means the editing socket, which is every upgrade that predates meetings.
 *
 * `shareId` and `readOnly` are named here rather than passed as excess
 * properties, so the two upgrades that set them are type-checked against the
 * fields the handlers read (`WsCtx` in rooms.ts, `MeetingClient` in
 * meeting-protocol.ts).
 *
 * It lives in this file because the three blocks that CONSTRUCT it do.
 * `server.ts` imports it for `Bun.serve<UpgradeData>` and the handler that
 * reads it back.
 */
export type UpgradeData = {
  docId: string;
  kind?: 'yjs' | 'audio' | 'recall';
  token?: string;
  shareId?: string;
  shareMember?: string;
  readOnly?: boolean;
};

/** The id a reconnecting SSE client last saw: the `Last-Event-ID` header a
 *  native EventSource sends back by itself once frames carry `id:` lines,
 *  else the `lastEventId` query param for hand-rolled fetch-stream consumers
 *  (the MCP watch loop). Absent/empty → a fresh subscription, no replay. */
function sseLastEventId(req: Request, url: URL): string | undefined {
  const v = req.headers.get('last-event-id') ?? url.searchParams.get('lastEventId');
  return v ? v : undefined;
}

/** What the upgrade and stream routes read. Every member is long-lived; the
 *  request, its address and the admitted visitor arrive per call. */
export interface UpgradeStreamContext {
  /** The Bun server, narrowed to the one method these routes call. It is a
   *  forward reference — `Bun.serve` has not returned when this factory is
   *  composed — and it is narrowed so this module can take a connection over
   *  and nothing else. */
  server: { upgrade: (req: Request, options: { data: UpgradeData }) => boolean };
  /** Doc rooms: what an address resolves to, and whether it exists at all. */
  rooms: Rooms;
  /** The boards, for whether a workspace-level stream has a channel. */
  taskStore: TaskStore;
  /** The event hub every SSE stream here subscribes against. */
  sse: SseHub;
  /** One agent's durable watch set, which is what the agent-level stream
   *  fans out and what `onWatchSetChanged` re-reads. */
  agentWatches: AgentWatches;
  /** Whether a watched key still addresses something, so a stale watch does
   *  not open a channel for a doc that is gone. */
  watchKeyExists: (key: string) => boolean;
  /** The bot relay that mints and forgets the per-bot tokens the `/recall/`
   *  upgrade authenticates against. */
  recallRelay: RecallMeetingRelay;
  /** The origin policy for THIS request, for the two upgrades that must run
   *  their own Origin check because CORS does not apply to websockets. */
  policyFor: (req: Request) => OriginPolicy;
  /** Whether this deployment gates writes on a proven identity. The `/y/`
   *  and `/audio/` upgrades are write surfaces the method-keyed gate cannot
   *  see, because an upgrade is a GET. */
  requireSignInToWrite: boolean;
  /** The docId shape check every address-taking block runs first. */
  isValidDocId: (id: string) => boolean;
  /** An address resolved to the canonical doc id, for the mux channel map. */
  canonicalDocId: (addressed: string) => string;
  /** Files a doc under the hub workspace — the widget's own creation path,
   *  which is the `/y/` upgrade for a mockup. */
  fileUnderHubWorkspace: (docId: string) => void;
  /** The JSON responder, so a refusal here is spelled as a route's. */
  j: (status: number, body: unknown) => Response;
  /** The request's SOCKET peer address, never a header. Long-lived here
   *  rather than passed per call, the same shape `opsRoutesCtx` uses: it
   *  closes over the Bun server, which is a forward reference at compose
   *  time and answers per request. */
  requestAddress: (req: Request) => string | undefined;
  /** The key the agent stream's `at1` bearer verifies under. */
  agentTokenKey: () => string;
  /** Whether the agent stream REFUSES a caller that presents no token. Off
   *  during the deprecation window; `CW_REQUIRE_AGENT_TOKEN` flips it. */
  requireAgentToken: boolean;
  /** Logs the deprecation-window warning, once per agent id per route. */
  warnLegacyAgentCaller: (agentId: string, route: string) => void;
}

/** The address this request is asking about, and what admission proved. */
export interface UpgradeStreamRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The admitted visitor, or null on a local request. Read to refuse the
   *  agent-level stream and to redact the workspace one — never to decide
   *  admission, which `request-admission.ts` has already done. */
  visitor: ShareTarget | null;
  /** What authorized this request, carried onto the socket so the revocation
   *  sweeps can find it again. */
  visitorShareId: string | null;
  visitorMemberKey: string | null;
  /** Whether this request comes from a browser that has proven nobody.
   *  Passed rather than hoisted: it closes over the request being decided,
   *  and the widget-token identity it reads is resolved per request. */
  browserProvedNobody: () => boolean;
}

/**
 * What this run did with the address.
 *
 * `null` — no block here claimed it, so the caller carries on exactly as the
 * run did in place. `response` — an answer to send, whether that is a
 * refusal or an opened SSE stream. `upgraded` — the socket has taken the
 * connection over, and `fetch` must return `undefined`.
 */
export type StreamOutcome = null | { kind: 'response'; response: Response } | { kind: 'upgraded' };

export interface UpgradeStream {
  serveUpgradeAndStreamRoutes: (addressed: UpgradeStreamRequest) => StreamOutcome;
}

export function createUpgradeStream(ctx: UpgradeStreamContext): UpgradeStream {
  const {
    server,
    rooms,
    taskStore,
    sse,
    agentWatches,
    watchKeyExists,
    recallRelay,
    policyFor,
    requireSignInToWrite,
    isValidDocId,
    canonicalDocId,
    fileUnderHubWorkspace,
    j,
    requestAddress,
    agentTokenKey,
    requireAgentToken,
    warnLegacyAgentCaller,
  } = ctx;

  const serveUpgradeAndStreamRoutes = ({
    req,
    url,
    pathname,
    visitor,
    visitorShareId,
    visitorMemberKey,
    browserProvedNobody,
  }: UpgradeStreamRequest): StreamOutcome => {
    // The run itself, unchanged from the position it held in `route()`:
    // a `Response` to send, `undefined` for a socket that took over, and
    // the trailing `null` for the fall-through. The wrapper below is the
    // only place those three become the named outcome.
    const answered = ((): Response | undefined | null => {
      // --- WebSocket upgrade: Recall dialling US with a bot's words ---
      //
      // NO Origin check, unlike `/audio/` and `/y/` below. That guard exists
      // because a browser will open a socket from any page the user visits
      // and hand it the data regardless of CORS. This caller is a vendor's
      // backend: there is no origin, and requiring one would refuse every
      // real connection. The unguessable per-bot token in the path is the
      // authentication — 128 CSPRNG bits, one bot, forgotten when that
      // bot's meeting ends (see RecallMeetingRelay's mintToken).
      if (pathname.startsWith('/recall/')) {
        const token = decodeURIComponent(pathname.slice('/recall/'.length));
        // Shape-checked before it is looked up so a lookup is never the
        // thing that distinguishes a malformed token from an unknown one.
        if (!/^[0-9a-f]{32}$/.test(token) || !recallRelay.acceptsToken(token)) {
          return j(404, { error: 'unknown endpoint' });
        }
        const upgraded = server.upgrade(req, {
          data: { docId: '', token, kind: 'recall' as const },
        });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }

      // --- WebSocket upgrade: a doc's live meeting audio ---
      //
      // Same guard as `/y/` below and for the same reason: CORS does not
      // apply to websockets, so without the Origin check any page the user
      // visits could open a microphone relay against any doc — and this one
      // spends money while it is open.
      if (pathname.startsWith('/audio/')) {
        if (!isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))) {
          return j(403, { error: 'origin_not_allowed' });
        }
        const addressed = decodeURIComponent(pathname.slice('/audio/'.length));
        if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
        const docId = rooms.get(addressed)?.docId ?? addressed;
        // Unlike `/y/`, this never conjures a room: a meeting belongs to a
        // doc that already exists, and auto-creating one here would let a
        // typo start a billed session against a doc nobody can find.
        if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
        // The SAME sign-in decision `/y/` makes two branches down, for a
        // surface that is write-only: a meeting opens a billed engine
        // session and writes transcript and notes into the doc, and the
        // method-keyed write gate cannot see it because a websocket
        // upgrade is a GET. Carried rather than refused at the handshake
        // so the strip can render the reason (meeting-protocol.ts refuses
        // the `start` frame); an upgrade refused here reaches the page as
        // a bare error event with no body to show.
        const audioReadOnly = requireSignInToWrite && browserProvedNobody();
        const upgraded = server.upgrade(req, {
          data: {
            docId,
            kind: 'audio' as const,
            // WHAT AUTHORIZED THIS SOCKET, carried for its life, exactly as
            // `/y/` carries it below. A websocket is authorized once at its
            // upgrade, so revoking a share, removing a member and throwing
            // the sharing master switch all have to be able to find the
            // connections that grant opened. Without these two the sweeps
            // closed the editor and left an open microphone running a
            // billed transcription session against a doc the person may no
            // longer read. `Rooms.trackShareSocket` is the other half: this
            // socket is in no room's `conns` for a sweep to walk.
            ...(visitorShareId ? { shareId: visitorShareId } : {}),
            ...(visitorMemberKey ? { shareMember: visitorMemberKey } : {}),
            ...(audioReadOnly ? { readOnly: true } : {}),
          },
        });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }

      // --- WebSocket upgrade ---
      if (pathname.startsWith('/y/')) {
        // CORS does not apply to websockets — the browser opens the socket and
        // hands the page the data regardless of what headers we set. So the
        // Origin check has to happen HERE, or any page the user visits can
        // sync (and mutate) any doc. Reproduced before this existed: a socket
        // sent with `Origin: https://evil.example.com` synced a real document.
        if (!isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))) {
          return j(403, { error: 'origin_not_allowed' });
        }
        const addressed = decodeURIComponent(pathname.slice(3));
        if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
        // `ws.data.docId` is re-resolved on every frame, so it must be the
        // canonical id — a socket opened by alias would otherwise sync a
        // room of its own.
        const docId = rooms.get(addressed)?.docId ?? addressed;
        const type = url.searchParams.get('type') as DocType | null;
        const sourceUrl = url.searchParams.get('sourceUrl') ?? undefined;
        // Mockup docs auto-create on WS — the widget connects first with a
        // known type + sourceUrl (this covers the dev-server surface too;
        // the widget always identifies as 'mockup'). Markdown docs MUST be
        // created upfront via POST /api/docs (which auto-attaches a file).
        // The browser navigating to /review/<docId> before the agent has
        // created the doc gets a clean 404 from /review's own handler.
        // Decided BEFORE the creation below, not after it. Creating a room
        // and filing a workspace row is a write like any other, and it used
        // to run above this line: a browser that had proven nobody could
        // open `/y/<any-new-id>?type=mockup` and make the server create a
        // doc and file it under the hub workspace, with the read-only carry
        // only stopping the ydoc edits that came afterwards.
        const readOnly = requireSignInToWrite && browserProvedNobody();
        if (!rooms.get(docId)) {
          if (type === 'mockup') {
            // Nothing to read yet, so refusing here gates no read: the doc
            // this socket would have created does not exist for anybody.
            if (readOnly) return j(401, signInRequiredBody());
            rooms.getOrCreate(docId, { type, sourceUrl });
            // The widget is the third creation path (next to POST /api/docs
            // and the MCP tools that front it), so it files its doc too —
            // otherwise a mockup that was only ever opened in a browser is
            // an orphan the hub can't see.
            fileUnderHubWorkspace(docId);
          } else {
            return j(404, { error: 'doc not found' });
          }
        }
        // READ-ONLY, not refused. The editing socket is also the READING
        // socket — a markdown doc's text arrives over it and nowhere else
        // — so refusing the upgrade would gate reading, which this gate
        // must never do. The socket opens, sync step 1 hands over the
        // whole doc, and `onMessage` drops anything that would change it
        // (see yjs-protocol.ts). Decided once here, at the handshake, and
        // then carried for the life of the connection: the same shape the
        // share authorization uses two lines up.
        const upgraded = server.upgrade(req, {
          data: {
            docId,
            ...(visitorShareId ? { shareId: visitorShareId } : {}),
            ...(visitorMemberKey ? { shareMember: visitorMemberKey } : {}),
            ...(readOnly ? { readOnly: true } : {}),
          },
        });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }

      // --- SSE (agent-level): every key ONE agent watches, on ONE socket. ---
      //
      // The route that ends the socket-per-watch storm. An MCP child used to
      // open a TCP connection per watched key, so a lead holding 214 watches
      // held 214 sockets; on 2026-09-04 the fleet exhausted this machine's
      // kernel socket memory and the supervisor read the resulting connect
      // failures as an unbound server, restarting it twenty times. The
      // per-key routes below are untouched — a session on the previous
      // bundle keeps using them through the rollout.
      //
      // The channel set is the agent's DURABLE watch set, so this route
      // needs no key list from the caller: the same set a respawn restores
      // from is the one the stream fans out, and `watch_doc` reaches an open
      // stream through the store's change hook rather than a reconnect.
      const agentEventsMatch = pathname.match(/^\/events\/agent\/([^/]+)$/);
      if (agentEventsMatch) {
        // A share visitor never opens one. The same posture the watches REST
        // route takes, and for a stronger reason: this stream carries every
        // channel one agent watches, which is a superset of any one board.
        if (visitor) return j(403, { error: 'not available to share visitors' });
        const streamAgentId = decodeURIComponent(agentEventsMatch[1] ?? '');
        if (!isValidAgentId(streamAgentId)) return j(400, { error: 'bad agentId' });
        if (SHARED_AGENT_IDS.has(streamAgentId)) {
          // Same refusal the watch store makes: a set keyed on the shared
          // identity is every anonymous session's watches at once, so a
          // stream over it would deliver everybody's events into each of
          // them. Those sessions keep the per-key routes.
          return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
        }
        // Prove it is that agent. An agent id is a hash of a name written on
        // the board, so before this the id was not a secret and this feed —
        // every channel one agent watches — opened to anyone who could type
        // one. Same function as the watches route runs, so the two doors
        // onto the same feed cannot drift. See auth/agent-token.ts.
        const allowed = authorizeAgentCaller({
          agentId: streamAgentId,
          req,
          address: requestAddress(req),
          key: agentTokenKey(),
          requireToken: requireAgentToken,
        });
        if (!allowed.ok) return j(allowed.status, allowed.body);
        if (allowed.proof === 'legacy') warnLegacyAgentCaller(streamAgentId, '/events/agent/<id>');
        return openAgentMuxStream({
          hub: sse,
          agentId: streamAgentId,
          keys: () => agentWatches.list(streamAgentId, watchKeyExists).watches.map((w) => w.key),
          channelFor: (key) => channelForWatchKey(key, canonicalDocId),
          cursors: parseMuxCursor(sseLastEventId(req, url)),
          onWatchSetChanged: (cb) => agentWatches.onChange(streamAgentId, cb),
        });
      }

      // --- SSE (workspace-level): every thread event on any member doc of a
      // workspace/diff review, one stream — agents watch this instead of one
      // stream per file. ---
      const wsEventsMatch = pathname.match(/^\/events\/workspace\/([^/]+)$/);
      if (wsEventsMatch) {
        const workspaceId = decodeURIComponent(wsEventsMatch[1] ?? '');
        if (!isValidDocId(workspaceId)) return j(400, { error: 'bad workspaceId' });
        // A workspace channel exists for reviews (diff
        // reviews / folder binds) AND for hub workspaces — task.* events
        // broadcast on the same `ws~<id>` channel (§3.6).
        const exists =
          rooms.list().some((m) => m.workspaceId === workspaceId) ||
          taskStore.getWorkspace(workspaceId) !== undefined;
        if (!exists) return j(404, { error: 'workspace not found' });
        // A share visitor's stream carries the §3.3 visitor-contract view
        // of every hub event (display names, projected tasks) — the SSE
        // feed is the second door next to the ws room, and redacting one
        // transport but not the other is how the DocMeta leak shipped.
        // An agent's MCP child names itself here; a browser tab does not.
        // A visitor never counts as one — their stream is authorized by a
        // share, and letting a share-bearer claim an agentId would let an
        // outside tab impersonate the agent whose work it can see.
        const streamAgentId = visitor ? undefined : (url.searchParams.get('agentId') ?? undefined);
        return openSseStream(
          sse,
          `ws~${workspaceId}`,
          visitorShareId ?? undefined,
          visitor ? redactHubEventForVisitor : undefined,
          streamAgentId,
          sseLastEventId(req, url),
          visitorMemberKey ?? undefined,
        );
      }
      // --- SSE ---
      if (pathname.startsWith('/events/')) {
        const addressed = decodeURIComponent(pathname.slice('/events/'.length));
        if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
        const eventsRoom = rooms.get(addressed);
        if (!eventsRoom) return j(404, { error: 'doc not found' });
        // The CHANNEL is the doc's own id: a watcher that opened the stream
        // by the readable name and a writer that fired on the canonical one
        // have to meet, and they only do if both spellings collapse here.
        return openSseStream(
          sse,
          eventsRoom.docId,
          visitorShareId ?? undefined,
          undefined,
          undefined,
          sseLastEventId(req, url),
          visitorMemberKey ?? undefined,
        );
      }
      return null;
    })();
    if (answered === null) return null;
    return answered === undefined ? { kind: 'upgraded' } : { kind: 'response', response: answered };
  };

  return { serveUpgradeAndStreamRoutes };
}
