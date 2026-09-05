/**
 * A review's own files: its thread roll-up, its grouped-diff sidebar, its
 * file tree, and the two lazy opens that bring one more file into it.
 *
 * One family because every route here addresses a REVIEW by set id — a diff
 * review or a bound folder — and reads or re-reconciles the file collection
 * under it. They were written as one if-chain inside `createServer` and the
 * sequence was kept exactly through the move. Order among them is not
 * load-bearing: each match is a distinct anchored regex plus a method, so no
 * two can claim the same request.
 *
 * The `/api/reviews` ⇄ `/api/workspaces` alias every one of them matches
 * is the `REVIEW_API` block below, which moved here with them.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import { attachmentIdOf } from '@feedback/core';
import type { DocMeta } from '@feedback/core';
import type { DocStore } from '../doc-store.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import {
  redactWorkspaceFilesForVisitor,
  redactWorkspaceGroupedForVisitor,
  redactWorkspaceTreeForVisitor,
} from '../share/redact-meta.ts';

/**
 * ===== COMPAT: the review API answers at two prefixes =====
 *
 * A diff review and a bound folder are REVIEWS. They were built as a second
 * thing called a "workspace" and their endpoints are still spelled
 * `/api/workspaces/<id>/…`, which is the vocabulary this change removes: the
 * canonical name is now `/api/reviews/<setId>/…`.
 *
 * Every one of these routes therefore matches BOTH prefixes. This is the whole
 * of the alias — one helper, one comment — and it exists because the callers
 * are plugin bundles running inside sessions nobody can restart, plus browser
 * tabs that are already open. They keep calling the address they were built
 * against and would get a 404 they could not explain from their own version.
 *
 * The bare `DELETE /api/workspaces/<id>` is deliberately NOT in here: that one
 * route fronts two stores (a board or a review, dispatched by id) and is
 * handled on its own.
 */
const reviewApi = (sub: string): RegExp =>
  new RegExp(`^/api/(?:reviews|workspaces)/([^/]+)/${sub}$`);
const REVIEW_API = {
  refresh: reviewApi('refresh'),
  groups: reviewApi('groups'),
  grouped: reviewApi('grouped'),
  threads: reviewApi('threads'),
  files: reviewApi('files'),
  tree: reviewApi('tree'),
  contextFile: reviewApi('context-file'),
  editableFile: reviewApi('editable-file'),
} as const;

/** The long-lived collaborators these routes need, built once per server. */
export interface ReviewFileRoutesContext {
  /** Doc store — every route here is a read or a re-read of one review's
   *  member files. */
  docStore: DocStore;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

/** What only this request knows. */
export interface ReviewFileRouteRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The share target this request resolved to, or null for a member. Every
   *  redaction below reads this and nothing else. */
  visitor: ShareTarget | null;
  /** The doc meta a REST reply carries — redacted when the caller is a share
   *  visitor, which is why it is per-request rather than per-server. */
  metaFor: <T extends DocMeta>(meta: T) => Record<string, unknown>;
  /** Attach the §-chips for the tasks a doc's thread produced. Per-request
   *  for the same reason: what a visitor is shown is narrower. */
  withTaskChips: <T extends { id: string }>(docId: string, t: T) => T;
}

/**
 * The eight review-file routes, tried in source order. `undefined` means none
 * of them matched and the caller's chain continues.
 */
