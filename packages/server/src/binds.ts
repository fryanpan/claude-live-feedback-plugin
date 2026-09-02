import { resolve as resolvePath } from 'node:path';
import type { DocType } from '@feedback/core';
import { bindDiff } from './bind-diff.ts';
import { type BindHost, deriveWorkspaceId } from './bind-meta.ts';

/**
 * The folder bind, and the door the rest of the server still comes in
 * through.
 *
 * `bindFolder` is a thin translation now: a folder is a BROWSE-mode diff
 * review, so it calls `bindDiff` and re-shapes the answer. What is left here
 * beside it is the re-export block — the diff bind, the refresh flows and
 * the shared vocabulary all moved to their own files, and every importer
 * still names them here.
 */

/** Re-exported where they were first published, so no importer moves. */
export { type BindDiffOpts, type BindDiffResult, bindDiff } from './bind-diff.ts';
export {
  type RefreshWorkspaceResult,
  type SetWorkspaceGroupsResult,
  type WorkspaceMemberRef,
  refreshWorkspace,
  setWorkspaceGroups,
} from './workspace-refresh.ts';
export {
  type BindHost,
  deriveDiffReviewId,
  deriveWorkspaceId,
  memberDocId,
} from './bind-meta.ts';

/**
 * The two "bind a set of files as one workspace" flows — folder/worktree
 * (`bindFolder`) and git diff (`bindDiff`) — extracted from rooms.ts and
 * built on the same skeleton: enumerate candidates → filter
 * (exclude/size/binary, recording `skipped[]`) → maxFiles guardrail →
 * deterministic member docIds → getOrCreate + attach per file.
 */

export interface BindFolderOpts {
  folderPath: string;
  /** Reuse an existing review's id instead of deriving one from the path. */
  setId?: string;
  title?: string;
  /** Accepted for back-compat; lazy opening made the allowlist obsolete. */
  include?: string[];
  exclude?: string[];
  /** Accepted for back-compat; browse mode binds lazily so no cap applies. */
  maxFiles?: number;
  owner?: string;
  producedBy?: { agentId?: string; sessionId?: string };
}

export type BindFolderResult =
  | {
      ok: true;
      setId: string;
      /** Same value as `setId`, deprecated for one release — callers built
       *  before a review stopped being called a workspace read it by this
       *  name. A key must never change MEANING. */
      workspaceId: string;
      root: string;
      fileCount: number;
      skipped: Array<{ path: string; reason: string }>;
      files: Array<{ docId: string; relPath: string; type: DocType; title: string }>;
    }
  | { ok: false; error: 'not-found' | 'too-many-files' | 'reserved-namespace'; fileCount?: number };

/**
 * bind_folder is now an alias for a BROWSE-mode diff workspace (bindDiff
 * without a base): the whole folder is navigable from the all-files
 * sidebar, files open lazily (markdown editable, source read-only), and
 * only an entry doc binds eagerly. `fileCount` is the scan count, not a
 * bound-docs count — the old eager-bind-everything path (and its 300-file
 * cap + per-file pollers) is gone.
 */
export function bindFolder(host: BindHost, opts: BindFolderOpts): BindFolderResult {
  const res = bindDiff(host, {
    repoPath: opts.folderPath,
    reviewId: opts.setId,
    title: opts.title,
    exclude: opts.exclude,
    owner: opts.owner,
    producedBy: opts.producedBy,
  });
  if (!res.ok) {
    if (res.error === 'empty-diff') {
      // An empty (but existing) folder is a degenerate success, matching
      // the old eager bind's behavior for a folder with no supported files.
      const root = resolvePath(opts.folderPath);
      const emptySetId = opts.setId ?? deriveWorkspaceId(root);
      return {
        ok: true,
        setId: emptySetId,
        workspaceId: emptySetId,
        root,
        fileCount: 0,
        skipped: [],
        files: [],
      };
    }
    // Flattening everything else to not-found would turn a namespace refusal
    // into "your folder doesn't exist", which sends the caller looking at the
    // wrong thing entirely.
    if (res.error === 'reserved-namespace') return { ok: false, error: 'reserved-namespace' };
    return { ok: false, error: 'not-found' };
  }
  return {
    ok: true,
    setId: res.reviewId,
    workspaceId: res.reviewId,
    root: res.root,
    fileCount: res.fileCount,
    skipped: res.skipped,
    files: res.files.map((f) => ({
      docId: f.docId,
      relPath: f.relPath,
      type: f.type,
      title: f.title,
    })),
  };
}
