import { basename } from 'node:path';
import type { DocMeta } from '@feedback/core';

/**
 * Strip a doc's metadata down to what a share visitor needs.
 *
 * `GET /api/docs/<id>` is in a share visitor's scope — they have to read it
 * to render the doc — but the full DocMeta is a description of Bryan's
 * machine, not of the document: an absolute `sourceUrl`
 * (`/Volumes/Data/Users/bryanchan/dev/<private-repo>/…`), an `owner` that is
 * an agent's project directory, a `workspaceRoot`, and a `reviewUrl` on the
 * tailnet hostname. None of it is needed to render a review, and together it
 * maps out a filesystem and a private network for someone who was handed one
 * link.
 *
 * Allowlist, not denylist: a field added later is redacted by default rather
 * than leaking until somebody notices.
 */
export function redactMetaForVisitor(
  meta: DocMeta & { reviewUrl?: string },
  opts?: {
    /** True when the SHARE covers a whole workspace. A doc-scoped share of a
     *  workspace member must not advertise its `workspaceId`: the client reads
     *  a non-empty one as permission to render workspace navigation and starts
     *  polling /api/workspaces/<id>/…, which `shareScopeAllows` refuses for a
     *  doc share (`if (!target.workspaceId) return false`). The visitor gets a
     *  broken sidebar and a 30s loop of 403s. The doc renders fine without it —
     *  a single-doc share has no sibling files to navigate to. */
    workspaceScoped?: boolean;
  },
): Partial<DocMeta> {
  return {
    docId: meta.docId,
    type: meta.type,
    createdAt: meta.createdAt,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    // relPath deliberately STAYS — it's the file's path within the review,
    // which is the thing being reviewed, and it's already in the sidebar.
    // When there isn't one (a standalone shared doc), fall back to the
    // BASENAME of the source path: the client picks its syntax-highlighting
    // language off this, so dropping it entirely would silently turn a
    // visitor's code view into plain text. A bare filename is already
    // visible as the title; the directories are what we're withholding.
    ...(meta.relPath !== undefined
      ? { relPath: meta.relPath }
      : meta.sourceUrl
        ? { relPath: basename(meta.sourceUrl) }
        : {}),
    ...(opts?.workspaceScoped && meta.workspaceId !== undefined
      ? { workspaceId: meta.workspaceId }
      : {}),
    // setId drives the legacy flat sibling nav, which fetches the whole
    // /api/docs list — also out of a visitor's scope. Same reasoning.
    ...(opts?.workspaceScoped && meta.setId !== undefined ? { setId: meta.setId } : {}),
    ...(meta.lastActivityAt !== undefined ? { lastActivityAt: meta.lastActivityAt } : {}),
    ...(meta.stale !== undefined ? { stale: meta.stale } : {}),
    // Diff presentation — line counts and status drive the badges the
    // visitor is looking at.
    //
    // diffTarget is LOAD-BEARING, not decoration: the client reads "pinned"
    // as "diffTarget is non-empty" (see code/editable-policy.ts), so dropping
    // it made every shared pinned review look like a live working-tree one
    // and UNLOCKED its editor. A visitor could then type into content that is
    // supposed to be immutable — no write-back to disk, but the Yjs doc
    // mutates and broadcasts to everyone else on the review.
    //
    // Keeping the hashes costs nothing worth protecting: a visitor holding
    // this link is already reading the diff's full contents, so the commit
    // ids they came from add no information.
    ...(meta.diffBase !== undefined ? { diffBase: meta.diffBase } : {}),
    ...(meta.diffTarget !== undefined ? { diffTarget: meta.diffTarget } : {}),
    ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
    ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
    ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
    // Describes the FILE's content, not the host — same class as the line
    // counts above. Listed so the sidebar's whitespace grouping renders the
    // same for a visitor as for the owner.
    ...(meta.diffWhitespaceOnly !== undefined
      ? { diffWhitespaceOnly: meta.diffWhitespaceOnly }
      : {}),
    ...(meta.diffOldPath !== undefined ? { diffOldPath: meta.diffOldPath } : {}),
    ...(meta.diffGroup !== undefined ? { diffGroup: meta.diffGroup } : {}),
    ...(meta.diffGroupRank !== undefined ? { diffGroupRank: meta.diffGroupRank } : {}),
    ...(meta.diffGroupDetails !== undefined ? { diffGroupDetails: meta.diffGroupDetails } : {}),
  };
}

/** `/workspaces/<id>/<kind>/<rest>` — the addressable-resource shape. */
const WORKSPACE_RESOURCE = /^\/workspaces\/[^/]+\/(docs|mockups|reviews)\/(.+)$/;

