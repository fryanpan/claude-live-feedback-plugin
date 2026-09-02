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
 */
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type ReviewPayload,
  type Thread,
  type User,
  anchors,
  answerAsksBack,
  answerFromReply,
  checkReviewPayload,
  isReviewPayloadHeld,
  latestThreadedQuestion,
  locateReviewItemRange,
  pendingDeclaration,
  readReviewPayload,
  reviewGapAdvice,
  reviewIdOf,
  reviewItemState,
  reviewPayloadMessage,
  suggestOps,
  summaryHash,
} from '@feedback/core';
import { needsCall } from '@feedback/core/summary-prompt';
import { classifyActor } from '../activity.ts';
import { normalizeDocHome, resolveHomeCheckout } from '../doc-home.ts';
import { RESERVED_DOC_PREFIXES } from '../doc-ids.ts';
import { compactDocRow, matchesDocFilters, pageDocs, parseListDocsQuery } from '../doc-listing.ts';
import { showFile } from '../git-diff.ts';
import {
  PLAN_REQUEST_COMMENT,
  RESEARCH_TOPIC_MAX,
  REVIEW_REQUEST_COMMENT,
  researchAskComment,
  researchPlaceholderMarkdown,
  researchSectionTitle,
} from '../huddle.ts';
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
import type { Rooms } from '../rooms.ts';
import { KEYCHAIN_SERVICE } from '../summarize.ts';
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
  isCategoryAuthor,
  parseAssigneeKind,
  resolveAssignee,
} from '../task-owner.ts';
import type { TaskProjection } from '../task-projection.ts';
import { taskIdOfBodyDoc } from '../task-projection.ts';
import { placeableGoals } from '../task-queue.ts';
import { clipToWordBoundary } from '../task-title.ts';
import { type Task, type TaskStore, taskChip } from '../tasks.ts';
import type { ThreadRequestDedup } from '../thread-request-dedup.ts';
import type { createWebhookDispatcher } from '../webhooks.ts';
/** The anchor's display snippet, whichever anchor kind carries it — an
 *  orphan keeps its original's snippet. */
function anchorSnippetText(anchor: Anchor): string | undefined {
  if (anchor.kind === 'subject') return undefined;
  if (anchor.kind === 'orphan') {
    return anchor.original.snippet?.text;
  }
  return anchor.snippet?.text;
}

/**
 * A comment's optional Review Item declaration, checked at the door.
 *
 * Every route that writes a comment calls this, because a payload that gets
 * past one of them is stored in the CRDT and renders on Bryan's Home queue
 * with a headline that does not fit two lines on a phone — which is the
 * defect the whole feature exists to remove, re-created by the feature.
 *
 * **Refuse rather than truncate.** Clipping a long headline is exactly what
 * produced the "titles are random detailed text" rows this replaces, and it
 * teaches the author nothing: the call returns 200, the row looks wrong, and
 * nobody connects the two. A 400 quoting every problem lands in a retrying
 * model's context, where it can be acted on.
 *
 * Returns `undefined` for an absent declaration — an ordinary comment is
 * still an ordinary comment, and the overwhelming majority are.
 *
 * `advice` is the non-refusing half: a payload that filed successfully but
 * left the card thin. It rides back on the 200 rather than being dropped
 * here, because an author who is never told writes the same thin item again.
 *
 * `text` is the comment the declaration arrived on. The checker needs it to
 * see a card whose links stayed behind in the comment — the reader acts from
 * the Home card, and the comment is not on it.
 */
function reviewFromBody(
  rawIn: unknown,
  text?: string,
): { ok: true; review?: ReviewPayload; advice?: string } | { ok: false; error: string } {
  if (rawIn === undefined || rawIn === null) return { ok: true };
  // The gate's own verdict is NEVER read off a caller's body. `judge` is
  // written by `runReviewGate` and restored from the CRDT by
  // `readReviewPayload`; accepting it here would let any filing clear the
  // gate with one key — `judge: {verdict: "ok"}` — which is a hole the
  // ticket form never had, because its verdict lives on a wrapper the
  // caller cannot address. Dropped silently: a payload carrying it is
  // almost certainly a peer echoing back an item it read, not an attack,
  // and refusing would bounce an otherwise honest ask.
  const raw =
    typeof rawIn === 'object' && rawIn !== null && 'judge' in (rawIn as Record<string, unknown>)
      ? (({ judge: _dropped, ...rest }) => rest)(rawIn as Record<string, unknown>)
      : rawIn;
  const check = checkReviewPayload(raw, { text });
  if (!check.ok) return { ok: false, error: reviewPayloadMessage(check) };
  const advice = reviewGapAdvice(check.gaps);
  // Stored via the reader so the agent-facing spellings (`review_type`,
  // 'question') land in the stored vocabulary and junk keys never persist.
  const review = readReviewPayload(raw);
  if (!review) return { ok: false, error: reviewPayloadMessage(check) };
  return { ok: true, review, ...(advice ? { advice } : {}) };
}

/** Attach the doc's pending syncError (if any) to a successful edit-tool
 *  response. Agents read edit results, not get_doc — so this is the surface
 *  where a disk↔doc conflict actually reaches whoever can fix it. */
function withSyncError(rooms: Rooms, docId: string, body: object): object {
  const syncError = rooms.getSyncError(docId);
  return syncError ? { ...body, syncError } : body;
}

