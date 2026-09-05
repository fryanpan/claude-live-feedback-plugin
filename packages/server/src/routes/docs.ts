/**
 * The doc, thread and bind REST block, in the order it is matched.
 *
 * These routes were written as one long if-chain inside `createServer` and
 * the sequence was kept exactly through the move, so the file stays auditable
 * against the pre-split closure. Order is behaviour here in two ways:
 *
 *  - `/api/docs/:id/threads/:threadId/promote` is matched BEFORE the general
 *    `/api/docs/:id/...` resource block, because the resource block's own
 *    `threads/<id>` subroute would otherwise answer it;
 *  - inside the resource block, `threads/by_find` sits below `threads` POST
 *    and the exact-`rest` tests sit above every prefix match, so a longer
 *    path can never be swallowed by a shorter one's handler.
 *
 * THREE entry points because the block sits in three places, not one. The
 * doc create/list pair runs above the board's own routes; the promote route
 * runs below the board's goal list; and the resource block runs far below
 * both, under the meeting and calendar routes. Each entry point is called
 * from the position its routes occupied, so nothing overtakes anything.
 *
 * The guard against reordering is the per-route HTTP suite — `docs-*.test.ts`,
 * `threads-*.test.ts`, `bind-*.test.ts`, `promote-*.test.ts` — each of which
 * fails if its path starts reaching a different handler.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 *
 * The third entry point, `handleDocResourceRoutes`, is itself a chain of
 * three: this file still owns the `/api/docs/:id/...` match and resolves
 * `docId` / `room` / `rest` once (both halves of the alias contract — see
 * the comment inside the function), then delegates to `doc-resource.ts`
 * (the doc's own reads/writes, its task chips, the meeting-float asks, its
 * repo home, and content/status/diff/activity), `doc-threads-routes.ts`
 * (creating a thread and every per-thread mutation) and `doc-edit-routes.ts`
 * (whole-doc rewrite, disk reparse, agent anchors, find_and_replace,
 * suggestions, the structural deletes) — the same shape `routes/tasks.ts`
 * uses for its six. Call order among the three is fixed but NOT
 * load-bearing, same reasoning as `tasks.ts`: every `rest` check inside them
 * is exact-string-plus-method equality (or a regex anchored past the exact
 * strings), so no two of the ~30 subroutes can match the same request and a
 * fixed delegation order cannot make one answer a path meant for another.
 */
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type ReviewPayload,
  type Thread,
  type User,
  reviewIdOf,
  suggestOps,
} from '@feedback/core';
import { classifyActor } from '../actor-identity.ts';
import { normalizeDocHome, resolveHomeCheckout } from '../doc-home.ts';
import { RESERVED_DOC_PREFIXES } from '../doc-ids.ts';
import { compactDocRow, matchesDocFilters, pageDocs, parseListDocsQuery } from '../doc-listing.ts';
import type { createLeadPresenceMonitor } from '../lead-presence.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import {
  captureMockup,
  checkMockupSource,
  isHtmlMockupSource,
  readMockupHtml,
} from '../mockup-capture.ts';
import type { ReadyWorkNudger } from '../ready-nudge.ts';
import type { DocRoom, Rooms } from '../rooms.ts';
import { OUT_OF_SHARE_SCOPE, firstRefOutOfScope } from '../share/ref-scope.ts';
import type { ThreadSummarizer } from '../summarize.ts';
import {
  BAD_OPTIONS_ERROR,
  BAD_REF_ERROR,
  createdVisibility,
  parseLinks,
  parseNeeds,
  parseOptions,
} from '../task-create.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_MESSAGE,
  BAD_ASSIGNEE_KIND_ERROR,
  BAD_ASSIGNEE_KIND_MESSAGE,
  parseAssigneeKind,
  resolveAssignee,
} from '../task-owner.ts';
import type { TaskProjection } from '../task-projection.ts';
import { placeableGoals } from '../task-queue.ts';
import { clipToWordBoundary } from '../task-title.ts';
import { type Task, type TaskStore } from '../tasks.ts';
import type { ThreadRequestDedup } from '../thread-request-dedup.ts';
import type { createWebhookDispatcher } from '../webhooks.ts';
import { handleDocEditRoutes } from './doc-edit-routes.ts';
import { handleDocResourceCore } from './doc-resource.ts';
import { handleDocThreadRoutes } from './doc-threads-routes.ts';
/** The anchor's display snippet, whichever anchor kind carries it — an
 *  orphan keeps its original's snippet. */