/**
 * A review URL a visitor can actually use: same path, but rooted at the
 * host they arrived on rather than the tailnet name the server prefers.
 * Returns a relative URL, which is correct for every share mode and leaks
 * no hostname at all.
 *
 * `scopeWorkspaceId` additionally rewrites the WORKSPACE segment, and it is
 * not cosmetic. A resource is addressed under a workspace, and the one the
 * server picks when minting is the first workspace holding the doc — which
 * need not be the workspace this visitor was shared. Handing that URL over
 * would do two things at once: name a workspace nobody shared with them (an
 * unguessable capability, the same reason `hubWorkspaceId` is owner-only),
 * and give them a link the host guard then refuses, because it checks the
 * workspace segment against their share. Every resource a visitor can see is
 * by definition inside their workspace, so their workspace is the correct
 * segment for all of them.
 */
export function relativeReviewUrl(
  reviewUrl: string | undefined,
  scopeWorkspaceId?: string,
): string | undefined {
  if (!reviewUrl) return undefined;
  let path: string;
  try {
    const u = new URL(reviewUrl);
    path = `${u.pathname}${u.search}`;
  } catch {
    // Already relative (or unparseable) — pass through only if it's a path.
    if (!reviewUrl.startsWith('/')) return undefined;
    path = reviewUrl;
  }
  if (!scopeWorkspaceId) return path;
  // A legacy `/review/<docId>` names no workspace, so there is nothing to
  // rewrite and nothing to leak — leave it as it is.
  const m = path.match(WORKSPACE_RESOURCE);
  if (!m) return path;
  return `/workspaces/${encodeURIComponent(scopeWorkspaceId)}/${m[1]}/${m[2]}`;
}

/**
 * Strip a workspace TREE down to what a share visitor may see.
 *
 * `GET /api/workspaces/<id>/tree` and `/files` are in a workspace visitor's
 * scope — they're what makes the set browsable — but unlike `/api/docs/<id>`
 * they never passed through any redaction, because they build their payload
 * themselves rather than returning a DocMeta. Two things leaked to anyone
 * holding a workspace link:
 *
 *   - `root`, the ABSOLUTE filesystem path of the shared directory on the
 *     host. Directory names routinely encode a client or project, so this is
 *     the same class of disclosure the private-meta sidecar exists to prevent.
 *   - `reviewUrl` on every node, carrying the tailnet hostname AND port —
 *     an internal name the visitor has no business learning, and one they
 *     cannot use anyway.
 *
 * Both are dropped/relativized here. `relPath` deliberately stays: it is the
 * path WITHIN the review, which is the thing being reviewed and is already
 * visible in the sidebar.
 *
 * Verified live against the running server before the fix: an external
 * visitor on a workspace link received both.
 */
export function redactWorkspaceTreeForVisitor<T extends { root?: string; tree?: unknown }>(
  payload: T,
  scopeWorkspaceId?: string,
): Omit<T, 'root'> {
  const { root: _dropped, ...rest } = payload;
  return {
    ...rest,
    ...(payload.tree ? { tree: redactNode(payload.tree, scopeWorkspaceId) } : {}),
  } as Omit<T, 'root'>;
}

/** Recursively relativize `reviewUrl` on every node of a workspace tree. */
function redactNode(node: unknown, scopeWorkspaceId?: string): unknown {
  if (Array.isArray(node)) return node.map((n) => redactNode(n, scopeWorkspaceId));
  if (!node || typeof node !== 'object') return node;
  const { reviewUrl, ...base } = node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  // Absent rather than absolute: an unparseable reviewUrl is dropped outright
  // instead of passed through, so a future URL shape can't leak by default.
  if (typeof reviewUrl === 'string') {
    const rel = relativeReviewUrl(reviewUrl, scopeWorkspaceId);
    if (rel !== undefined) out.reviewUrl = rel;
  }
  if (Array.isArray(out.children)) {
    out.children = out.children.map((n) => redactNode(n, scopeWorkspaceId));
  }
  return out;
}

/**
 * Same treatment for `GET /api/workspaces/<id>/files`, whose payload is a
 * flat `files` array rather than a tree.
 */
export function redactWorkspaceFilesForVisitor<T extends { root?: string; files?: unknown[] }>(
  payload: T,
  scopeWorkspaceId?: string,
): Omit<T, 'root'> {
  const { root: _dropped, ...rest } = payload;
  return {
    ...rest,
    ...(payload.files ? { files: payload.files.map((n) => redactNode(n, scopeWorkspaceId)) } : {}),
  } as Omit<T, 'root'>;
}
