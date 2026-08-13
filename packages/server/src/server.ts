import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type User,
  contentKind,
  suggestOps,
  summaryHash,
} from '@feedback/core';
import { needsCall } from '@feedback/core/summary-prompt';
import type { Server as BunServer } from 'bun';
import { classifyActor } from './activity.ts';
import { showFile } from './git-diff.ts';
import {
  LOOPBACK_HOSTS,
  corsHeadersFor,
  isAllowedBrowserOrigin,
} from './middleware/browser-origin.ts';
import { type CfAccessOptions, createCfAccessVerifier } from './middleware/cf-access.ts';
import {
  type ShareTarget,
  classifyHost,
  isTrustedLocalHost,
  shareScopeAllows,
} from './middleware/host-guard.ts';
import { localHostnames, publicBaseUrl } from './public-host.ts';
import { type FeedbackWs, Rooms, type WorkspaceDirNode, type WorkspaceFileNode } from './rooms.ts';
import { isWithinRoot } from './safe-path.ts';
import { CfApi } from './share/cf-api.ts';
import { resolveShareEntry } from './share/entry-resolve.ts';
import {
  SHARE_COOKIE,
  loadCookieKey,
  readCookie,
  sessionCookieHeader,
  verifySession,
} from './share/link-session.ts';
import { redactHubEventForVisitor } from './share/redact-hub-events.ts';
import {
  redactMetaForVisitor,
  redactWorkspaceFilesForVisitor,
  redactWorkspaceTreeForVisitor,
  relativeReviewUrl,
} from './share/redact-meta.ts';
import { Shares } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import type { ShareConfig } from './share/types.ts';
import { sanitizeVisitorAuthor } from './share/visitor-identity.ts';
import { SseHub, openSseStream } from './sse.ts';
import { KEYCHAIN_SERVICE, ThreadSummarizer } from './summarize.ts';
import { applyImport, importBanner, importMarkerFor, parseTrackerMarkdown } from './task-import.ts';
import { TaskProjection } from './task-projection.ts';
import {
  type Ref,
  type TaskStatus,
  TaskStore,
  type WorkspaceGoal,
  type WorkspaceSubgoal,
  eventsLogPath,
  isAttachmentRuntime,
  REF_KINDS,
  isValidRef,
  taskChip,
} from './tasks.ts';
import { SERVER_TICK_EVENT, UptimeMonitor, analyzeUptime } from './uptime.ts';
import { type VoiceComplete, VoiceRouter, parseVoiceContext } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

/**
 * Structural validation for PUT /api/workspaces/:id/goals. Returns the
 * sanitized list, or null if any entry is malformed. Unknown keys are
 * dropped rather than persisted — the sidecar shape is a contract, not a
 * junk drawer. ONE subgoal level max (§3.2); a subgoal with subgoals is
 * malformed, not silently flattened.
 */
function parseGoalList(raw: unknown): WorkspaceGoal[] | null {
  if (!Array.isArray(raw)) return null;
  const goals: WorkspaceGoal[] = [];
  for (const entry of raw) {
    const g = entry as Record<string, unknown>;
    if (typeof g?.id !== 'string' || g.id.length === 0) return null;
    if (typeof g?.title !== 'string' || g.title.length === 0) return null;
    if (g.dueAt !== undefined && typeof g.dueAt !== 'number') return null;
    let subgoals: WorkspaceSubgoal[] | undefined;
    if (g.subgoals !== undefined) {
      if (!Array.isArray(g.subgoals)) return null;
      subgoals = [];
      for (const sub of g.subgoals) {
        const s = sub as Record<string, unknown>;
        if (typeof s?.id !== 'string' || s.id.length === 0) return null;
        if (typeof s?.title !== 'string' || s.title.length === 0) return null;
        if (s.dueAt !== undefined && typeof s.dueAt !== 'number') return null;
        if (s.subgoals !== undefined) return null;
        subgoals.push({
          id: s.id,
          title: s.title,
          ...(s.dueAt !== undefined ? { dueAt: s.dueAt as number } : {}),
        });
      }
    }
    goals.push({
      id: g.id,
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt as number } : {}),
      ...(subgoals !== undefined ? { subgoals } : {}),
    });
  }
  return goals;
}

/**
 * `needs` for the two task-create routes. Validated HERE, the way `riskTier`
 * and `runtime` already are on neighbouring routes: a capitalized
 * `'Decision'` stored verbatim produces a task that is absent from the
 * decisions strip, absent from `list_tasks(needs:'decision')`, and refused
 * by `answer_decision` — while the create call answered 200.
 */
function parseNeeds(raw: unknown): { ok: true; needs?: 'action' | 'decision' } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (raw === 'action' || raw === 'decision') return { ok: true, needs: raw };
  return { ok: false };
}

/**
 * `links` for the two task-create routes: every element through the SAME
 * `isValidRef` the dedicated links route runs — a malformed ref matches no
 * backlink query, so the chip the link existed for never appears, and a
 * silent 200 hides that.
 *
 * But it is PARTIAL: bad refs are dropped and reported in `ignoredLinks`,
 * and the task is still created. Rejecting the whole call cost an outside
 * user a task's title, body, goal and assignee over one malformed field on
 * an *annotation* — and refs are explicitly never existence-checked, so a
 * well-formed ref pointing nowhere was already accepted. Refusing the
 * malformed one outright was the harsher answer to the lesser problem.
 * The precedent is the import path, which returns `ignoredColumns` rather
 * than refusing a tracker with one column it doesn't understand.
 *
 * The dedicated `POST /api/tasks/:id/links` route deliberately still 400s:
 * there the ref IS the request, so dropping it would mean answering 200 to
 * a call that did nothing. The distinction is annotation vs. payload, not
 * one route being stricter than another.
 *
 * `ok: false` now means only "this isn't an array at all".
 */
function parseLinks(
  raw: unknown,
): { ok: true; links?: Ref[]; ignored: unknown[] } | { ok: false } {
  if (raw === undefined) return { ok: true, ignored: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const links: Ref[] = [];
  const ignored: unknown[] = [];
  for (const ref of raw) {
    if (isValidRef(ref)) links.push(ref);
    else ignored.push(ref);
  }
  return { ok: true, links, ignored };
}

/**
 * The promotion `origin`, validated rather than cast.
 *
 * It used to be `body?.origin as Ref | undefined` — a cast, which checks
 * nothing at runtime. Two holes, both reachable from one unauthenticated
 * POST: a `url` origin skipped the http(s) scheme check that the identical
 * ref in `links` gets (the whole reason that check exists is that a url ref
 * reaches the DOM as an href), and `origin: null` persisted to disk and then
 * threw in `refKey` on every backlink query — including the doc-open path,
 * for every workspace, until someone hand-edited the JSON.
 *
 * `null` is read as "no origin" because clients spell an absent field that
 * way and dropping it is harmless. A present-but-malformed origin 400s: it's
 * payload, not annotation — unlike `links`, there is no good half to keep.
 */
function parseOrigin(raw: unknown): { ok: true; origin?: Ref } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isValidRef(raw)) return { ok: false };
  return { ok: true, origin: raw };
}

/** The 400 body for a ref a route refuses. Naming the accepted kinds turns a
 *  source dive into a re-send — the first outside caller of these routes had
 *  to read tasks.ts to discover which spellings existed. */
const BAD_REF_ERROR = `links must be an array of valid refs (kind: ${REF_KINDS.join(' | ')}); a url ref must be http(s)`;

/** Same rules, one ref, named for the field so the caller knows where to look. */
const BAD_ORIGIN_ERROR = `origin must be a valid ref (kind: ${REF_KINDS.join(' | ')}); a url ref must be http(s)`;

/** The anchor's display snippet, whichever anchor kind carries it — an
 *  orphan keeps its original's snippet. */
function anchorSnippetText(anchor: Anchor): string | undefined {
  if (anchor.kind === 'orphan') {
    return anchor.original.snippet?.text;
  }
  return anchor.snippet?.text;
}

/** Attribution for a write that arrived with no author at all. Deliberately
 *  NOT Bryan: an unattributed action must never gain his authority just
 *  because a field was missing. */
const ANONYMOUS_ACTOR: User = {
  id: 'anon-unattributed',
  name: 'Anonymous',
  kind: 'anon',
  color: '#8a8a8a',
};

export interface ServerOptions {
  /**
   * LF_SHARING_DISABLED was set: external sharing starts OFF and the runtime
   * toggle refuses to reopen it. The switch to reach for while a security
   * review is in flight — nothing this process exposes can undo it.
   */
  sharingEnvLocked?: boolean;
  port?: number;
  dataDir?: string;
  /** Absolute path to the built widget dist dir, or null to skip. */
  widgetDistDir?: string | null;
  /** Absolute path to the built markdown-app dist dir. */
  markdownAppDistDir?: string | null;
  /** Absolute path to the demos dir (static HTML). */
  demosDir?: string | null;
  /**
   * Extra hostnames treated as LOCAL (bypass the host gate) beyond loopback,
   * the tailnet name, and this machine's LAN names. Requests arriving on any
   * other hostname are denied unless an active share owns that hostname —
   * see middleware/host-guard.ts. Tests use this to simulate a local caller.
   */
  trustedHosts?: string[];
  /**
   * Browser origins allowed to call the API cross-origin, beyond the server's
   * own origin and loopback (which the widget on a dev server needs). Matched
   * exactly. Anything else gets no CORS headers, so the browser blocks it —
   * see middleware/browser-origin.ts.
   */
  allowedOrigins?: string[];
  /**
   * Cloudflare Access JWT verification config. When set, every non-OPTIONS
   * request must carry a valid `Cf-Access-Jwt-Assertion` header (or
   * `CF_Authorization` cookie) signed by the team's JWKS and matching the
   * given audience. When unset, the server runs unauthenticated — local
   * dev / Tailscale-only use is unchanged.
   *
   * When `share` is also set, the verifier only gates requests whose
   * Host header matches an active share — Tailscale traffic to the
   * canonical hostname stays unauthenticated.
   */
  cfAccess?: CfAccessOptions;
  /**
   * Cloudflare Access share machinery. When set, the server exposes
   * /api/share routes for creating/listing/revoking shares, instantiates
   * a CfApi client (uses `cfApi` directly if provided, else builds one
   * from `cfApiToken`), and wires the cf-access middleware's audience to
   * the shares registry so each share's hostname gets its own AUD.
   */
  share?: {
    config: ShareConfig;
    cfApiToken?: string;
    cfApi?: CfApi;
  };
  /**
   * Thread summarizer. **No default.** Omitting it leaves generation off
   * entirely: every card falls back to its deterministic lines and the
   * on-demand route answers 503.
   *
   * It used to default to `new ThreadSummarizer()`, which resolves the real
   * Keychain key and the real global `fetch` — so every one of the 40-odd
   * server test files that creates a thread fired a live, billed
   * api.anthropic.com call three seconds later, carrying its fixture comment
   * text off the machine. Measured: 21 outbound calls across one
   * `bun run test:server`, with the suite green throughout, because the
   * scheduled path is fire-and-forget. The only caller that should have a
   * summarizer is the one that starts the real server (`bin.ts`), so it is
   * the one that constructs it.
   */
  summarizer?: ThreadSummarizer;
  /**
   * Voice fast-path completer (§3.8). **No default**, same seam rule as the
   * summarizer above: omitting it disables the Haiku fast path entirely —
   * every voice utterance still gets an answer, routed to the attached agent
   * — and nothing that merely spins a server up can reach the network. Only
   * bin.ts constructs the real one (`haikuVoiceComplete`).
   */
  voiceComplete?: VoiceComplete;
  /**
   * Liveness-marker interval for the uptime measurement (§3.12 commit 11).
   * The monitor appends `server.tick` lines to every hub workspace's
   * events.jsonl so the gap analysis has density even on an idle board.
   * Overridable so tests never wait real minutes; default 5 minutes.
   */
  uptimeTickMs?: number;
}

