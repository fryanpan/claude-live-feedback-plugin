import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type User,
  type WebhookPayload,
  anchors,
  contentKind,
  suggestOps,
  summaryHash,
} from '@feedback/core';
import { needsCall } from '@feedback/core/summary-prompt';
import type { Server as BunServer } from 'bun';
import { classifyActor } from './activity.ts';
import { clientReleaseStatus } from './client-release.ts';
import { showFile } from './git-diff.ts';
import {
  type LandingGroupRow,
  type LandingInputDoc,
  type LandingModel,
  type NeedsYouRow,
  buildLandingModel,
} from './landing.ts';
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
import type { PluginRefresher } from './plugin-refresh.ts';
import { agentsBehind, checkableAttachments, readReleasedPluginVersion } from './plugin-release.ts';
import { localHostnames, publicBaseUrl } from './public-host.ts';
import { reviewThreadItems } from './review-queue.ts';
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
import { indexBatchKeys, resolveRowRefs } from './task-batch-refs.ts';
import { type BodyGap, bodyGapMessage, bodyShapeGaps } from './task-body.ts';
import {
  BAD_OPTIONS_ERROR,
  BAD_REF_ERROR,
  parseLinks,
  parseNeeds,
  parseOptions,
  parseTaskCreate,
} from './task-create.ts';
import { applyImport, importBanner, importMarkerFor, parseTrackerMarkdown } from './task-import.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
  ASSIGNEE_REQUIRED_MESSAGE,
  BAD_ASSIGNEE_KIND_ERROR,
  BAD_ASSIGNEE_KIND_MESSAGE,
  parseAssigneeKind,
  resolveAssignee,
} from './task-owner.ts';
import { TaskProjection, taskBodyDocId, taskIdOfBodyDoc } from './task-projection.ts';
import { buildQueue, placeableGoals, summarizeGoals } from './task-queue.ts';
import { type TitleGap, clipToWordBoundary, titleGapMessage } from './task-title.ts';
import {
  type GoalListEntry,
  type Ref,
  type Task,
  type TaskStatus,
  TaskStore,
  eventsLogPath,
  isAttachmentRuntime,
  isValidRef,
  taskChip,
} from './tasks.ts';
import { SERVER_TICK_EVENT, UptimeMonitor, analyzeUptime } from './uptime.ts';
import { type VoiceComplete, VoiceRouter, parseVoiceContext } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

/** Rows one `POST /tasks/batch` will take. A burst out of a conversation is
 *  single digits; a hundred is a tracker, and that has its own import path. */
const MAX_BATCH_TASKS = 100;

/**
 * Structural validation for PUT /api/workspaces/:id/goals. Returns the
 * sanitized list, or null if any entry is malformed. Unknown keys are
 * dropped rather than persisted — the sidecar shape is a contract, not a
 * junk drawer. ONE subgoal level max (§3.2); a subgoal with subgoals is
 * malformed, not silently flattened.
 *
 * `id` is OPTIONAL and that is the create/keep switch (see `GoalListEntry`):
 * omitted means "create this band, mint me an id", present means "the band
 * you already have with this id". A present-but-empty id is still malformed —
 * it is a caller trying to say something, not a caller omitting the key, and
 * reading it as "create" would turn a bug into a silent new band.
 */
function parseGoalList(raw: unknown): GoalListEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const goals: GoalListEntry[] = [];
  for (const entry of raw) {
    const g = entry as Record<string, unknown>;
    if (g?.id !== undefined && (typeof g.id !== 'string' || g.id.length === 0)) return null;
    if (typeof g?.title !== 'string' || g.title.length === 0) return null;
    if (g.dueAt !== undefined && typeof g.dueAt !== 'number') return null;
    let subgoals: Array<{ id?: string; title: string; dueAt?: number }> | undefined;
    if (g.subgoals !== undefined) {
      if (!Array.isArray(g.subgoals)) return null;
      subgoals = [];
      for (const sub of g.subgoals) {
        const s = sub as Record<string, unknown>;
        if (s?.id !== undefined && (typeof s.id !== 'string' || s.id.length === 0)) return null;
        if (typeof s?.title !== 'string' || s.title.length === 0) return null;
        if (s.dueAt !== undefined && typeof s.dueAt !== 'number') return null;
        if (s.subgoals !== undefined) return null;
        subgoals.push({
          ...(s.id !== undefined ? { id: s.id as string } : {}),
          title: s.title,
          ...(s.dueAt !== undefined ? { dueAt: s.dueAt as number } : {}),
        });
      }
    }
    goals.push({
      ...(g.id !== undefined ? { id: g.id as string } : {}),
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt as number } : {}),
      ...(subgoals !== undefined ? { subgoals } : {}),
    });
  }
  return goals;
}

/**
 * The one doc every hub's feedback widget writes to.
 *
 * Deliberately NOT per-workspace: a comment on the hub UI is about the
 * product, so it should reach the same agent from every hub rather than
 * whoever happens to own the workspace you were standing in. The anchor's
 * url carries which hub it came from.
 */
export const HUB_FEEDBACK_DOC_ID = 'lf-hub-feedback';

/** The anchor's display snippet, whichever anchor kind carries it — an
 *  orphan keeps its original's snippet. */