function anchorSnippetText(anchor: Anchor): string | undefined {
  if (anchor.kind === 'subject') return undefined;
  if (anchor.kind === 'orphan') {
    return anchor.original.snippet?.text;
  }
  return anchor.snippet?.text;
}

/** Attach the doc's pending syncError (if any) to a successful edit-tool
 *  response. Agents read edit results, not get_doc — so this is the surface
 *  where a disk↔doc conflict actually reaches whoever can fix it. Used by
 *  both `doc-threads-routes.ts` and `doc-edit-routes.ts`, which is why it
 *  stays here rather than moving with either. */
export function withSyncError(rooms: Rooms, docId: string, body: object): object {
  const syncError = rooms.getSyncError(docId);
  // The write just landed: ask whether it left markdown syntax sitting in the
  // doc as literal characters. This is the only signal for that family of
  // corruption — the verb returns ok and the file on disk serializes back
  // correctly, so a reader of the rendered page is otherwise the first to
  // know. A disk conflict is the more urgent of the two, so it leads and the
  // integrity note is appended rather than replacing it.
  const literal = rooms.literalMarkdownSyncError(docId);
  if (syncError && literal) {
    return {
      ...body,
      syncError: { ...syncError, message: `${syncError.message}; ${literal.message}` },
    };
  }
  const combined = syncError ?? literal;
  return combined ? { ...body, syncError: combined } : body;
}

/** Sentinel for a `placement` body value that is present but not one of the
 *  two known values — the route answers 400 rather than silently splicing at
 *  the default position (an insert in the wrong place is a structure edit
 *  the caller then has to hunt down and undo). Used by both
 *  `doc-threads-routes.ts` and `doc-edit-routes.ts`. */
export const PLACEMENT_INVALID = Symbol('placement-invalid');

/** Parse an insert_blocks body's optional `placement`. Absent → undefined
 *  (core defaults to 'after-block', the historical behavior). */
export function parsePlacement(
  value: unknown,
): 'after-block' | 'top-level' | undefined | typeof PLACEMENT_INVALID {
  if (value === undefined || value === null) return undefined;
  if (value === 'after-block' || value === 'top-level') return value;
  return PLACEMENT_INVALID;
}

/** Parse a `suggest: true` request body's `author` field into a
 *  SuggestionAuthor. Requires `id` + `name`; `color` defaults so a caller
 *  that omits it (unlikely — MCP always sends the full identity) still
 *  produces an attributable proposal instead of a 400. Used by both
 *  `doc-threads-routes.ts` and `doc-edit-routes.ts`. */
export function parseSuggestionAuthor(
  body: Record<string, unknown> | null,
): suggestOps.SuggestionAuthor | null {
  const a = body?.author as { id?: unknown; name?: unknown; color?: unknown } | undefined;
  if (!a || typeof a.id !== 'string' || a.id.length === 0) return null;
  if (typeof a.name !== 'string' || a.name.length === 0) return null;
  return { id: a.id, name: a.name, color: typeof a.color === 'string' ? a.color : '#888888' };
}

/** The gate's answer for a COMMENT-borne item. Same three facts as
 *  `ReviewGate`; a bare payload where that one carries the wrapper.
 *
 *  It lives here rather than in the server closure for the same reason
 *  `ReviewGate` lives in `task-routes-context.ts`: both sides of the split
 *  need it — `createServer` runs the judge and these routes report what it
 *  said. */
export type ThreadReviewGate =
  | { held: false; review: ReviewPayload }
  | { held: true; review: ReviewPayload; reason: string; message: string };

