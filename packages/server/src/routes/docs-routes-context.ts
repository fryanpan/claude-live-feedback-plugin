/**
 * The vocabulary every `/api/docs/...` route module shares: the context and
 * request shapes all four of them take, and the three body parsers more than
 * one of them calls.
 *
 * It mirrors `task-routes-context.ts`, and for the reason that file gives.
 * `routes/docs.ts` used to hold this, which made the entry-point module its
 * own siblings' dependency: `doc-resource.ts`, `doc-threads-routes.ts` and
 * `doc-edit-routes.ts` are called BY `docs.ts` and imported types back OUT of
 * it, so the docs family was wired the opposite way round from the tasks
 * family next door. Same routes, same order, one home for the shared names.
 *
 * `ThreadReviewGate` is re-exported rather than declared: the gate that
 * produces it is `review-gate.ts`, a service, and a service may not import a
 * type out of `routes/`.
 */
import type { DocMeta, DocType, ReviewPayload, Thread, User, suggestOps } from '@feedback/core';
import type { DocRoom, DocStore } from '../doc-store.ts';
import type { createLeadPresenceMonitor } from '../lead-presence.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { ReadyWorkNudger } from '../ready-nudge.ts';
import type { ThreadReviewGate } from '../review-gate-types.ts';
import type { ThreadSummarizer } from '../summarize.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { Task, TaskStore } from '../tasks.ts';
import type { ThreadRequestDedup } from '../thread-request-dedup.ts';
import type { createWebhookDispatcher } from '../webhooks.ts';

export type { ThreadReviewGate };

/** Attach the doc's pending syncError (if any) to a successful edit-tool
 *  response. Agents read edit results, not get_doc — so this is the surface
 *  where a disk↔doc conflict actually reaches whoever can fix it. Used by
 *  both `doc-threads-routes.ts` and `doc-edit-routes.ts`, which is why it
 *  stays here rather than moving with either. */
export function withSyncError(docStore: DocStore, docId: string, body: object): object {
  const syncError = docStore.getSyncError(docId);
  return syncError ? { ...body, syncError } : body;
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

/** The long-lived collaborators these routes need, built once per server. */
export interface DocRoutesContext {
  /** Doc store — every route here is an operation on one. */
  docStore: DocStore;
  /** The board task store — doc↔board membership, and the rows a doc carries. */
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
  backTargetFor: (docId: string, attachmentId?: string) => { id: string; name: string } | null;
  /** The board a doc belongs to, or null. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** Decorate a doc's meta with its review URL. `precomputedHome` is the
   *  doc's board when a listing already resolved it off a shared index;
   *  `null` is a real answer (no board), `undefined` means "not supplied". */
  withReviewUrl: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
    precomputedHome?: string | null,
  ) => T & { reviewUrl?: string };
  /** doc id → the boards holding it, built once per request that needs it. */
  boardIndexForListing: () => Map<string, string[]>;
  /** Which boards hold a doc, answered off a prebuilt index. */
  boardsForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => Set<string>;
  /** Which board a doc calls home, answered off the same index. */
  homeForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => string | null;
  /** File a loose attachment under a board, minting Unfiled if needed. */
  fileUnderBoardWorkspace: (attachmentId: string, requested?: string) => string | undefined;
  /** Drop an attachment from every board that holds it. */
  unlinkFromEveryBoardWorkspace: (attachmentId: string) => void;
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
