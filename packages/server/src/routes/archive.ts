/**
 * Archive and unarchive, for a review and for one free-standing doc.
 *
 * SOFT BY DEFAULT is the project rule these routes exist to keep: the `.ydoc`
 * is the durable record the analyses are rebuilt from, so a delete retires a
 * review rather than destroying it and `?purge=true` is how the destructive
 * half is asked for. The four routes and `DELETE /api/reviews/:id` are one
 * family because they share `archiveReview` and the board-relink bookkeeping
 * around it — a row pointing at a review that no longer loads is a dead end,
 * so archiving takes the row and the manifest remembers which boards to put
 * it back on.
 *
 * `deleteReview` is built here and handed back to `createServer`, because
 * `DELETE /api/workspaces/:id` (routes/workspace-delete.ts) fronts both verbs
 * and still calls it from further down the chain.
 *
 * Lifted verbatim out of `createServer`'s request closure, keeping its chain
 * position: after the agent attachments, before the board delete.
 * Dependencies arrive in an explicit context, following
 * `task-routes-context.ts`.
 */
import { attachmentIdOf } from '@feedback/core';
import type { DocStore } from '../doc-store.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { listArchivedDocs, listArchivedReviews } from '../review-archive.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { TaskStore } from '../tasks.ts';

/** Review-only delete. `DELETE /api/workspaces/<id>` still fronts both. */
const REVIEW_DELETE = /^\/api\/reviews\/([^/]+)$/;

/** The long-lived collaborators these routes need. */
export interface ArchiveRoutesContext {
  /** Doc store — the archive and unarchive verbs live on them. */
  docStore: DocStore;
  /** The board store — which boards link a review, and where it goes back. */
  taskStore: TaskStore;
  /** The ydoc projection, refreshed by hand after an unarchive re-attaches. */
  taskProjection: TaskProjection;
  /** The data dir — `_archive/` and its manifests hang off it. */
  dataDir: string;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;

  /** Take a doc or review off every board holding it, so an archived row is
   *  not left as a dead end. */
  unlinkFromEveryBoardWorkspace: (attachmentId: string) => void;
  /** A doc's own id, whichever spelling it was addressed by. */
  canonicalDocId: (addressed: string) => string;
}

/** What only this request knows. */
export interface ArchiveRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/**
 * Build the archive family once per server.
 *
 * Returns the handler AND `deleteReview`, which the board-delete route two
 * positions further down still calls — it used to be a closure in the request
 * scope both reached, and this is the same reference reached the same way.
 */