/** The long-lived collaborators these routes need, built once per server. */
export interface DocRoutesContext {
  /** Doc rooms — every route here is an operation on one. */
  rooms: Rooms;
  /** The hub task store — doc↔board membership, and the rows a doc carries. */
  taskStore: TaskStore;
  /** The ydoc projection of the store, refreshed after writes that emit no
   *  store event. */
  taskProjection: TaskProjection;
  /** Webhook fan-out for thread events. */
  webhooks: ReturnType<typeof createWebhookDispatcher>;
  /** Who is holding the lead seat, for the doc page's presence chip. */
  leadPresence: ReturnType<typeof createLeadPresenceMonitor>;
  /** Wakes the lead when a row it owns becomes ready. */
  readyNudger: ReadyWorkNudger;
  /** Collapses concurrent identical thread requests onto one answer. */
  threadRequestDedup: ThreadRequestDedup<Thread | null>;
  /** The thread summarizer, or null when generation is not opted into. */
  summarizer: ThreadSummarizer | null;
  /** The data directory — read for the mockup capture's output path. */
  dataDir: string;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** Attribution for a write that arrived with no author at all. */
  ANONYMOUS_ACTOR: User;

  /** Whether a string may be used as a doc id at all. */
  isValidDocId: (s: string) => boolean;
  /** An alias or an id → the doc's own id. */
  canonicalDocId: (addressed: string) => string;
  /** Where a doc's back arrow goes — the board or review that holds it. */
  backTargetFor: (docId: string, reviewId?: string) => { id: string; name: string } | null;
  /** The board a doc belongs to, or null. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** Decorate a doc's meta with its review URL. `precomputedHome` is the
   *  doc's board when a listing already resolved it off a shared index;
   *  `null` is a real answer (no board), `undefined` means "not supplied". */
  withReviewUrl: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
    precomputedHome?: string | null,
  ) => T & { reviewUrl?: string };
  /** doc id → the hub boards holding it, built once per request that needs it. */
  boardIndexForListing: () => Map<string, string[]>;
  /** Which hub boards hold a doc, answered off a prebuilt index. */
  hubBoardsForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => Set<string>;
  /** Which board a doc calls home, answered off the same index. */
  homeForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => string | null;
  /** File a loose attachment under a hub board, minting Unfiled if needed. */
  fileUnderHubWorkspace: (attachmentId: string, requested?: string) => string | undefined;
  /** Drop an attachment from every hub board that holds it. */
  unlinkFromEveryHubWorkspace: (attachmentId: string) => void;
  /** The doc-thread URL a webhook or an SSE payload carries. */
  threadUrl: (docId: string, isVisitor: boolean) => string | undefined;

  /** Turn a "review this" ask into a filed review request. */
  fileReviewRequest: (
    docId: string,
    author: User,
    text: string,
  ) => Promise<{ threadId: string; requestedAt?: number } | null>;
  /** Put a comment-borne review declaration through the quality gate. */
  judgeThreadReview: (
    docId: string,
    threadId: string,
    commentId: string,
    review: ReviewPayload,
    author: User,
  ) => Promise<ThreadReviewGate>;
  /** Tell the addressee a comment-borne review item is waiting on them. */
  announceThreadReview: (
    docId: string,
    threadId: string,
    review: ReviewPayload,
    author: User,
  ) => void;
  /** Record that the gate held a comment-borne item, so a revision is judged
   *  against what was actually said. */
  recordedThreadHold: (
    docId: string,
    thread: Thread,
    review: ReviewPayload | undefined,
  ) => ThreadReviewGate | undefined;
  /** Run the gate over a declaration arriving on a comment. */
  gateThreadDeclaration: (
    docId: string,
    thread: Thread,
    review: ReviewPayload,
    author: User,
  ) => Promise<ThreadReviewGate>;
  /** The response fields a filing route adds when the gate held the item. */
  heldFields: (gate: ThreadReviewGate | undefined) => Record<string, unknown>;
  /** Replace a task's body markdown through the body doc. */
  rewriteTaskBody: (
    task: Task,
    markdown: string,
    opts: {
      actor?: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ) => { ok: true } | { ok: false; error: string };
  /** Parse a revise route's optional `revisedRange`. */
  parseRevisedRange: (
    raw: unknown,
  ) => { ok: true; range?: { start: number; end: number } } | { ok: false; error: string };
  /**
   * Every workspace an id belongs to — `shareWorkspacesOf`, the same resolver
   * the host guard scopes paths with. Read here for the fields the guard
   * cannot see, which are the ones a request names in its BODY: a promoted
   * row's cross-references. See `share/ref-scope.ts`.
   */
  workspacesOfDoc: (id: string) => string[];
}