export async function handleReviewFileRoutes(
  ctx: ReviewFileRoutesContext,
  rq: ReviewFileRouteRequest,
): Promise<Response | undefined> {
  const { docStore, j, safeJson } = ctx;
  const { req, url, pathname, visitor, metaFor, withTaskChips } = rq;

  // File-tree view for a bound workspace: nested directory tree with
  // per-file unresolved-comment counts + folder roll-ups. Files are
  // decorated with reviewUrl by the doc-store decorator (withReviewUrl).
  // All threads across a workspace (folder bind or diff review) in one
  // call — lets a watching agent poll a single endpoint per review
  // instead of one per member file. ?status=open|resolved filters.
  const wsThreadsMatch = pathname.match(REVIEW_API.threads);
  if (wsThreadsMatch && req.method === 'GET') {
    const setId = decodeURIComponent(wsThreadsMatch[1] ?? '');
    if (!docStore.list().some((m) => attachmentIdOf(m) === setId)) {
      return j(404, { error: 'review not found', setId, workspaceId: setId });
    }
    const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
    const threads = docStore
      .listWorkspaceThreads(setId, status ? { status } : undefined)
      .map((t) => withTaskChips(t.docId, t));
    // `workspaceId` carries the SAME value and is deprecated for one
    // release: callers built before the rename read it by that name.
    return j(200, { setId, workspaceId: setId, threads });
  }
  // Grouped-diff sidebar model: changed files organized into logical
  // groups (agent-supplied or heuristic). The default nav for diff
  // reviews.
  const wsGroupedMatch = pathname.match(REVIEW_API.grouped);
  if (wsGroupedMatch && req.method === 'GET') {
    const setId = decodeURIComponent(wsGroupedMatch[1] ?? '');
    const grouped = docStore.listGroupedDiff(setId);
    if (grouped.groups.length === 0) {
      return j(404, { error: 'no diff review found', setId, workspaceId: setId });
    }
    // Every file node carries the same absolute `reviewUrl` /tree and
    // /files build, and this route is on the same visitor allowlist
    // line — see redactWorkspaceGroupedForVisitor.
    return j(
      200,
      visitor ? redactWorkspaceGroupedForVisitor(grouped, visitor.workspaceId) : grouped,
    );
  }
  // Re-reconcile a workspace against disk: pick up files that changed
  // since the bind, flag members whose file is gone. Never re-mints a
  // docId, so every comment thread survives.
  const wsRefreshMatch = pathname.match(REVIEW_API.refresh);
  if (wsRefreshMatch && req.method === 'POST') {
    const setId = decodeURIComponent(wsRefreshMatch[1] ?? '');
    const res = await docStore.refreshWorkspace(setId);
    if (res.ok) return j(200, res);
    return j(res.error === 'not-found' ? 404 : 400, res);
  }
  // Re-group a diff review's sidebar in place. An empty `groups` array
  // is meaningful (fall back to the heuristic); a MISSING one is a
  // caller mistake, so it 400s rather than silently regrouping.
  const wsGroupsMatch = pathname.match(REVIEW_API.groups);
  if (wsGroupsMatch && req.method === 'POST') {
    const setId = decodeURIComponent(wsGroupsMatch[1] ?? '');
    const body = await safeJson(req);
    const groups = body?.groups;
    if (!Array.isArray(groups)) return j(400, { error: 'groups array required' });
    const res = docStore.setWorkspaceGroups(
      setId,
      groups as Array<{ title: string; paths: string[]; details?: string }>,
    );
    if (res.ok) return j(200, res);
    return j(res.error === 'not-found' ? 404 : 400, res);
  }
  // Every file in the workspace's repo (changed ones marked) — the
  // "Show All Files" context view.
  const wsFilesMatch = pathname.match(REVIEW_API.files);
  if (wsFilesMatch && req.method === 'GET') {
    const setId = decodeURIComponent(wsFilesMatch[1] ?? '');
    const res = docStore.listRepoFiles(setId);
    if (!res.ok) return j(404, res);
    // `root` is an absolute host path and every reviewUrl carries the
    // tailnet hostname — neither belongs in a visitor's copy.
    return j(200, visitor ? redactWorkspaceFilesForVisitor(res, visitor.workspaceId) : res);
  }
  // Lazily open an unchanged repo file for context (read-only code doc
  // in the same workspace).
  const wsCtxMatch = pathname.match(REVIEW_API.contextFile);
  if (wsCtxMatch && req.method === 'POST') {
    const setId = decodeURIComponent(wsCtxMatch[1] ?? '');
    const body = await safeJson(req);
    const relPath = body?.relPath as string | undefined;
    if (!relPath) return j(400, { error: 'relPath required' });
    const res = await docStore.openContextFile(setId, relPath);
    // `not-listed` is a 404 on purpose: the tree does not show the
    // file, and whether it exists is exactly what must not be told.
    // `unavailable` is a 503: the file is there and did not answer, which is
    // a retry-later, not a missing file — telling the sidebar 404 would make
    // it look deleted.
    if (!res.ok) {
      const status = res.error === 'bad-path' ? 400 : res.error === 'unavailable' ? 503 : 404;
      return j(status, res);
    }
    return j(200, { docId: res.docId, meta: metaFor(res.meta) });
  }
  const wsEditMatch = pathname.match(REVIEW_API.editableFile);
  if (wsEditMatch && req.method === 'POST') {
    const setId = decodeURIComponent(wsEditMatch[1] ?? '');
    const body = await safeJson(req);
    const relPath = body?.relPath as string | undefined;
    if (!relPath) return j(400, { error: 'relPath required' });
    const res = await docStore.openEditableFile(setId, relPath);
    if (!res.ok) {
      const status =
        res.error === 'bad-path' || res.error === 'not-markdown'
          ? 400
          : res.error === 'pinned'
            ? 409
            : res.error === 'unavailable'
              ? 503
              : 404;
      return j(status, res);
    }
    return j(200, { docId: res.docId, meta: metaFor(res.meta) });
  }
  const wsTreeMatch = pathname.match(REVIEW_API.tree);
  if (wsTreeMatch && req.method === 'GET') {
    const setId = decodeURIComponent(wsTreeMatch[1] ?? '');
    const tree = docStore.buildWorkspaceTree(setId);
    if (tree.tree.children.length === 0) {
      return j(404, { error: 'review not found', setId, workspaceId: setId });
    }
    // Same redaction as /files — see redactWorkspaceTreeForVisitor.
    return j(200, visitor ? redactWorkspaceTreeForVisitor(tree, visitor.workspaceId) : tree);
  }

  return undefined;
}