/** Sentinel for a `placement` body value that is present but not one of the
 *  two known values — the route answers 400 rather than silently splicing at
 *  the default position (an insert in the wrong place is a structure edit
 *  the caller then has to hunt down and undo). */
const PLACEMENT_INVALID = Symbol('placement-invalid');

/** Parse an insert_blocks body's optional `placement`. Absent → undefined
 *  (core defaults to 'after-block', the historical behavior). */
function parsePlacement(
  value: unknown,
): 'after-block' | 'top-level' | undefined | typeof PLACEMENT_INVALID {
  if (value === undefined || value === null) return undefined;
  if (value === 'after-block' || value === 'top-level') return value;
  return PLACEMENT_INVALID;
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
      attached = rooms.attachFile(canonicalId, sourceUrl);
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
  const { rooms, taskStore, j, safeJson, canonicalDocId } = ctx;
  const { req, pathname, authorFor } = rq;
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
  const {
    rooms,
    taskStore,
    taskProjection,
    webhooks,
    leadPresence,
    readyNudger,
    threadRequestDedup,
    summarizer,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    isValidDocId,
    backTargetFor,
    resolveWorkspaceForDoc,
    withReviewUrl,
    unlinkFromEveryHubWorkspace,
    threadUrl,
    fileReviewRequest,
    judgeThreadReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    heldFields,
    rewriteTaskBody,
    parseRevisedRange,
  } = ctx;
  const { req, url, pathname, visitor, authorFor, refuseCategoryAuthor, metaFor, withTaskChips } =
    rq;
  const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
  if (docMatch) {
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
    // Tasks referencing this doc under EITHER of its names: origin and
    // link refs routinely hold the caller-chosen alias rather than the
    // minted id, and an exact-match query under only the canonical id
    // silently drops those rows from the doc's own surface.
    const docTaskRows = (): Task[] => {
      const rows = taskStore.tasksReferencingDoc(docId);
      const alias = room.meta.alias;
      if (alias === undefined || alias === docId) return rows;
      const seen = new Set(rows.map((t) => t.id));
      return [...rows, ...taskStore.tasksReferencingDoc(alias).filter((t) => !seen.has(t.id))];
    };
    // The chip a MEMBER sees carries what the doc page's derived-work
    // strip draws: where the row lives (a board id is an unguessable
    // URL capability, so it never reaches a visitor), and the two
    // plan-linkage marks. A visitor keeps the bare §3.3 chip.
    const docTaskEntries = (): Array<Record<string, unknown>> =>
      docTaskRows().map((t) =>
        visitor
          ? { ...taskChip(t) }
          : {
              ...taskChip(t),
              workspaceId: t.workspaceId,
              ...(t.planHold !== undefined ? { planHeld: true } : {}),
              ...(t.possiblyStale !== undefined ? { possiblyStale: true } : {}),
            },
      );
    if (rest === '' && req.method === 'GET') {
      // Doc→task surfacing (§3.12 commit 4): chips for the tasks that
      // reference this doc — directly or via one of its threads.
      // Visitor-safe by construction (§3.3 rule 2); omitted when empty.
      const taskRefs = docTaskEntries();
      // Which hub workspace this doc is attached to, so the doc surface
      // can route voice utterances (§3.8: voice is not board-only).
      // OWNER ONLY: a workspace id is an unguessable URL capability, and
      // a doc-scoped visitor must not learn it from a member doc.
      const hubWs = visitor ? null : taskStore.workspaceOfDoc(docId);
      // Where the review app's `←` should go: the board that links this
      // doc, rather than the machine-wide landing page. OWNER ONLY for
      // the same reason `hubWorkspaceId` is — a board id is an
      // unguessable URL capability, and a share visitor must not learn
      // one from a member doc. Resolved through the review when the
      // doc is a member of a review, which is where `hubWorkspaceId`
      // deliberately stops.
      const backTo = visitor ? null : backTargetFor(docId, room.meta.workspaceId);
      // Who the Make Plan float names ("Ask <lead> to create a plan").
      // Owner-only like the board id it comes from; a lead id is
      // already a display name everywhere the hub shows one.
      const lead = hubWs ? taskStore.getWorkspace(hubWs)?.leadAgentId : undefined;
      return j(200, {
        meta: metaFor(room.meta),
        ...(taskRefs.length > 0 ? { tasks: taskRefs } : {}),
        ...(hubWs ? { hubWorkspaceId: hubWs } : {}),
        ...(lead !== undefined ? { leadAgentId: lead } : {}),
        ...(backTo ? { backTo: { workspaceId: backTo.id, name: backTo.name } } : {}),
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
      const filter = status ? { status } : undefined;
      const threads: Array<Thread & { docId?: string }> = rooms
        .listThreads(docId, filter)
        .map((t) => withTaskChips(docId, t));
      // A `.md` diff member's companion editor doc holds the threads
      // the reviewer left in the File view. The agent asked about the
      // member because that is the id it was handed; answer for the
      // file, and tag each companion thread with the doc it lives on
      // so a reply lands there. Member threads keep their shape.
      const companionId = rooms.companionOf(docId);
      if (companionId) {
        for (const t of rooms.listThreads(companionId, filter)) {
          threads.push({ ...withTaskChips(companionId, t), docId: companionId });
        }
        threads.sort((a, b) => b.lastActivity - a.lastActivity);
      }
      return j(200, { threads });
    }
    // Task-chip resolution (§3.3 rule 2): how a chip inside a doc
    // resolves for a DOC-scoped invite, which never gets the workspace
    // board room. The chip is the visitor-safe shape (id, title,
    // status, assignee) — adding a field to it is a sharing decision.
    if (rest === 'tasks' && req.method === 'GET') {
      return j(200, { docId, tasks: docTaskEntries() });
    }
    // The plan gate's one control: a doc becomes a pending plan, or a
    // pending plan is approved — which clears every draft hold pointing
    // at it and releases the held rows to todo, attributed to the
    // approver. Owner-only: approval is a decision about the board, and
    // a share visitor does not hold that seat.
    if (rest === 'plan' && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const body = await safeJson(req);
      const state = body?.state;
      if (state !== 'pending' && state !== 'approved') {
        return j(400, { error: "state must be 'pending' or 'approved'" });
      }
      const author = authorFor(body?.author);
      if (!author) return j(400, { error: 'author required' });
      const set = rooms.setPlanState(docId, state, author.name);
      if (!set.ok) return j(404, { error: 'doc not found' });
      let released: string[] = [];
      if (state === 'approved') {
        const ids = room.meta.alias ? [docId, room.meta.alias] : [docId];
        const rel = taskStore.releasePlanHolds(ids, author);
        released = rel.released;
        // Holds cleared WITHOUT a transition (archived rows, rows
        // already moved) emit nothing — refresh those boards by hand,
        // the linkRef pattern.
        for (const wsId of rel.workspaceIds) taskProjection.ensureWorkspace(wsId);
      }
      return j(200, { docId, planState: state, released });
    }
    // The Make Plan float's press: the person asking this doc's agent
    // for a plan. The ask IS a comment — a subject-anchored thread
    // from the presser, riding the existing thread.created channel to
    // whoever watches — plus a server-written stamp so a reopened doc
    // renders "plan requested" rather than offering a first ask.
    // Owner-only for the same reason `plan` is: asking for board work
    // is a member's seat.
    if (rest === 'plan-request' && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (!author) return j(400, { error: 'author required' });
      // The same door every other comment route holds: the ask names a
      // person for the agent to answer, and the bare category "agent"
      // names nobody.
      if (isCategoryAuthor(author)) return refuseCategoryAuthor();
      const thread = await rooms.postComment(
        docId,
        null,
        author,
        PLAN_REQUEST_COMMENT,
        { kind: 'subject' },
        { generate: false },
      );
      if (!thread) return j(404, { error: 'doc not found' });
      const stamped = rooms.setPlanRequested(docId, author.name);
      return j(200, {
        docId,
        threadId: thread.id,
        ...(stamped.ok ? { requestedAt: stamped.requestedAt } : {}),
      });
    }
    // Whether this doc's asks have a live lead to land on. The page
    // registers itself by asking; changes arrive on its event stream.
    if (rest === 'lead-presence' && req.method === 'GET') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      return j(200, leadPresence.watch(docId));
    }
    // The Review float's press — the meeting's other one-tap ask: the
    // presser asking this doc's agent to read the notes and transcript
    // and question what is thin. Same shape as plan-request: the ask is
    // a subject thread from the presser, and the stamp names that
    // thread so the float can offer another ask once it is resolved.
    if (rest === 'review-request' && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (!author) return j(400, { error: 'author required' });
      if (isCategoryAuthor(author)) return refuseCategoryAuthor();
      const filed = await fileReviewRequest(docId, author, REVIEW_REQUEST_COMMENT);
      if (!filed) return j(404, { error: 'doc not found' });
      return j(200, { docId, ...filed });
    }
    // The pointer pill's Research press. NOT a task (it was, and Bryan
    // found a board row where the mock had a section in the notes):
    // an anchored thread on the selected line, from the presser, plus
    // a placeholder section inserted right after that line for the
    // agent to fill. Same channel as the two floats — a comment every
    // watching agent already hears — and the thread names the section
    // so the answer lands where the person will look.
    if (rest === 'research-request' && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (!author) return j(400, { error: 'author required' });
      if (isCategoryAuthor(author)) return refuseCategoryAuthor();
      const topicRaw = typeof body?.topic === 'string' ? body.topic.trim() : '';
      if (!topicRaw) return j(400, { error: 'topic required' });
      const topic = clipToWordBoundary(topicRaw, RESEARCH_TOPIC_MAX);
      const anchor = body?.anchor as Anchor | undefined;
      if (!anchor || anchor.kind !== 'text-range') {
        return j(400, { error: 'a text-range anchor is required' });
      }
      const anchorCheck = anchors.validateAnchor(anchor);
      if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
      const thread = await rooms.postComment(
        docId,
        null,
        author,
        researchAskComment(topic),
        anchor,
        { generate: false },
      );
      if (!thread) return j(404, { error: 'doc not found' });
      // After the thread, so the section follows the selection — the
      // same insertion an agent's insert_blocks_after_thread makes.
      // Top-level: a selection inside a bullet must not nest a
      // heading inside that bullet; the section goes after the list.
      const placed = rooms.insertBlocksAfterThread(
        docId,
        thread.id,
        researchPlaceholderMarkdown(topic),
        { placement: 'top-level' },
      );
      if (!placed.ok) {
        console.error(`[research-request] placeholder on ${docId}: ${placed.error}`);
      }
      return j(200, {
        docId,
        threadId: thread.id,
        section: researchSectionTitle(topic),
        placeholder: placed.ok,
      });
    }
    // --- The doc's repo home: pin, read, unpin. OWNER ONLY — a home is
    // host paths, which a share visitor must never see. The visitor
    // allowlist in host-guard already refuses unknown doc subroutes;
    // this is the local stop for the collab-host path.
    if (rest === 'home') {
      if (visitor) return j(403, { error: 'not available on a share' });
      if (req.method === 'GET') {
        const status = rooms.docHomeStatus(docId);
        return status ? j(200, { docId, ...status }) : j(404, { error: 'no home pinned' });
      }
      if (req.method === 'PUT') {
        const body = await safeJson(req);
        // Accept `{ home: {...} }` or the three fields at top level.
        const res = rooms.setDocHome(docId, body?.home ?? body);
        if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
        return j(200, { docId, home: res.home, placement: res.placement });
      }
      if (req.method === 'DELETE') {
        const res = rooms.clearDocHome(docId);
        return res.ok ? j(200, { docId, ok: true }) : j(404, { error: 'no home pinned' });
      }
      return j(405, { error: 'method not allowed' });
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
        if (isCategoryAuthor(user)) return refuseCategoryAuthor();
        const declared = reviewFromBody(body?.review, text);
        if (!declared.ok) return j(400, { error: declared.error });
        // A person's plain reply IS the answer to the ask it lands on.
        //
        // Three surfaces render an Answer composer and post at
        // `/answer`; every other door a reply comes through — a task
        // panel's discussion composer, the widget, MCP `post_reply`, an
        // older bundle — arrives here. Measured across this project's
        // stored docs, that gap left 12 declarations unanswered with a
        // person's reply sitting under each one, which is what made the
        // queue read as ignored while the reader had in fact answered.
        //
        // `pendingDeclaration` and `answerFromReply` are core's, shared
        // with the queue and the doc panel, so what counts as pending
        // and what counts as an answer are decided in one place. A
        // reply that DECLARES its own ask is skipped: that is a new
        // question, not an answer to the old one.
        const priorThread = declared.review ? null : rooms.getThread(docId, threadId);
        const pending = priorThread ? pendingDeclaration(priorThread) : null;
        const folded =
          pending?.review && classifyActor(user) === 'person'
            ? answerFromReply(pending.review, text)
            : null;
        let t: Thread | null = null;
        if (pending && folded) {
          // The whole answer path, exactly as the explicit route uses
          // it — the stamps, the displaced-answer history, the reply,
          // the events. A second writer here is how the two spellings
          // of "answered" would drift.
          const res = await rooms.answerReviewItem(
            docId,
            threadId,
            pending.id,
            user,
            text,
            folded.optionId,
            // Conditional on the item STILL being pending, re-checked
            // inside the same synchronous stretch as the stamp. The read
            // above is a claim about a moment already past; an
            // unconditional write here would let a reply folded on that
            // stale claim displace an answer somebody had meanwhile
            // given, and displace it into history where nobody looks.
            { generate: !visitor, onlyIfUnanswered: true },
          );
          if (res.ok) {
            t = res.thread;
            // Same nudge the explicit answer fires: an answer on a
            // COMMENT moves no task row, so `decision.answered` never
            // fires for it and the lead would otherwise not hear that
            // the thing it was blocked on came back.
            const foldedHome = resolveWorkspaceForDoc(docId);
            if (foldedHome) {
              readyNudger.reviewAnswered({ workspaceId: foldedHome, actorId: user.id });
            }
          }
          // A refusal here is the loser of that race, never a reason to
          // drop the words: fall through and post the reply as the
          // ordinary comment it always was.
        }
        if (!t) {
          t = await rooms.postComment(docId, threadId, user, text, undefined, {
            // A share visitor must not be able to spend the API key.
            generate: !visitor,
            ...(declared.review ? { review: declared.review } : {}),
          });
        }
        // The quality gate, on the same terms the ticket form gets: the
        // reply that DECLARES an ask is judged before anything says the
        // reader can see it. This is the path `.claude/rules` tells the
        // whole fleet to file asks on, so leaving it ungated meant the
        // gate covered the road nobody drives.
        const replyGate =
          t && declared.review
            ? await gateThreadDeclaration(docId, t, declared.review, user)
            : undefined;
        const handoff = threadUrl(docId, Boolean(visitor));
        return t
          ? j(200, {
              thread: rooms.getThread(docId, t.id) ?? t,
              ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
              ...(handoff ? { threadUrl: handoff } : {}),
              ...heldFields(replyGate),
            })
          : j(404, { error: 'thread not found' });
      }
      // Answering a Review Item. Deliberately a thin wrapper over the
      // reply above rather than a second write path: `text` is always
      // the verbatim answer, and `optionId` only records which offered
      // option those words came from. A person who types their own
      // answer sends no id and is not answering any less.
      if (threadRest === '/answer' && req.method === 'POST') {
        const body = await safeJson(req);
        const user = authorFor(body?.author);
        const text = body?.text as string | undefined;
        const commentId = body?.commentId as string | undefined;
        if (!user || !text || !commentId) {
          return j(400, { error: 'author + text + commentId required' });
        }
        // A person's question is not the answer, here either — same
        // conversion as the task review-item route. It posts as an
        // ordinary reply on the declaring thread: no answer stamp, so
        // the item stays open, and the owner hears the question the way
        // it hears every comment. `answerFromReply` refuses the same
        // reading on the plain-comment door, so the two doors agree. A
        // tapped option answers whatever its label reads.
        if (
          typeof body?.optionId !== 'string' &&
          classifyActor(user) === 'person' &&
          answerAsksBack(text)
        ) {
          const asked = await rooms.postComment(docId, threadId, user, text, undefined, {
            generate: !visitor,
          });
          if (!asked) return j(404, { error: 'thread not found' });
          return j(200, { asked: true, thread: rooms.getThread(docId, asked.id) ?? asked });
        }
        const res = await rooms.answerReviewItem(
          docId,
          threadId,
          commentId,
          user,
          text,
          typeof body?.optionId === 'string' ? body.optionId : undefined,
          { generate: !visitor },
        );
        if (!res.ok) {
          return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
        }
        // A review item on a COMMENT is the same ask as one on a
        // ticket, and its answer is the same thing to act on — but it
        // moves no task row, so `decision.answered` never fires for it
        // and the store-event bridge cannot see it. Wired here, at the
        // one route that records such an answer.
        const answerHome = resolveWorkspaceForDoc(docId);
        if (answerHome) {
          readyNudger.reviewAnswered({ workspaceId: answerHome, actorId: user.id });
        }
        return j(200, { thread: res.thread });
      }
      // Correcting a review item raised on a doc thread — the verb
      // that did not exist, and whose absence forced an agent that
      // found its own advice wrong to file a SECOND item, leaving the
      // reader two rows about one question with the older, wronger one
      // still reading as live.
      //
      // Addressed by commentId, like /answer directly above: that is
      // the identity `review-queue.ts` already keys a doc-thread row on
      // and the one `setCommentReview` already mutates by. Nothing was
      // minted for this route.
      if (threadRest === '/revise' && req.method === 'POST') {
        const body = await safeJson(req);
        const user = authorFor(body?.author);
        const commentId = body?.commentId as string | undefined;
        if (!user || !commentId) return j(400, { error: 'author + commentId required' });
        if (isCategoryAuthor(user)) return refuseCategoryAuthor();
        const parsed = parseRevisedRange(body?.revisedRange);
        if (!parsed.ok) return j(400, { error: parsed.error });
        const res = rooms.reviseCommentReview(
          docId,
          threadId,
          commentId,
          {
            ...(body?.headline !== undefined ? { headline: body.headline } : {}),
            ...(body?.detail !== undefined ? { detail: body.detail } : {}),
            ...(body?.options !== undefined ? { options: body.options } : {}),
          },
          {
            actor: user,
            ...(parsed.range ? { revisedRange: parsed.range } : {}),
          },
        );
        if (!res.ok) {
          return j(res.error === 'no-doc' || res.error === 'not-a-review-item' ? 404 : 400, {
            error: res.error,
            ...(res.message !== undefined ? { message: res.message } : {}),
          });
        }
        // Re-judged on every revision, exactly as the ticket form is:
        // the verdict was about the old words. Without this a hold on
        // this surface would be a dead end — the filer's one remedy
        // would leave the item held for words the judge never read.
        const gate = await judgeThreadReview(docId, threadId, commentId, res.review, user);
        // Watchers hear a revision the same way they hear the original
        // ask: the item changed, and anyone holding the old words is
        // holding words the reader can no longer see. Not while it is
        // held, though — a held item is on nobody's queue, so nothing
        // may buzz a phone claiming it is.
        if (!gate.held) announceThreadReview(docId, threadId, gate.review, user);
        return j(200, {
          thread: rooms.getThread(docId, threadId) ?? res.thread,
          review: gate.review,
          ...heldFields(gate),
        });
      }
      // Taking the ASK back — the asker's exit, as opposed to /answer
      // (the reader's) and /revise (a correction that keeps asking).
      //
      // Scoped to one comment on purpose. `/resolve` retires the whole
      // thread, so an agent that had filed a correction as a second
      // item on a shared thread could only clean up by taking its live
      // ask down alongside the stale one. This leaves the thread open
      // and its siblings answerable.
      //
      // Agents only. A withdrawal is a statement about what its author
      // meant to ask, and a share visitor is a reader — the person a
      // review item is FOR — so the door they get is /answer.
      if (
        (threadRest === '/withdraw' || threadRest === '/withdraw/undo') &&
        req.method === 'POST'
      ) {
        if (visitor) return j(403, { error: 'not available to share visitors' });
        const body = await safeJson(req);
        const user = authorFor(body?.author);
        const commentId = body?.commentId as string | undefined;
        if (!user || !commentId) return j(400, { error: 'author + commentId required' });
        if (isCategoryAuthor(user)) return refuseCategoryAuthor();
        const reason = body?.reason;
        if (reason !== undefined && typeof reason !== 'string') {
          return j(400, { error: 'reason must be a string' });
        }
        const res = rooms.withdrawCommentReview(docId, threadId, commentId, {
          actor: user,
          ...(reason !== undefined ? { reason } : {}),
          ...(threadRest === '/withdraw/undo' ? { undo: true } : {}),
        });
        if (!res.ok) {
          return j(res.error === 'no-doc' || res.error === 'not-a-review-item' ? 404 : 400, {
            error: res.error,
            ...(res.message !== undefined ? { message: res.message } : {}),
          });
        }
        // Announced on the way BACK only. `announceThreadReview` sends
        // the reader a push whose title is the item's headline — "here
        // is something to review" — so announcing a withdrawal would
        // buzz their phone with the exact ask that was just taken off
        // their queue. Reinstating does put an ask in front of them
        // again, and that is worth telling them about.
        // …unless the gate is still holding it. Reinstating restores an
        // item's standing, not its verdict: the words never changed, so
        // the hold placed on them stands and the queue still omits it.
        if (threadRest === '/withdraw/undo' && !isReviewPayloadHeld(res.review)) {
          announceThreadReview(docId, threadId, res.review, user);
        }
        return j(200, { thread: res.thread, review: res.review });
      }
      // Taking an answer back. The stamps move into the declaration's
      // `answerHistory` (soft delete — the words are user content) and
      // the reply comment stays in the thread. Un-stamping is what
      // re-offers the item on every surface: each queue derives
      // "waiting on you" from the stamps, so there is no second state
      // to sync. Same visitor gating as /answer — a share visitor's
      // click must not spend the API key.
      if (threadRest === '/answer/undo' && req.method === 'POST') {
        const body = await safeJson(req);
        const user = authorFor(body?.author);
        const commentId = body?.commentId as string | undefined;
        if (!user || !commentId) return j(400, { error: 'author + commentId required' });
        const res = rooms.undoReviewItemAnswer(docId, threadId, commentId, user, {
          generate: !visitor,
        });
        if (!res.ok) {
          return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
        }
        return j(200, { thread: res.thread });
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
            detail: `set CW_SUMMARIES=1 and add a key: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
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
        if (isCategoryAuthor(author)) return refuseCategoryAuthor();
        // Resolve is a thread change, so it schedules a summary — and a
        // visitor must not be able to spend the API key by clicking it.
        const t = rooms.resolve(docId, threadId, author, { generate: !visitor });
        return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
      }
      if (threadRest === '/reopen' && req.method === 'POST') {
        const body = await safeJson(req);
        const author = authorFor(body?.author);
        if (isCategoryAuthor(author)) return refuseCategoryAuthor();
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
        const placement = parsePlacement(body?.placement);
        if (placement === PLACEMENT_INVALID) {
          return j(400, { error: "placement must be 'after-block' or 'top-level'" });
        }
        const res = rooms.insertBlocksAfterThread(docId, threadId, markdown, { placement });
        return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
      }
    }
    if (rest === 'threads' && req.method === 'POST') {
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const text = body?.text as string | undefined;
      let anchor = body?.anchor as Anchor | undefined;
      if (!user || !text || !anchor) {
        return j(400, { error: 'author + text + anchor required' });
      }
      if (isCategoryAuthor(user)) return refuseCategoryAuthor();
      // Validate BEFORE the write. An anchor whose startRel/endRel
      // don't decode is accepted silently by the CRDT and then kills
      // the re-anchor sweep from inside a Yjs observer, i.e. on
      // whatever request happens to be in flight minutes later. The
      // caller that wrote it has to be the one that hears about it.
      const anchorCheck = anchors.validateAnchor(anchor);
      if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
      // Computed early (not just before the write, where it used to
      // live) so both the dedup escape hatch below and the normal
      // return can build the SAME response shape — a retry must get
      // its reviewAdvice back too, not just its thread.
      const requestId = typeof body?.requestId === 'string' ? body.requestId : undefined;
      const declared = reviewFromBody(body?.review, text);
      if (!declared.ok) return j(400, { error: declared.error });
      // Identity for the dedup below — computed from the RAW anchor
      // (so a duplicate call matches regardless of how the
      // review-item branch below rewrites `anchor` for the eventual
      // write), the declared review, AND the author. Codex review
      // caught both gaps in turn: anchor alone let a requestId reuse
      // with a CORRECTED review payload silently return the stale
      // thread, and anchor+review alone let two DIFFERENT people who
      // (client-controlled, not globally unique) happened to mint the
      // same requestId collide — the second author's comment would
      // come back attributed to the first.
      const identityKey = JSON.stringify({
        anchor,
        review: declared.review ?? null,
        authorId: user.id,
      });
      // A retry of an already-handled request has to be caught HERE,
      // before the review-item validation below: that block refuses a
      // second ask while the item is `waiting`, a state the FIRST
      // request's own side effect sets — so a retry would otherwise
      // never reach the dedupe() call at the bottom and would get a
      // stale-state 409 instead of the thread it already made.
      const priorThreadCreate = threadRequestDedup.lookup(docId, requestId, text, identityKey);
      if (priorThreadCreate) {
        const t = await priorThreadCreate;
        const handoff = threadUrl(docId, Boolean(visitor));
        // Re-read, because the FIRST request's judge wrote to the
        // comment after the thread this promise resolved to was built.
        // A retry told nothing about the hold would treat its filing as
        // accepted and wait on a reader who cannot see the item (codex
        // review) — so the verdict is read back off the stored payload.
        const settledPrior = t ? (rooms.getThread(docId, t.id) ?? t) : null;
        return t && settledPrior
          ? j(200, {
              thread: settledPrior,
              ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
              ...(handoff ? { threadUrl: handoff } : {}),
              ...heldFields(recordedThreadHold(docId, settledPrior, declared.review)),
            })
          : j(500, { error: 'could not create thread' });
      }
      // A thread on a PHRASE of a review item — the doc-style question
      // asked back at an ask. The anchor names an item this task must
      // carry, and its offsets must spell its snippet in the item's
      // current detail (or be absent, in which case the phrase is
      // located here). The write below is two writes: the thread, and
      // the question recorded on the item — which is what takes the
      // item off the reader's queue while the owner revises it.
      let itemAsk:
        | {
            taskId: string;
            reviewItemId: string;
            range: ReturnType<typeof locateReviewItemRange>;
          }
        | undefined;
      if (anchor.kind === 'review-item') {
        if (!docId.startsWith('task:')) {
          return j(400, {
            error: 'a review-item anchor belongs on a task doc (task:<taskId>)',
          });
        }
        const taskId = docId.slice('task:'.length);
        if (!taskStore.getTask(taskId)) return j(404, { error: 'task not found' });
        // The derived `r-legacy` row is admitted like any other — it
        // used to be refused here ("anchor a text-range there
        // instead"), which left a `needs: 'decision'` ticket's card
        // with no way to ask: an identical-looking card whose only
        // exit was Skip. `listReviewItems` derives the row, the
        // question is recorded on the task WITH its thread
        // (`requestMoreInfoOnReview` → `requestMoreInfo`), and the
        // decision leaves the reader's queue by the same derivation a
        // stored item does. Its `detail` is the task body, so a phrase
        // of the body anchors with offsets and the headline (the
        // title) anchors snippet-only.
        const wanted = anchor.reviewItemId;
        const item = taskStore.listReviewItems(taskId).find((r) => r.id === wanted);
        if (!item) return j(404, { error: 'unknown-review-item' });
        // One open question at a time. A second anchored ask while the
        // item is already `waiting` would orphan the first — `revise`
        // only reads the NEWEST threaded question (`latestThreadedQuestion`),
        // so a buried one could never be answered. Refused before the
        // thread is created (not just before the info-request stamp),
        // so a refusal never leaves an orphan thread with nothing
        // recorded against it.
        if (reviewItemState(item) === 'waiting') {
          const openThreadId = latestThreadedQuestion(item)?.threadId;
          const owner = item.createdBy.trim() || 'the owner';
          return j(409, {
            error: 'waiting',
            message: `Already waiting on ${owner} — add to the open thread instead`,
            ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
          });
        }
        const range = locateReviewItemRange(item.review.detail, {
          text: anchor.snippet.text,
          ...(anchor.start !== undefined ? { start: anchor.start } : {}),
          ...(anchor.end !== undefined ? { end: anchor.end } : {}),
        });
        if (!range) {
          return j(400, {
            error: "anchor.start/end do not spell anchor.snippet.text in the item's current detail",
          });
        }
        // Store the LOCATED anchor, so a snippet-only ask still renders
        // at its offsets.
        anchor = {
          kind: 'review-item',
          reviewItemId: item.id,
          snippet: { text: range.text },
          ...(range.start !== undefined && range.end !== undefined
            ? { start: range.start, end: range.end }
            : {}),
        };
        itemAsk = { taskId, reviewItemId: item.id, range };
      }
      // `dedupe` reserves (docId, requestId) synchronously and runs
      // this closure at most once for however many duplicate requests
      // arrive while it is in flight — the write AND the review-item
      // side effects it triggers, so a concurrent repeat never fires
      // `requestMoreInfoOnReview` a second time either.
      let gate: ThreadReviewGate | undefined;
      const { value: t } = await threadRequestDedup.dedupe(
        docId,
        requestId,
        text,
        identityKey,
        async () => {
          const created = await rooms.postComment(docId, null, user, text, anchor, {
            generate: !visitor,
            ...(declared.review ? { review: declared.review } : {}),
          });
          if (created && itemAsk?.range) {
            const asked = taskStore.requestMoreInfoOnReview(
              itemAsk.taskId,
              itemAsk.reviewItemId,
              text,
              { actor: user, threadId: created.id, range: itemAsk.range },
            );
            if (asked.ok) taskProjection.ensureWorkspace(asked.task.workspaceId);
          }
          if (created && declared.review) {
            // Judged before it is announced, and before this route
            // answers — see `gateThreadDeclaration`. Inside the dedupe
            // closure so a duplicated request cannot spend a second
            // judge call on one filing.
            gate = await gateThreadDeclaration(docId, created, declared.review, user);
          }
          return created;
        },
      );
      const handoff = threadUrl(docId, Boolean(visitor));
      const settled = t ? (rooms.getThread(docId, t.id) ?? t) : null;
      return t && settled
        ? j(200, {
            thread: settled,
            ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
            ...(handoff ? { threadUrl: handoff } : {}),
            // `gate` is undefined on a DEDUPLICATED request — it never
            // ran the closure — so the hold is read back off the stored
            // payload rather than dropped. See `recordedThreadHold`.
            ...heldFields(gate ?? recordedThreadHold(docId, settled, declared.review)),
          })
        : j(500, { error: 'could not create thread' });
    }
    if (rest === 'threads/by_find' && req.method === 'POST') {
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      const text = body?.text as string | undefined;
      const find = body?.find ? String(body.find) : '';
      if (!author || !text || find.length === 0) {
        return j(400, { error: 'author + text + find required' });
      }
      const declared = reviewFromBody(body?.review, text);
      if (!declared.ok) return j(400, { error: declared.error });
      const res = await rooms.createThreadByFind(
        docId,
        {
          find,
          contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
          contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
          occurrence: typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
        },
        author,
        text,
        // Visitor-authored text becomes the entire prompt on this route.
        { generate: !visitor, ...(declared.review ? { review: declared.review } : {}) },
      );
      const findGate =
        res.ok && declared.review
          ? await gateThreadDeclaration(docId, res.thread, declared.review, author)
          : undefined;
      const findHandoff = threadUrl(docId, Boolean(visitor));
      return res.ok
        ? j(200, {
            thread: rooms.getThread(docId, res.thread.id) ?? res.thread,
            ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
            ...(findHandoff ? { threadUrl: findHandoff } : {}),
            ...heldFields(findGate),
          })
        : j(409, res);
    }
    if (rest === 'content' && req.method === 'GET') {
      const doc = rooms.getDoc(docId);
      if (!doc) return j(404, { error: 'doc not found' });
      // `reader` marks this caller's copy of the doc as current-as-of-
      // now, which is what lets the stale-write guard below judge their
      // next whole-doc rewrite by order instead of the blunt time
      // window. Sent by get_doc since 0.1.113; older bundles omit it.
      const reader = url.searchParams.get('reader');
      if (reader) rooms.noteAgentRead(docId, reader);
      return j(200, doc);
    }
    // Cheap doc health check — metadata + counts, never the body.
    // Exists because get_doc has returned 320KB for one doc: an agent
    // that only needs "bound? wedged? how big?" must not have to pay
    // for (or overflow on) the content to find out.
    if (rest === 'status' && req.method === 'GET') {
      const status = rooms.getDocStatus(docId);
      if (!status) return j(404, { error: 'doc not found' });
      if (visitor) {
        // Same rule as `sourceUrl` in PRIVATE_META_KEYS: host-machine
        // paths are not workspace content. syncError goes with it —
        // its message can embed the bound path (backup locations,
        // parse errors naming the file).
        const { path: _path, syncError: _syncError, ...visitorSafe } = status;
        return j(200, visitorSafe);
      }
      return j(200, status);
    }
    // Whole-doc rewrite through the live doc — the safe replacement for
    // Write-the-bound-file + reparse_from_disk, which raced the
    // write-back and clobbered (see docs/research/2026-08-03 review).
    if (rest === 'content' && req.method === 'POST') {
      const body = await safeJson(req);
      const markdown = String(body?.markdown ?? '');
      if (markdown.length === 0) return j(400, { error: 'markdown is required' });
      // Stale-write guard (2026-08-26 incident): a whole-doc rewrite
      // built from a copy that predates a human's live edits destroys
      // those edits with a 200. The DEFAULT path is the protected one —
      // an old bundle that omits every new field still gets refused
      // when a human edited recently; only the explicit confirm field
      // opens the gate, and even then the backup below has already run.
      if (body?.confirmOverwriteHumanEdits !== true) {
        const reader = authorFor(body?.author)?.id;
        const stale = rooms.staleWriteCheck(docId, reader);
        if (stale) {
          return j(409, {
            error: 'stale-write',
            humanEditedAt: stale.humanEditedAt,
            ...(stale.lastReadAt !== undefined ? { lastReadAt: stale.lastReadAt } : {}),
            message:
              `REFUSED: a human edited this doc at ${new Date(stale.humanEditedAt).toISOString()}` +
              (stale.lastReadAt !== undefined
                ? `, AFTER your last read at ${new Date(stale.lastReadAt).toISOString()}`
                : ', within the last 10 minutes') +
              ' — a full rewrite from your in-context copy would destroy their work.' +
              ' Re-read the doc with get_doc, re-apply your change onto the CURRENT' +
              ' content (prefer a scoped tool: find_and_replace, rewrite_thread_region,' +
              ' edit_at_anchor), and only if a whole-doc rewrite is truly needed retry' +
              ' set_doc_content with confirmOverwriteHumanEdits: true.',
          });
        }
      }
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
      // Fold a successful task read_session onto the task record's
      // cumulative reading time. `recordReadEvent` clamps `payload`
      // in place (see `clampReadPayload`), so `durationMs` here is
      // already the server-trusted value, not whatever the browser
      // sent. Quiet on the task (no event, no `updatedAt`) — see
      // `TaskStore.recordReadingTime`.
      if (res.ok && type === 'read_session') {
        const taskId = taskIdOfBodyDoc(docId);
        const durationMs = payload.durationMs;
        if (taskId && typeof durationMs === 'number' && durationMs > 0) {
          taskStore.recordReadingTime(taskId, Math.round(durationMs / 1000));
        }
      }
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
        const placement = parsePlacement(body?.placement);
        if (placement === PLACEMENT_INVALID) {
          return j(400, { error: "placement must be 'after-block' or 'top-level'" });
        }
        const res = rooms.insertBlocksAtAnchor(docId, anchorId, markdown, { placement });
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
      const occurrence = typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined;
      const replaceAll = body?.replaceAll === true;
      if (body?.suggest === true) {
        if (replaceAll) {
          // Bulk suggestions are out of scope: the suggestion model is
          // one proposal per span, each individually acceptable.
          return j(400, {
            error: 'replaceAll cannot be combined with suggest — propose spans one at a time',
          });
        }
        const author = parseSuggestionAuthor(visitor ? { author: authorFor(body?.author) } : body);
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
        replaceAll,
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
          typeof body?.startOccurrence === 'number' ? Number(body.startOccurrence) : undefined,
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
        occurrence: typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
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
  return undefined;
}