/** What only this request knows. */
export interface DocRouteRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim. */
  authorFor: (claimed: unknown) => User | undefined;
  /** The 400 for an author that names a category rather than a person. */
  refuseCategoryAuthor: () => Response;
  /** The doc meta a REST reply carries — redacted when the caller is a share
   *  visitor, which is why it is per-request rather than per-server. */
  metaFor: <T extends DocMeta>(meta: T) => Record<string, unknown>;
  /** Attach the §-chips for the tasks a doc's thread produced. Per-request
   *  for the same reason: what a visitor is shown is narrower. */
  withTaskChips: <T extends { id: string }>(docId: string, t: T) => T;
}

/**
 * What only a `/api/docs/:id/...` resource-block route knows, on top of the
 * plain request: the doc `handleDocResourceRoutes` resolved from the path
 * (canonicalized — see that function), and the path remaining after the id,
 * tried by each of the three family handlers in turn.
 */
export interface DocResourceRouteRequest extends DocRouteRequest {
  /** The doc this resource route is operating on. */
  docId: string;
  /** The room for `docId`, already confirmed to exist. */
  room: DocRoom;
  /** The path after `/api/docs/:id/`, e.g. `''`, `threads`, `content`. */
  rest: string;
}

/**
 * The doc create and list pair, which run above the board's own routes.
 * `undefined` means neither matched and the caller's chain continues.
 */