function anchorSnippetText(anchor: Anchor): string | undefined {
  if (anchor.kind === 'subject') return undefined;
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
  /**
   * Runs `claude plugin update` on this machine when a peer asks. Absent by
   * default and constructed in ONE place (bin.ts), so nothing that merely
   * spins a server up — every test, every embedded use — can mutate this
   * machine's plugin cache. Same seam rule as `summarizer`; here it also
   * means a CI run can never trigger a deploy.
   */
  pluginRefresher?: PluginRefresher;
  /**
   * The client release root this deployment publishes into (see
   * client-release.ts), enabling the "your browser is running an old client"
   * signal on the board.
   *
   * Set in ONE place — scripts/serve.ts --no-watch, via bin.ts — because only
   * the process that PUBLISHES a release may report on it. `bun run dev` and
   * `bun run staging` serve their own checkout's dist while sharing this
   * machine's default release root, so reading it there would report prod's
   * deploy state on a server that is not serving prod's client. Same seam
   * rule as `pluginRefresher`.
   */
  clientReleaseRootDir?: string | null;
  /**
   * How far a description may lag the newest note on its task before the
   * work queue says so (see task-staleness.ts). Defaults to
   * `PREMISE_STALE_AFTER_MS`.
   *
   * Overridable because the arming rule is a comparison against wall-clock
   * gaps of DAYS, and a test cannot wait for one: the alternative is
   * backdating a task through a route built for it, which would add a
   * production surface whose only caller is a test.
   */
  premiseStaleAfterMs?: number;
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
   * The external base URL this deployment is reached on, when something in
   * front terminates TLS (`tailscale serve` → this process on loopback).
   * Already normalized — bin.ts runs `normalizePublicBaseUrl` on
   * `LF_PUBLIC_BASE_URL` at boot so a typo fails there rather than here.
   *
   * Every human-facing URL the server emits (`reviewUrl`, `entryUrl`, the
   * import banner's `hubUrl`) is built from this when set. Unset — the
   * default, and every test that doesn't care — falls back to
   * `http://<discovered host>:<port>`, which is what a server with nothing
   * in front of it is actually reachable on.
   */
  publicBaseUrl?: string;
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
  const clientReleaseRootDir = opts.clientReleaseRootDir ?? null;
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
    return { docId: share.docId, workspaceId: share.workspaceId };
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
  const pluginRefresher = opts.pluginRefresher ?? null;
  // Late-bound because Rooms is constructed before the task store and the
  // projection it needs. Nothing can fire through it until a room exists,
  // which is after both.
  let onTaskBodyEvent: ((docId: string, payload: WebhookPayload) => void) | null = null;
  const rooms = new Rooms({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: withReviewUrl,
    onRoomEvent: (docId, payload) => onTaskBodyEvent?.(docId, payload),
    ...(summarizer ? { summarizer } : {}),
  });
  // Materialize the shared hub-feedback doc at startup rather than letting
  // the first widget connection conjure it. A room created by a `/y/<id>`
  // connect has no title and no type, so it reads as a ghost in list_docs —
  // and this one is meant to be found and watched by an agent that never
  // visited a hub.
  rooms.getOrCreate(HUB_FEEDBACK_DOC_ID, {
    type: 'mockup',
    title: 'Hub feedback (all workspaces)',
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
  //
  // A goal-retriage is addressed to the workspace's LEAD agent specifically:
  // it asks someone to re-place the whole board against a new north star,
  // and "whoever happened to be connected" is how that request reached
  // nobody accountable. A task placement stays any-live-agent — a new task
  // can be placed by whoever is home. Undelivered goal-retriages are not
  // lost either way; the store persists them for the lead's next attach.
  taskStore.setTriageDelivery((req) => {
    const live =
      req.kind === 'goal-retriage'
        ? taskStore.hasLiveLeadAttachment(req.workspaceId)
        : taskStore.hasLiveAttachment(req.workspaceId);
    if (!live) return false;
    // The WHOLE request goes on the wire, deliberately: the MCP renders its
    // channel line straight off this frame, so a field trimmed here cannot be
    // rendered no matter what the renderer does — and the lead who is HERE
    // would get less than the one who was away and picks the same edit up as
    // `pendingRetriage` on attach. Pinned by a test that reads this frame.
    sse.broadcast(`ws~${req.workspaceId}`, { event: 'triage.requested', ...req });
    return true;
  });
  // The ydoc projection (§3.3): ws:<workspaceId> board rooms the server
  // writes and defends (foreign writes reverted), plus task:<taskId> body
  // rooms. init() runs after both stores hydrated, so the sidecar is
  // authoritative for gated fields on restart.
  const taskProjection = new TaskProjection({ rooms, tasks: taskStore });
  taskProjection.init();
  // A task's discussion lives in its body room, but an agent working a board
  // watches the WORKSPACE channel, not each task's doc — so a comment that
  // only fans out on the doc's own stream reaches nobody who is working. The
  // same event also moves the row's comment count, which nothing else would
  // refresh (the store never changes, so no task.* event fires).
  onTaskBodyEvent = (docId, payload) => {
    const taskId = taskIdOfBodyDoc(docId);
    if (!taskId) return;
    const workspaceId = taskStore.getTask(taskId)?.workspaceId;
    if (!workspaceId) return;
    sse.broadcast(`ws~${workspaceId}`, payload);
    taskProjection.refresh(workspaceId);
  };
  /**
   * Rewrite a task's description through its live `task:<id>` body room, with
   * everything the act owes: the room exists, the snapshot the board and
   * `next_tasks` read is fresh immediately rather than on the debounce, and —
   * when the caller said who it is — an attributed `task.body_edited` row.
   *
   * ONE function because there are TWO routes: `POST /api/tasks/:id/body` and
   * `POST /api/docs/task:<id>/content`. The second one used to reach
   * `rooms.setDocContent` directly and got none of this, which is how a
   * rewrite through `set_doc_content` destroyed a capture with nothing
   * recorded while both the caller and the board saw success.
   *
   * The preservation into `quote` is deliberately NOT here. It lives at
   * `TaskStore.updateBodySnapshot`, the choke point every writer of a body
   * fragment passes through — including `find_and_replace` on the same docId
   * and a person typing on the board, neither of which comes through this
   * function. Putting it here would rebuild the exact gap being closed, one
   * layer up.
   */
  /**
   * The title standard, as an advisory a caller actually receives.
   *
   * Spread onto every response whose act wrote a title, and onto every row
   * the list route returns — because a check nothing renders is not a check.
   * Empty for a title that meets the standard, so a clean row adds no keys and
   * an agent can treat the presence of `titleGaps` as the whole signal.
   *
   * The discussion clause is computed HERE rather than in the store because
   * the comments live in the task's body room, which the store cannot see —
   * the same split that makes `projectTask` take `commentCount` as an
   * argument. `titleWrittenAt ?? createdAt` is the honest fallback for a row
   * filed before the standard existed: nobody has named it since it was
   * created, which is exactly the state being complained about.
   */
  /**
   * The shape advisories a caller gets back on any write that touches a task.
   *
   * Both halves are ADVISORY and neither can refuse: the response carries what
   * is missing, and the write has already landed. Named for the task rather
   * than the title because it now covers the description too — Bryan expanded
   * the standard on 2026-08-17, and a helper still called `titleAdvisory`
   * while returning `bodyGaps` is the kind of drift that makes the next
   * reader trust the name over the code.
   */
  const taskAdvisory = (
    task: Task,
  ): {
    titleGaps?: TitleGap[];
    titleMessage?: string;
    bodyGaps?: BodyGap[];
    bodyMessage?: string;
  } => {
    const since = task.titleWrittenAt ?? task.createdAt;
    const commentsSinceTitle = taskProjection
      .discussionNotes(task.id)
      .filter((n) => n.ts > since).length;
    const gaps = taskStore.titleGapsOf(task, commentsSinceTitle);
    const bGaps = bodyShapeGaps(task.body, task.needs);
    const bMessage = bodyGapMessage(bGaps);
    const bodyPart =
      bGaps.length === 0
        ? {}
        : { bodyGaps: bGaps, ...(bMessage !== undefined ? { bodyMessage: bMessage } : {}) };
    if (gaps.length === 0) return bodyPart;
    const message = titleGapMessage(gaps);
    return {
      titleGaps: gaps,
      ...(message !== undefined ? { titleMessage: message } : {}),
      ...bodyPart,
    };
  };

  const rewriteTaskBody = (
    task: Task,
    markdown: string,
    opts: { actor?: { id: string; name: string; kind?: string }; title?: string },
  ): { ok: true } | { ok: false; error: string } => {
    const docId = taskProjection.ensureBodyRoom(task);
    const res = rooms.setDocContent(docId, markdown);
    if (!res.ok) return res;
    taskProjection.flushBodySnapshot(task.id);
    // Attribution is the one half a route can lack: `POST /api/docs/:id/content`
    // has never required an author, and an audit row naming nobody is worse
    // than the honest absence of one. The words are safe either way — the
    // snapshot flush above has already preserved them.
    if (opts.actor) {
      taskStore.noteBodyEdited(task.id, {
        actor: opts.actor,
        ...(opts.title ? { title: opts.title } : {}),
      });
    }
    return { ok: true };
  };
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
   * Which workspaces an id belongs to, for SHARE SCOPING (§3.12 commit 8).
   * The id may be a doc room OR a grouping (folder bind / diff review), and
   * the answer is a SET because those two senses of "workspace" nest:
   *
   *   1. a member doc's own GROUPING     (`meta.workspaceId`)
   *   2. the HUB board the id is filed on directly — docs linked via
   *      attachDoc, each task's `task:<id>` body room, and a grouping id,
   *      which is how a review goes on a board as one row
   *   3. the HUB board that member's GROUPING is filed on — the hop that
   *      makes a review row on a shared board actually open. Without it a
   *      hub-scoped share saw the row and 403'd on everything behind it,
   *      because every member answers with the grouping id and the share
   *      carries the hub id.
   *
   * ONE rule for both halves of the guard, on purpose: the same function
   * tells the allowlist that a grouping belongs to a hub and tells it that
   * the grouping's members do. Two rules would agree today and diverge
   * later, and the one that diverges open is the breach.
   *
   * Exactly one hop from grouping to board — not a transitive closure.
   * Deliberately NOT the ws:<id> board room: its share allowance is spelled
   * out in host-guard, never a resolver side effect.
   */
  const shareWorkspacesOf = (id: string): string[] => {
    const out = new Set<string>();
    const grouping = rooms.get(id)?.meta.workspaceId;
    if (grouping) out.add(grouping);
    for (const board of hubWorkspacesHolding(id)) out.add(board);
    if (grouping) for (const board of hubWorkspacesHolding(grouping)) out.add(board);
    return Array.from(out);
  };

  /**
   * EVERY hub board an attachment is linked to — not the first one.
   *
   * `attachDoc` links, it does not move: only the default holding pen is
   * unfiled on the way (see `unfileFromDefault`), so a review deliberately
   * put on two real boards is on both. `taskStore.workspaceOfDoc` answers
   * with whichever the store iterates first, which for share scoping means
   * the visitors of every OTHER board holding it are refused the row their
   * own board shows them — the exact 403-on-your-own-share failure
   * `unfileFromDefault` records, surviving in the case it cannot fix,
   * because there both links are legitimate and neither may be dropped.
   *
   * `task:<id>` keeps the store's own resolution: a task body belongs to its
   * task's workspace, which is a field rather than a link, so it has one
   * answer by construction.
   */
  function hubWorkspacesHolding(attachmentId: string): string[] {
    if (attachmentId.startsWith('task:')) {
      const w = taskStore.workspaceOfDoc(attachmentId);
      return w ? [w] : [];
    }
    return taskStore
      .listWorkspaces()
      .filter((w) => w.docIds.includes(attachmentId))
      .map((w) => w.id);
  }

  /**
   * ── Two things wear the word "workspace". Read this before touching any
   * helper below, because the names in this file are the only place the
   * difference is written down. ──
   *
   * GROUPING workspace — `meta.workspaceId`, also spelled `reviewId`. The tag
   *   that binds the member docs of one folder bind or diff review together.
   *   It is what `rooms.listWorkspaces` / `listRepoFiles` / `bindDiff` mean,
   *   and it has NO doc room of its own: `/review/<groupingId>` is a 404, its
   *   content lives under `/api/workspaces/<id>/tree|threads`.
   *
   * HUB workspace — the board (`taskStore`): goals, tasks, a name, and a list
   *   of ATTACHMENT ids in `docIds`. Helpers here say `hub` in their name when
   *   they mean this one; a bare `workspaceId` in this file means a grouping.
   *
   * An ATTACHMENT is either a doc room id or a grouping id — `POST
   * /api/workspaces/:id/docs` has accepted both since it was written, and the
   * hub sidebar resolves a grouping through the workspace endpoints
   * (`hub-sidebar.ts`). So a review goes on a board as ONE row; its members
   * stay off, because a hundred-file review is one unit of work, not a hundred.
   *
   * Every doc and every group bind belongs to a hub workspace (Bryan,
   * 2026-08-13) — and requiring one must not add a step. "Bind it, send Bryan
   * the URL" is ONE agent call, so a caller with no board in hand does not get
   * an error telling them to go create one first: what arrives unfiled lands on
   * the default board, and the id comes back in the same response so the caller
   * learns where it went.
   */
  const DEFAULT_HUB_WORKSPACE_NAME = 'Unfiled';
  const DEFAULT_HUB_WORKSPACE_GOAL =
    'Docs that arrived without a workspace. Move one into a real workspace once its work has a home.';

  /**
   * The default hub workspace, created on first need.
   *
   * Found by LOOKUP, never remembered in a variable: the store hydrates from
   * disk on boot, so a cached id would fragment into one "Unfiled" per restart
   * — which is the same as no workspace at all, one board per doc.
   */
  const defaultHubWorkspaceId = (): string => {
    const existing = taskStore.listWorkspaces().find((w) => w.name === DEFAULT_HUB_WORKSPACE_NAME);
    if (existing) return existing.id;
    const created = taskStore.createWorkspace(
      DEFAULT_HUB_WORKSPACE_NAME,
      DEFAULT_HUB_WORKSPACE_GOAL,
    );
    // createWorkspace emits no event (nothing subscribes to a workspace that
    // doesn't exist yet), so bring the board room up by hand — same as the
    // POST /api/workspaces route.
    taskProjection.ensureWorkspace(created.id);
    return created.id;
  };

  /**
   * Put an attachment — a doc room id OR a grouping id — on a hub workspace and
   * answer which one. Idempotent: something already attached keeps the board it
   * has (moving it is `attach_doc`'s job, not a side effect of re-binding, and
   * re-running `create_diff_review` on a live review is documented as safe). A
   * `requested` id that names no real board falls back to the default rather
   * than failing the bind — the whole point is that it always lands somewhere.
   */
  const fileUnderHubWorkspace = (attachmentId: string, requested?: string): string => {
    const existing = taskStore.workspaceOfDoc(attachmentId);
    if (existing) return existing;
    const target =
      requested && taskStore.getWorkspace(requested) ? requested : defaultHubWorkspaceId();
    taskStore.attachDoc(target, attachmentId);
    // attachDoc emits no store event; refresh the projection's docIds.
    taskProjection.ensureWorkspace(target);
    return target;
  };

  /**
   * Filing an attachment onto a real board takes it OUT of the default one.
   *
   * Without this, the usual agent flow — create it, then attach it — leaves it
   * linked to two hub workspaces, and `workspaceOfDoc` answers with whichever
   * the store iterates first. That is not cosmetic: it is what SHARE SCOPING
   * resolves against, so a workspace visitor was refused (403) on the very doc
   * the share was created for. The default board is a holding pen, not a second
   * home.
   */
  const unfileFromDefault = (attachmentId: string, keptHubWorkspaceId: string): void => {
    // `find`, never `defaultHubWorkspaceId()` — filing something must not
    // conjure a holding pen on a server that has never needed one.
    const holding = taskStore.listWorkspaces().find((w) => w.name === DEFAULT_HUB_WORKSPACE_NAME);
    if (!holding || holding.id === keptHubWorkspaceId) return;
    const res = taskStore.detachDoc(holding.id, attachmentId);
    if (res.ok && res.removed) taskProjection.ensureWorkspace(holding.id);
  };

  /**
   * A deleted doc — or a deleted REVIEW, which is deleted as one unit and is
   * one row on the board — leaves no link behind. This mattered little while
   * attaching was a deliberate act on a handful of docs; now that everything is
   * filed, a board would otherwise silently accumulate one tombstone per
   * deletion, invisible in the UI because a dangling id renders as nothing.
   */
  const unlinkFromEveryHubWorkspace = (attachmentId: string): void => {
    for (const w of taskStore.listWorkspaces()) {
      const res = taskStore.detachDoc(w.id, attachmentId);
      if (res.ok && res.removed) taskProjection.ensureWorkspace(w.id);
    }
  };

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
              return { docId: s.docId, workspaceId: s.workspaceId };
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
            if (!shareScopeAllows(pathname, req.method, decision.target, shareWorkspacesOf)) {
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
              if (!shareScopeAllows(pathname, req.method, target, shareWorkspacesOf)) {
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
        // `POST /api/share/doc` is GONE — a workspace is the unit of sharing.
        // It is answered explicitly rather than left to the 404 fall-through
        // because an older plugin bundle's `share_doc` still POSTs here with
        // its own payload, and the useful reply names the replacement instead
        // of reading as "your server is broken".
        if (pathname === '/api/share/doc' && req.method === 'POST') {
          return j(410, {
            error: 'per_doc_sharing_removed',
            hint: 'A workspace is the unit of sharing. File the doc on a workspace (attach_doc / bind_folder / create_diff_review) and call share_workspace or share_link with workspaceId.',
          });
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
          const target = currentWorkspaceEntry(share.workspaceId, share.docId);
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
          const workspaceId = body?.workspaceId as string | undefined;
          // A `docId` in the body is an OLDER BUNDLE's share_link asking for a
          // single-doc share. That grant is gone, and the dangerous reading of
          // this payload is "ignore the field you don't know and mint
          // something" — so it is refused by name, before anything is created.
          // Every peer keeps calling the shared server with the payload ITS
          // bundle sends, long after this one stopped sending it.
          if (body?.docId !== undefined) {
            return j(410, {
              error: 'per_doc_sharing_removed',
              hint: 'A workspace is the unit of sharing. Pass workspaceId (the doc must be filed on a workspace) — docId is no longer accepted.',
            });
          }
          if (!workspaceId) return j(400, { error: 'workspaceId required' });

          let entryDocId = body?.entryDocId as string | undefined;
          let memberCount: number | undefined;
          // A HUB workspace (§3.12 commit 8) is shareable with zero bound
          // member docs — its entry is the hub page, not a review doc.
          const isHubShare = !!taskStore.getWorkspace(workspaceId);
          if (isHubShare) {
            if (entryDocId) {
              return j(400, {
                error: 'a hub workspace share opens the hub page — entryDocId is not supported',
              });
            }
          } else {
            const members = rooms.list().filter((m) => m.workspaceId === workspaceId);
            if (members.length === 0) return j(404, { error: 'workspace not found', workspaceId });
            if (entryDocId && !members.some((m) => m.docId === entryDocId)) {
              return j(400, { error: 'entryDocId is not a member of this workspace' });
            }
            entryDocId = entryDocId ?? members[0]?.docId;
            memberCount = members.length;
          }
          try {
            const share = shares.createShareLink({
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
              // The widget is the third creation path (next to POST /api/docs
              // and the MCP tools that front it), so it files its doc too —
              // otherwise a mockup that was only ever opened in a browser is
              // an orphan the hub can't see.
              fileUnderHubWorkspace(docId);
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
          // Before the file attach, not after: the room already exists at this
          // point, and the 409 below returns early — filing afterwards would
          // leave a failed bind as the one doc this route can still strand
          // outside a workspace.
          const hubWorkspaceId = fileUnderHubWorkspace(
            docId,
            body?.hubWorkspaceId as string | undefined,
          );
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
            // Where the doc landed, in the same call that created it — a
            // caller who supplied no workspace still learns which one it got.
            hubWorkspaceId,
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
            // Who leads the board. Explicit `leadAgentId` wins; otherwise the
            // CREATING agent takes the seat — which is the whole point of
            // "every workspace has a lead, always": the common path is an
            // agent minting a board for work it is about to do. A person
            // creating one leaves the seat open rather than being installed
            // as an agent lead; the first agent to attach claims it.
            const claimed = body?.leadAgentId;
            const author = authorFor(body?.author);
            const leadAgentId =
              typeof claimed === 'string' && claimed.trim().length > 0
                ? claimed.trim()
                : author && classifyActor(author) === 'agent'
                  ? author.id
                  : undefined;
            const workspace = taskStore.createWorkspace(body.name.trim(), goal, {
              ...(leadAgentId !== undefined ? { leadAgentId } : {}),
            });
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
          // The GROUPING goes on the board, not its members: `res.workspaceId`
          // is the grouping id, and one row for the whole bind is the unit a
          // reader thinks in. See the vocabulary note above `fileUnderHubWorkspace`.
          const hubWorkspaceId = fileUnderHubWorkspace(
            res.workspaceId,
            body?.hubWorkspaceId as string | undefined,
          );
          return j(200, {
            ...res,
            hubWorkspaceId,
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
          // One row per REVIEW on the board, never one per changed file — the
          // members are reachable through the review's own tree. Idempotent, so
          // a re-run that omits `hubWorkspaceId` cannot sweep a live review out
          // of the board a reviewer already filed it on.
          const hubWorkspaceId = fileUnderHubWorkspace(
            res.reviewId,
            body?.hubWorkspaceId as string | undefined,
          );
          return j(200, { ...res, hubWorkspaceId, files, entryUrl: entry?.reviewUrl });
        }
        // List bound workspaces with rolled-up triage signals (fileCount,
        // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
        // this to treat a folder bind as one cleanup unit.
        if (pathname === '/api/workspaces' && req.method === 'GET') {
          return j(200, {
            workspaces: rooms.listWorkspaces(),
            // Hub workspaces (the boards) are a different thing from the
            // grouping workspaces above and stay in their own key rather than
            // being mixed into one list. They belong on this route because a
            // workspace the SERVER materialized for an unfiled doc has no
            // other way to be found: nobody was told its id at creation time.
            hubWorkspaces: taskStore.listWorkspaces().map((w) => ({
              id: w.id,
              name: w.name,
              goal: w.goal,
              docCount: w.docIds.length,
              createdAt: w.createdAt,
            })),
          });
        }
        // --- REST: hub workspaces + tasks (plan §3.10) ---
        // Every handler below hand-copies body fields into the store call.
        // A field that isn't copied is silently discarded while the request
        // still returns 200 — so every param here has an HTTP-level test in
        // task-routes.test.ts (the `groups` lesson).
        const hubWsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (hubWsMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(hubWsMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          // Goals with their counts, in priority order. The goals were always
          // in this payload and no MCP tool read it, so ordering lived in
          // each agent's head; the counts are what make the list answer
          // "where is the open work" without a second call per goal.
          return j(200, {
            workspace,
            goalSummary: summarizeGoals(taskStore.listTasks(workspaceId), workspace.goals),
            // A goal edit waiting for the lead agent. Read-only here: only an
            // attach drains it. Surfaced so "nobody has picked this up" is
            // visible work on the board rather than a silent gap.
            pendingRetriage: taskStore.getPendingRetriage(workspaceId),
          });
        }
        // The human's queue, to the board's agent-side `next` below: every
        // open thread across this workspace's tasks and docs whose newest
        // comment is an agent's. Decisions are NOT here — the board already
        // holds every task, so shipping them again would put the priority
        // rule in two places; the client merges the two halves and orders
        // them (see `reviewQueue` in hub-model).
        //
        // One request rather than one per doc: a board with forty tasks is a
        // board with forty rooms, and the strip has to be right at first
        // paint or it is not a "what do I look at next" surface.
        const wsReviewMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/review-items$/);
        if (wsReviewMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsReviewMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          return j(200, {
            workspaceId,
            items: reviewThreadItems({
              tasks: taskStore.listTasks(workspaceId).map((t) => ({
                id: t.id,
                title: t.title,
                bodyDocId: taskBodyDocId(t.id),
                done: t.status === 'done',
              })),
              docs: workspace.docIds.map((docId) => {
                const meta = rooms.get(docId)?.meta;
                // Title, else the file's BASENAME — never `relPath` whole and
                // never `sourceUrl`. Those describe the host machine, and a
                // share visitor reads this route (§3.3): a label is workspace
                // content, a path is not.
                const base = meta?.relPath?.split('/').pop();
                return { docId, title: meta?.title || base || docId };
              }),
              source: {
                threadsOf: (docId) => rooms.listThreads(docId, { status: 'open' }),
                // Unfiltered, and only for the roster: who counts as a person
                // here must not depend on whether their thread is still open.
                allThreadsOf: (docId) => rooms.listThreads(docId),
              },
            }),
          });
        }
        // The work queue: priority order, dependency-aware, grouped into
        // waves that can run at once (§3.9 agent side).
        const wsNextMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/next$/);
        if (wsNextMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsNextMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          const limitRaw = url.searchParams.get('limit');
          const rows = buildQueue(taskStore.listTasks(workspaceId), workspace.goals, {
            ...(url.searchParams.get('assignee')
              ? { assignee: url.searchParams.get('assignee') ?? '' }
              : {}),
            ...(limitRaw !== null && Number.isFinite(Number(limitRaw))
              ? { limit: Number(limitRaw) }
              : {}),
            includeBlocked: url.searchParams.get('includeBlocked') === 'true',
            // The discussion the queue has always dropped. Every one of the
            // five known stale-premise pickups had a comment on the task
            // saying the premise had moved, and none of them reached the
            // next reader, because this route returned `body` and nothing
            // else. Passed as a reader rather than a map so `buildQueue`
            // stays pure and only the armed rows pay for their notes.
            discussion: (taskId) => taskProjection.discussionNotes(taskId),
            ...(opts.premiseStaleAfterMs !== undefined
              ? { staleAfterMs: opts.premiseStaleAfterMs }
              : {}),
          });
          return j(200, { workspaceId, tasks: rows });
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
          // `summary` is the ≤20-word line the board DISPLAYS in place of the
          // goal. It rides this route rather than getting one of its own so
          // there is exactly one way in: two writers for one field is how a
          // stale hash gets computed against the wrong goal.
          const summary = body?.summary;
          if (summary !== undefined && typeof summary !== 'string') {
            return j(400, { error: 'summary must be a string' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          if (typeof goal !== 'string') {
            // Summary-only: re-wording the display line must not require the
            // caller to echo the goal back, which would let a stale read
            // silently revert a north star somebody else just edited.
            if (typeof summary !== 'string') {
              return j(400, { error: 'goal or summary required' });
            }
            const only = taskStore.setGoalSummary(workspaceId, summary);
            if (!only.ok) return j(404, only);
            // The store emits nothing for a display-only change, so nothing
            // would push it to the open boards. Reassert the projection here
            // — otherwise the summary exists and no surface can show it.
            taskProjection.ensureWorkspace(workspaceId);
            return j(200, { ok: true, workspace: only.workspace, changed: false });
          }
          const res = taskStore.setWorkspaceGoal(workspaceId, goal, {
            actor: author,
            ...(typeof summary === 'string' ? { summary } : {}),
          });
          if (!res.ok) return j(404, res);
          // A no-op goal edit carrying a new summary emits no event either,
          // so the same reassert applies. Idempotent, so doing it on the
          // changed path too costs nothing and removes a branch to get wrong.
          if (typeof summary === 'string') taskProjection.ensureWorkspace(workspaceId);
          return j(200, res);
        }
        // set_workspace_lead: hand the board's lead-agent seat to someone
        // else. A standing assignment, not a session fact — the lead may be
        // away, and a goal edit still has an addressee to queue for.
        const wsLeadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/lead$/);
        if (wsLeadMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsLeadMatch[1] ?? '');
          const body = await safeJson(req);
          const leadAgentId = body?.leadAgentId;
          if (typeof leadAgentId !== 'string' || leadAgentId.trim().length === 0) {
            return j(400, { error: 'leadAgentId required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.setLeadAgent(workspaceId, leadAgentId, { actor: author });
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
          // A doc filed here is no longer unfiled.
          unfileFromDefault(docId, workspaceId);
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
          // An import inherits the importer's identity for every row that
          // names nobody, so an anonymous importer would file those rows under
          // the generic word — the one thing every other create refuses. The
          // test is per row and the refusal is whole: a tracker whose owner
          // column is filled in imports fine no matter who ran it, and one
          // that isn't fails before anything is written, so there is no
          // partial state to reason about. The dry run above stays allowed —
          // it creates nothing, and it's what you read while fixing this.
          if (mapping.tasks.some((row) => !resolveAssignee(row.assignee, author))) {
            return j(400, { error: ASSIGNEE_REQUIRED_ERROR, message: ASSIGNEE_REQUIRED_MESSAGE });
          }
          const res = applyImport(taskStore, workspaceId, mapping, { actor: author });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // Stamp the source file. If the tracker is bound as a live doc,
          // pull the banner into the live doc too — reparse right after our
          // own write, so disk (which we just wrote) wins the race with the
          // doc's debounced flush.
          const hubUrl = `${externalBaseUrl()}/workspaces/${encodeURIComponent(workspaceId)}`;
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
            // Hand-copied, like every field above it — a mapping field that
            // isn't listed here is silently dropped on the apply path while
            // the dry-run (which spreads `mapping`) still shows it.
            warnings: mapping.warnings,
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
          // The kind the BOARD resolves, not just the one somebody declared.
          // An agent has no other way to ask "which of my rows read as an
          // unrecorded owner" — the resolved value lives in a ydoc it cannot
          // read, and the two answers differ exactly where it matters (an
          // undeclared row whose owner is an attached agent reads `agent`).
          const ownerKindOf = taskProjection.ownerKindReader(workspaceId);
          return j(200, {
            workspaceId,
            // `titleGaps` rides every row, not just the response to the act
            // that wrote one. A caller reviewing a board is the reader who
            // most needs to know which rows do not say what they will do, and
            // it cannot get that from a create response it never saw.
            tasks: tasks.map((t) => ({ ...t, ownerKind: ownerKindOf(t), ...taskAdvisory(t) })),
          });
        }
        if (wsTasksMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
          const body = await safeJson(req);
          // An unknown workspace is a 404 before anything about the task is
          // judged — otherwise a typo'd id comes back as a complaint about
          // the body, and the caller fixes the wrong thing.
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace-not-found' });
          }
          // One reading of a create body, shared with the batch route below.
          const parsed = parseTaskCreate(body, authorFor(body?.author));
          if (!parsed.ok) {
            return j(400, {
              error: parsed.error,
              ...(parsed.message !== undefined ? { message: parsed.message } : {}),
            });
          }
          const res = taskStore.createTask(workspaceId, parsed.opts);
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // Dropped refs are reported, never swallowed: the caller finds out
          // what didn't survive without having to diff what it sent. Same
          // reasoning for `shapeGaps` — the decision WAS created and the
          // caller still learns which parts of the shape are missing.
          return j(200, {
            task: res.task,
            // What happened to the placement, and — only when nobody judged
            // it — the bands it could have been ranked into. The caller that
            // just generated this work is the one party that still knows why
            // it exists; handing it `goal: "chores"` and nothing else is what
            // let agent-generated work drift out of the goal structure.
            placement: {
              ...res.placement,
              ...(res.placement.placed
                ? {}
                : { goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []) }),
            },
            ...(parsed.ignoredLinks.length > 0 ? { ignoredLinks: parsed.ignoredLinks } : {}),
            ...(res.shapeGaps !== undefined ? { shapeGaps: res.shapeGaps } : {}),
            // Same reasoning one field over: the task WAS created, and the
            // caller still learns that its title doesn't say who this is for
            // or what will be built. Advisory on purpose — refusing here
            // would make a rough capture impossible to file at all.
            ...taskAdvisory(res.task),
          });
        }
        /**
         * Batch capture: a burst of ideas in ONE call, each landing owned and
         * placed, and the whole thing coming back in board order so the caller
         * can see the ranking it just produced without a second read.
         *
         * PER-ITEM failure, deliberately. An all-or-nothing batch turns one
         * typo into "which of these eight already landed?", and the answer to
         * that question is a read the caller shouldn't have to do — so a bad
         * row is reported by index and its neighbours still land. The two
         * whole-call refusals left are the ones where nothing could have
         * landed anyway: an unknown workspace, and a body with no rows in it.
         */
        const wsTasksBatchMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks\/batch$/);
        if (wsTasksBatchMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsTasksBatchMatch[1] ?? '');
          const body = await safeJson(req);
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace-not-found' });
          }
          const rows = body?.tasks;
          if (!Array.isArray(rows) || rows.length === 0) {
            return j(400, { error: 'tasks must be a non-empty array of task bodies' });
          }
          // Refused, never truncated. A capture tool that silently keeps the
          // first N reports success for rows that don't exist, and the caller
          // has no way to know which — the failure this whole route is shaped
          // to avoid. The number is a burst-sized ceiling, not a capacity
          // limit: a batch this large is a tracker, and import_tasks_markdown
          // is the surface for one.
          if (rows.length > MAX_BATCH_TASKS) {
            return j(400, {
              error: 'too-many-tasks',
              message: `a batch takes at most ${MAX_BATCH_TASKS} rows; this one had ${rows.length}. Nothing was created — split it, or use import_tasks_markdown for a whole tracker.`,
            });
          }
          const createdBy = authorFor(body?.author);
          const createdIds = new Set<string>();
          const failures: Array<{
            index: number;
            title?: string;
            error: string;
            message?: string;
          }> = [];
          const ignoredLinks: Array<{ taskId: string; ignored: unknown[] }> = [];
          const shapeGaps: Array<{ taskId: string; gaps: unknown[] }> = [];
          // Placement, collected per row and reported ONCE. Per-row it would
          // repeat the same band list a hundred times in a hundred-row burst;
          // the rows that need naming are the unplaced ones, so those are what
          // it names.
          const unplaced: string[] = [];
          const triageDelivered: string[] = [];
          // Batch-local dependency references. Keys are read once, up front,
          // so an ambiguous one is refused where it is DECLARED rather than
          // at every site that reads it; `idByIndex` fills in as rows land,
          // which is what lets a row that depends on a FAILED row fail too
          // instead of being created with the edge silently dropped.
          const { keyToIndex, keyErrors } = indexBatchKeys(rows);
          const idByIndex = new Map<number, string>();
          const refCtx = { keyToIndex, idByIndex, rowCount: rows.length };
          for (const [index, row] of rows.entries()) {
            // One caller, one identity: every row is attributed to whoever
            // sent the batch. A row naming its own author would be a second
            // way to spell attribution with no caller asking for it — and
            // `assignee` already answers the question people actually have,
            // which is who OWNS the row rather than who typed it.
            const title = (row as { title?: unknown } | null)?.title;
            const named = typeof title === 'string' ? { title } : {};
            const keyError = keyErrors.get(index);
            if (keyError) {
              failures.push({ index, ...named, ...keyError });
              continue;
            }
            const refs = resolveRowRefs(row, index, refCtx);
            if (!refs.ok) {
              failures.push({ index, ...named, error: refs.error, message: refs.message });
              continue;
            }
            // Hand the parser a row whose references are already real ids —
            // so the store's `unknown-after` gate and every rule downstream
            // of it are unchanged by this feature.
            const resolvedRow =
              refs.after === undefined && refs.afterEnforce === undefined
                ? row
                : {
                    ...(row as Record<string, unknown>),
                    ...(refs.after !== undefined ? { after: refs.after } : {}),
                    ...(refs.afterEnforce !== undefined ? { afterEnforce: refs.afterEnforce } : {}),
                  };
            const parsed = parseTaskCreate(resolvedRow, createdBy);
            if (!parsed.ok) {
              failures.push({
                index,
                ...named,
                error: parsed.error,
                ...(parsed.message !== undefined ? { message: parsed.message } : {}),
              });
              continue;
            }
            const res = taskStore.createTask(workspaceId, parsed.opts);
            if (!res.ok) {
              failures.push({
                index,
                ...named,
                error: res.error,
                ...(res.message !== undefined ? { message: res.message } : {}),
              });
              continue;
            }
            createdIds.add(res.task.id);
            idByIndex.set(index, res.task.id);
            if (!res.placement.placed) unplaced.push(res.task.id);
            if (res.placement.triageDelivered) triageDelivered.push(res.task.id);
            if (parsed.ignoredLinks.length > 0) {
              ignoredLinks.push({ taskId: res.task.id, ignored: parsed.ignoredLinks });
            }
            if (res.shapeGaps !== undefined) {
              shapeGaps.push({ taskId: res.task.id, gaps: res.shapeGaps });
            }
          }
          // Board order comes from the board, not from a second sort of our
          // own that happens to agree with it today.
          const tasks = taskStore.listTasks(workspaceId).filter((t) => createdIds.has(t.id));
          return j(200, {
            workspaceId,
            tasks,
            failures,
            // Absent when every row was placed — there is nothing to act on,
            // and a block that is always there is a block nobody reads.
            ...(unplaced.length > 0
              ? {
                  placement: {
                    unplaced,
                    triageDelivered,
                    goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []),
                  },
                }
              : {}),
            ...(ignoredLinks.length > 0 ? { ignoredLinks } : {}),
            ...(shapeGaps.length > 0 ? { shapeGaps } : {}),
            // Per row and by id, the same sidecar shape as `shapeGaps` — a
            // burst capture is exactly where clipped, persona-less titles
            // arrive, and reporting only a total would leave the caller
            // diffing to find which of eight rows needs naming.
            ...(() => {
              const rows = tasks
                .map((t) => ({ taskId: t.id, gaps: taskStore.titleGapsOf(t) }))
                .filter((r) => r.gaps.length > 0);
              const bodyRows = tasks
                .map((t) => ({ taskId: t.id, gaps: bodyShapeGaps(t.body, t.needs) }))
                .filter((r) => r.gaps.length > 0);
              return {
                ...(rows.length > 0 ? { titleGaps: rows } : {}),
                ...(bodyRows.length > 0 ? { bodyGaps: bodyRows } : {}),
              };
            })(),
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
          });
          // `body.confirmed` is read by nothing now (the risk gate was removed
          // 2026-08-18) and is deliberately NOT validated: peers on older
          // bundles keep sending it until they restart, and a request that
          // starts failing over a field the server no longer cares about is
          // exactly how a removal breaks a caller it never meant to touch.
          if (!res.ok) {
            // A gate refusal is a refusal, not a malformed request: same 409
            // an enforce-marked blocker returns, so callers have one shape
            // for "the gate said no".
            const refused = res.error === 'blocked';
            const status = res.error === 'not-found' ? 404 : refused ? 409 : 400;
            return j(status, res);
          }
          return j(200, res);
        }
        // Evidence for a move that already happened. Not a second status
        // door — it never touches `status` — but the answer to the one case
        // the gate above has to refuse: the move was right and the proof was
        // wrong or missing. Appends; the original row is never rewritten.
        const taskEvidenceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
        if (taskEvidenceMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskEvidenceMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          const evidence = body?.evidence as { commit?: string; threadRef?: Ref } | undefined;
          if (!author || evidence === undefined) {
            return j(400, { error: 'author + evidence required' });
          }
          const res = taskStore.amendEvidence(taskId, {
            actor: author,
            evidence,
            note: body?.note as string | undefined,
            transitionTs: body?.transitionTs as number | undefined,
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
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
        // The same question asked about an ARBITRARY ref. `backlinksFor`
        // always answered it; the HTTP surface could only pose it about a
        // task (above) or a doc/thread (`GET /api/docs/<id>/tasks`), so the
        // question the `url` kind was added for — "which tasks point at this
        // pull request" — had no route, and `diff` refs had none either.
        //
        // POST for a read is deliberate: a ref is a structured value whose
        // `url` kind carries a caller-supplied URL, and putting that in a
        // query string writes it into every access log and proxy on the path
        // for no gain. Nothing here mutates.
        if (pathname === '/api/refs/backlinks' && req.method === 'POST') {
          const body = await safeJson(req);
          const ref = body?.ref;
          // A malformed ref must NOT fall through to an empty answer: [] and
          // "I didn't understand you" are indistinguishable to the caller,
          // and the first one reads as "nothing points at this PR".
          if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
          return j(200, { ref, tasks: taskStore.backlinksFor(ref).map(taskChip) });
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
        // set_task_goal (§3.10): goal/subgoal + exact position — the write
        // half of triage and the board's regroup gesture. Every field here is
        // hand-copied; each has an HTTP-level test in task-tool-routes.test.ts.
        //
        // `riskTier` used to be validated here and forwarded to the store. It
        // is now IGNORED, not refused: an older peer sends it on every
        // placement until it restarts, and the 400 this route used to be able
        // to return would now fire on a field that means nothing. Accept the
        // old payload shape; there is an HTTP-level test that sends it.
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
          const batchId = body?.batchId;
          if (batchId !== undefined && typeof batchId !== 'string') {
            return j(400, { error: 'batchId must be a string' });
          }
          const res = taskStore.setTaskGoal(taskId, goal, {
            actor: author,
            position: typeof body?.position === 'number' ? Number(body.position) : undefined,
            batchId,
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // A confirm-in-place (changed:false) mutates gated fields
          // (triagedAgainst, triagePendingTs) without emitting an event —
          // refresh the projection by hand, same as attachDoc.
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
          // `optionId` says which candidate the words came from. The words are
          // still the answer — an option is a shortcut to typing them, so this
          // route deliberately does NOT look the label up and substitute it.
          const optionId = body?.optionId;
          if (optionId !== undefined && typeof optionId !== 'string') {
            return j(400, { error: 'optionId must be a string' });
          }
          const res = taskStore.answerDecision(taskId, text, {
            actor: author,
            ...(optionId !== undefined ? { optionId } : {}),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // "Tell me more" — a question asked back at a decision INSTEAD of
        // answering it. Keeps the options from being a closed set: the row
        // stays open, stays counted, and the attached agent owes context.
        const taskMoreInfoMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/more-info$/);
        if (taskMoreInfoMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskMoreInfoMatch[1] ?? '');
          const body = await safeJson(req);
          const question = typeof body?.question === 'string' ? body.question.trim() : '';
          if (question.length === 0) return j(400, { error: 'question required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.requestMoreInfo(taskId, question, { actor: author });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // set_task_dependencies: edit `after` / `afterEnforce` on a task that
        // already exists. Until this route, `after` could only be set at
        // creation — so a decision filed after the work it gates could never
        // be wired to it, every decision on a real board had an empty `after`,
        // and "is this blocking anything" was underivable. Replaces the whole
        // edge set (an edge has to be removable), and emits no store event, so
        // the projection is refreshed by hand — the renameTask contract.
        const taskAfterMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/after$/);
        if (taskAfterMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAfterMatch[1] ?? '');
          const body = await safeJson(req);
          if (!Array.isArray(body?.after)) return j(400, { error: 'after must be an array' });
          if (body?.afterEnforce !== undefined && !Array.isArray(body.afterEnforce)) {
            return j(400, { error: 'afterEnforce must be an array' });
          }
          for (const id of [...body.after, ...((body.afterEnforce as unknown[]) ?? [])]) {
            if (typeof id !== 'string') return j(400, { error: 'task ids must be strings' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.setDependencies(
            taskId,
            {
              after: body.after as string[],
              ...(body.afterEnforce !== undefined
                ? { afterEnforce: body.afterEnforce as string[] }
                : {}),
            },
            { actor: author },
          );
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
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
          return j(200, { ...res, ...taskAdvisory(res.task) });
        }
        // update_task_body: replace a task's description after creation.
        // The body is a live `task:<id>` doc room, so this goes THROUGH that
        // room rather than at the store's snapshot field — a block-level
        // diff, so comment threads on paragraphs the rewrite didn't touch
        // keep their anchors, and anyone reading the task on the board sees
        // it change under them. Three things the doc route alone can't do,
        // and each of them looks like "the rewrite failed" from outside:
        // create the room on a workspace this process hasn't served yet,
        // flush the snapshot the board and next_tasks read, and put an
        // attributed row in the audit log.
        const taskBodyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/body$/);
        if (taskBodyMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskBodyMatch[1] ?? '');
          const body = await safeJson(req);
          const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
          // Optional: shaping retitles and rewrites in ONE act, so a clipped
          // capture title is not left behind by the pass that fixed its body.
          // A blank string is "no new title", never a request to blank one.
          const title = typeof body?.title === 'string' ? body.title.trim() : '';
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const task = taskStore.getTask(taskId);
          if (!task) return j(404, { ok: false, error: 'not-found' });
          if (!markdown.trim()) return j(400, { ok: false, error: 'empty' });
          const res = rewriteTaskBody(task, markdown, {
            actor: author,
            ...(title ? { title } : {}),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // No hand-refresh of the projection: unlike `/title` (which emits
          // nothing by design), this act DOES emit, and the projection's own
          // subscriber re-runs ensureWorkspace off the event.
          const rewritten = taskStore.getTask(taskId);
          return j(200, {
            ok: true,
            task: rewritten,
            // Shaping is one act, so the advisory on the title this act set
            // belongs on this response — and when the caller sent no title,
            // this is where a rewrite that moved the body far enough reports
            // that the old name no longer fits.
            ...(rewritten ? taskAdvisory(rewritten) : {}),
          });
        }
        // assign_task (§3.6 task.assigned): hand a task between the human and
        // the agent (or a named identity). Status is untouched — a hand-off
        // is not progress, and routing it through the transition gate would
        // make "you take this" require evidence.
        const taskAssigneeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assignee$/);
        if (taskAssigneeMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAssigneeMatch[1] ?? '');
          const body = await safeJson(req);
          const assignee = resolveAssignee(body?.assignee, undefined);
          // The create routes gate this; without the same gate here a board
          // could be walked back to the generic owner one hand-over at a time.
          // No author fallback: "hand it to whoever" is not a hand-over, and
          // silently assigning to the caller would do something else than what
          // they asked.
          if (!assignee) {
            return j(400, {
              error: ASSIGNEE_REQUIRED_ERROR,
              message: ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
            });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `assigneeKind` is forwarded here explicitly. The route layer is
          // the one nothing type-checks, and a param accepted by the tool and
          // dropped by the route answers 200 while doing nothing — this
          // codebase has shipped that exact bug. Refused rather than dropped
          // for the same reason: the plausible typo here is 'human', which is
          // a valid ASSIGNEE, and swallowing it would answer 200 while the
          // row lands undeclared.
          const handoverKind = parseAssigneeKind(body?.assigneeKind);
          if (!handoverKind.ok) {
            return j(400, {
              error: BAD_ASSIGNEE_KIND_ERROR,
              message: BAD_ASSIGNEE_KIND_MESSAGE,
            });
          }
          const res = taskStore.setAssignee(taskId, assignee, {
            actor: author,
            assigneeKind: handoverKind.assigneeKind,
          });
          if (!res.ok) return j(404, res);
          // A no-op emits nothing, so nothing would refresh the board room —
          // harmless here (nothing changed) but the changed path is covered
          // by the task.assigned event's own projection hook.
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          // Echo what the board now says this owner IS. Without it the caller
          // learns only that the call didn't error — which is exactly what a
          // declaration that silently failed to land also reports.
          const ownerKind = taskProjection.ownerKindReader(res.task.workspaceId)(res.task);
          return j(200, { ...res, ownerKind });
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
            return j(400, { error: 'goals must be [{id?, title, dueAt?, subgoals?}]' });
          }
          // `drop` is the caller's explicit "yes, remove that band even
          // though it holds work". A malformed value must NOT read as absent
          // — silently treating a string as no acknowledgement would turn a
          // typo into a refusal the caller cannot explain.
          const drop = body?.drop;
          if (
            drop !== undefined &&
            (!Array.isArray(drop) || drop.some((id) => typeof id !== 'string' || id.length === 0))
          ) {
            return j(400, { error: 'drop must be an array of goal ids' });
          }
          const res = taskStore.setGoalList(workspaceId, goals, {
            actor: author,
            ...(drop !== undefined ? { drop: drop as string[] } : {}),
          });
          if (!res.ok) {
            // The refusal is the whole feature, so it has to name the way
            // out: the MCP layer surfaces this body verbatim as the error
            // text an agent reads.
            // An id this board does not hold is the re-key gesture arriving
            // by its other spelling ("submit the list with a new id"), so the
            // message has to name both ways out rather than just saying no.
            const detail =
              res.error === 'unknown-goal-id'
                ? {
                    message:
                      `this board has no goal with id ${res.unknownIds
                        .map((id) => `"${id}"`)
                        .join(', ')}. ` +
                      'Goal ids are generated and permanent: to CREATE a band, send the entry ' +
                      'with no `id` at all and the new id comes back in `created`; to change a ' +
                      "band's title, use rename_goal, which cannot move a task. There is no " +
                      "way to give an existing band a different id, because a task's band IS " +
                      'its goal id — re-keying one is what strands everything filed under it.',
                  }
                : res.error === 'would-strand-tasks'
                  ? {
                      message:
                        'this replace would strand work filed under ' +
                        `${res.stranding
                          .map(
                            (s) =>
                              `"${s.title}" (${s.id}: ${s.openTasks} open, ${s.doneTasks} done)`,
                          )
                          .join('; ')}. ` +
                        'If you meant to RENAME a band, use rename_goal — it changes the title ' +
                        'in place and cannot move a task. If you meant to remove it, say so by ' +
                        'listing its id in `drop`; open tasks then land at the bottom of Chores ' +
                        'and done tasks keep pointing at the removed id, both reported back.',
                    }
                  : {};
            return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
          }
          return j(200, res);
        }
        // rename_goal (§3.2): change a band's TITLE without touching its id.
        // Its own route rather than a flag on the PUT above, because the
        // whole value is that it cannot reach the replace path at all — a
        // task's band IS its goal id, and nothing here changes an id.
        const wsRenameMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/rename$/);
        if (wsRenameMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsRenameMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const goalId = body?.goal;
          if (typeof goalId !== 'string' || goalId.length === 0) {
            return j(400, { error: 'goal must be a goal id' });
          }
          const title = body?.title;
          if (typeof title !== 'string' || title.trim().length === 0) {
            return j(400, { error: 'title must be a non-empty string' });
          }
          // `null` clears dueAt, a number sets it, absent leaves it alone —
          // three distinct meanings, so the parse keeps them distinct.
          const dueAt = body?.dueAt;
          if (dueAt !== undefined && dueAt !== null && typeof dueAt !== 'number') {
            return j(400, { error: 'dueAt must be a number, or null to clear it' });
          }
          const res = taskStore.renameGoal(
            workspaceId,
            goalId,
            {
              title: title.trim(),
              ...(dueAt !== undefined ? { dueAt: dueAt as number | null } : {}),
            },
            { actor: author },
          );
          if (!res.ok) {
            // `chores` is a 400, not a 404: it is a row the caller really
            // saw, so "no such goal" would send them hunting for a typo.
            const status =
              res.error === 'reserved-goal-id' ? 400 : res.error === 'goal-not-found' ? 404 : 404;
            return j(status, res);
          }
          return j(200, res);
        }
        // reorder_goals (§3.2): the priority gesture, permutation-only. A
        // separate route from the PUT above because that one REPLACES the
        // list — the two params here (`order`, `parent`) are the whole
        // contract, and `parent` is exactly the kind of param a hand-copying
        // route drops while still answering 200, so both are asserted
        // end-to-end in goal-reorder.test.ts (the `groups` lesson).
        const wsReorderMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/reorder$/);
        if (wsReorderMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsReorderMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const order = body?.order;
          if (
            !Array.isArray(order) ||
            order.some((id) => typeof id !== 'string' || id.length === 0)
          ) {
            return j(400, { error: 'order must be an array of goal ids' });
          }
          const parent = body?.parent;
          if (parent !== undefined && (typeof parent !== 'string' || parent.length === 0)) {
            return j(400, { error: 'parent must be a goal id' });
          }
          const res = taskStore.reorderGoals(workspaceId, order as string[], {
            actor: author,
            ...(parent !== undefined ? { parent: parent as string } : {}),
          });
          if (!res.ok) {
            // The refusal has to be readable by the agent that hit it: the
            // MCP layer surfaces the raw body as the error text, so the ids
            // and what to do about them belong right here.
            const detail =
              res.error === 'order-mismatch'
                ? {
                    message:
                      'order must be exactly the goal ids at this scope. ' +
                      `unknown: [${res.unknownIds.join(', ')}]; ` +
                      // Named separately because the fix differs: an unknown
                      // id means re-read, a reserved one means drop it.
                      `reserved (never ordered — leave these out): [${res.reservedIds.join(', ')}]; ` +
                      `missing: [${res.missingIds.join(', ')}]; ` +
                      `duplicated: [${res.duplicateIds.join(', ')}]. ` +
                      `Re-read the list with GET /api/workspaces/${workspaceId} and send back every ` +
                      'row at this scope whose `reorderable` is true.',
                  }
                : {};
            return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
          }
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
              : // A word boundary, not a character count. This clip used to be
                // `slice(0, 79)`, which is where the board's *"For tasks, I get
                // dumped o…"* came from — the GENERATOR produced that, not
                // whoever spoke it. The replacement is a prefix of the same
                // prefix, so it can only ever read better.
                clipToWordBoundary(titleSource, 80);
          const draftBody =
            typeof body?.body === 'string'
              ? body.body
              : [
                  `Promoted from a comment thread${snippet ? ` on "${snippet}"` : ''}.`,
                  ...(quote ? ['', `> ${quote}`] : []),
                ].join('\n');
          const promoteNeeds = parseNeeds(body?.needs);
          if (!promoteNeeds.ok) return j(400, { error: "needs must be 'action' | 'decision'" });
          const promoteOptions = parseOptions(body?.options);
          if (!promoteOptions.ok) return j(400, { error: BAD_OPTIONS_ERROR });
          const promoteLinks = parseLinks(body?.links);
          if (!promoteLinks.ok) return j(400, { error: BAD_REF_ERROR });
          // Same rule as a plain create: a promoted thread lands owned by
          // whoever promoted it unless the call names someone else.
          const promotedBy = authorFor(body?.author);
          const promoteKind = parseAssigneeKind(body?.assigneeKind);
          if (!promoteKind.ok) {
            return j(400, {
              error: BAD_ASSIGNEE_KIND_ERROR,
              message: BAD_ASSIGNEE_KIND_MESSAGE,
            });
          }
          const promoteOwner = resolveAssignee(body?.assignee, promotedBy);
          if (!promoteOwner) {
            return j(400, {
              error: ASSIGNEE_REQUIRED_ERROR,
              message: ASSIGNEE_REQUIRED_MESSAGE,
            });
          }
          const res = taskStore.createTask(workspaceId, {
            title,
            body: draftBody,
            assignee: promoteOwner,
            assigneeKind: promoteKind.assigneeKind,
            needs: promoteNeeds.needs,
            options: promoteOptions.options,
            // Forward undefined untouched: an omitted goal is what routes the
            // task through triage (an explicit 'chores' would skip it).
            goal: body?.goal as string | undefined,
            order: typeof body?.order === 'number' ? Number(body.order) : undefined,
            dueAt: typeof body?.dueAt === 'number' ? Number(body.dueAt) : undefined,
            links: promoteLinks.links,
            origin: { kind: 'thread', docId, threadId },
            ...(quote !== undefined ? { quote } : {}),
            actor: promotedBy ?? undefined,
          });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          return j(200, {
            task: res.task,
            // Third create path, same report. Promoting a thread has exactly
            // the same goal semantics as a create, so an agent that learns to
            // read `placement` on one and finds it missing on another is being
            // taught the field is unreliable.
            placement: {
              ...res.placement,
              ...(res.placement.placed
                ? {}
                : { goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []) }),
            },
            ...(promoteLinks.ignored.length > 0 ? { ignoredLinks: promoteLinks.ignored } : {}),
            ...(res.shapeGaps !== undefined ? { shapeGaps: res.shapeGaps } : {}),
            // Third create path, third report — and the one most likely to
            // need it, since an unnamed promote derives its title from
            // somebody's comment rather than from a decision to name a row.
            ...taskAdvisory(res.task),
          });
        }
        // --- REST: plugin refresh ---
        // The other half of the drift signal: any peer that can read who is
        // behind can also ask the machine to fetch the new bundle. Safe to
        // expose to everyone in the workspace because it cannot interrupt
        // anyone — it rewrites a version-keyed cache, and a running session
        // keeps loading the path it resolved at launch. Peers take the new
        // version at their own next restart.
        if (pathname === '/api/plugin/refresh') {
          // Unreachable today — `shareScopeAllows` is an allowlist and this
          // path is not on it, so a share host is refused before any route
          // runs (host-guard.test.ts pins that). Kept, and kept AHEAD of the
          // capability check, so that allowlisting this path later cannot
          // silently open a deploy step to external reviewers, and so an
          // unconfigured deployment never answers a visitor with what it
          // would have done.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          if (!pluginRefresher) {
            return j(501, {
              error:
                'plugin refresh not enabled on this server (dev and staging deliberately cannot spawn an update)',
            });
          }
          if (req.method === 'GET') return j(200, { refresh: pluginRefresher.last() });
          if (req.method === 'POST') return j(200, { refresh: await pluginRefresher.refresh() });
          return j(405, { error: 'method not allowed' });
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
          const attachments = visitor
            ? taskStore.listPublicAttachments(workspaceId)
            : taskStore.listAttachments(workspaceId);
          // Drift rides the same read the board already makes, so nobody has
          // to run a command to discover that a merge never reached them.
          // A plugin version is workspace-visible, not host-describing —
          // it says which tools an agent here can use, so a visitor sees it
          // for the same reason they see who is attached.
          const released = readReleasedPluginVersion();
          // The other half of "what is running where": the plugin drift above
          // is about the agents, this is about the browser the reader is
          // holding. A failed client build keeps the previous release live and
          // used to say so only on stderr, so the split widened in silence.
          //
          // Owner-only: `lastError` is a build error off this machine's disk
          // (absolute paths), and which release is live is a fact about the
          // host's deploy rather than workspace content — the same line the
          // `endpoint` redaction draws.
          const clientRelease =
            clientReleaseRootDir && !visitor ? clientReleaseStatus(clientReleaseRootDir) : null;
          return j(200, {
            workspaceId,
            attachments,
            ...(clientRelease ? { clientRelease } : {}),
            pluginRelease: {
              version: released,
              behind: agentsBehind(released, attachments).map((a) => ({
                agentId: a.agentId,
                ...(a.pluginVersion !== undefined ? { pluginVersion: a.pluginVersion } : {}),
              })),
              // How many sessions the `behind` list was computed OVER. It
              // ships beside the list because the list alone cannot be read:
              // empty means "none of the ones checked", and for this board
              // that has normally been one session — its own. Without the
              // denominator the surface renders participation as clearance.
              checked: checkableAttachments(attachments).length,
            },
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
            // The bundle this session is running. Absent from every peer
            // older than the release that added it — which is the signal,
            // not a gap to paper over with a default.
            pluginVersion:
              typeof body?.pluginVersion === 'string' && body.pluginVersion.trim().length > 0
                ? body.pluginVersion.trim()
                : undefined,
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
          // Two different stores answer to the word "workspace", and this one
          // route fronts both: `POST /api/workspaces` mints a hub board from
          // `name` and a doc grouping from `folderPath`. `rooms.deleteWorkspace`
          // enumerates DOC members, so a hub board — which has none — always
          // came back not-found, and a board created for a five-minute
          // experiment was permanent. Ask the task store first, by id.
          if (taskStore.getWorkspace(workspaceId)) {
            const openTasks = taskStore.openTaskCount(workspaceId) ?? 0;
            if (openTasks > 0 && !force) {
              return j(409, { ok: false, error: 'has-open-tasks', openTasks });
            }
            // Three steps, ordered so that nothing irreversible happens
            // while the operation can still fail. (1) STAGE the rooms' files
            // — a rename, so it proves they are removable and can be undone;
            // orphan .ydocs must not outlive the board, because once the
            // store entry is gone the id no longer resolves as a board and
            // nothing can come back for them. (2) Delete the board: the
            // commit point. (3) Only now tear the live rooms down, which
            // destroys each task's discussion threads and is therefore the
            // one step that must never run ahead of a refusal. Both failure
            // paths unstage, so a failed DELETE costs nothing at all — not
            // even to a restart that lands right after it.
            // Attached docs are untouched throughout: attachDoc is a LINK,
            // so a doc a deleted board merely cited keeps working.
            const taskIds = taskStore.listTasks(workspaceId).map((t) => t.id);
            if (!taskProjection.stageWorkspaceFiles(workspaceId, taskIds).ok) {
              taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
              return j(500, { ok: false, error: 'rooms-cleanup-failed' });
            }
            // force: the open-task guard was applied above.
            const hub = taskStore.deleteWorkspace(workspaceId, { force: true });
            if (!hub.ok) {
              taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
              // 'persist-failed' is a 500, not a 404: the board is still
              // there, and the caller must not read the refusal as "already
              // gone" and stop asking.
              return j(hub.error === 'persist-failed' ? 500 : 404, hub);
            }
            taskProjection.dropWorkspaceRooms(workspaceId, hub.taskIds);
            return j(200, { ok: true, deletedTasks: hub.deletedTasks });
          }
          const res = rooms.deleteWorkspace(workspaceId, { force });
          if (res.ok) {
            // The grouping was one row on a board; deleting it must take the
            // row with it, the same way a deleted doc does.
            unlinkFromEveryHubWorkspace(workspaceId);
            return j(200, res);
          }
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
            if (res.ok) {
              unlinkFromEveryHubWorkspace(docId);
              return j(200, res);
            }
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
              // Same gate as thread creation: this route can plant a
              // malformed anchor on an EXISTING thread just as easily.
              const reanchorCheck = anchors.validateAnchor(anchor);
              if (!reanchorCheck.ok) return j(400, { error: reanchorCheck.error });
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
            // Validate BEFORE the write. An anchor whose startRel/endRel
            // don't decode is accepted silently by the CRDT and then kills
            // the re-anchor sweep from inside a Yjs observer, i.e. on
            // whatever request happens to be in flight minutes later. The
            // caller that wrote it has to be the one that hears about it.
            const anchorCheck = anchors.validateAnchor(anchor);
            if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
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
            // A `task:<id>` doc is a task's DESCRIPTION, not a free-standing
            // document, and rewriting one is an act the board has a name for.
            // Reachable here by anyone who knows the docId convention, so this
            // route runs the same ceremony `/api/tasks/:id/body` does rather
            // than writing the room and walking away. It is not refused: that
            // would take away the only body-rewrite a bundle older than
            // `update_task_body` (0.1.24) has, to buy a guarantee this branch
            // can simply provide.
            const bodyTaskId = taskIdOfBodyDoc(docId);
            const bodyTask = bodyTaskId ? taskStore.getTask(bodyTaskId) : undefined;
            if (bodyTask) {
              const author = authorFor(body?.author);
              const res = rewriteTaskBody(bodyTask, markdown, {
                ...(author ? { actor: author } : {}),
              });
              return res.ok ? j(200, { ok: true }) : j(409, res);
            }
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
          return new Response(
            renderHubShell(workspace.id, workspace.name, { feedback: !visitor }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
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
          const model = buildLandingModel(collectLandingDocs(rooms, taskStore), Date.now());
          return new Response(renderLanding(model), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        // --- One project's artifacts, on demand ---
        // The landing page deliberately does not carry these. Work here is
        // proportional to the project somebody actually opened, not to every
        // room on the server.
        if (pathname.startsWith('/projects/')) {
          let owner: string;
          try {
            owner = decodeURIComponent(pathname.slice('/projects/'.length));
          } catch {
            return new Response('bad project', { status: 400 });
          }
          if (owner === '') return new Response('not found', { status: 404 });
          const artifacts = buildProjectArtifacts(rooms, withReviewUrl, owner);
          return new Response(renderProjectPage(owner, artifacts), {
            status: artifacts.length === 0 ? 404 : 200,
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

  /**
   * The base every human-facing URL this server emits is built on.
   *
   * One function, so the operator override cannot reach some links and miss
   * others. That is not hypothetical tidiness: the links are the deliverable
   * of a TLS deploy — a `reviewUrl` still pointing at `http://<host>:<port>`
   * sends the reader back to the origin the deploy existed to leave, where
   * the browser refuses the microphone. Missing one call site would look
   * entirely fine until someone pressed the mic on that particular link.
   *
   * A function rather than a captured constant because `server.port` is only
   * known after `Bun.serve` resolves port 0.
   */
  function externalBaseUrl(): string {
    return opts.publicBaseUrl ?? publicBaseUrl(server.port ?? port);
  }

  // Decorate doc metadata with a `reviewUrl` that's actually reachable from
  // other devices on the tailnet / LAN. Markdown docs render at /review/...;
  // mockup docs bound to a file on disk render at /mockup/<docId> — same
  // one-call-one-URL contract as markdown. Mockup docs without a sourceUrl
  // (e.g. dev-server surfaces hosted elsewhere) get no URL — there's nothing
  // for us to serve.
  function withReviewUrl<T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ): T & { reviewUrl?: string } {
    const base = externalBaseUrl();
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
 *
 * `feedback` embeds the comment widget, pointed at ONE well-known doc
 * (`HUB_FEEDBACK_DOC_ID`) rather than at a per-workspace one — feedback about
 * the hub UI is about the product, not about the workspace you happened to be
 * standing in, so it should reach the same place from every hub. The widget
 * auto-captures `location` as the anchor url, so the comment already says
 * which hub it came from; `view` adds the workspace NAME so the thread reads
 * without anyone resolving an id.
 *
 * `identity-scope="host"` is what makes the feedback ATTRIBUTED. The widget
 * normally keeps its identity under a `cfw:` prefix so it cannot touch a
 * third-party host page's storage — but this page is ours, and the hub has
 * already asked the reader their name (`ensureUserIdentity`, unprefixed keys).
 * Without this attribute the same page holds two identities for one human: the
 * presence strip greets the reader by the name they gave, while every comment
 * the widget posts from that same page is signed "Anonymous <animal>".
 * Observed in a browser on 2026-08-17.
 *
 * Declarative `<claude-feedback-widget>` rather than `FeedbackWidget.init` on
 * purpose: a module script is deferred, so a plain inline script calling
 * `init` would run before the module that defines it. The element upgrades on
 * parse and reads its own attributes.
 */
function renderHubShell(
  workspaceId: string,
  name: string,
  opts: { feedback: boolean } = { feedback: false },
): string {
  const safeName = escape(name);
  const safeId = escape(workspaceId);
  // Deliberately NOT rendered for a share visitor. Every peer on a Yjs doc
  // syncs the whole doc, so one shared feedback doc would hand every hub
  // visitor every other workspace's feedback threads — including the hub
  // paths and quoted UI text they were anchored to. Same lesson as the
  // DocMeta sidecar: a field that must not reach a visitor cannot live in a
  // CRDT they sync. Keeping the widget off their page keeps them off the doc.
  const widget = opts.feedback
    ? `
    <script type="module" src="/widget.esm.js"></script>
    <claude-feedback-widget doc-id="${escape(HUB_FEEDBACK_DOC_ID)}" view="${safeName}" identity-scope="host"></claude-feedback-widget>`
    : '';
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
    <script type="module" src="/app/hub.js"></script>${widget}
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
/**
 * Is the thing this doc reviews still on disk?
 *
 * Two shapes, one question. A standalone doc reviews a FILE, so its
 * `sourceUrl` is the thing to look for; a workspace member reviews one file of
 * a bound FOLDER, and the honest per-artifact question there is whether the
 * folder itself survives — a diff review routinely contains members whose
 * files are deleted on purpose, so asking per member would report every normal
 * deletion as an abandoned review.
 *
 * `seen` memoizes within one request. 3,500 docs mostly share a few hundred
 * roots, and this runs on a page that already walks every room.
 */
function reviewSourceMissing(meta: DocMeta, seen: Map<string, boolean>): boolean {
  const target = meta.workspaceId ? meta.workspaceRoot : meta.sourceUrl;
  // A dev-server or mockup doc points at a URL, not a path — nothing on this
  // machine's filesystem answers for it, so it is never "gone".
  if (!target || /^https?:\/\//.test(target)) return false;
  const cached = seen.get(target);
  if (cached !== undefined) return cached;
  let missing = false;
  try {
    missing = !existsSync(target);
  } catch {
    // Unknowable is not missing: an unreadable path would otherwise flag every
    // artifact under it as abandoned on the strength of a permissions error.
    missing = false;
  }
  seen.set(target, missing);
  return missing;
}

/**
 * Every room the landing page can say something about, as the pure model
 * wants it.
 *
 * Two kinds arrive here and only one of them is an artifact. A review doc is
 * something a person put up for review, and it belongs to a PROJECT (the
 * creating agent's cwd). A `task:<id>` room is a task's discussion on a hub
 * board — not an artifact, so it carries no `artifactId` and inflates nobody's
 * count, but its unanswered questions are exactly the cross-workspace "someone
 * needs you" the page exists to surface, so its threads come along. `ws:<id>`
 * board rooms carry no threads of their own and are skipped outright.
 */
function collectLandingDocs(rooms: Rooms, taskStore: TaskStore): LandingInputDoc[] {
  const out: LandingInputDoc[] = [];
  const seen = new Map<string, boolean>();
  for (const meta of rooms.list()) {
    // Infrastructure, not an artifact: the shared hub-feedback doc exists on
    // every install from startup, and the board rooms are surfaces the server
    // owns. Same exclusions the previous index made, for the same reasons.
    if (meta.docId === HUB_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:')) continue;

    if (meta.docId.startsWith('task:')) {
      const taskId = meta.docId.slice('task:'.length);
      const task = taskStore.getTask(taskId);
      // A finished task's discussion is not a queue item — answering it
      // changes nothing, which is the same call `review-queue` makes.
      if (!task || task.status === 'done') continue;
      const ws = taskStore.getWorkspace(task.workspaceId);
      if (!ws) continue;
      out.push({
        groupKey: `ws:${ws.id}`,
        groupLabel: ws.name,
        groupKind: 'workspace',
        groupHref: `/workspaces/${encodeURIComponent(ws.id)}`,
        name: task.title,
        link: { kind: 'task', workspaceId: ws.id, taskId: task.id },
        threads: rooms.listThreads(meta.docId),
      });
      continue;
    }

    const owner = meta.owner || 'ungrouped';
    out.push({
      groupKey: owner,
      groupLabel: projectLabel(owner),
      groupKind: 'project',
      groupHref: `/projects/${encodeURIComponent(owner)}`,
      name:
        meta.relPath ?? (meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId),
      link: { kind: 'doc', docId: meta.docId },
      threads: rooms.listThreads(meta.docId),
      // Every member of a bound folder / diff review shares ONE artifact id,
      // so a 60-file review counts as the single thing somebody put up.
      artifactId: meta.workspaceId ?? meta.docId,
      ...(reviewSourceMissing(meta, seen) ? { sourceMissing: true } : {}),
    });
  }
  return out;
}

/**
 * One project's artifacts, built only when somebody opens that project.
 *
 * This is the old whole-server index, narrowed to a single owner: the same
 * rollup of workspace members into one expandable row, the same per-artifact
 * open counts. What changed is WHEN it runs — `buildWorkspaceTree` per
 * workspace and a nested file list per artifact was the bulk of both the 910
 * KB and the per-request work on a page that mostly nobody scrolled.
 */
function buildProjectArtifacts(
  rooms: Rooms,
  decorate: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string },
  owner: string,
): LandingArtifact[] {
  const workspaceArtifacts = new Map<string, LandingArtifact>();
  const artifacts: LandingArtifact[] = [];

  for (const meta of rooms.list()) {
    if (meta.docId === HUB_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:') || meta.docId.startsWith('task:')) continue;
    if ((meta.owner || 'ungrouped') !== owner) continue;

    const threads = rooms.listThreads(meta.docId);
    const openCount = threads.filter((t) => t.status === 'open').length;
    // Thread activity, never `meta.lastActivityAt` — see the header note in
    // landing.ts. That field is the `.ydoc` mtime and a snapshot rewrite
    // refreshes it, so it ranks by persistence noise.
    const lastActivity = threads.reduce((max, t) => Math.max(max, t.lastActivity), 0);

    if (meta.workspaceId) {
      let art = workspaceArtifacts.get(meta.workspaceId);
      if (!art) {
        const tree = rooms.buildWorkspaceTree(meta.workspaceId);
        const files = flattenWorkspaceFiles(tree.tree);
        // Clicking the workspace opens its entry file directly (the biggest
        // change for a diff review, first file otherwise); expansion is a
        // separate affordance in the renderer.
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
        artifacts.push(art);
      }
      // A diff member marks the whole workspace as a diff review (members can
      // also include plain 'code' context docs — any diff doc wins).
      if (meta.type === 'diff') art.kind = 'diff';
      art.threadCount += threads.length;
      if (lastActivity > art.lastActivity) art.lastActivity = lastActivity;
      continue;
    }

    const decorated = decorate(meta);
    artifacts.push({
      kind: (meta.type as ArtifactKind) ?? 'markdown',
      name: meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId,
      id: meta.docId,
      reviewUrl: decorated.reviewUrl,
      openCount,
      threadCount: threads.length,
      lastActivity,
    });
  }

  artifacts.sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name);
  });
  return artifacts;
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

/**
 * Shared chrome for the two server-rendered pages (`/` and `/projects/<owner>`).
 *
 * Mobile is load-bearing here — this is the page Bryan lands on from his
 * phone. Every rule is authored for a 430px viewport first: single column, no
 * fixed widths, and `min-width: 0` on every flex child that holds prose, which
 * is the flex twin of the `minmax(0, 1fr)` grid footgun in
 * docs/product/design-mobile.md. Nothing here reaches into styles.css: the
 * landing page is server-rendered and owns its own styles, so the client
 * bundle's cascade cannot move it.
 */
const LANDING_CSS = `
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:760px;padding:20px 14px 40px;color:#1b1f23;overflow-wrap:anywhere}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a;margin:26px 0 8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.count{font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:#8b95a1}
.summary{color:#6e7781;font-size:12px;margin:0 0 4px}
ul{padding:0;list-style:none;margin:0}
a{color:#2e7dd7;text-decoration:none}
a:hover{text-decoration:underline}
.need{border-left:3px solid #e36f1e;background:#fffaf5;border-radius:0 6px 6px 0;margin-bottom:6px}
.need a{display:block;padding:9px 12px;color:inherit}
.need a:hover{text-decoration:none;background:#fff3e8}
.need-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;font-size:12px;color:#8b95a1}
.need-wait{font-weight:700;color:#bf5b16;flex-shrink:0}
.need-where{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.need-ask{margin-top:2px;font-size:15px;color:#1b1f23}
.grp{border-bottom:1px solid #f0f2f4}
.grp-link{display:block;padding:10px 4px;color:inherit;min-height:44px}
.grp-link:hover{text-decoration:none;background:#f8f9fb}
.grp-row{display:flex;align-items:baseline;gap:8px}
.grp-name{flex:1;min-width:0;font-weight:600;font-size:15px;color:#2e7dd7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-meta{color:#8b95a1;font-size:12px;margin-top:2px}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500;flex-shrink:0}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-need{background:#e36f1e;color:#fff;font-weight:700}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-kind{background:#f6f8fa;color:#8b95a1}
.badge-gone{background:#fdecec;color:#b42318}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
li.artifact{padding:9px 0;border-bottom:1px solid #f3f4f6}
li.artifact.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:8px}
.art-glyph{flex-shrink:0;font-size:13px;width:1.4em;text-align:center}
.art-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 36px minimum tap target (design-mobile.md). An inline link is ~23px tall,
   so every link a thumb aims at gets vertical padding rather than a bigger
   font — this page is read on a phone. */
.art-name a{font-weight:600;display:inline-block;padding:7px 0}
.art-sub{color:#8b95a1;font-size:11px;flex-shrink:0}
.meta{color:#8b95a1;font-size:11px;margin-top:3px;padding-left:1.4em}
details > summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none;min-height:36px;align-items:center}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'\\25B8';color:#8b95a1;font-size:11px;flex-shrink:0}
details[open] > summary::before{content:'\\25BE'}
.ws-files{margin:6px 0 0 1.8em;border-left:1px solid #eef0f2;padding-left:10px}
.ws-file{display:flex;align-items:baseline;gap:8px;padding:3px 0}
.ws-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ws-file-name a{display:inline-block;padding:9px 0}
.ws-file.empty{color:#8b95a1;font-style:italic}
.empty{color:#6e7781;padding:18px 0;font-style:italic;font-size:13px}
.back{font-size:13px;display:inline-block;padding:8px 0;margin-bottom:4px}
footer{margin-top:28px;color:#8b95a1;font-size:11px}
`;

function landingShell(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>${LANDING_CSS}</style>
${body}
<footer>POST /api/docs · /widget.iife.js · /demos/mockup</footer>`;
}

/** A duration, at the coarsest unit that still says something. Distinct from
 *  `formatRelative`, which takes a timestamp — the band already computed its
 *  own elapsed time against a single `now`, and re-reading the clock per row
 *  would let two rows on one page disagree about what time it is. */
function formatWait(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function renderNeedsYouRow(r: NeedsYouRow): string {
  return `<li class="need"><a href="${escape(r.href)}">
    <div class="need-top"><span class="need-wait">${escape(formatWait(r.waitedMs))}</span><span class="need-where">${escape(r.group)} · ${escape(r.name)}</span></div>
    <div class="need-ask">${escape(r.ask)}</div>
    <div class="need-top">${escape(r.askedBy)}</div>
  </a></li>`;
}

function renderGroupRow(g: LandingGroupRow): string {
  const needBadge =
    g.needsYou > 0 ? `<span class="badge badge-need">${g.needsYou} need you</span>` : '';
  const openBadge =
    g.openThreads > 0 ? `<span class="badge badge-open">${g.openThreads} open</span>` : '';
  // What each row COUNTS differs by kind, and saying "0 artifacts" on a board
  // that has none would read as an empty project rather than a different kind
  // of thing.
  const size =
    g.kind === 'workspace' ? 'board' : `${g.artifacts} artifact${g.artifacts === 1 ? '' : 's'}`;
  const activity =
    g.lastActivity > 0 ? `last comment ${formatRelative(g.lastActivity)}` : 'no comments yet';
  // Forgetting, made visible, and nothing more. No row is hidden, nothing is
  // acted on, and no cleanup affordance sits next to this badge: archiving is
  // a separate step that has not been built yet (soft delete is the project
  // rule), so the honest thing is a fact with no verb attached.
  const gone =
    g.missingSources > 0
      ? `<span class="badge badge-gone">${g.missingSources} source${g.missingSources === 1 ? '' : 's'} gone</span>`
      : '';
  // The whole row is the tap target, not the name inside it. An inline text
  // link is ~21px tall, under the 36px floor in docs/product/design-mobile.md,
  // and this is the page Bryan opens on a phone.
  return `<li class="grp"><a class="grp-link" href="${escape(g.href)}">
    <div class="grp-row"><span class="grp-name">${escape(g.label)}</span><span class="badges">${needBadge}${openBadge}${gone}</span></div>
    <div class="grp-meta">${escape(size)} · ${escape(activity)}</div>
  </a></li>`;
}

function renderLanding(model: LandingModel): string {
  // The denominator ships whatever the numerator is — including zero. An
  // empty list with no denominator reads as a fleet-wide all-clear, which is
  // the failure written up as "An empty list is a clearance only if you also
  // render the denominator" in docs/process/learnings.md.
  const shown = model.needsYou.length;
  const denom = `${shown} of ${model.needsYouTotal} shown`;
  const needs =
    shown === 0
      ? `<div class="empty">Nothing is waiting on you (0 of ${model.needsYouTotal}).</div>`
      : `<ul>${model.needsYou.map(renderNeedsYouRow).join('')}</ul>`;
  const groups =
    model.groups.length === 0
      ? '<div class="empty">No workspaces yet — POST /api/docs to create one.</div>'
      : `<ul>${model.groups.map(renderGroupRow).join('')}</ul>`;
  return landingShell(
    'Live Feedback',
    `<h1>Live Feedback</h1>
<div class="summary">${model.totalArtifacts} artifact${model.totalArtifacts === 1 ? '' : 's'} · ${model.totalOpen} open thread${model.totalOpen === 1 ? '' : 's'} · ${model.groups.length} workspace${model.groups.length === 1 ? '' : 's'}</div>
<h2>Needs you <span class="count">${escape(denom)}</span></h2>
${needs}
<h2>Workspaces <span class="count">${model.groups.length}</span></h2>
${groups}`,
  );
}

/** The "artifacts on demand" half: one project's contents, fetched only when
 *  somebody asks for that project. Keeping this off `/` is what took the
 *  landing response from ~910 KB to a few KB — the nested per-file lists were
 *  most of the bytes and none of the reason anyone opened the page. */
function renderProjectPage(owner: string, artifacts: LandingArtifact[]): string {
  const body =
    artifacts.length === 0
      ? '<div class="empty">No artifacts in this project.</div>'
      : `<ul>${artifacts.map(renderLandingArtifact).join('')}</ul>`;
  const open = artifacts.reduce((sum, a) => sum + a.openCount, 0);
  return landingShell(
    `${projectLabel(owner)} · Live Feedback`,
    `<a class="back" href="/">← all workspaces</a>
<h1>${escape(projectLabel(owner))}</h1>
<div class="summary">${escape(owner)}</div>
<div class="summary">${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} · ${open} open thread${open === 1 ? '' : 's'}</div>
${body}`,
  );
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