const CT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ServerHandle {
  port: number;
  rooms: Rooms;
  /** The hub task store — workspaces, tasks, the transition gate. */
  tasks: TaskStore;
  /** The ydoc projection of the task store (ws:<id> board rooms + task
   *  body rooms). Exposed so tests can force a reassert. */
  projection: TaskProjection;
  shares: Shares | null;
  /** Hang up every websocket and SSE stream whose share is no longer live.
   *  Runs on a 60s interval; exposed so tests exercise the real sweep. */
  sweepDeadShares: () => void;
  /** The external-access master switch — read/flip it without HTTP. */
  sharingGate: SharingGate;
  webhookLog: WebhookLogEntry[];
  stop: () => Promise<void>;
}

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  const demosDir = opts.demosDir ?? null;

  let shares: Shares | null = null;
  if (opts.share) {
    // Only build a Cloudflare client when Access mode is actually
    // configured. Link-mode sharing needs no Cloudflare credentials at all.
    const accountId = opts.share.config.cfAccountId;
    const cfApi =
      opts.share.cfApi ??
      (accountId ? new CfApi({ accountId, token: opts.share.cfApiToken ?? '' }) : undefined);
    shares = new Shares({
      dataDir,
      cfApi,
      config: opts.share.config,
    });
  }

  /**
   * The master switch for external access. Consulted on every request whose
   * Host is a share or link host, AHEAD of authentication — see the host
   * decision block below.
   */
  const sharingGate = new SharingGate({
    dataDir,
    envLocked: opts.sharingEnvLocked ?? false,
  });

  // HMAC key for link-mode session cookies. Generated on first use, mode
  // 600 — whoever can read it can mint a session for any share.
  let cookieKeyCache: string | null = null;
  const cookieKey = (): string => {
    cookieKeyCache ??= loadCookieKey(dataDir);
    return cookieKeyCache;
  };

  /** The shareId behind a link-mode session cookie, or null. */
  const linkSessionShareId = (req: Request): string | null => {
    if (!shares) return null;
    const shareId = verifySession(readCookie(req.headers.get('cookie'), SHARE_COOKIE), cookieKey());
    if (!shareId) return null;
    return shares.findLive(shareId)?.shareId ?? null;
  };

  /** Resolve a link-mode session cookie to what it may reach, or null. */
  const linkSessionTarget = (req: Request): ShareTarget | null => {
    if (!shares) return null;
    const shareId = verifySession(readCookie(req.headers.get('cookie'), SHARE_COOKIE), cookieKey());
    if (!shareId) return null;
    // Re-checked every request, so revoking or expiring a share takes
    // effect immediately rather than when a browser's cookie lapses.
    const share = shares.findLive(shareId);
    if (!share || share.mode !== 'link') return null;
    return share.workspaceId
      ? { docId: share.docId, workspaceId: share.workspaceId }
      : { docId: share.docId };
  };

  /**
   * The doc a workspace share should open right now, or null when the
   * workspace has no members left. Resolved per request rather than stored,
   * because a member docId encodes the file's relPath — renaming the entry
   * file changes its docId.
   */
  const currentWorkspaceEntry = (workspaceId: string, preferred?: string): string | null => {
    const members = rooms.list().filter((m) => m.workspaceId === workspaceId);
    const resolved = resolveShareEntry(
      preferred,
      members.map((m) => ({
        docId: m.docId,
        ...(m.relPath ? { relPath: m.relPath } : {}),
        ...(m.stale ? { stale: true } : {}),
        ...(m.type === 'diff' ? { isChangedFile: true } : {}),
      })),
    );
    // Everything bound is a tombstone. A BROWSE workspace usually has exactly
    // one bound doc — its entry — so renaming that one file is the common
    // case, and there is no survivor to fall back to. But the folder is full
    // of files that are one lazy open away; the sidebar lists them already.
    // Bind the best of them rather than land the visitor on a ghost.
    //
    // NOT for a diff review: there, every member stale means every reviewed
    // change was reverted, i.e. the review is empty. Binding some arbitrary
    // unchanged file would misrepresent that as a review of a file nobody
    // touched. Land on the tombstone — it still holds the comments.
    const isDiffReview = members.some((m) => m.type === 'diff');
    const winner = resolved ? members.find((m) => m.docId === resolved) : undefined;
    if (!isDiffReview && (!resolved || winner?.stale)) {
      const live = liveFileEntry(workspaceId, members);
      if (live) return live;
    }
    return resolved;
  };

  /**
   * Lazily bind the best on-disk file of a workspace as a landing doc.
   *
   * Honours the workspace's stored `exclude`: listRepoFiles powers the
   * all-files sidebar and deliberately scans everything, so picking from it
   * unfiltered would land a reviewer on a vendored or generated file the
   * caller explicitly kept out — and bind it into the workspace on the way.
   */
  const liveFileEntry = (workspaceId: string, members: DocMeta[]): string | null => {
    const listed = rooms.listRepoFiles(workspaceId);
    if (!listed.ok || !listed.files) return null;
    const bound = new Set(members.map((m) => m.relPath));
    const excluded = (members.find((m) => m.workspaceExclude)?.workspaceExclude ?? []).map((p) =>
      p.replace(/^\/+/, '').replace(/\/+$/, ''),
    );
    const candidates = listed.files
      .filter((f) => !bound.has(f.relPath))
      .filter((f) => !excluded.some((p) => f.relPath === p || f.relPath.startsWith(`${p}/`)))
      .map((f) => ({ docId: f.relPath, relPath: f.relPath }));
    const pick = resolveShareEntry(undefined, candidates);
    if (!pick) return null;
    const opened = rooms.openContextFile(workspaceId, pick);
    return opened.ok ? opened.docId : null;
  };

  /**
   * Repair a share visitor's `/review/<docId>` when that doc is gone.
   *
   * Link shares resolve their landing doc at redemption, but the URL the
   * visitor ends up with (and bookmarks, and is sent by email in the case of
   * an Access share, whose URL is handed out directly and never redeemed)
   * still names a specific docId. Renaming the file behind it leaves that URL
   * pointing at nothing. Redirect to the workspace's current entry instead —
   * which also repairs every URL already in someone's inbox.
   *
   * Fires for the share's own entry doc, in two states: gone entirely, or
   * kept as a stale tombstone (the usual rename outcome — the doc survives so
   * its threads do). Deliberately NOT for any other stale member: those are
   * listed in the tree precisely so a stranded thread stays readable, and
   * bouncing a visitor away from one would make it unreachable.
   *
   * Only for workspace shares: a single-doc share has nowhere else to go, and
   * silently moving it would be wrong. Returns null when nothing to do.
   */
  const repairStaleReviewUrl = (
    pathname: string,
    method: string,
    target: ShareTarget,
  ): Response | null => {
    if (method !== 'GET' || !target.workspaceId) return null;
    if (!pathname.startsWith('/review/')) return null;
    const docId = decodeURIComponent(pathname.slice('/review/'.length));
    // ONLY the share's own entry. Repairing an arbitrary docId would answer
    // a question the scope check deliberately refuses: a missing id would
    // redirect while a real id belonging to someone else's workspace 403s,
    // handing a visitor an existence oracle they never had before. Every
    // docId other than this share's entry gets the same 403 it always did.
    if (docId !== target.docId) return null;
    const room = rooms.get(docId);
    if (room && !room.meta.stale) return null;
    const entry = currentWorkspaceEntry(target.workspaceId);
    if (!entry || entry === docId) return null;
    return new Response(null, {
      status: 302,
      headers: { location: `/review/${encodeURIComponent(entry)}` },
    });
  };

  // When shares is wired, automatically derive the cf-access audience from
  // the registry so each share-<slug> host can use its own AUD. Callers
  // can still override by passing cfAccess.audience explicitly.
  const cfAccessConfig =
    opts.cfAccess && shares
      ? { ...opts.cfAccess, audience: shares.audienceResolver }
      : opts.cfAccess;
  const cfAccessVerifier = cfAccessConfig ? createCfAccessVerifier(cfAccessConfig) : null;

  const sse = new SseHub();
  const webhookLog: WebhookLogEntry[] = [];
  const webhooks = createWebhookDispatcher({
    onLog: (e) => {
      webhookLog.push(e);
      if (webhookLog.length > 1000) webhookLog.shift();
    },
  });
  // `withReviewUrl` is a hoisted function declaration; it captures
  // `server` lazily and is only invoked during requests / thread events,
  // after Bun.serve has assigned. Same instance is reused for SSE +
  // webhook payloads via the Rooms decorator.
  // Generation is opt-IN at this seam: no summarizer, no outbound call, ever.
  // See ServerOptions.summarizer for why constructing one here was wrong.
  const summarizer = opts.summarizer ?? null;
  const rooms = new Rooms({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: withReviewUrl,
    ...(summarizer ? { summarizer } : {}),
  });
  // The hub task store (plan §3.2/§3.3): server-owned workspaces + tasks,
  // persisted as per-workspace sidecars under <dataDir>/workspaces/.
  const taskStore = new TaskStore({ dataDir });
  // Every store event rides the existing SSE pipeline on the workspace
  // channel (`ws~<workspaceId>`, the same channel doc thread events use for
  // legacy grouping workspaces) — no new transport (§3.6). The audit log
  // append happens inside the store's emit, not here.
  taskStore.onEvent((ev) => {
    const { type, ...rest } = ev;
    sse.broadcast(`ws~${ev.workspaceId}`, { event: type, ...rest });
  });
  // The real triage-delivery bridge (§3.4, grounded-pending): a request
  // counts as delivered ONLY when the workspace has a live attachment to act
  // on it — that check is what earns the task its triagePendingTs. The
  // request rides the workspace SSE channel (the MCP watch transport) but
  // deliberately NOT the store's emit: §3.6's table is the exhaustive
  // subscriber/audit contract and has no triage.requested row, so requests
  // never reach events.jsonl (they're a delivery, not a change).
  taskStore.setTriageDelivery((req) => {
    if (!taskStore.hasLiveAttachment(req.workspaceId)) return false;
    sse.broadcast(`ws~${req.workspaceId}`, { event: 'triage.requested', ...req });
    return true;
  });
  // The ydoc projection (§3.3): ws:<workspaceId> board rooms the server
  // writes and defends (foreign writes reverted), plus task:<taskId> body
  // rooms. init() runs after both stores hydrated, so the sidecar is
  // authoritative for gated fields on restart.
  const taskProjection = new TaskProjection({ rooms, tasks: taskStore });
  taskProjection.init();
  // Deploy readiness (§3.12 commit 11): uptime is measured from the same
  // events.jsonl the audit trail lives in. The monitor stamps
  // server.started now (bounding whatever outage this boot ended) and
  // beats server.tick so an idle workspace's log still has gap-analysis
  // density. Markers bypass taskStore.emit on purpose — §3.6's table has
  // no server.* rows, and SSE/MCP subscribers must not see a beat every
  // five minutes.
  const uptimeMonitor = new UptimeMonitor({
    dataDir,
    tasks: taskStore,
    ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
  });
  uptimeMonitor.start();
  // Voice routing (§3.8): lookups take the Haiku fast path when a completer
  // was injected; changes go to the attached agent (or the on-disk queue).
  const voiceRouter = new VoiceRouter({
    tasks: taskStore,
    ...(opts.voiceComplete ? { complete: opts.voiceComplete } : {}),
  });

  /**
   * Which workspace a docId belongs to, for SHARE SCOPING (§3.12 commit 8).
   * Legacy grouping tags (folder binds / diff reviews) answer from the doc's
   * own metadata; hub workspaces answer from the store — docs linked via
   * attachDoc plus each task's own `task:<id>` body room, which is what
   * makes "visitors may post comments" true for a hub share (comments need
   * an in-scope doc). Deliberately NOT the ws:<id> board room: its share
   * allowance is spelled out in host-guard, never a resolver side effect.
   */
  const shareWorkspaceOf = (docId: string): string | null =>
    rooms.get(docId)?.meta.workspaceId ?? taskStore.workspaceOfDoc(docId);

  /**
   * CORS is decided once, here, for every response the handler produces,
   * rather than by `j()` — which has no request context and used to stamp
   * `Access-Control-Allow-Origin: *` on everything. See
   * middleware/browser-origin.ts for why that wildcard was a hole.
   */
  /**
   * The origin policy for a request. `localHostnames` mirrors the host gate's
   * own notion of "this machine", so a dev server reached over the tailnet or
   * the LAN — not just loopback — can still embed the widget.
   */
  const policyFor = (req: Request) => {
    // Scheme matters (http://x and https://x are different browser origins),
    // and behind cloudflared the socket is plain http while the browser is on
    // https — so trust the forwarded scheme when the proxy sets one.
    // ALLOWLISTED, not interpolated. This value is concatenated into a URL
    // string, so an unvalidated one rewrites the origin we compare against:
    // `x-forwarded-proto: https://evil.example.com#` makes
    // `new URL('https://evil.example.com#://feedback.example.com').origin`
    // the ATTACKER's origin, originMatch returns 'same-origin', and on the
    // share host — where same-origin is the only rule left — that is the
    // whole boundary gone. A proxy appending to an existing header
    // (`https://evil.example.com#, https`) does it too.
    //
    // Note the asymmetry this fixes: host-guard requires `cf-ray` before it
    // believes a proxy claim, while this trusted a bare header.
    const forwarded = req.headers.get('x-forwarded-proto');
    const scheme =
      forwarded === 'http' || forwarded === 'https'
        ? forwarded
        : new URL(req.url).protocol.replace(':', '');
    const host = req.headers.get('host') ?? '';
    // The dev-server allowances belong to the LOCAL surface, where nothing is
    // cookie-authenticated. A share host is not that: the visitor carries a
    // SameSite=Lax session cookie, and websockets ignore CORS entirely — so an
    // allowed origin that happened to be same-SITE with the share host would
    // carry that cookie into /y/<docId> and act as a logged-in visitor. A
    // share visitor loads the app FROM the share host, so same-origin is all
    // they ever need, and it's all they get.
    // Cached (60s TTL) — tailscaleHost() shells out, and this runs on every
    // write and every websocket handshake.
    const ourNames = localHostnames();
    const isLocalSurface = isTrustedLocalHost(host, {
      lanHosts: ourNames,
      extraHosts: opts.trustedHosts ?? [],
      viaProxy: req.headers.has('cf-ray'),
    });
    return {
      // Canonicalized, not concatenated. A proxy may forward Host with an
      // explicit default port (`feedback.example.com:443`) while the browser
      // sends `Origin: https://feedback.example.com` — a raw string compare
      // would then treat every legitimate request on the share host as
      // foreign and 403 its websocket. URL.origin drops the default port.
      requestOrigin: canonicalOrigin(scheme, host),
      localHostnames: isLocalSurface
        ? [...LOOPBACK_HOSTS, ...ourNames, ...(opts.trustedHosts ?? [])].filter((h) => h !== '')
        : [],
      allowedOrigins: isLocalSurface ? (opts.allowedOrigins ?? []) : [],
    };
  };

  const applyCors = (req: Request, res: Response): Response => {
    const headers = corsHeadersFor(req.headers.get('origin'), policyFor(req));
    if (!headers) return res;
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: merged,
    });
  };

  const server = Bun.serve<{ docId: string }>({
    port,
    async fetch(req, server) {
      // `undefined` means the request became a websocket — nothing to decorate.
      const routed = await route(req, server);
      return routed === undefined ? undefined : applyCors(req, routed);

      // Hoisted, so the wrapper above can call it first. The whole route
      // table lives in here unchanged.
      async function route(
        req: Request,
        server: BunServer<{ docId: string }>,
      ): Promise<Response | undefined> {
        const url = new URL(req.url);
        const { pathname } = url;

        // --- CORS preflight ---
        // The canonical embed loads the widget bundle from this server but
        // runs on a different origin (e.g. an Astro dev server on :4321).
        // Every REST call from the widget is therefore cross-origin and
        // browsers preflight non-simple requests (POST + JSON body) with an
        // OPTIONS. Reply once here so we don't have to thread the response
        // through every route handler.
        // The wrapper above attaches the CORS headers when the origin is
        // allowed. A disallowed origin gets a bare 204 with no
        // Access-Control-Allow-* — which is exactly how the browser learns no.
        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204 });
        }

        // --- Cross-origin WRITE gate ---
        // Withholding CORS headers only hides the RESPONSE. A "simple request"
        // — POST with content-type text/plain — is never preflighted, so the
        // browser sends it and the write lands; the page just can't read the
        // reply. safeJson() parses the body whatever the content-type says, so
        // that was a working CSRF write: post comments as someone else, or
        // create a doc bound to any file on the machine.
        //
        // GET stays open on purpose. Its response is already withheld by CORS,
        // and refusing it would break <script>/<img>-style loads of the widget
        // bundle from arbitrary dev sites (those send no Origin at all).
        if (
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          !isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))
        ) {
          return j(403, { error: 'origin_not_allowed' });
        }

        // --- Cloudflare Access gate ---
        // When cfAccess is configured (server is reachable via a public
        // tunnel), gate the request. Two modes:
        //   - With shares wired: gate ONLY requests whose Host matches an
        //     active share. Tailscale/LAN traffic to the canonical hostname
        //     stays unauthenticated, so the agent's MCP tools can still
        //     hit /api/share over loopback.
        //   - Without shares: gate everything (legacy/test mode).
        // DEFAULT-DENY BY HOST. The tunnel forwards every hostname under the
        // share wildcard here, so "not a known share host" must mean REFUSE,
        // never "skip the gate" (which is what it used to mean — an unknown
        // tunnel hostname reached the whole API unauthenticated). Only our own
        // local names bypass; a share host is gated AND scoped; anything else
        // is denied even when Access isn't configured, so a half-configured
        // deployment fails closed instead of publishing the API.
        /**
         * Doc metadata as this caller may see it. On the tailnet that's all of
         * it; a share visitor gets an allowlisted subset — the full DocMeta
         * carries absolute paths on Bryan's machine and a tailnet hostname,
         * none of which is needed to render a review.
         */
        const metaFor = <T extends DocMeta>(meta: T): Record<string, unknown> => {
          const decorated = withReviewUrl(meta);
          if (!visitor) return decorated as unknown as Record<string, unknown>;
          return {
            ...redactMetaForVisitor(decorated, {
              workspaceScoped: Boolean(visitor.workspaceId),
            }),
            // Same path, no host — correct for every share mode.
            ...(relativeReviewUrl(decorated.reviewUrl) !== undefined
              ? { reviewUrl: relativeReviewUrl(decorated.reviewUrl) }
              : {}),
          };
        };

        /**
         * The author to attribute a write to. On the tailnet the body is
         * trusted (it's Bryan's browser or his own agents). From a share
         * visitor it is NOT: their claimed identity is rewritten into the
         * `guest-` namespace so nobody can post as a member of the fleet.
         */
        const authorFor = (claimed: unknown): User | undefined => {
          if (visitor) {
            return sanitizeVisitorAuthor(claimed, {
              // The SHARE, not the doc: two links to the same doc are two
              // different audiences, and seeding from the doc id would give a
              // returning browser the same guest identity on both — attributing
              // comments on a freshly minted link to the old one's visitor.
              shareKey: visitorShareId ?? visitor.workspaceId ?? visitor.docId,
            });
          }
          return claimed as User | undefined;
        };

        /**
         * Thread→task surfacing (§3.12 commit 4): decorate a thread payload
         * with chips for the tasks that reference it — via `links` or via a
         * promotion `origin`. The chip is the §3.3 rule-2 visitor-safe shape,
         * so visitors get the decoration too. Omitted when empty (trimmed
         * results, §3.10) — every reader treats a missing `tasks` as none.
         */
        const withTaskChips = <T extends { id: string }>(docId: string, t: T): T => {
          const chips = taskStore.tasksReferencingThread(docId, t.id).map(taskChip);
          return chips.length > 0 ? { ...t, tasks: chips } : t;
        };

        // Set when this request comes from a SHARE visitor (either mode).
        // Everything below treats a non-null value as "untrusted outsider":
        // their claimed identity is rewritten and doc metadata is redacted.
        let visitor: ShareTarget | null = null;
        /** The share that authorized this request, stamped onto any websocket
         *  it upgrades so revocation can find and close it later. */
        let visitorShareId: string | null = null;
        {
          const decision = classifyHost(req.headers.get('host'), {
            // Cached (60s TTL) — this used to spawn `tailscale status` on
            // every single request.
            lanHosts: localHostnames(),
            extraHosts: opts.trustedHosts ?? [],
            // cloudflared forwards the visitor's Host verbatim, so a tunnel
            // visitor could otherwise claim `Host: localhost`. Cloudflare
            // stamps cf-ray on everything it proxies (overwriting any the
            // client sent), so its presence means "not from our LAN".
            viaProxy: req.headers.has('cf-ray'),
            lookupShare: (h) => {
              // LIVE, not merely known: an expired share's hostname must stop
              // being a share hostname, or expiry never takes effect for
              // Access mode (see Shares.findLiveByHostname).
              const s = shares?.findLiveByHostname(h);
              if (!s) return null;
              return s.workspaceId
                ? { docId: s.docId, workspaceId: s.workspaceId }
                : { docId: s.docId };
            },
            linkHost: shares?.publicHostname ?? null,
          });
          if (decision.kind === 'deny') {
            return j(403, { error: 'unknown_host' });
          }
          // --- External-access master switch ---
          // AHEAD of both auth paths on purpose: while sharing is off, a live
          // Access JWT, an unexpired session cookie and no credential at all
          // must be indistinguishable. Gating after auth would leak which
          // slugs are real to anyone still holding one.
          //
          // Only external hosts pass through here — `local` returned above
          // this point untouched, so the agent's MCP calls over loopback and
          // Bryan's own browser keep working while the outside door is shut.
          if ((decision.kind === 'share' || decision.kind === 'link') && !sharingGate.isEnabled()) {
            return j(403, { error: 'sharing_disabled' });
          }
          if (decision.kind === 'share') {
            if (!cfAccessVerifier) {
              // A share exists but we cannot verify Access tokens — refuse
              // rather than serve the doc to an unauthenticated visitor.
              return j(503, { error: 'access_not_configured' });
            }
            const result = await cfAccessVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            // Authenticated for THIS share — but Access only proves the
            // visitor's email domain, not what they may touch. Scope them to
            // the shared doc: no doc enumeration, no workspace/diff creation,
            // no share administration.
            // Ahead of the scope check on purpose: a /review/<docId> for a doc
            // that does NOT exist can't pass scope (there's no workspace to
            // match), so the repair would be unreachable behind it. It leaks
            // nothing — a docId that exists elsewhere is left alone and still
            // gets the 403 below.
            const repaired = repairStaleReviewUrl(pathname, req.method, decision.target);
            if (repaired) return repaired;
            if (!shareScopeAllows(pathname, req.method, decision.target, shareWorkspaceOf)) {
              return j(403, { error: 'out_of_share_scope' });
            }
            visitor = decision.target;
            visitorShareId =
              shares?.findLiveByHostname(req.headers.get('host') ?? '')?.shareId ?? null;
          } else if (decision.kind === 'link') {
            // Redeeming a link is the ONLY thing reachable here without a
            // session — that request is what mints one.
            // Matched with the SAME regex the redeem route uses. A `startsWith`
            // prefix let any GET under /s/ skip the session check — inert today
            // because nothing else is mounted there and URL normalizes `..`,
            // but it becomes a hole the moment something is.
            const redeeming = req.method === 'GET' && /^\/s\/[^/]+$/.test(pathname);
            if (!redeeming) {
              const target = linkSessionTarget(req);
              if (!target) return j(401, { error: 'no_share_session' });
              const repaired = repairStaleReviewUrl(pathname, req.method, target);
              if (repaired) return repaired;
              if (!shareScopeAllows(pathname, req.method, target, shareWorkspaceOf)) {
                return j(403, { error: 'out_of_share_scope' });
              }
              visitor = target;
              visitorShareId = linkSessionShareId(req);
            }
          } else if (cfAccessVerifier && !shares) {
            // Legacy whole-server mode: cfAccess configured WITHOUT per-share
            // hostnames means the entire deployment sits behind Access, so
            // even a local-looking Host must present a token. (With shares
            // wired, local traffic is the agent's own MCP calls over loopback
            // and stays unauthenticated.)
            const result = await cfAccessVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
          }
        }

        // --- REST: shares ---
        if (pathname === '/api/share' && req.method === 'GET') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          return j(200, { shares: shares.list(), sharing: sharingGate.status() });
        }
        // Flip the master switch. Local-only, like the rest of /api/share*.
        // Turning it OFF also hangs up what is already connected: a websocket
        // and an SSE stream are authorized ONCE at open, so a visitor mid-review
        // would otherwise keep syncing and keep receiving comments on a doc
        // that is no longer reachable. Same lesson as share revocation.
        if (pathname === '/api/share/enabled' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const enabled = body?.enabled;
          if (typeof enabled !== 'boolean') {
            return j(400, { error: 'enabled must be a boolean' });
          }
          const res = sharingGate.setEnabled(enabled);
          if (!res.ok) {
            return j(409, {
              error: res.error,
              hint: 'LF_SHARING_DISABLED is set in the environment. Remove it from the service definition and restart to allow runtime control.',
            });
          }
          let closedSockets = 0;
          let closedStreams = 0;
          if (!enabled) {
            for (const share of shares.list()) {
              closedSockets += rooms.closeSocketsForShare(share.shareId);
              closedStreams += sse.closeForShare(share.shareId);
            }
          }
          return j(200, {
            ok: true,
            sharing: sharingGate.status(),
            ...(closedSockets ? { closedSockets } : {}),
            ...(closedStreams ? { closedStreams } : {}),
          });
        }
        if (pathname === '/api/share/doc' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const docId = (body?.docId as string) ?? '';
          const allowDomains = (body?.allowDomains as string[]) ?? [];
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
          if (!Array.isArray(allowDomains) || allowDomains.length === 0) {
            return j(400, { error: 'allowDomains must be a non-empty array' });
          }
          try {
            const share = await shares.createShareDoc({
              docId,
              allowDomains,
              ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
              name: typeof body?.name === 'string' ? body.name : undefined,
            });
            return j(200, { share });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'create_share_failed';
            return j(502, { error });
          }
        }
        // --- Redeem a share link ---
        // The slug is a bearer credential: exchange it for a signed session
        // cookie, then redirect to the doc. Deliberately gives nothing away
        // on failure — an unknown, expired, or malformed slug all look alike.
        const redeemMatch = pathname.match(/^\/s\/([^/]+)$/);
        if (redeemMatch && req.method === 'GET') {
          const slug = decodeURIComponent(redeemMatch[1] ?? '');
          const share = shares?.findBySlug(slug) ?? null;
          if (!share) {
            return new Response(renderLinkNotFound(), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          // A HUB workspace share lands IN the hub — never a review URL,
          // never a lobby (§2.5). Resolved at redemption like everything
          // else, so a workspace deleted after minting falls through to the
          // same not-found the legacy path gives.
          if (share.workspaceId && taskStore.getWorkspace(share.workspaceId)) {
            const maxAge = Math.floor((share.expiresAt - Date.now()) / 1000);
            return new Response(null, {
              status: 302,
              headers: {
                location: `/workspaces/${encodeURIComponent(share.workspaceId)}`,
                'set-cookie': sessionCookieHeader(share.shareId, cookieKey(), maxAge),
                'referrer-policy': 'no-referrer',
              },
            });
          }
          // Where to land is resolved NOW, not when the share was minted: a
          // member docId encodes the file's relPath, so renaming or deleting
          // the entry file used to 404 the link with no way to repoint it.
          // A single-doc share has exactly one answer and skips this.
          const target = share.workspaceId
            ? currentWorkspaceEntry(share.workspaceId, share.docId)
            : share.docId;
          // An emptied-out workspace has nothing to show; say no more than an
          // unknown slug would.
          if (!target) {
            return new Response(renderLinkNotFound(), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          const maxAge = Math.floor((share.expiresAt - Date.now()) / 1000);
          return new Response(null, {
            status: 302,
            headers: {
              location: `/review/${encodeURIComponent(target)}`,
              'set-cookie': sessionCookieHeader(share.shareId, cookieKey(), maxAge),
              // Keep the slug out of any downstream Referer header.
              'referrer-policy': 'no-referrer',
            },
          });
        }

        // Mint a share link. Local-only: /api/share* is out of scope for a
        // visitor, so this can only be called from the machine or the tailnet.
        if (pathname === '/api/share/link' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const docId = body?.docId as string | undefined;
          const workspaceId = body?.workspaceId as string | undefined;
          if (!docId && !workspaceId) return j(400, { error: 'docId or workspaceId required' });
          if (docId && workspaceId) return j(400, { error: 'pass docId OR workspaceId, not both' });

          let entryDocId = body?.entryDocId as string | undefined;
          let memberCount: number | undefined;
          // A HUB workspace (§3.12 commit 8) is shareable with zero bound
          // member docs — its entry is the hub page, not a review doc.
          const isHubShare = workspaceId !== undefined && !!taskStore.getWorkspace(workspaceId);
          if (isHubShare) {
            if (entryDocId) {
              return j(400, {
                error: 'a hub workspace share opens the hub page — entryDocId is not supported',
              });
            }
          } else if (workspaceId) {
            const members = rooms.list().filter((m) => m.workspaceId === workspaceId);
            if (members.length === 0) return j(404, { error: 'workspace not found', workspaceId });
            if (entryDocId && !members.some((m) => m.docId === entryDocId)) {
              return j(400, { error: 'entryDocId is not a member of this workspace' });
            }
            entryDocId = entryDocId ?? members[0]?.docId;
            memberCount = members.length;
          } else if (!rooms.get(docId ?? '')) {
            return j(404, { error: 'doc not found' });
          }
          try {
            const share = shares.createShareLink({
              docId,
              workspaceId,
              entryDocId,
              hub: isHubShare,
              ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
              label: typeof body?.label === 'string' ? body.label : undefined,
            });
            return j(200, { share, ...(memberCount ? { memberCount } : {}) });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'create_share_failed';
            return j(400, { error });
          }
        }

        // Extend or shorten a live share. Local-only, same as creation.
        const ttlMatch = pathname.match(/^\/api\/share\/([^/]+)\/ttl$/);
        if (ttlMatch && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const shareId = decodeURIComponent(ttlMatch[1] ?? '');
          const body = await safeJson(req);
          const ttlSeconds = body?.ttlSeconds;
          if (typeof ttlSeconds !== 'number') return j(400, { error: 'ttlSeconds required' });
          try {
            const share = shares.setTtl(shareId, ttlSeconds);
            return share ? j(200, { share }) : j(404, { error: 'share not found' });
          } catch (err) {
            return j(400, { error: err instanceof Error ? err.message : 'bad ttl' });
          }
        }

        // Share a whole workspace (folder bind / diff review) rather than one
        // doc: the visitor gets the file tree and every member, so the set
        // browses as a set. Scope is enforced in middleware/host-guard.ts.
        if (pathname === '/api/share/workspace' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const workspaceId = (body?.workspaceId as string) ?? '';
          const allowDomains = (body?.allowDomains as string[]) ?? [];
          if (!workspaceId) return j(400, { error: 'workspaceId required' });
          if (!Array.isArray(allowDomains) || allowDomains.length === 0) {
            return j(400, { error: 'allowDomains must be a non-empty array' });
          }
          // A HUB workspace share (§3.12 commit 8): same email-share
          // machinery, but the URL opens the hub page and there is no entry
          // doc — the guard scopes by workspaceId alone.
          if (taskStore.getWorkspace(workspaceId)) {
            if (body?.entryDocId) {
              return j(400, {
                error: 'a hub workspace share opens the hub page — entryDocId is not supported',
              });
            }
            try {
              const share = await shares.createShareWorkspace({
                workspaceId,
                hub: true,
                allowDomains,
                ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
                name: typeof body?.name === 'string' ? body.name : undefined,
              });
              return j(200, { share });
            } catch (err) {
              const error = err instanceof Error ? err.message : 'create_share_failed';
              return j(502, { error });
            }
          }
          const members = rooms.list().filter((m) => m.workspaceId === workspaceId);
          if (members.length === 0) return j(404, { error: 'workspace not found', workspaceId });
          // Entry doc: caller's choice, else the first member. Must belong to
          // the workspace — otherwise the URL would open an out-of-scope doc
          // and the visitor would land on a 403.
          const requested = body?.entryDocId as string | undefined;
          if (requested && !members.some((m) => m.docId === requested)) {
            return j(400, { error: 'entryDocId is not a member of this workspace' });
          }
          const entryDocId = requested ?? members[0]?.docId ?? '';
          try {
            const share = await shares.createShareWorkspace({
              workspaceId,
              entryDocId,
              allowDomains,
              ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
              name: typeof body?.name === 'string' ? body.name : undefined,
            });
            return j(200, { share, memberCount: members.length });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'create_share_failed';
            return j(502, { error });
          }
        }
        const shareIdMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
        if (shareIdMatch && req.method === 'DELETE') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const shareId = decodeURIComponent(shareIdMatch[1] ?? '');
          try {
            const result = await shares.deleteShare(shareId);
            // Authorization is checked per HTTP request, but a websocket is
            // authorized once at its upgrade — so without this, a visitor who
            // already had the doc open kept reading and writing it after the
            // share was revoked.
            const closed = result.ok ? rooms.closeSocketsForShare(shareId) : 0;
            // The SSE stream has the same "authorized once, then long-lived"
            // shape: a visitor with the review page still open would otherwise
            // keep receiving every new comment on a doc they can no longer load.
            const closedStreams = result.ok ? sse.closeForShare(shareId) : 0;
            return result.ok
              ? j(200, {
                  ok: true,
                  ...(closed ? { closedSockets: closed } : {}),
                  ...(closedStreams ? { closedStreams } : {}),
                })
              : j(404, { error: 'share not found' });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'delete_share_failed';
            return j(502, { error });
          }
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
          const docId = decodeURIComponent(pathname.slice(3));
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          const type = url.searchParams.get('type') as DocType | null;
          const sourceUrl = url.searchParams.get('sourceUrl') ?? undefined;
          // Mockup docs auto-create on WS — the widget connects first with a
          // known type + sourceUrl (this covers the dev-server surface too;
          // the widget always identifies as 'mockup'). Markdown docs MUST be
          // created upfront via POST /api/docs (which auto-attaches a file).
          // The browser navigating to /review/<docId> before the agent has
          // created the doc gets a clean 404 from /review's own handler.
          if (!rooms.get(docId)) {
            if (type === 'mockup') {
              rooms.getOrCreate(docId, { type, sourceUrl });
            } else {
              return j(404, { error: 'doc not found' });
            }
          }
          const upgraded = server.upgrade(req, {
            data: { docId, ...(visitorShareId ? { shareId: visitorShareId } : {}) },
          });
          if (!upgraded) return new Response('upgrade required', { status: 426 });
          return undefined;
        }

        // --- SSE (workspace-level): every thread event on any member doc of a
        // workspace/diff review, one stream — agents watch this instead of one
        // stream per file. ---
        const wsEventsMatch = pathname.match(/^\/events\/workspace\/([^/]+)$/);
        if (wsEventsMatch) {
          const workspaceId = decodeURIComponent(wsEventsMatch[1] ?? '');
          if (!isValidDocId(workspaceId)) return j(400, { error: 'bad workspaceId' });
          // A workspace channel exists for legacy grouping workspaces (diff
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
          return openSseStream(
            sse,
            `ws~${workspaceId}`,
            visitorShareId ?? undefined,
            visitor ? redactHubEventForVisitor : undefined,
          );
        }
        // --- SSE ---
        if (pathname.startsWith('/events/')) {
          const docId = decodeURIComponent(pathname.slice('/events/'.length));
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
          return openSseStream(sse, docId, visitorShareId ?? undefined);
        }

        // --- REST: docs ---
        if (pathname === '/api/docs' && req.method === 'POST') {
          const body = await safeJson(req);
          const docId = (body?.docId as string) ?? '';
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          const type = (body?.type as DocType) ?? 'markdown';
          const sourceUrl = body?.sourceUrl as string | undefined;
          // Every markdown doc is file-backed. POST /api/docs is the sole
          // creation path for markdown — sourceUrl is required, and the
          // server attaches the file (loads content + sets up bidirectional
          // disk sync) before returning. Mockup/dev docs are about
          // commenting on running surfaces, not about a markdown buffer,
          // so they don't need a file.
          // Diff docs are created only via POST /api/diffs, which resolves the
          // range and seeds content from git — a bare create can't do that.
          if (type === 'diff') {
            return j(400, {
              error: 'use /api/diffs',
              hint: 'Diff review docs are created per changed file by POST /api/diffs {repo, base, target}.',
            });
          }
          if ((type === 'markdown' || type === 'code') && !sourceUrl) {
            return j(400, {
              error: 'sourceUrl required',
              hint: 'Markdown and code review docs are backed by a file on disk. Pass sourceUrl: "/abs/path/to/file" in the POST body.',
            });
          }
          const room = rooms.getOrCreate(docId, {
            type,
            sourceUrl,
            title: body?.title as string | undefined,
            setId: body?.setId as string | undefined,
            webhookUrl: body?.webhookUrl as string | undefined,
            owner: body?.owner as string | undefined,
            workspaceId: body?.workspaceId as string | undefined,
            relPath: body?.relPath as string | undefined,
            workspaceRoot: body?.workspaceRoot as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          let attached: ReturnType<typeof rooms.attachFile> | undefined;
          if (type === 'markdown' && sourceUrl) {
            attached = rooms.attachFile(docId, sourceUrl);
            if (!attached.ok) return j(409, { error: 'attach_failed', attached });
          } else if (type === 'code' && sourceUrl) {
            attached = rooms.attachReadonlyFile(docId, sourceUrl);
            if (!attached.ok) return j(409, { error: 'attach_failed', attached });
          }
          return j(200, {
            docId: room.docId,
            meta: withReviewUrl(room.meta),
            ...(attached ? { attached } : {}),
          });
        }
        if (pathname === '/api/docs' && req.method === 'GET') {
          return j(200, { docs: rooms.list().map(withReviewUrl) });
        }

        // --- REST: workspaces (hub create OR folder bind) ---
        // One resource, two shapes: `folderPath` binds a folder of files
        // (the legacy grouping workspace), `name` creates a hub Workspace —
        // a NEW first-class entity with a crypto-random id that tasks and
        // goals hang off (plan §3.12 commit 1). Nothing is migrated between
        // the two; attach_doc LINKS existing docs/reviews to a hub workspace.
        if (pathname === '/api/workspaces' && req.method === 'POST') {
          const body = await safeJson(req);
          const folderPath = body?.folderPath as string | undefined;
          if (!folderPath && typeof body?.name === 'string' && body.name.trim().length > 0) {
            const goal = typeof body?.goal === 'string' ? (body.goal as string) : undefined;
            const workspace = taskStore.createWorkspace(body.name.trim(), goal);
            // createWorkspace emits no event (nothing subscribes to a
            // workspace that doesn't exist yet), so the route brings the
            // board room up itself.
            taskProjection.ensureWorkspace(workspace.id);
            return j(200, { workspace });
          }
          if (!folderPath || typeof folderPath !== 'string') {
            return j(400, { error: 'folderPath (folder bind) or name (hub workspace) required' });
          }
          const res = rooms.bindFolder({
            folderPath,
            workspaceId: body?.workspaceId as string | undefined,
            title: body?.title as string | undefined,
            include: Array.isArray(body?.include) ? (body.include as string[]) : undefined,
            // Accepted by bindFolder and honoured by the scan since forever,
            // but this route never forwarded it — so bind_folder's exclude had
            // no effect end-to-end. It matters more now: refresh_workspace
            // persists and replays the exclude, which is meaningless if the
            // bind could never set one. (/api/diffs already forwarded it.)
            exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
            maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
            owner: body?.owner as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          if (!res.ok) {
            // not-found → 404; too-many-files → 409 (guardrail, caller must
            // narrow the folder or raise maxFiles).
            return j(res.error === 'not-found' ? 404 : 409, res);
          }
          return j(200, {
            ...res,
            files: res.files.map((f) => ({
              ...f,
              reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
            })),
          });
        }
        // --- REST: diff reviews ---
        // One doc per changed file, grouped as a workspace (= the review id).
        // Default mode diffs base → the WORKING TREE (live: docs bind to the
        // files on disk and re-render as the agent edits); pass `target` for a
        // review pinned to a commit. Returns per-file reviewUrls plus an
        // entryUrl (first changed file) the agent can hand to a human.
        if (pathname === '/api/diffs' && req.method === 'POST') {
          const body = await safeJson(req);
          const repoPath = body?.repo as string | undefined;
          const base = body?.base as string | undefined;
          const target = body?.target as string | undefined;
          if (!repoPath) {
            return j(400, {
              error:
                'repo is required. base optional: omit for a BROWSE workspace (no diff); pass base to diff against the working tree; base+target for a pinned range.',
            });
          }
          if (target && !base) {
            return j(400, { error: 'target requires base' });
          }
          const reviewId = body?.reviewId as string | undefined;
          if (reviewId !== undefined && !isValidDocId(reviewId)) {
            return j(400, { error: 'bad reviewId' });
          }
          const res = rooms.bindDiff({
            repoPath,
            base,
            target,
            reviewId,
            title: body?.title as string | undefined,
            exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
            groups: Array.isArray(body?.groups)
              ? (body.groups as Array<{ title: string; paths: string[]; details?: string }>)
              : undefined,
            maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
            owner: body?.owner as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          if (!res.ok) {
            const status =
              res.error === 'not-found' || res.error === 'bad-ref'
                ? 404
                : res.error === 'empty-diff' ||
                    res.error === 'group-details-too-long' ||
                    res.error === 'bad-groups'
                  ? 400
                  : 409;
            return j(status, res);
          }
          const files = res.files.map((f) => ({
            ...f,
            reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
          }));
          // Land the reviewer on the MEATIEST change, not the first file
          // alphabetically (which is usually dotfile/config noise on a big
          // review). The in-page tree navigates to everything else.
          const entry = files.reduce(
            (best, f) =>
              (f.additions ?? 0) + (f.deletions ?? 0) >
              (best.additions ?? 0) + (best.deletions ?? 0)
                ? f
                : best,
            files[0],
          );
          return j(200, { ...res, files, entryUrl: entry?.reviewUrl });
        }
        // List bound workspaces with rolled-up triage signals (fileCount,
        // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
        // this to treat a folder bind as one cleanup unit.
        if (pathname === '/api/workspaces' && req.method === 'GET') {
          return j(200, { workspaces: rooms.listWorkspaces() });
        }
        // --- REST: hub workspaces + tasks (plan §3.10) ---
        // Every handler below hand-copies body fields into the store call.
        // A field that isn't copied is silently discarded while the request
        // still returns 200 — so every param here has an HTTP-level test in
        // task-routes.test.ts (the `groups` lesson).
        const hubWsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (hubWsMatch && req.method === 'GET') {
          const workspace = taskStore.getWorkspace(decodeURIComponent(hubWsMatch[1] ?? ''));
          if (!workspace) return j(404, { error: 'workspace not found' });
          return j(200, { workspace });
        }
        // Activity view (§3.9): the per-workspace events.jsonl audit log,
        // read back as rows. This is the surface where the after-the-fact
        // 80/95 review happens, built on the same file every subscriber saw
        // (§3.6: the audit log can never disagree with what subscribers saw).
        const wsAuditMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/events$/);
        if (wsAuditMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsAuditMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const logPath = eventsLogPath(dataDir, workspaceId);
          let rows: Array<{ event?: unknown; ts?: unknown }> = [];
          if (existsSync(logPath)) {
            rows = readFileSync(logPath, 'utf8')
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .flatMap((line) => {
                try {
                  return [JSON.parse(line) as { event?: unknown; ts?: unknown }];
                } catch {
                  // A torn tail line (crash mid-append) must not take the
                  // whole activity view down with it.
                  return [];
                }
              });
          }
          // Uptime (§3.12 commit 11): every line — real event or liveness
          // marker — is proof the server was alive when it was written, so
          // the gap analysis runs over ALL timestamps, before any filtering.
          const uptime = analyzeUptime(
            rows.map((r) => r.ts).filter((t): t is number => typeof t === 'number'),
            {
              now: Date.now(),
              ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
            },
          );
          // Ticks are measurement substrate, not activity — strip them from
          // the review list (BEFORE the cap, so a week of beats can't crowd
          // real rows out of it). server.started stays: a restart is honest
          // activity.
          let events: unknown[] = rows.filter((r) => r.event !== SERVER_TICK_EVENT);
          // Cap the payload: the newest rows are the review's working set.
          if (events.length > 1000) events = events.slice(-1000);
          return j(200, { workspaceId, events, uptime });
        }
        // set_workspace_goal: edit the north-star goal (§3.10). The store
        // emits workspace.goal_updated and requests a re-triage of open
        // tasks; the response reports whether that request reached a live
        // attachment (with none, the re-triage honestly does not happen).
        const wsGoalMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goal$/);
        if (wsGoalMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsGoalMatch[1] ?? '');
          const body = await safeJson(req);
          const goal = body?.goal;
          if (typeof goal !== 'string') return j(400, { error: 'goal required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.setWorkspaceGoal(workspaceId, goal, { actor: author });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        // Voice (§3.8): transcript + per-surface context in, route decision +
        // ack out. EVERY utterance gets an explicit ack naming what was heard
        // and which route handles it — the router owns that invariant; this
        // handler only validates and forwards (transcript VERBATIM).
        const wsVoiceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/voice$/);
        if (wsVoiceMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsVoiceMatch[1] ?? '');
          const body = await safeJson(req);
          const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
          if (transcript.length === 0) return j(400, { error: 'transcript required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const context = parseVoiceContext(body?.context);
          const res = await voiceRouter.handle(workspaceId, {
            transcript,
            ...(context !== undefined ? { context } : {}),
            actor: author,
          });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        // attach_doc: link an existing doc or review to a hub workspace.
        const wsAttachMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/docs$/);
        if (wsAttachMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsAttachMatch[1] ?? '');
          const body = await safeJson(req);
          const docId = body?.docId as string | undefined;
          if (!docId || typeof docId !== 'string') return j(400, { error: 'docId required' });
          // The link target must exist: either a doc room, or a legacy
          // grouping workspace id (a diff review / folder bind, attached as
          // one unit).
          const exists =
            rooms.get(docId) !== undefined || rooms.list().some((m) => m.workspaceId === docId);
          if (!exists) return j(404, { error: 'doc not found', docId });
          const res = taskStore.attachDoc(workspaceId, docId);
          if (!res.ok) return j(404, res);
          // attachDoc emits no store event; refresh the projection's docIds.
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, { ok: true, workspace: taskStore.getWorkspace(workspaceId) });
        }
        // import_tasks_markdown (§3.10 / §3.12 commit 10): ingest a
        // hand-maintained tracker (group headings + status tables). The
        // DEFAULT is a dry-run that returns the mapping and touches nothing;
        // apply:true creates the goals + tasks and stamps the source file
        // with a banner + hub link so the old tracker can't quietly stay a
        // second source of truth (a stamped file refuses re-import).
        const wsImportMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/import-tasks$/);
        if (wsImportMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsImportMatch[1] ?? '');
          const body = await safeJson(req);
          const path = body?.path;
          if (typeof path !== 'string' || path.length === 0) {
            return j(400, { error: 'path required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          if (!existsSync(path)) return j(404, { error: 'file not found', path });
          const markdown = readFileSync(path, 'utf8');
          const alreadyImported = importMarkerFor(markdown);
          const mapping = parseTrackerMarkdown(markdown, workspace);
          if (body?.apply !== true) {
            return j(200, {
              dryRun: true,
              workspaceId,
              path,
              ...(alreadyImported !== null ? { alreadyImported } : {}),
              mapping,
            });
          }
          if (alreadyImported !== null) {
            return j(409, { error: 'already-imported', workspaceId: alreadyImported });
          }
          const res = applyImport(taskStore, workspaceId, mapping, { actor: author });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // Stamp the source file. If the tracker is bound as a live doc,
          // pull the banner into the live doc too — reparse right after our
          // own write, so disk (which we just wrote) wins the race with the
          // doc's debounced flush.
          const hubUrl = `${publicBaseUrl(server.port ?? port)}/workspaces/${encodeURIComponent(workspaceId)}`;
          writeFileSync(
            path,
            importBanner({
              workspaceId,
              hubUrl,
              taskCount: res.tasksCreated.length,
              ts: Date.now(),
            }) + markdown,
          );
          const resolved = resolve(path);
          const bound = rooms
            .list()
            .find((m) => m.sourceUrl !== undefined && resolve(m.sourceUrl) === resolved);
          if (bound) rooms.reparseFromDisk(bound.docId);
          // Task/goal events already refreshed the projection; this covers a
          // mapping with zero new goals and zero tasks (nothing emitted).
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, {
            ok: true,
            workspaceId,
            hubUrl,
            stamped: true,
            goalsCreated: res.goalsCreated,
            tasksCreated: res.tasksCreated,
            failures: res.failures,
            skipped: mapping.skipped,
            ignoredColumns: mapping.ignoredColumns,
          });
        }
        const wsTasksMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks$/);
        if (wsTasksMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const status = url.searchParams.get('status') as TaskStatus | null;
          const tasks = taskStore.listTasks(workspaceId, {
            ...(status ? { status } : {}),
            ...(url.searchParams.get('goal') ? { goal: url.searchParams.get('goal') ?? '' } : {}),
            ...(url.searchParams.get('assignee')
              ? { assignee: url.searchParams.get('assignee') ?? '' }
              : {}),
            ...(url.searchParams.get('needs')
              ? { needs: url.searchParams.get('needs') as 'action' | 'decision' }
              : {}),
          });
          return j(200, { workspaceId, tasks });
        }
        if (wsTasksMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
          const body = await safeJson(req);
          const title = body?.title as string | undefined;
          if (!title || typeof title !== 'string' || title.trim().length === 0) {
            return j(400, { error: 'title required' });
          }
          const needs = parseNeeds(body?.needs);
          if (!needs.ok) return j(400, { error: "needs must be 'action' | 'decision'" });
          const links = parseLinks(body?.links);
          if (!links.ok) return j(400, { error: BAD_REF_ERROR });
          const origin = parseOrigin(body?.origin);
          if (!origin.ok) return j(400, { error: BAD_ORIGIN_ERROR });
          const res = taskStore.createTask(workspaceId, {
            title: title.trim(),
            body: body?.body as string | undefined,
            assignee: body?.assignee as string | undefined,
            needs: needs.needs,
            goal: body?.goal as string | undefined,
            order: typeof body?.order === 'number' ? Number(body.order) : undefined,
            after: Array.isArray(body?.after) ? (body.after as string[]) : undefined,
            afterEnforce: Array.isArray(body?.afterEnforce)
              ? (body.afterEnforce as string[])
              : undefined,
            dueAt: typeof body?.dueAt === 'number' ? Number(body.dueAt) : undefined,
            links: links.links,
            origin: origin.origin,
            quote: body?.quote as string | undefined,
            // Optional: a task can be created by a UI with no session yet.
            // When it IS supplied, the created row is attributed (§3.6) —
            // "who put this here" is the first question of every triage.
            actor: authorFor(body?.author) ?? undefined,
          });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // Dropped refs are reported, never swallowed: the caller finds out
          // what didn't survive without having to diff what it sent.
          return j(200, {
            task: res.task,
            ...(links.ignored.length > 0 ? { ignoredLinks: links.ignored } : {}),
          });
        }
        // The single gate for status changes: attributed, evidence-stamped,
        // dependency-checked. 409 on an enforce-marked open dependency.
        const taskTransitionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
        if (taskTransitionMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskTransitionMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          const to = body?.to as TaskStatus | undefined;
          if (!author || !to) return j(400, { error: 'author + to required' });
          const res = taskStore.transition(taskId, to, {
            actor: author,
            note: body?.note as string | undefined,
            evidence: body?.evidence as { commit?: string; threadRef?: Ref } | undefined,
            usage: body?.usage as { inputTokens: number; outputTokens: number } | undefined,
            // The human's live confirmation for a yellow-tier move (§3.4).
            confirmed: body?.confirmed === true,
          });
          if (!res.ok) {
            // A gate refusal is a refusal, not a malformed request: same 409
            // an enforce-marked blocker returns, so callers have one shape
            // for "the gate said no".
            const refused =
              res.error === 'blocked' ||
              res.error === 'risk-refused' ||
              res.error === 'needs-confirmation';
            const status = res.error === 'not-found' ? 404 : refused ? 409 : 400;
            return j(status, res);
          }
          return j(200, res);
        }
        // Cross-references (§3.10 `.../links`): links are STORED on the
        // task; backlinks are COMPUTED per read, never stored, so the two
        // directions can't drift.
        const taskLinksMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/links$/);
        if (taskLinksMatch && req.method === 'GET') {
          const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
          const task = taskStore.getTask(taskId);
          if (!task) return j(404, { error: 'task not found' });
          return j(200, {
            taskId,
            links: task.links,
            backlinks: taskStore.backlinksFor({ kind: 'task', taskId }).map(taskChip),
          });
        }
        if (taskLinksMatch && (req.method === 'POST' || req.method === 'DELETE')) {
          const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
          const body = await safeJson(req);
          const ref = body?.ref;
          if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
          const res =
            req.method === 'POST'
              ? taskStore.linkRef(taskId, ref)
              : taskStore.unlinkRef(taskId, ref);
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // Link changes emit no store event (§3.6's exhaustive table has no
          // row for them), so refresh the projection by hand — the same
          // pattern as createWorkspace/attachDoc above.
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, { ok: true, changed: res.changed, task: res.task });
        }
        // set_task_goal (§3.10): goal/subgoal + exact position + riskTier —
        // the write half of triage and the board's regroup gesture. Every
        // field here is hand-copied; each has an HTTP-level test in
        // task-tool-routes.test.ts.
        const taskGoalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/goal$/);
        if (taskGoalMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskGoalMatch[1] ?? '');
          const body = await safeJson(req);
          const goal = body?.goal;
          if (typeof goal !== 'string' || goal.length === 0) {
            return j(400, { error: 'goal required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const riskTier = body?.riskTier;
          if (
            riskTier !== undefined &&
            riskTier !== 'green' &&
            riskTier !== 'yellow' &&
            riskTier !== 'red'
          ) {
            return j(400, { error: 'riskTier must be green | yellow | red' });
          }
          const batchId = body?.batchId;
          if (batchId !== undefined && typeof batchId !== 'string') {
            return j(400, { error: 'batchId must be a string' });
          }
          const res = taskStore.setTaskGoal(taskId, goal, {
            actor: author,
            position: typeof body?.position === 'number' ? Number(body.position) : undefined,
            riskTier,
            batchId,
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // A confirm-in-place (changed:false) mutates gated fields
          // (triagedAgainst, triagePendingTs, riskTier) without emitting an
          // event — refresh the projection by hand, same as attachDoc.
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // answer_decision (§3.10): record the VERBATIM answer. Does not
        // transition the task — status changes stay with the single gate.
        const taskAnswerMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/answer$/);
        if (taskAnswerMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAnswerMatch[1] ?? '');
          const body = await safeJson(req);
          const text = body?.text;
          if (typeof text !== 'string' || text.length === 0) {
            return j(400, { error: 'text required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.answerDecision(taskId, text, { actor: author });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // In-place task title edit (§3.9: tap the title, Enter commits).
        // Renames emit no store event (§3.6 has no task.renamed row), so the
        // projection the board renders from is refreshed by hand.
        const taskTitleMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/title$/);
        if (taskTitleMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskTitleMatch[1] ?? '');
          const body = await safeJson(req);
          const title = typeof body?.title === 'string' ? body.title.trim() : '';
          if (title.length === 0) return j(400, { error: 'title required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.renameTask(taskId, title, { actor: author });
          if (!res.ok) return j(404, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // assign_task (§3.6 task.assigned): hand a task between the human and
        // the agent (or a named identity). Status is untouched — a hand-off
        // is not progress, and routing it through the transition gate would
        // make "you take this" require evidence.
        const taskAssigneeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assignee$/);
        if (taskAssigneeMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAssigneeMatch[1] ?? '');
          const body = await safeJson(req);
          const assignee = typeof body?.assignee === 'string' ? body.assignee.trim() : '';
          if (assignee.length === 0) return j(400, { error: 'assignee required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.setAssignee(taskId, assignee, { actor: author });
          if (!res.ok) return j(404, res);
          // A no-op emits nothing, so nothing would refresh the board room —
          // harmless here (nothing changed) but the changed path is covered
          // by the task.assigned event's own projection hook.
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // set_goal_list (§3.2 edit contract): replace the ordered board
        // sections. Structural validation happens HERE because the store
        // trusts its callers with shapes — a junk entry that reached the
        // sidecar would render as a broken section forever.
        const wsGoalsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals$/);
        if (wsGoalsMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsGoalsMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const goals = parseGoalList(body?.goals);
          if (!goals) {
            return j(400, { error: 'goals must be [{id, title, dueAt?, subgoals?}]' });
          }
          const res = taskStore.setGoalList(workspaceId, goals, { actor: author });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // promote_to_task (§3.10): thread → task. Captures the origin ref,
        // the latest HUMAN comment as the verbatim quote (an agent's closing
        // note must never become the quote), and drafts a title + body the
        // caller didn't supply. classifyActor draws the person/agent line —
        // the same one replies and transitions use.
        const promoteMatch = pathname.match(/^\/api\/docs\/([^/]+)\/threads\/([^/]+)\/promote$/);
        if (promoteMatch && req.method === 'POST') {
          const docId = decodeURIComponent(promoteMatch[1] ?? '');
          const threadId = decodeURIComponent(promoteMatch[2] ?? '');
          const body = await safeJson(req);
          const workspaceId = body?.workspaceId;
          if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            return j(400, { error: 'workspaceId required' });
          }
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const thread = rooms.getThread(docId, threadId);
          if (!thread) return j(404, { error: 'thread not found' });
          const humanComment = [...thread.comments]
            .reverse()
            .find((c) => classifyActor(c.author) === 'person');
          const quote =
            typeof body?.quote === 'string' && body.quote.length > 0
              ? body.quote
              : humanComment?.text;
          const snippet = anchorSnippetText(thread.anchor);
          const titleSource = (quote ?? snippet ?? 'Promoted thread').split('\n')[0] ?? '';
          const title =
            typeof body?.title === 'string' && body.title.trim().length > 0
              ? body.title.trim()
              : titleSource.length > 80
                ? `${titleSource.slice(0, 79)}…`
                : titleSource;
          const draftBody =
            typeof body?.body === 'string'
              ? body.body
              : [
                  `Promoted from a comment thread${snippet ? ` on "${snippet}"` : ''}.`,
                  ...(quote ? ['', `> ${quote}`] : []),
                ].join('\n');
          const promoteNeeds = parseNeeds(body?.needs);
          if (!promoteNeeds.ok) return j(400, { error: "needs must be 'action' | 'decision'" });
          const promoteLinks = parseLinks(body?.links);
          if (!promoteLinks.ok) return j(400, { error: BAD_REF_ERROR });
          const res = taskStore.createTask(workspaceId, {
            title,
            body: draftBody,
            assignee: body?.assignee as string | undefined,
            needs: promoteNeeds.needs,
            // Forward undefined untouched: an omitted goal is what routes the
            // task through triage (an explicit 'chores' would skip it).
            goal: body?.goal as string | undefined,
            order: typeof body?.order === 'number' ? Number(body.order) : undefined,
            dueAt: typeof body?.dueAt === 'number' ? Number(body.dueAt) : undefined,
            links: promoteLinks.links,
            origin: { kind: 'thread', docId, threadId },
            ...(quote !== undefined ? { quote } : {}),
            actor: authorFor(body?.author) ?? undefined,
          });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          return j(200, {
            task: res.task,
            ...(promoteLinks.ignored.length > 0 ? { ignoredLinks: promoteLinks.ignored } : {}),
          });
        }
        // --- REST: agent attachments (§4) ---
        // AgentAttachment records live OUTSIDE every ydoc; this REST surface
        // is their only read path. `endpoint` is host-machine-describing, so
        // a share visitor's read is redacted (the private-meta pattern) and
        // the mutations are owner-only outright — a visitor attaching an
        // agent or forging a heartbeat is never legitimate.
        const wsAgentsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/attachments$/);
        if (wsAgentsMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          return j(200, {
            workspaceId,
            attachments: visitor
              ? taskStore.listPublicAttachments(workspaceId)
              : taskStore.listAttachments(workspaceId),
          });
        }
        if (wsAgentsMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
          const body = await safeJson(req);
          const agentId = body?.agentId;
          if (typeof agentId !== 'string' || agentId.trim().length === 0) {
            return j(400, { error: 'agentId required' });
          }
          const runtime = body?.runtime;
          if (!isAttachmentRuntime(runtime)) {
            return j(400, { error: 'runtime must be claude-code-local | managed-agent | webhook' });
          }
          const res = taskStore.attachAgent(workspaceId, {
            agentId: agentId.trim(),
            runtime,
            capabilities: Array.isArray(body?.capabilities)
              ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
              : undefined,
            endpoint: typeof body?.endpoint === 'string' ? body.endpoint : undefined,
          });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        const wsAgentHeartbeatMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)\/heartbeat$/,
        );
        if (wsAgentHeartbeatMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentHeartbeatMatch[1] ?? '');
          const agentId = decodeURIComponent(wsAgentHeartbeatMatch[2] ?? '');
          const body = await safeJson(req);
          const res = taskStore.heartbeat(workspaceId, agentId, {
            // Forwarded, not re-derived: the runtime knows when it last did
            // work; the route's job is only to not drop the field.
            toolCallAt: typeof body?.toolCallAt === 'number' ? Number(body.toolCallAt) : undefined,
          });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        const wsAgentDetachMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)$/,
        );
        if (wsAgentDetachMatch && req.method === 'DELETE') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentDetachMatch[1] ?? '');
          const agentId = decodeURIComponent(wsAgentDetachMatch[2] ?? '');
          if (!taskStore.detachAgent(workspaceId, agentId)) {
            return j(404, { error: 'attachment not found' });
          }
          return j(200, { ok: true });
        }
        // Delete a whole workspace as one unit (all-or-nothing open-thread
        // guardrail; ?force=true to override). Member SOURCE files are left
        // untouched, same as DELETE /api/docs/:id.
        const wsDeleteMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (wsDeleteMatch && req.method === 'DELETE') {
          const workspaceId = decodeURIComponent(wsDeleteMatch[1] ?? '');
          const force = url.searchParams.get('force') === 'true';
          const res = rooms.deleteWorkspace(workspaceId, { force });
          if (res.ok) return j(200, res);
          return j(res.error === 'has-open-threads' ? 409 : 404, res);
        }
        // File-tree view for a bound workspace: nested directory tree with
        // per-file unresolved-comment counts + folder roll-ups. Files are
        // decorated with reviewUrl by the rooms decorator (withReviewUrl).
        // All threads across a workspace (folder bind or diff review) in one
        // call — lets a watching agent poll a single endpoint per review
        // instead of one per member file. ?status=open|resolved filters.
        const wsThreadsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/threads$/);
        if (wsThreadsMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsThreadsMatch[1] ?? '');
          if (!rooms.list().some((m) => m.workspaceId === workspaceId)) {
            return j(404, { error: 'workspace not found', workspaceId });
          }
          const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
          const threads = rooms
            .listWorkspaceThreads(workspaceId, status ? { status } : undefined)
            .map((t) => withTaskChips(t.docId, t));
          return j(200, { workspaceId, threads });
        }
        // Grouped-diff sidebar model: changed files organized into logical
        // groups (agent-supplied or heuristic). The default nav for diff
        // reviews.
        const wsGroupedMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/grouped$/);
        if (wsGroupedMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsGroupedMatch[1] ?? '');
          const grouped = rooms.listGroupedDiff(workspaceId);
          if (grouped.groups.length === 0) {
            return j(404, { error: 'no diff review found', workspaceId });
          }
          return j(200, grouped);
        }
        // Re-reconcile a workspace against disk: pick up files that changed
        // since the bind, flag members whose file is gone. Never re-mints a
        // docId, so every comment thread survives.
        const wsRefreshMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/refresh$/);
        if (wsRefreshMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsRefreshMatch[1] ?? '');
          const res = rooms.refreshWorkspace(workspaceId);
          if (res.ok) return j(200, res);
          return j(res.error === 'not-found' ? 404 : 400, res);
        }
        // Re-group a diff review's sidebar in place. An empty `groups` array
        // is meaningful (fall back to the heuristic); a MISSING one is a
        // caller mistake, so it 400s rather than silently regrouping.
        const wsGroupsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/groups$/);
        if (wsGroupsMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsGroupsMatch[1] ?? '');
          const body = await safeJson(req);
          const groups = body?.groups;
          if (!Array.isArray(groups)) return j(400, { error: 'groups array required' });
          const res = rooms.setWorkspaceGroups(
            workspaceId,
            groups as Array<{ title: string; paths: string[]; details?: string }>,
          );
          if (res.ok) return j(200, res);
          return j(res.error === 'not-found' ? 404 : 400, res);
        }
        // Every file in the workspace's repo (changed ones marked) — the
        // "Show All Files" context view.
        const wsFilesMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/);
        if (wsFilesMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsFilesMatch[1] ?? '');
          const res = rooms.listRepoFiles(workspaceId);
          if (!res.ok) return j(404, res);
          // `root` is an absolute host path and every reviewUrl carries the
          // tailnet hostname — neither belongs in a visitor's copy.
          return j(200, visitor ? redactWorkspaceFilesForVisitor(res) : res);
        }
        // Lazily open an unchanged repo file for context (read-only code doc
        // in the same workspace).
        const wsCtxMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/context-file$/);
        if (wsCtxMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsCtxMatch[1] ?? '');
          const body = await safeJson(req);
          const relPath = body?.relPath as string | undefined;
          if (!relPath) return j(400, { error: 'relPath required' });
          const res = rooms.openContextFile(workspaceId, relPath);
          if (!res.ok) return j(res.error === 'bad-path' ? 400 : 404, res);
          return j(200, { docId: res.docId, meta: metaFor(res.meta) });
        }
        const wsEditMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/editable-file$/);
        if (wsEditMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsEditMatch[1] ?? '');
          const body = await safeJson(req);
          const relPath = body?.relPath as string | undefined;
          if (!relPath) return j(400, { error: 'relPath required' });
          const res = rooms.openEditableFile(workspaceId, relPath);
          if (!res.ok) {
            const status =
              res.error === 'bad-path' || res.error === 'not-markdown'
                ? 400
                : res.error === 'pinned'
                  ? 409
                  : 404;
            return j(status, res);
          }
          return j(200, { docId: res.docId, meta: metaFor(res.meta) });
        }
        const wsTreeMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
        if (wsTreeMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsTreeMatch[1] ?? '');
          const tree = rooms.buildWorkspaceTree(workspaceId);
          if (tree.tree.children.length === 0) {
            return j(404, { error: 'workspace not found', workspaceId });
          }
          // Same redaction as /files — see redactWorkspaceTreeForVisitor.
          return j(200, visitor ? redactWorkspaceTreeForVisitor(tree) : tree);
        }
        const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
        if (docMatch) {
          const docId = decodeURIComponent(docMatch[1] ?? '');
          const rest = docMatch[2] ?? '';
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          const room = rooms.get(docId);
          if (!room) return j(404, { error: 'doc not found' });
          if (rest === '' && req.method === 'GET') {
            // Doc→task surfacing (§3.12 commit 4): chips for the tasks that
            // reference this doc — directly or via one of its threads.
            // Visitor-safe by construction (§3.3 rule 2); omitted when empty.
            const taskRefs = taskStore.tasksReferencingDoc(docId).map(taskChip);
            // Which hub workspace this doc is attached to, so the doc surface
            // can route voice utterances (§3.8: voice is not board-only).
            // OWNER ONLY: a workspace id is an unguessable URL capability, and
            // a doc-scoped visitor must not learn it from a member doc.
            const hubWs = visitor ? null : taskStore.workspaceOfDoc(docId);
            return j(200, {
              meta: metaFor(room.meta),
              ...(taskRefs.length > 0 ? { tasks: taskRefs } : {}),
              ...(hubWs ? { hubWorkspaceId: hubWs } : {}),
            });
          }
          if (rest === '' && req.method === 'DELETE') {
            const force = url.searchParams.get('force') === 'true';
            const res = rooms.deleteDoc(docId, { force });
            if (res.ok) return j(200, res);
            return j(res.error === 'has-open-threads' ? 409 : 404, res);
          }
          if (rest === 'threads' && req.method === 'GET') {
            const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
            return j(200, {
              threads: rooms
                .listThreads(docId, status ? { status } : undefined)
                .map((t) => withTaskChips(docId, t)),
            });
          }
          // Task-chip resolution (§3.3 rule 2): how a chip inside a doc
          // resolves for a DOC-scoped invite, which never gets the workspace
          // board room. The chip is the visitor-safe shape (id, title,
          // status, assignee) — adding a field to it is a sharing decision.
          if (rest === 'tasks' && req.method === 'GET') {
            return j(200, { docId, tasks: taskStore.tasksReferencingDoc(docId).map(taskChip) });
          }
          const threadIdMatch = rest.match(/^threads\/([^/]+)(\/.*)?$/);
          if (threadIdMatch) {
            const threadId = decodeURIComponent(threadIdMatch[1] ?? '');
            const threadRest = threadIdMatch[2] ?? '';
            if (threadRest === '' && req.method === 'GET') {
              const t = rooms.getThread(docId, threadId);
              return t
                ? j(200, { thread: withTaskChips(docId, t) })
                : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/comments' && req.method === 'POST') {
              const body = await safeJson(req);
              const user = authorFor(body?.author);
              const text = body?.text as string | undefined;
              if (!user || !text) return j(400, { error: 'author + text required' });
              const t = await rooms.postComment(docId, threadId, user, text, undefined, {
                // A share visitor must not be able to spend the API key.
                generate: !visitor,
              });
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/summary' && req.method === 'POST') {
              // On-demand generation. The scheduled path is debounced and
              // fire-and-forget; this one blocks and reports what happened,
              // because an agent asked for it and is waiting.
              if (visitor) return j(403, { error: 'not available to share visitors' });
              const t = rooms.getThread(docId, threadId);
              if (!t) return j(404, { error: 'thread not found' });
              if (!summarizer?.enabled) {
                return j(503, {
                  error: 'summaries disabled',
                  detail: `set LF_SUMMARIES=1 and add a key: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
                });
              }
              // Already summarized as it stands: answer with what is stored
              // rather than paying to regenerate the same two lines. The
              // scheduled path and the backfill both ask this question through
              // `needsCall`; an agent that polls this route was the one caller
              // that could bill on every retry. `force` is the deliberate
              // "that line is wrong, do it again" escape hatch.
              const force = (await safeJson(req))?.force === true;
              if (!force && !needsCall(t, t.summary)) {
                return j(200, { thread: t, summary: t.summary, cached: true });
              }
              const summary = await summarizer.generate(t);
              if (!summary) return j(503, { error: 'generation failed' });
              // Re-read before storing, exactly as the scheduled path does.
              // A reply that landed during the call moves `summaryHash`, so
              // storing this one would (a) report success for a summary
              // `threadLines` will ignore forever, and (b) overwrite a valid
              // summary the scheduled path may have just landed for the NEW
              // state — leaving nothing scheduled to repair it.
              const now = rooms.getThread(docId, threadId);
              if (!now) return j(404, { error: 'thread not found' });
              if (summaryHash(now) !== summary.hash) {
                return j(409, { error: 'thread changed during generation' });
              }
              const updated = rooms.applyThreadSummary(docId, threadId, summary);
              return updated
                ? j(200, { thread: updated, summary })
                : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/resolve' && req.method === 'POST') {
              const body = await safeJson(req);
              const author = authorFor(body?.author);
              // Resolve is a thread change, so it schedules a summary — and a
              // visitor must not be able to spend the API key by clicking it.
              const t = rooms.resolve(docId, threadId, author, { generate: !visitor });
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/reopen' && req.method === 'POST') {
              const body = await safeJson(req);
              const author = authorFor(body?.author);
              const t = rooms.reopen(docId, threadId, author, { generate: !visitor });
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/reanchor' && req.method === 'POST') {
              const body = await safeJson(req);
              const anchor = body?.anchor as Anchor | undefined;
              if (!anchor) return j(400, { error: 'anchor required' });
              const t = rooms.reanchor(docId, threadId, anchor);
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/rewrite_region' && req.method === 'POST') {
              const body = await safeJson(req);
              const replacement = String(body?.replacement ?? '');
              const parseInlineMarks = body?.parseInlineMarks === true;
              if (body?.suggest === true) {
                const author = parseSuggestionAuthor(
                  visitor ? { author: authorFor(body?.author) } : body,
                );
                if (!author) return j(400, { error: 'author required when suggest is true' });
                const res = rooms.createSuggestionForThread(docId, threadId, {
                  replacement,
                  parseInlineMarks,
                  author,
                });
                return res.ok ? j(200, res) : j(409, res);
              }
              const res = rooms.rewriteThreadRegion(docId, threadId, replacement, {
                parseInlineMarks,
              });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (threadRest === '/insert_after' && req.method === 'POST') {
              const body = await safeJson(req);
              const text = String(body?.text ?? '');
              const res = rooms.insertAfterThread(docId, threadId, text);
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (threadRest === '/insert_blocks_after' && req.method === 'POST') {
              const body = await safeJson(req);
              const markdown = String(body?.markdown ?? '');
              const res = rooms.insertBlocksAfterThread(docId, threadId, markdown);
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
          }
          if (rest === 'threads' && req.method === 'POST') {
            const body = await safeJson(req);
            const user = authorFor(body?.author);
            const text = body?.text as string | undefined;
            const anchor = body?.anchor as Anchor | undefined;
            if (!user || !text || !anchor) {
              return j(400, { error: 'author + text + anchor required' });
            }
            const t = await rooms.postComment(docId, null, user, text, anchor, {
              generate: !visitor,
            });
            return t ? j(200, { thread: t }) : j(500, { error: 'could not create thread' });
          }
          if (rest === 'threads/by_find' && req.method === 'POST') {
            const body = await safeJson(req);
            const author = authorFor(body?.author);
            const text = body?.text as string | undefined;
            const find = body?.find ? String(body.find) : '';
            if (!author || !text || find.length === 0) {
              return j(400, { error: 'author + text + find required' });
            }
            const res = await rooms.createThreadByFind(
              docId,
              {
                find,
                contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
                contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
                occurrence:
                  typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
              },
              author,
              text,
              // Visitor-authored text becomes the entire prompt on this route.
              { generate: !visitor },
            );
            return res.ok ? j(200, { thread: res.thread }) : j(409, res);
          }
          if (rest === 'content' && req.method === 'GET') {
            const doc = rooms.getDoc(docId);
            if (!doc) return j(404, { error: 'doc not found' });
            return j(200, doc);
          }
          // Whole-doc rewrite through the live doc — the safe replacement for
          // Write-the-bound-file + reparse_from_disk, which raced the
          // write-back and clobbered (see docs/research/2026-08-03 review).
          if (rest === 'content' && req.method === 'POST') {
            const body = await safeJson(req);
            const markdown = String(body?.markdown ?? '');
            if (markdown.length === 0) return j(400, { error: 'markdown is required' });
            const res = rooms.setDocContent(docId, markdown);
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
          }
          if (rest === 'reparse_from_disk' && req.method === 'POST') {
            const res = rooms.reparseFromDisk(docId);
            return res.ok ? j(200, res) : j(409, res);
          }
          // Diff-review rendering data: the file's text at the BASE commit
          // (the target text is the doc's own content, streamed over Yjs).
          // Computed on demand from the repo; if the worktree has since been
          // cleaned up, baseText comes back null and the client falls back to
          // the full-file view, which needs nothing beyond the ydoc.
          if (rest === 'diff' && req.method === 'GET') {
            const meta = room.meta;
            if (meta.type !== 'diff') return j(400, { error: 'not a diff doc' });
            const { workspaceRoot, diffBase, diffTarget, relPath } = meta;
            const basePath = meta.diffOldPath ?? relPath;
            let baseText: string | null = null;
            let error: string | undefined;
            if (meta.diffStatus === 'added') {
              baseText = '';
            } else if (workspaceRoot && diffBase && basePath) {
              baseText = showFile(workspaceRoot, diffBase, basePath);
              if (baseText === null) error = 'base content unavailable (repo moved or pruned?)';
            } else {
              error = 'diff metadata incomplete';
            }
            return j(200, {
              baseText,
              status: meta.diffStatus,
              oldPath: meta.diffOldPath,
              base: diffBase,
              target: diffTarget,
              additions: meta.diffAdditions,
              deletions: meta.diffDeletions,
              ...(error ? { error } : {}),
            });
          }
          // Browser-originated reading activity (read_session / doc_open). The
          // markdown/code review surfaces POST interaction-bounded reading
          // sessions here; the server resolves doc/repo/producedBy and stamps
          // actor=person. Unknown types are ignored (400). See activity.ts.
          if (rest === 'activity' && req.method === 'POST') {
            const body = await safeJson(req);
            const type = body?.type as 'read_session' | 'doc_open' | undefined;
            if (type !== 'read_session' && type !== 'doc_open') {
              return j(400, { error: 'type must be read_session or doc_open' });
            }
            const payload = (body?.payload as Record<string, unknown> | undefined) ?? {};
            // Never DEFAULT to Bryan. This endpoint is in a share visitor's
            // scope, so an omitted author used to record their reading
            // activity as his — the one identity on the server that carries
            // any weight. An unattributed read is now unattributed.
            const author = authorFor(body?.author) ?? ANONYMOUS_ACTOR;
            const res = rooms.recordReadEvent(docId, type, payload, author);
            return res.ok ? j(200, { ok: true }) : j(404, res);
          }
          if (rest === 'agent_anchors' && req.method === 'POST') {
            const body = await safeJson(req);
            const find = String(body?.find ?? '');
            if (find.length === 0) return j(400, { error: 'find is required' });
            const res = rooms.createAgentAnchor(docId, {
              find,
              contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
              contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
              occurrence: typeof body?.occurrence === 'number' ? body.occurrence : undefined,
              label: body?.label ? String(body.label) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          const anchorMatch = rest.match(/^agent_anchors\/([^/]+)(\/.*)?$/);
          if (anchorMatch) {
            const anchorId = decodeURIComponent(anchorMatch[1] ?? '');
            const anchorRest = anchorMatch[2] ?? '';
            if (anchorRest === '/edit' && req.method === 'POST') {
              const body = await safeJson(req);
              const kind = body?.kind as 'replace' | 'insert_after' | undefined;
              const text = String(body?.text ?? '');
              if (kind !== 'replace' && kind !== 'insert_after') {
                return j(400, { error: 'kind must be replace or insert_after' });
              }
              const res = rooms.editAtAgentAnchor(docId, anchorId, { kind, text });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (anchorRest === '/insert_blocks' && req.method === 'POST') {
              const body = await safeJson(req);
              const markdown = String(body?.markdown ?? '');
              if (markdown.length === 0) return j(400, { error: 'markdown is required' });
              const res = rooms.insertBlocksAtAnchor(docId, anchorId, markdown);
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (anchorRest === '' && req.method === 'DELETE') {
              const removed = rooms.deleteAgentAnchor(docId, anchorId);
              return removed ? j(200, { ok: true }) : j(404, { error: 'anchor not found' });
            }
          }
          if (rest === 'find_and_replace' && req.method === 'POST') {
            const body = await safeJson(req);
            const find = String(body?.find ?? '');
            const replace = String(body?.replace ?? '');
            if (find.length === 0) return j(400, { error: 'find is required' });
            const contextBefore = body?.contextBefore ? String(body.contextBefore) : undefined;
            const contextAfter = body?.contextAfter ? String(body.contextAfter) : undefined;
            const occurrence =
              typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined;
            if (body?.suggest === true) {
              const author = parseSuggestionAuthor(
                visitor ? { author: authorFor(body?.author) } : body,
              );
              if (!author) return j(400, { error: 'author required when suggest is true' });
              const res = rooms.createSuggestion(docId, {
                find,
                replace,
                contextBefore,
                contextAfter,
                occurrence,
                parseInlineMarks: body?.parseInlineMarks === true,
                author,
              });
              return res.ok ? j(200, res) : j(409, res);
            }
            const res = rooms.findAndReplace(docId, {
              find,
              replace,
              contextBefore,
              contextAfter,
              occurrence,
              parseInlineMarks: body?.parseInlineMarks === true,
            });
            // Piggy-back any pending sync trouble on the response: agents act
            // on edit results, not on get_doc, so this is where a conflict
            // actually gets seen.
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
          }
          // Suggested edits (redline-suggestions phase 2, commit 3): list/
          // accept/reject/resolve-all over the doc's pending proposals. See
          // `suggest: true` on find_and_replace / rewrite_region above for
          // creation.
          if (rest === 'suggestions' && req.method === 'GET') {
            return j(200, { suggestions: rooms.listSuggestions(docId) });
          }
          if (rest === 'suggestions/resolve_all' && req.method === 'POST') {
            const body = await safeJson(req);
            const action = body?.action as 'accept' | 'reject' | undefined;
            if (action !== 'accept' && action !== 'reject') {
              return j(400, { error: 'action must be accept or reject' });
            }
            const authorId = body?.authorId ? String(body.authorId) : undefined;
            const res = rooms.resolveAllSuggestions(docId, { action, authorId });
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
          }
          const suggestionMatch = rest.match(/^suggestions\/([^/]+)\/(accept|reject)$/);
          if (suggestionMatch && req.method === 'POST') {
            const sid = decodeURIComponent(suggestionMatch[1] ?? '');
            const action = suggestionMatch[2];
            const res =
              action === 'accept'
                ? rooms.acceptSuggestion(docId, sid)
                : rooms.rejectSuggestion(docId, sid);
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
          }
          if (rest === 'delete_block_at_anchor' && req.method === 'POST') {
            const body = await safeJson(req);
            const threadId = body?.threadId ? String(body.threadId) : undefined;
            const anchorId = body?.anchorId ? String(body.anchorId) : undefined;
            if ((threadId && anchorId) || (!threadId && !anchorId)) {
              return j(400, { error: 'exactly one of threadId or anchorId required' });
            }
            const res = threadId
              ? rooms.deleteBlockAtThread(docId, threadId)
              : rooms.deleteBlockAtAgentAnchor(docId, anchorId!);
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'delete_blocks_in_range' && req.method === 'POST') {
            const body = await safeJson(req);
            const startFind = String(body?.startFind ?? '');
            const endFind = String(body?.endFind ?? '');
            if (startFind.length === 0 || endFind.length === 0) {
              return j(400, { error: 'startFind and endFind are required' });
            }
            const res = rooms.deleteBlocksInRange(docId, {
              startFind,
              endFind,
              contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
              contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
              startOccurrence:
                typeof body?.startOccurrence === 'number'
                  ? Number(body.startOccurrence)
                  : undefined,
              endOccurrence:
                typeof body?.endOccurrence === 'number' ? Number(body.endOccurrence) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'delete_section' && req.method === 'POST') {
            const body = await safeJson(req);
            const heading = String(body?.heading ?? '');
            if (heading.length === 0) return j(400, { error: 'heading is required' });
            const res = rooms.deleteSection(docId, {
              heading,
              level: typeof body?.level === 'number' ? Number(body.level) : undefined,
              occurrence:
                typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'hooks/fire' && req.method === 'POST') {
            // debug-fires the last thread update again
            const ts = rooms.listThreads(docId);
            if (ts.length === 0) return j(404, { error: 'no threads' });
            const last = ts[ts.length - 1]!;
            if (room.webhookUrl) {
              await webhooks.send(room.webhookUrl, {
                event: 'thread.replied',
                docId,
                threadId: last.id,
                thread: last,
                doc: withReviewUrl(room.meta),
                seq: ++room.seq,
              });
            }
            return j(200, { fired: !!room.webhookUrl });
          }
        }

        // --- Web log ---
        if (pathname === '/api/webhooks/log') {
          return j(200, { log: webhookLog.slice(-100) });
        }

        // --- Static: widget ---
        if (widgetDist && pathname.startsWith('/widget/')) {
          const p = join(widgetDist, pathname.slice('/widget/'.length));
          // serveStaticUnder, like /app/ and /demos/ — this was the one static
          // root built from the request path that skipped the containment
          // check. Inert today (URL normalizes `..` before we see it, and we
          // never decode the remainder), but /widget/ is on the SHARE
          // visitor's allowlist, so it is the last of the three that should
          // be relying on that.
          const resp = serveStaticUnder(widgetDist, p);
          if (resp) return resp;
        }
        if (
          widgetDist &&
          (pathname === '/widget.js' ||
            pathname === '/widget.iife.js' ||
            pathname === '/widget.esm.js')
        ) {
          const map: Record<string, string> = {
            '/widget.js': 'widget.esm.js',
            '/widget.esm.js': 'widget.esm.js',
            '/widget.iife.js': 'widget.iife.js',
          };
          const file = map[pathname]!;
          const p = join(widgetDist, file);
          const resp = serveStatic(p);
          if (resp) return resp;
        }

        // --- Workspace hub (plan §3.9/§3.10: /workspaces/:workspaceId) ---
        // The shell is server-rendered (like the landing page) so the route
        // works — and 404s crisply — whether or not the app bundle has been
        // built; the page's behavior all lives in /app/hub.js.
        const hubPageMatch = pathname.match(/^\/workspaces\/([^/]+)$/);
        if (hubPageMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(hubPageMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) {
            return new Response(renderHubNotFound(workspaceId), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response(renderHubShell(workspace.id, workspace.name), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        // --- Markdown app (surface 1) ---
        if (markdownAppDist && pathname.startsWith('/review/')) {
          const docId = decodeURIComponent(pathname.slice('/review/'.length));
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          // Markdown docs are file-backed and must be created upfront via
          // POST /api/docs with sourceUrl. Navigating here before the
          // agent has done that gets a clean 404 — the markdown app
          // can't render anything useful for a doc that doesn't exist.
          if (!rooms.get(docId)) {
            return new Response(renderReviewNotFound(docId), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          // Device-frame simulation: when ?mobile=<preset> is on the URL,
          // return an HTML shell that hosts the real page in an iframe sized
          // to the preset's viewport. Media queries inside the iframe see
          // the small width correctly.
          const mobilePreset = url.searchParams.get('mobile');
          if (mobilePreset) {
            return new Response(renderDeviceFrame(mobilePreset, url), {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          const p = join(markdownAppDist, 'index.html');
          const resp = serveStatic(p);
          if (resp) return resp;
        }
        if (markdownAppDist && pathname.startsWith('/app/')) {
          const p = join(markdownAppDist, pathname.slice('/app/'.length));
          const resp = serveStaticUnder(markdownAppDist, p);
          if (resp) return resp;
        }

        // --- Mockup HTML — bound to a docId via bind_mock / POST /api/docs
        //     with type='mockup'. Reads the file at the room's sourceUrl
        //     (any absolute path on disk) and streams it as text/html. The
        //     pre-bind_mock workflow required symlinking each new HTML
        //     into <plugin-repo>/demos/ — `/mockup/<docId>` replaces that
        //     dance and matches the contract of `/review/<docId>` for
        //     markdown docs: one MCP call, one URL, no filesystem juggling.
        //     Single-file mockups only — assets the HTML references via
        //     relative paths won't resolve since we don't serve the source
        //     directory. Use the existing /demos/ multi-page path for
        //     mockups that ship with sibling files.
        if (pathname.startsWith('/mockup/')) {
          const slug = decodeURIComponent(pathname.slice('/mockup/'.length));
          // Tolerate `/mockup/<docId>.html` AND `/mockup/<docId>` — agents
          // share whichever URL feels natural.
          const docId = slug.replace(/\.html?$/i, '');
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          const room = rooms.get(docId);
          if (!room || room.meta.type !== 'mockup' || !room.meta.sourceUrl) {
            return new Response(renderMockupNotFound(docId), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          const resp = serveStatic(room.meta.sourceUrl);
          if (resp) return resp;
          return new Response(renderMockupNotFound(docId), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        // --- Demos ---
        if (demosDir && pathname.startsWith('/demos/')) {
          let p = join(demosDir, pathname.slice('/demos/'.length));
          if (!extname(p)) p = join(p, 'index.html');
          const resp = serveStaticUnder(demosDir, p);
          if (resp) return resp;
        }

        // --- Landing ---
        if (pathname === '/') {
          return new Response(renderLanding(buildLandingModel(rooms, withReviewUrl)), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        return new Response('not found', { status: 404 });
      }
    },
    websocket: {
      open(ws) {
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) {
          ws.close(1008, 'no room');
          return;
        }
        onOpen(room, typed);
      },
      message(ws, message) {
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) return;
        let data: Uint8Array;
        if (typeof message === 'string') {
          data = new TextEncoder().encode(message);
        } else {
          // Bun's Buffer extends Uint8Array; copy to plain Uint8Array for y-protocols
          const buf = message as unknown as ArrayBufferView;
          data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        onMessage(room, typed, data);
      },
      close(ws) {
        onClose(ws as unknown as FeedbackWs);
      },
    },
  });

  // Decorate doc metadata with a `reviewUrl` that's actually reachable from
  // other devices on the tailnet / LAN. Markdown docs render at /review/...;
  // mockup docs bound to a file on disk render at /mockup/<docId> — same
  // one-call-one-URL contract as markdown. Mockup docs without a sourceUrl
  // (e.g. dev-server surfaces hosted elsewhere) get no URL — there's nothing
  // for us to serve.
  function withReviewUrl<T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ): T & { reviewUrl?: string } {
    const base = publicBaseUrl(server.port ?? port);
    if (contentKind(meta.type) !== 'none') {
      // Every doc kind with LF-held content (markdown/code/diff) shares the
      // SPA route; the app branches the editor on the doc's type at boot.
      return { ...meta, reviewUrl: `${base}/review/${encodeURIComponent(meta.docId)}` };
    }
    if (meta.type === 'mockup' && meta.sourceUrl) {
      return { ...meta, reviewUrl: `${base}/mockup/${encodeURIComponent(meta.docId)}` };
    }
    return meta;
  }

  // A share can also lapse without anyone revoking it. Revocation hangs up
  // immediately (see DELETE /api/share/:id); expiry has no such moment, so
  // sweep. 60s means a lapsed visitor keeps their socket for at most a
  // minute — HTTP already refuses them the whole time, so nothing new is
  // reachable, they just haven't been hung up on yet.
  const SHARE_SWEEP_MS = 60_000;
  /** Exactly what the interval does, named so tests drive the real thing
   *  rather than a re-implementation of it. */
  const sweepDeadShares = (): void => {
    if (!shares) return;
    const isLive = (id: string) => shares.findLive(id) !== null;
    rooms.closeSocketsForDeadShares(isLive);
    // Websockets aren't the only long-lived grant — an SSE stream is
    // authorized once at open too, and would otherwise keep delivering
    // comments to a visitor whose share has lapsed.
    sse.closeForDeadShares(isLive);
  };
  const shareSweep = shares
    ? setInterval(() => {
        try {
          sweepDeadShares();
        } catch {
          // A sweep failure must never take the server down with it.
        }
      }, SHARE_SWEEP_MS)
    : null;
  // Never hold the process (or a test runner) open.
  shareSweep?.unref?.();

  return {
    port: server.port ?? port,
    rooms,
    tasks: taskStore,
    projection: taskProjection,
    shares,
    sweepDeadShares,
    sharingGate,
    webhookLog,
    stop: async () => {
      if (shareSweep) clearInterval(shareSweep);
      uptimeMonitor.stop();
      // Flush pending body snapshots into the store BEFORE the store's own
      // flush, so the last keystrokes in a task body reach the sidecar.
      taskProjection.stop();
      // Flush pending sidecar writes so a clean shutdown never loses board
      // state that was still inside the debounce window.
      taskStore.stop();
      server.stop();
    },
  };
}

function isValidDocId(s: string): boolean {
  // Allow a reasonable set of URL-safe chars. Disallow leading dot so IDs
  // can't masquerade as hidden files on disk. Length cap protects the
  // filename from being pathological. `~` is permitted because workspace
  // member docIds encode the relPath's `/` separators as `~`
  // (`${workspaceId}:${relPath.replaceAll('/', '~')}` in rooms.ts), so any
  // file in a subdirectory of a bound folder needs `~` to be reachable via
  // the /api/docs/:docId routes. `~` is RFC 3986 unreserved (URL-safe) and a
  // valid filename char, matching the .ydoc-on-disk naming.
  if (!s || s.startsWith('.')) return false;
  return /^[a-zA-Z0-9_.:~\-]{1,100}$/.test(s);
}

/** `scheme://host` with the default port normalized away, or the raw
 *  concatenation when it doesn't parse (which then simply matches nothing). */
function canonicalOrigin(scheme: string, host: string): string {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return `${scheme}://${host}`;
  }
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // CORS is added by the per-request wrapper in createServer, which knows
    // the Origin. This used to stamp a wildcard `*` origin on every reply.
    headers: { 'content-type': 'application/json' },
  });
}

/** Attach the doc's pending syncError (if any) to a successful edit-tool
 *  response. Agents read edit results, not get_doc — so this is the surface
 *  where a disk↔doc conflict actually reaches whoever can fix it. */
function withSyncError(rooms: Rooms, docId: string, body: object): object {
  const syncError = rooms.getSyncError(docId);
  return syncError ? { ...body, syncError } : body;
}

/** Parse a `suggest: true` request body's `author` field into a
 *  SuggestionAuthor. Requires `id` + `name`; `color` defaults so a caller
 *  that omits it (unlikely — MCP always sends the full identity) still
 *  produces an attributable proposal instead of a 400. */
function parseSuggestionAuthor(
  body: Record<string, unknown> | null,
): suggestOps.SuggestionAuthor | null {
  const a = body?.author as { id?: unknown; name?: unknown; color?: unknown } | undefined;
  if (!a || typeof a.id !== 'string' || a.id.length === 0) return null;
  if (typeof a.name !== 'string' || a.name.length === 0) return null;
  return { id: a.id, name: a.name, color: typeof a.color === 'string' ? a.color : '#888888' };
}

// The canonical embed loads the widget bundle from this server but runs the
// host page on a different origin (e.g. an Astro dev server on a different
// port). Every REST call from the widget is therefore cross-origin and needs
// CORS. The widget posts comments without credentials (auth is via the
// request body's `author` field, not cookies), so `*` is safe and avoids
// the per-request-Origin echo dance.
async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Serve a file only if it really sits under `root`.
 *
 * `/app/*` and `/demos/*` build their path out of the request URL. Today
 * that is safe by accident rather than by design — `new URL()` collapses
 * `..` segments before we ever see the pathname — but nothing in this file
 * says so, and one future caller that decodes or rewrites a path would turn
 * a static route into an arbitrary-file read on a host that is now publicly
 * reachable. Assert the containment where the read happens.
 */
export function serveStaticUnder(root: string, p: string): Response | null {
  // isWithinRoot realpaths both sides: `path.resolve` is purely LEXICAL, so a
  // symlink inside the root pointing anywhere on disk sails straight through a
  // string-prefix check. `demos/` in particular is a directory of Bryan's own
  // files, where a convenience symlink is entirely plausible. It answers
  // closed for a missing file or a dangling link — nothing to serve either way.
  if (!isWithinRoot(root, p)) return null;
  return serveStatic(p);
}

function serveStatic(p: string): Response | null {
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const ct = CT[extname(p).toLowerCase()] ?? 'application/octet-stream';
  return new Response(buf, { headers: { 'content-type': ct, 'cache-control': 'no-cache' } });
}

function renderMockupNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Mockup not found · Live Feedback</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Mockup not found</h1>
<p>No mockup is bound to <code>${safe}</code>, or its source file isn't readable.
Mockups are bound by an agent calling <code>bind_mock</code> with an absolute path
to an HTML file. Once bound, the file is served here without any symlink dance.</p>
<p>Ask the agent who shared this URL to call <code>bind_mock(docId, sourceHtmlPath)</code>, then refresh.</p>`;
}

/**
 * Shown when a share link doesn't resolve. Says nothing about WHY — unknown,
 * expired, and malformed all render the same page, so the endpoint can't be
 * used to probe which slugs exist.
 */
function renderLinkNotFound(): string {
  return `<!doctype html><meta charset="utf-8"><title>Link not available</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#222}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>
<h1>This link isn't available</h1>
<p>It may have expired or been revoked. Ask whoever shared it for a new one.</p>`;
}

/**
 * The hub page shell (§3.9). Tab title is `<workspace> · Workspace Hub` —
 * the browser tab is a workspace switcher. Everything dynamic renders
 * client-side from the ws:<id> ydoc projection + REST; the shell only names
 * the workspace and loads the bundle.
 */
function renderHubShell(workspaceId: string, name: string): string {
  const safeName = escape(name);
  const safeId = escape(workspaceId);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
    <title>${safeName} · Workspace Hub</title>
    <link rel="stylesheet" href="/app/styles.css" />
  </head>
  <body class="hub-body">
    <div id="hub-root" data-workspace-id="${safeId}"></div>
    <script type="module" src="/app/hub.js"></script>
  </body>
</html>`;
}

function renderHubNotFound(workspaceId: string): string {
  const safe = escape(workspaceId);
  return `<!doctype html><meta charset="utf-8"><title>Workspace not found · Live Feedback</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Workspace not found</h1>
<p>No hub workspace exists for <code>${safe}</code>. Hub workspaces are
created by an agent calling <code>create_workspace</code> (or
<code>POST /api/workspaces</code> with a name).</p>
<p><small><a href="/">all docs</a></small></p>`;
}

function renderReviewNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Doc not found · Live Feedback</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Doc not found</h1>
<p>No review doc exists for <code>${safe}</code>. Markdown review docs are
created by an agent calling <code>POST /api/docs</code> with a
<code>sourceUrl</code> pointing at a markdown file on disk.</p>
<p>Ask the agent who shared this URL to create the doc, then refresh this page.</p>
<p><small><a href="/">all docs</a></small></p>`;
}

// --- Landing page: project → artifacts model ---
//
// The landing page answers "what does this project have under review, and what
// needs my attention?". It groups by PROJECT (the creating agent's cwd =
// doc.owner; 'ungrouped' when absent), and within a project lists ARTIFACTS.
// An artifact is one of:
//   - a workspace (bound folder/worktree; docs sharing a workspaceId) →
//     one expandable row with a rolled-up open-count badge and a nested file
//     list, each file linking to its reviewUrl
//   - a single markdown file, a code file, a mockup, or a dev server
// Each artifact carries its open-comment count and a kind glyph/label.

type ArtifactKind = 'workspace' | 'markdown' | 'code' | 'diff' | 'mockup';

interface LandingFile {
  name: string;
  reviewUrl?: string;
  openCount: number;
}

interface LandingArtifact {
  kind: ArtifactKind;
  /** Display name (file basename, workspace title, or docId fallback). */
  name: string;
  /** docId for standalone artifacts; workspaceId for workspaces. */
  id: string;
  reviewUrl?: string;
  openCount: number;
  threadCount: number;
  lastActivity: number;
  /** Nested file list (workspace artifacts only). */
  files?: LandingFile[];
}

interface LandingProject {
  /** Project key = creating agent's cwd, or 'ungrouped'. */
  owner: string;
  totalOpen: number;
  artifacts: LandingArtifact[];
}

interface LandingModel {
  projects: LandingProject[];
  totalArtifacts: number;
  totalOpen: number;
}

// Glyph + human label per artifact kind. The glyph keeps the kinds visually
// distinct at a glance; the label disambiguates for screen readers / clarity.
const ARTIFACT_KIND: Record<ArtifactKind, { glyph: string; label: string }> = {
  workspace: { glyph: '📁', label: 'folder' },
  markdown: { glyph: '📄', label: 'markdown' },
  code: { glyph: '⟨⟩', label: 'code' },
  diff: { glyph: '±', label: 'diff' },
  mockup: { glyph: '🖼', label: 'mockup' },
};

function flattenTreeFileNodes(node: WorkspaceDirNode | WorkspaceFileNode): WorkspaceFileNode[] {
  if (node.type === 'file') return [node];
  return node.children.flatMap(flattenTreeFileNodes);
}

/** Flatten a workspace tree into a sorted file list for the landing nesting. */
function flattenWorkspaceFiles(node: WorkspaceDirNode | WorkspaceFileNode): LandingFile[] {
  if (node.type === 'file') {
    return [{ name: node.relPath, reviewUrl: node.reviewUrl, openCount: node.openCount }];
  }
  return node.children.flatMap(flattenWorkspaceFiles);
}

/**
 * Build the project → artifacts model from the live rooms. Pure data shaping —
 * all HTML lives in `renderLanding`. Exported-shape via the route only.
 */
function buildLandingModel(
  rooms: Rooms,
  decorate: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string },
): LandingModel {
  // workspaceId → accumulating workspace artifact (filled from buildWorkspaceTree).
  const workspaceArtifacts = new Map<string, LandingArtifact>();
  // owner → its standalone + workspace artifacts.
  const projects = new Map<string, LandingProject>();

  const ensureProject = (owner: string): LandingProject => {
    let p = projects.get(owner);
    if (!p) {
      p = { owner, totalOpen: 0, artifacts: [] };
      projects.set(owner, p);
    }
    return p;
  };

  for (const meta of rooms.list()) {
    const threads = rooms.listThreads(meta.docId);
    const openCount = threads.filter((t) => t.status === 'open').length;
    const lastActivity = Math.max(
      meta.lastActivityAt ?? 0,
      threads.reduce((max, t) => Math.max(max, t.lastActivity), 0),
    );
    const owner = meta.owner || 'ungrouped';

    if (meta.workspaceId) {
      // Workspace member — fold into (or create) the workspace artifact. The
      // per-file detail comes from buildWorkspaceTree; here we just track the
      // owner/lastActivity rollup and ensure the artifact is registered.
      let art = workspaceArtifacts.get(meta.workspaceId);
      if (!art) {
        const tree = rooms.buildWorkspaceTree(meta.workspaceId);
        const files = flattenWorkspaceFiles(tree.tree);
        // Clicking the workspace opens its entry file directly (the
        // biggest change for a diff review, first file otherwise);
        // expansion is a separate affordance in the renderer.
        const treeFiles = flattenTreeFileNodes(tree.tree);
        const entry = treeFiles.reduce(
          (best, f) =>
            (f.diffAdditions ?? 0) + (f.diffDeletions ?? 0) >
            (best?.diffAdditions ?? 0) + (best?.diffDeletions ?? 0)
              ? f
              : best,
          treeFiles[0],
        );
        art = {
          kind: 'workspace',
          name: meta.workspaceId,
          id: meta.workspaceId,
          reviewUrl: entry?.reviewUrl,
          openCount: tree.totalOpen,
          threadCount: 0,
          lastActivity: 0,
          files,
        };
        workspaceArtifacts.set(meta.workspaceId, art);
        ensureProject(owner).artifacts.push(art);
      }
      // A diff member marks the whole workspace as a diff review (members
      // can also include plain 'code' context docs — any diff doc wins).
      if (meta.type === 'diff') art.kind = 'diff';
      art.threadCount += threads.length;
      if (lastActivity > art.lastActivity) art.lastActivity = lastActivity;
      continue;
    }

    // Standalone artifact (single file / mockup / dev).
    const decorated = decorate(meta);
    const kind = (meta.type as ArtifactKind) ?? 'markdown';
    const name = meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId;
    ensureProject(owner).artifacts.push({
      kind,
      name,
      id: meta.docId,
      reviewUrl: decorated.reviewUrl,
      openCount,
      threadCount: threads.length,
      lastActivity,
    });
  }

  // Sort artifacts within each project, then projects by total open desc.
  const projectList = Array.from(projects.values());
  for (const p of projectList) {
    p.totalOpen = p.artifacts.reduce((sum, a) => sum + a.openCount, 0);
    p.artifacts.sort((a, b) => {
      if (a.openCount !== b.openCount) return b.openCount - a.openCount;
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
      return a.name.localeCompare(b.name);
    });
  }
  projectList.sort((a, b) => {
    if (a.totalOpen !== b.totalOpen) return b.totalOpen - a.totalOpen;
    return a.owner.localeCompare(b.owner);
  });

  const totalArtifacts = projectList.reduce((sum, p) => sum + p.artifacts.length, 0);
  const totalOpen = projectList.reduce((sum, p) => sum + p.totalOpen, 0);
  return { projects: projectList, totalArtifacts, totalOpen };
}

function basenameOf(p: string): string {
  let s = p;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const m = s.match(/[^/\\]+$/);
  return m ? m[0] : s;
}

/** Display label for a project owner (cwd) — its basename, or the raw key. */
function projectLabel(owner: string): string {
  if (owner === 'ungrouped') return 'Ungrouped';
  return basenameOf(owner) || owner;
}

function renderLandingFile(f: LandingFile): string {
  const link = f.reviewUrl
    ? `<a href="${escape(f.reviewUrl)}">${escape(f.name)}</a>`
    : escape(f.name);
  const badge = f.openCount > 0 ? `<span class="badge badge-open">${f.openCount} open</span>` : '';
  return `<li class="ws-file"><span class="ws-file-name">${link}</span>${badge}</li>`;
}

function renderLandingArtifact(a: LandingArtifact): string {
  const kind = ARTIFACT_KIND[a.kind];
  const openBadge =
    a.openCount > 0
      ? `<span class="badge badge-open">${a.openCount} open</span>`
      : a.threadCount > 0
        ? `<span class="badge badge-resolved">all resolved</span>`
        : '';
  const kindBadge = `<span class="badge badge-kind">${kind.glyph} ${escape(kind.label)}</span>`;
  const activityLine =
    a.lastActivity > 0
      ? `<div class="meta">last activity ${escape(formatRelative(a.lastActivity))}</div>`
      : '';

  if (a.files) {
    const fileCount = a.files.length;
    const files = a.files.map(renderLandingFile).join('');
    const nameLink = a.reviewUrl
      ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
      : escape(a.name);
    // Clicking the NAME opens the review's entry file; the caret + file
    // count is the (separate) expansion affordance for the nested list.
    return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
      <div class="row">
        <span class="art-glyph">${kind.glyph}</span>
        <span class="art-name">${nameLink}</span>
        <span class="badges">${openBadge}<span class="badge badge-kind">${escape(kind.label)}</span></span>
      </div>
      <details class="ws-details">
        <summary><span class="art-sub">${fileCount} file${fileCount === 1 ? '' : 's'}</span></summary>
        <ul class="ws-files">${files || '<li class="ws-file empty">(no files)</li>'}</ul>
      </details>
      ${activityLine}
    </li>`;
  }

  const link = a.reviewUrl
    ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
    : escape(a.name);
  return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
    <div class="row">
      <span class="art-glyph">${kind.glyph}</span>
      <span class="art-name">${link}</span>
      <span class="badges">${openBadge}${kindBadge}</span>
    </div>
    ${activityLine}
  </li>`;
}

function renderLanding(model: LandingModel): string {
  const projectsHtml = model.projects
    .map((p) => {
      const openBadge =
        p.totalOpen > 0 ? `<span class="badge badge-open">${p.totalOpen} open</span>` : '';
      const arts = p.artifacts.map(renderLandingArtifact).join('');
      return `<section class="project">
        <h2 class="project-head">${escape(projectLabel(p.owner))}${openBadge}</h2>
        <ul class="artifacts">${arts}</ul>
      </section>`;
    })
    .join('');
  const summary =
    model.totalArtifacts === 0
      ? ''
      : `${model.totalArtifacts} artifact${model.totalArtifacts === 1 ? '' : 's'} · ${model.totalOpen} open thread${model.totalOpen === 1 ? '' : 's'}`;
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live Feedback</title>
<style>
body{font:14px/1.5 system-ui, -apple-system, sans-serif;margin:32px auto;max-width:760px;padding:0 16px;color:#1b1f23}
h1{font-size:22px;margin:0 0 4px}
.summary{color:#6e7781;font-size:12px;margin-bottom:20px}
ul{padding:0;list-style:none;margin:0}
.project{margin-bottom:26px}
.project-head{font-size:13px;font-weight:600;color:#57606a;margin:0 0 8px;display:flex;align-items:center;gap:8px;text-transform:none;border-bottom:1px solid #eef0f2;padding-bottom:6px}
li.artifact{padding:10px 0;border-bottom:1px solid #f3f4f6}
li.artifact.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:8px}
.art-glyph{flex-shrink:0;font-size:13px;width:1.4em;text-align:center}
.art-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.art-name a{color:#2e7dd7;text-decoration:none;font-weight:600;font-size:15px}
.art-name a:hover{text-decoration:underline}
.art-sub{color:#8b95a1;font-size:11px;flex-shrink:0}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-kind{background:#f6f8fa;color:#8b95a1}
.meta{color:#8b95a1;font-size:11px;margin-top:3px;padding-left:1.4em}
details > summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'▸';color:#8b95a1;font-size:11px;flex-shrink:0}
details[open] > summary::before{content:'▾'}
.ws-files{margin:6px 0 0 1.8em;border-left:1px solid #eef0f2;padding-left:10px}
.ws-file{display:flex;align-items:baseline;gap:8px;padding:3px 0}
.ws-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ws-file-name a{color:#2e7dd7;text-decoration:none}
.ws-file-name a:hover{text-decoration:underline}
.ws-file.empty{color:#8b95a1;font-style:italic}
.empty{color:#6e7781;padding:24px 0;text-align:center;font-style:italic}
footer{margin-top:24px;color:#8b95a1;font-size:11px}
</style>
<h1>Live Feedback</h1>
<div class="summary">${summary}</div>
${projectsHtml || '<div class="empty">No docs yet — POST /api/docs to create one.</div>'}
<footer>POST /api/docs · /widget.iife.js · /demos/mockup</footer>`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Viewport presets for ?mobile=<preset>. CSS px sizes (logical).
const DEVICE_PRESETS: Record<string, { w: number; h: number; label: string }> = {
  iphone16pm: { w: 440, h: 956, label: 'iPhone 16 Pro Max' },
  iphone16: { w: 393, h: 852, label: 'iPhone 16' },
  iphone15: { w: 393, h: 852, label: 'iPhone 15' },
  iphonese: { w: 375, h: 667, label: 'iPhone SE' },
  pixel8: { w: 412, h: 915, label: 'Pixel 8' },
};

function renderDeviceFrame(presetName: string, url: URL): string {
  const preset = DEVICE_PRESETS[presetName] ?? DEVICE_PRESETS.iphone16pm!;
  // Build the inner URL with the mobile param stripped to avoid recursion
  const innerParams = new URLSearchParams(url.searchParams);
  innerParams.delete('mobile');
  const innerQs = innerParams.toString();
  const innerUrl = `${url.pathname}${innerQs ? `?${innerQs}` : ''}`;
  const asParam = url.searchParams.get('as') ?? 'bryan';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escape(preset.label)} · ${escape(url.pathname)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e2228; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #eee; }
  body { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 8px; box-sizing: border-box; overflow: auto; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #cfd3d9; }
  .bar .label { background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a { color: #8fbfff; text-decoration: none; background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a:hover { background: rgba(0,0,0,0.75); }
  .bar a.current { background: #8fbfff; color: #1e2228; }
  .device {
    width: ${preset.w}px;
    height: ${preset.h}px;
    background: #fff;
    border: 1px solid #3a3e45;
    border-radius: 18px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.45);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .device iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
  }
</style>
</head><body>
<div class="bar">
  <span class="label">${escape(preset.label)} · ${preset.w}×${preset.h}</span>
  <a href="?as=${escape(asParam)}">← exit</a>
  <a class="${presetName === 'iphone16pm' ? 'current' : ''}" href="?mobile=iphone16pm&as=${escape(asParam)}">16 Pro Max</a>
  <a class="${presetName === 'iphone16' ? 'current' : ''}" href="?mobile=iphone16&as=${escape(asParam)}">16</a>
  <a class="${presetName === 'iphonese' ? 'current' : ''}" href="?mobile=iphonese&as=${escape(asParam)}">SE</a>
  <a class="${presetName === 'pixel8' ? 'current' : ''}" href="?mobile=pixel8&as=${escape(asParam)}">Pixel 8</a>
</div>
<div class="device"><iframe src="${escape(innerUrl)}" allow="clipboard-write"></iframe></div>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}