export async function handleDocCreateListRoutes(
  ctx: DocRoutesContext,
  rq: DocRouteRequest,
): Promise<Response | undefined> {
  const {
    rooms,
    taskStore,
    dataDir,
    j,
    safeJson,
    isValidDocId,
    withReviewUrl,
    boardIndexForListing,
    hubBoardsForDocIndexed,
    homeForDocIndexed,
    fileUnderHubWorkspace,
  } = ctx;
  const { req, url, pathname } = rq;

  // --- REST: docs ---
  if (pathname === '/api/docs' && req.method === 'POST') {
    // A file bind names a host path. Agents only — see
    // browserCannotBindBody for why a page, on any origin, is refused.
    if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
    const body = await safeJson(req);
    const docId = (body?.docId as string) ?? '';
    if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
    const type = (body?.type as DocType) ?? 'markdown';
    let sourceUrl = body?.sourceUrl as string | undefined;
    // A markdown doc created WITHOUT a path can be placed by its
    // workspace's configured notes home: the file is derived as
    // `<dir>/<docId>.md` on the home branch and the doc is pinned
    // there (see rooms.setDocHome), which is what gets planning notes
    // checked in instead of scattered wherever a session's checkout
    // happens to sit. Opt-in twice over — the workspace set a
    // notesHome, and the caller named the workspace.
    let derivedHome: { repoRoot: string; branch: string; relPath: string } | null = null;
    if (type === 'markdown' && !sourceUrl) {
      const wsForNotes = typeof body?.hubWorkspaceId === 'string' ? body.hubWorkspaceId : undefined;
      const notes = wsForNotes ? taskStore.notesHome(wsForNotes) : undefined;
      if (notes) {
        const fileName = `${docId.replace(/[^a-zA-Z0-9._-]/g, '-')}.md`;
        const norm = normalizeDocHome({
          repoRoot: notes.repoRoot,
          branch: notes.branch,
          relPath: `${notes.dir}/${fileName}`,
        });
        if (!norm.ok) return j(400, { error: 'bad_notes_home', hint: norm.error });
        const placed = resolveHomeCheckout(norm.home);
        if (!placed.placed) {
          return j(409, {
            error: 'notes_home_unplaced',
            reason: placed.reason,
            hint: `The workspace notes home is ${notes.repoRoot} branch "${notes.branch}", but ${
              placed.reason === 'repo-missing'
                ? 'that path is not a git checkout any more'
                : placed.reason === 'path-escapes-checkout'
                  ? 'the notes dir passes through a symlink that leaves the checkout'
                  : 'no worktree has that branch checked out right now'
            }. Check the branch out (git worktree add <path> "${notes.branch}") and retry, or pass an explicit sourceUrl.`,
          });
        }
        derivedHome = norm.home;
        sourceUrl = placed.absPath;
      }
    }
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
    // A mockup binds to a file OUTSIDE the repo, so this route was the
    // one bind that took a path on faith: an unreachable one bound
    // happily, and the 404 arrived weeks later in front of whoever
    // opened the link. Markdown and code already fail their attach
    // loudly; this is the same courtesy.
    //
    // Both the check AND the read happen here, before the room exists,
    // for two reasons: a failed bind leaves nothing behind, and the
    // content held from this read is what the capture below stores — so
    // a source that goes away between the two steps is still a refusal
    // rather than a doc bound to a copy nobody took.
    let mockupHtml: string | null = null;
    if (type === 'mockup' && sourceUrl) {
      const unreadable = (reason: string) =>
        j(400, {
          error: 'mockup_source_unreadable',
          path: sourceUrl,
          reason,
          hint: `Cannot read the mockup HTML at ${sourceUrl} (${reason}). Pass an absolute path to a readable file — the server captures its content at bind time so the link keeps working after the file is cleaned up, and it cannot capture a file it cannot read.`,
        });
      const check = checkMockupSource(sourceUrl);
      if (!check.ok) return unreadable(check.reason);
      if (isHtmlMockupSource(sourceUrl)) {
        mockupHtml = readMockupHtml(sourceUrl);
        if (mockupHtml === null) return unreadable('became unreadable while binding');
      }
    }
    // The caller NAMES the doc; the server decides its id. `docId` in
    // the body is therefore a readable alias from here on — which is
    // also what closes the write-anywhere hole this route was: a
    // `task:<realTaskId>` body used to land on that task's live
    // description and file-bind it, 200 and no audit row. A caller
    // cannot address a server-owned namespace by a name it invents.
    const created = rooms.createForCaller(docId, {
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
    if (!created.ok) {
      return j(400, {
        error: created.error,
        hint: `"${docId}" is in a namespace the server owns (${RESERVED_DOC_PREFIXES.join(', ')}). Pick a docId that isn't.`,
      });
    }
    const room = created.room;
    // Canonical from here down. Everything below keys on the doc's own
    // id, never the name the request arrived under — two callers using
    // the two spellings of one doc must not end up with two of anything.
    const canonicalId = room.docId;
    // Before the file attach, not after: the room already exists at this
    // point, and the 409 below returns early — filing afterwards would
    // leave a failed bind as the one doc this route can still strand
    // outside a workspace.
    const hubWorkspaceId = fileUnderHubWorkspace(
      canonicalId,
      body?.hubWorkspaceId as string | undefined,
    );
    let attached: ReturnType<typeof rooms.attachFile> | undefined;
    if (type === 'markdown' && sourceUrl) {
      attached = await rooms.attachFileAsync(canonicalId, sourceUrl);
      if (!attached.ok) return j(409, { error: 'attach_failed', attached });
      // Notes-home creation: pin the doc to the derived home. The pin
      // exports the (possibly still missing) file and takes over the
      // binding, so branch churn from here on follows the branch.
      if (derivedHome) rooms.setDocHome(canonicalId, derivedHome);
    } else if (type === 'code' && sourceUrl) {
      attached = rooms.attachReadonlyFile(canonicalId, sourceUrl);
      if (!attached.ok) return j(409, { error: 'attach_failed', attached });
    }
    // Capture at bind, not merely on first serve: a mock that is bound
    // and then never opened until after its scratch dir is cleaned is
    // exactly the case that produced this. Keyed on the CANONICAL id,
    // so a rebind under the same readable name replaces the same copy.
    if (mockupHtml !== null) {
      // `allowEmpty`: a bind REPLACES, including with nothing. The
      // serve-time refusal protects a capture from its own source being
      // caught mid-write; a rebind names a different file, and holding
      // the old copy there would leave the link resolving to a mockup
      // nobody pointed it at.
      const captured = captureMockup(dataDir, canonicalId, mockupHtml, { allowEmpty: true });
      if (captured === 'failed') {
        // The bind READ fine — this is the data dir refusing the write,
        // so it is the box's problem, not the caller's, and it gets a
        // 5xx. It still fails: durability is part of what bind_mock now
        // promises, and a 200 here would hand back a link that reads as
        // durable and is not. That is the shape of the incident.
        //
        // DELIBERATELY not rolled back. The binding itself is in place
        // and works — the doc is exactly as durable as every mockup was
        // before this change — so the response says that rather than
        // claiming nothing happened. Undoing it would mean purging a
        // room, or restoring a previous sourceUrl, on the one path that
        // only fires when the disk is already refusing writes; that is
        // destructive machinery guarding a condition an operator has to
        // fix anyway, and the capture write is atomic, so a failure here
        // cannot have damaged an existing copy.
        return j(500, {
          error: 'mockup_capture_failed',
          docId: canonicalId,
          path: sourceUrl,
          bound: true,
          hint: `Bound ${canonicalId} to ${sourceUrl}, but could not store its captured copy under the data dir — see the server log for the write error. The binding works and serves from the file; it is NOT durable, so it will 404 once that file is gone. Fix the data dir and bind again.`,
        });
      }
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
    // `?workspaceId=` scopes the listing. Without honouring it here,
    // list_docs accepted the param and silently answered a board-scoped
    // question with every doc on the server. It matches either kind of
    // id a caller holds under the name "workspace": the review tag in
    // meta (folder binds, diff reviews) or a hub board the doc is filed
    // under — resolved via hubBoardsForDoc so the answer is the same
    // set the event fan-out and coverage readout already use.
    //
    // `?setId=` scopes it to one REVIEW instead. It exists because the
    // sidebar's legacy flat-set path had no way to ask: it fetched every
    // doc on the server — 4,205,683 bytes for 4,062 rows, measured
    // 2026-08-21 — and kept the 6 that shared its setId. Matching goes
    // through `reviewIdOf` so this route cannot answer differently from
    // the other set queries beside it (grouped diff, repo files, tree),
    // which means a doc restored from an archive carrying only the
    // deprecated `workspaceId` spelling is still found by its set.
    //
    // `?limit=` (or a `?cursor=`) switches the route into PAGED mode:
    // compact rows sorted by most recent activity, `limit` per page,
    // `nextCursor` to continue, `?full=1` for whole meta on that page.
    // Measured 2026-09-01: the unscoped dump was 7,420,585 bytes for
    // 5,919 rows, and a fresh session's first tool call was all of it.
    // Without `limit` the answer is the old one — every row, full meta —
    // because REST callers exist that cannot be restarted. The doc-level
    // filters (`kind`, `query`, `sourcePrefix`) apply in both modes.
    // See doc-listing.ts.
    const q = parseListDocsQuery(url.searchParams);
    const { workspaceId, setId } = q;
    const all = rooms.list();
    // ONE pass over the workspaces for the whole listing. Both the
    // board filter and the reviewUrl below used to run their own scan
    // per row, which is what made an unscoped listing quadratic — and
    // on Bun's single JS thread a quadratic listing stops the server
    // answering anything else while it runs. See `boardIndexForListing`.
    const boardIndex = boardIndexForListing();
    const byWorkspace = workspaceId
      ? all.filter(
          (m) =>
            m.workspaceId === workspaceId || hubBoardsForDocIndexed(boardIndex, m).has(workspaceId),
        )
      : all;
    const bySet = setId ? byWorkspace.filter((m) => reviewIdOf(m) === setId) : byWorkspace;
    const docs = bySet.filter((m) => matchesDocFilters(m, q));
    const decorate = (m: DocMeta) => withReviewUrl(m, homeForDocIndexed(boardIndex, m));
    if (q.limit === undefined) {
      return j(200, { docs: docs.map(decorate) });
    }
    const project = q.full
      ? decorate
      : (m: DocMeta) =>
          compactDocRow(decorate(m), {
            boardId: homeForDocIndexed(boardIndex, m),
            threads: rooms.threadCounts(m.docId),
          });
    return j(200, {
      ...pageDocs(docs, { limit: q.limit, cursor: q.cursor }, project),
      full: q.full,
    });
  }
  return undefined;
}

/** promote_to_task, which runs below the board's ordered goal list. */
export async function handleDocPromoteRoute(
  ctx: DocRoutesContext,
  rq: DocRouteRequest,
): Promise<Response | undefined> {
  const { rooms, taskStore, j, safeJson, canonicalDocId, workspacesOfDoc } = ctx;
  const { req, pathname, authorFor, visitor } = rq;
  // promote_to_task (§3.10): thread → task. Captures the origin ref,
  // the latest HUMAN comment as the verbatim quote (an agent's closing
  // note must never become the quote), and drafts a title + body the
  // caller didn't supply. classifyActor draws the person/agent line —
  // the same one replies and transitions use.
  const promoteMatch = pathname.match(/^\/api\/docs\/([^/]+)\/threads\/([^/]+)\/promote$/);
  if (promoteMatch && req.method === 'POST') {
    const docId = canonicalDocId(decodeURIComponent(promoteMatch[1] ?? ''));
    const threadId = decodeURIComponent(promoteMatch[2] ?? '');
    const body = await safeJson(req);
    const workspaceId = body?.workspaceId;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      return j(400, { error: 'workspaceId required' });
    }
    // A scoped caller — a share member, a collaborator — may promote onto the
    // board their scope covers and nowhere else.
    //
    // This is the one route on the share surface whose DESTINATION is named in
    // the body rather than in the path. The host guard read the path, found
    // the doc in scope and said yes; the body then chose a different board,
    // and the row landed there. So the destination is asked the same question
    // the path was, and the answer comes from the scope this request already
    // resolved rather than from a second membership rule that could drift.
    //
    // Fail closed: a scope with no workspace at all promotes nowhere. And
    // this sits ABOVE the existence check on purpose — 404 for a real id and
    // 403 for a made-up one would tell a member which board ids exist.
    if (visitor && workspaceId !== visitor.workspaceId) {
      return j(403, { error: 'out_of_share_scope' });
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
      typeof body?.quote === 'string' && body.quote.length > 0 ? body.quote : humanComment?.text;
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
    // The third body-borne ref surface, and the same rule as the other two
    // (share/ref-scope.ts): a member may annotate their promoted row with
    // things on their own board and nothing else. `origin` needs no check —
    // it is built from the doc and thread this route already scoped.
    if (firstRefOutOfScope(promoteLinks.links, visitor, workspacesOfDoc) !== undefined) {
      return j(403, OUT_OF_SHARE_SCOPE);
    }
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
    // A thread on a PENDING plan doc is part of the plan: its promoted
    // rows are drafts like the batch-filed ones, held until the same
    // approval. A doc with no plan gate (or an approved one) promotes
    // exactly as before.
    const promoteRoom = rooms.get(docId);
    const promoteHold =
      promoteRoom?.meta.planState === 'pending' ? { docId: promoteRoom.docId } : undefined;
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
      ...(promoteHold !== undefined ? { planHold: promoteHold } : {}),
      ...(quote !== undefined ? { quote } : {}),
      actor: promotedBy ?? undefined,
    });
    if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
    const promoteVisibility = createdVisibility(
      res.task.status,
      false,
      res.task.planHold !== undefined,
    );
    return j(200, {
      task: res.task,
      ...(promoteVisibility !== undefined ? { visibility: promoteVisibility } : {}),
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
    });
  }
  return undefined;
}

/**
 * Everything under `/api/docs/:id/...` — the doc itself, its threads, its
 * content and the edit tools. Runs far below the pair above, under the
 * meeting and calendar routes.
 */
export async function handleDocResourceRoutes(
  ctx: DocRoutesContext,
  rq: DocRouteRequest,
): Promise<Response | undefined> {
  const { rooms, j, isValidDocId } = ctx;
  const { pathname } = rq;
  const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
  if (!docMatch) return undefined;
  const addressed = decodeURIComponent(docMatch[1] ?? '');
  const rest = docMatch[2] ?? '';
  if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
  const room = rooms.get(addressed);
  if (!room) return j(404, { error: 'doc not found' });
  // Canonicalize ONCE, here, and the ~30 subroutes below inherit both
  // halves of the alias contract: a readable name resolves, and
  // everything they key on (SSE channels, activity rows, thread ids,
  // filenames) uses the doc's own id. Rebinding the name `docId` is
  // deliberate — it is what makes the subroutes correct by default
  // rather than each one having to remember.
  const docId = room.docId;
  const docRq: DocResourceRouteRequest = { ...rq, docId, room, rest };
  return (
    (await handleDocResourceCore(ctx, docRq)) ??
    (await handleDocThreadRoutes(ctx, docRq)) ??
    (await handleDocEditRoutes(ctx, docRq))
  );
}