export function createArchiveRoutes(ctx: ArchiveRoutesContext): {
  deleteReview: (setId: string, force: boolean, purge: boolean) => Response;
  handleArchiveRoutes: (rq: ArchiveRouteRequest) => Promise<Response | undefined>;
} {
  const {
    docStore,
    taskStore,
    taskProjection,
    dataDir,
    j,
    safeJson,
    unlinkFromEveryBoardWorkspace,
    canonicalDocId,
  } = ctx;
  /** Boards that link this review, so an archive can put them back. */
  const boardsLinking = (attachmentId: string): string[] =>
    taskStore
      .listWorkspaces()
      .filter((w) => w.docIds?.includes(attachmentId))
      .map((w) => w.id);
  /**
   * Retire a review WITHOUT destroying it: its members' `.ydoc` files
   * move to `data/_archive/`, out of the top level `hydrateFromDisk`
   * reads and into the directory `activity-backfill` scans. Open threads
   * do not block it — a review is usually retired precisely because the
   * threads it still shows have stopped mattering.
   */
  const archiveReview = (setId: string, by: string, reason: string | undefined): Response => {
    const res = docStore.archiveReview(setId, {
      archivedBy: by,
      ...(reason !== undefined ? { reason } : {}),
      linkedWorkspaces: boardsLinking(setId),
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
    // A board row pointing at a review that no longer loads is a dead
    // end, so archiving takes the row too — and the manifest remembers
    // which boards, so unarchiving puts it back rather than orphaning it.
    unlinkFromEveryBoardWorkspace(setId);
    return j(200, res);
  };
  // Delete a REVIEW as one unit (all-or-nothing open-thread guardrail;
  // ?force=true to override). Member SOURCE files are left untouched,
  // same as DELETE /api/docs/:id.
  //
  // SOFT BY DEFAULT since 0.1.92. The guardrail and the response shape
  // are unchanged — what changed is what happens to the files once it
  // commits: they are archived, not purged. The old payload still works
  // and still means "retire this review"; `?purge=true` is the way to
  // ask for the destructive half, and asking is the point. The project
  // rule is that the `.ydoc` is the durable record the Weekly Review
  // analyses are rebuilt from, so purging is a decision, never a default.
  const deleteReview = (setId: string, force: boolean, purge: boolean): Response => {
    if (!purge) {
      // Apply the SAME open-thread guardrail before archiving, so a
      // caller that passed no `force` gets the refusal it has always
      // got rather than a surprise retirement.
      if (!force) {
        const blocked = docStore
          .list()
          .filter((m) => attachmentIdOf(m) === setId)
          .map((m) => ({
            docId: m.docId,
            openThreads: docStore.listThreads(m.docId, { status: 'open' }).length,
          }))
          .filter((f) => f.openThreads > 0);
        if (blocked.length > 0) {
          return j(409, { ok: false, error: 'has-open-threads', files: blocked });
        }
      }
      return archiveReview(setId, 'delete_review', undefined);
    }
    const res = docStore.deleteWorkspace(setId, { force });
    if (res.ok) {
      // The review was one row on a board; deleting it must take the
      // row with it, the same way a deleted doc does.
      unlinkFromEveryBoardWorkspace(setId);
      return j(200, res);
    }
    return j(res.error === 'has-open-threads' ? 409 : 404, res);
  };
  const handleArchiveRoutes = async (rq: ArchiveRouteRequest): Promise<Response | undefined> => {
    const { req, pathname, url, visitor } = rq;
    // Everything currently parked in `data/_archive/` with a manifest.
    // Read-only, and the answer to "what can I bring back".
    //
    // Both kinds, under separate keys. `docs` is ADDITIVE: an older bundle
    // reading `archived` still gets reviews and only reviews, so nothing
    // it already reads changes meaning — which is the rule for this
    // server's REST routes, where the caller is a plugin nobody can
    // restart. Keys rather than one merged list with a discriminator,
    // because the two manifests genuinely differ (a review has `docIds`
    // and a `root`; a doc is one id) and a caller almost always wants one
    // kind or the other.
    if (pathname === '/api/reviews/archived' && req.method === 'GET') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      return j(200, {
        archived: listArchivedReviews(dataDir),
        docs: listArchivedDocs(dataDir),
      });
    }
    const reviewArchiveMatch = pathname.match(/^\/api\/reviews\/([^/]+)\/archive$/);
    if (reviewArchiveMatch && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const setId = decodeURIComponent(reviewArchiveMatch[1] ?? '');
      const body = await safeJson(req);
      const author = body?.author as { name?: string } | undefined;
      const reason = typeof body?.reason === 'string' ? (body.reason as string) : undefined;
      return archiveReview(setId, author?.name ?? 'unknown', reason);
    }
    const reviewUnarchiveMatch = pathname.match(/^\/api\/reviews\/([^/]+)\/unarchive$/);
    if (reviewUnarchiveMatch && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const setId = decodeURIComponent(reviewUnarchiveMatch[1] ?? '');
      const body = await safeJson(req);
      const author = body?.author as { name?: string } | undefined;
      const res = docStore.unarchiveReview(setId, { archivedBy: author?.name ?? 'unknown' });
      if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
      // Put the review back on every board it was on when it was archived.
      for (const workspaceId of res.manifest.linkedWorkspaces) {
        if (taskStore.attachDoc(workspaceId, setId).ok) taskProjection.ensureWorkspace(workspaceId);
      }
      return j(200, res);
    }
    // The same pair for ONE free-standing doc. They sit HERE rather than in
    // the `/api/docs/:id/...` block below because that block opens with
    // `docStore.get(docId)` and 404s without a room — which is precisely the
    // state an archived doc is in, so an unarchive route inside it could
    // never be reached.
    const docArchiveMatch = pathname.match(/^\/api\/docs\/([^/]+)\/archive$/);
    if (docArchiveMatch && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const docId = canonicalDocId(decodeURIComponent(docArchiveMatch[1] ?? ''));
      const body = await safeJson(req);
      const author = body?.author as { name?: string } | undefined;
      const reason = typeof body?.reason === 'string' ? (body.reason as string) : undefined;
      const res = docStore.archiveDoc(docId, {
        archivedBy: author?.name ?? 'unknown',
        ...(reason !== undefined ? { reason } : {}),
        linkedWorkspaces: boardsLinking(docId),
      });
      if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
      // A board row pointing at a doc that no longer loads is a dead end,
      // so archiving takes the row too — and the manifest remembers which
      // boards, so unarchiving puts it back rather than orphaning it.
      unlinkFromEveryBoardWorkspace(docId);
      return j(200, res);
    }
    const docUnarchiveMatch = pathname.match(/^\/api\/docs\/([^/]+)\/unarchive$/);
    if (docUnarchiveMatch && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      // Deliberately NOT canonicalized: an archived doc has no room, so
      // there is nothing for an alias to resolve against. The canonical
      // id is what `list_archived_reviews` hands back, which is where a
      // caller gets one. Asserted in doc-id-routes.test.ts so the
      // asymmetry is a decision on the record rather than a surprise.
      const docId = decodeURIComponent(docUnarchiveMatch[1] ?? '');
      const body = await safeJson(req);
      const author = body?.author as { name?: string } | undefined;
      const res = docStore.unarchiveDoc(docId, { archivedBy: author?.name ?? 'unknown' });
      if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
      for (const workspaceId of res.manifest.linkedWorkspaces) {
        if (taskStore.attachDoc(workspaceId, docId).ok) taskProjection.ensureWorkspace(workspaceId);
      }
      return j(200, res);
    }
    const reviewDeleteMatch = pathname.match(REVIEW_DELETE);
    if (reviewDeleteMatch && req.method === 'DELETE') {
      // Review-only, and that is the point of the separate verb: a BOARD
      // id here answers not-found rather than being destroyed by a call
      // that meant to clean up a diff review.
      return deleteReview(
        decodeURIComponent(reviewDeleteMatch[1] ?? ''),
        url.searchParams.get('force') === 'true',
        url.searchParams.get('purge') === 'true',
      );
    }
    return undefined;
  };

  return { deleteReview, handleArchiveRoutes };
}
