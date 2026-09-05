/**
 * The workspace surface of an attachment set: what a bound folder or diff
 * review looks like from the outside, and how it is retired.
 *
 * Two clusters live here because they are the same subject seen twice. The
 * projections — the tree, the grouped diff, the all-files list, the thread
 * roll-up — all answer "what is in this set", and every one of them is
 * built by walking `list()` and summing thread counts. The archive verbs
 * answer "this set is finished", and they are the only writers that treat
 * a set's member docs as one unit.
 *
 * What is NOT here is the room lifecycle they act on. Hydration, teardown,
 * alias release and the persisted index stay in `doc-store.ts`, reached through
 * the interface below — so archiving can move a doc's files without this
 * file knowing what a room is made of.
 */
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DocMeta,
  type DocType,
  type Thread,
  attachmentIdOf,
  isAttachmentMember,
} from '@feedback/core';
import {
  type Event,
  appendActivity,
  buildEventDoc,
  eventId,
  payloadDigest,
  toUtcIso,
} from './activity.ts';
import { memberDocId } from './binds.ts';
import { isBoardOwnedDoc } from './doc-ids.ts';
import {
  type DocIndexEntry,
  deleteDocIndex,
  docIndexPath,
  moveDocIndex,
  readDocIndex,
} from './doc-index.ts';
import type { DocRoom, WorkspaceDirNode, WorkspaceFileNode, WorkspaceTree } from './doc-store.ts';
import { isListedFile, scanFolderPaths } from './fs-scan.ts';
import { privateMetaPath } from './private-meta.ts';
import {
  type ArchivedDoc,
  type ArchivedReview,
  archiveDirPath,
  ensureArchiveDir,
  readArchiveManifest,
  readDocArchiveManifest,
  removeArchiveManifest,
  removeDocArchiveManifest,
  writeArchiveManifest,
  writeDocArchiveManifest,
} from './review-archive.ts';
import { isWithinRoot } from './safe-path.ts';
import { boundFiles } from './slow-fs.ts';

/**
 * What the workspace surface needs from the room lifecycle. Deliberately
 * verbs rather than the maps behind them: `residentRoom` is the doc map,
 * `setIndexEntry` / `deleteIndexEntry` are the persisted doc index, and
 * nothing here gets to iterate either.
 *
 * `room` resolves an alias and hydrates; `residentRoom` returns only what is
 * already in memory. Archiving uses the second on purpose — it flushes a room
 * that happens to be open, and must not page in the several hundred members
 * of a set nobody is looking at just to retire them.
 */
export interface DocStoreWorkspacePersistence {
  dataDir(): string;
  /** Fill in `reviewUrl` and friends — the URL machinery stays in the server layer. */
  decorate(meta: DocMeta): DocMeta;
  list(): DocMeta[];
  threadCounts(docId: string): { open: number; total: number };
  listThreads(docId: string, filter?: { status?: 'open' | 'resolved' }): Thread[];
  peekMeta(docId: string): DocMeta | undefined;
  docExists(docId: string): boolean;
  room(docId: string): DocRoom | undefined;
  residentRoom(docId: string): DocRoom | undefined;
  getOrCreate(
    docId: string,
    init: {
      type: DocType;
      sourceUrl: string;
      setId: string;
      owner?: string;
      workspaceId: string;
      workspaceRoot: string;
      relPath: string;
      title: string;
    },
  ): DocRoom;
  // The pool doors, not the synchronous ones: the path being bound came out
  // of a repo tree the caller pointed at, so it is exactly the path a
  // cloud-sync provider can refuse to answer for.
  attachFileAsync(docId: string, filePath: string): Promise<{ ok: boolean }>;
  attachReadonlyFileAsync(docId: string, filePath: string): Promise<{ ok: boolean }>;
  deleteDoc(docId: string, opts?: { force?: boolean }): { ok: boolean };
  hydrateDoc(docId: string): boolean;
  persistRoomNow(room: DocRoom): void;
  teardownRoom(room: DocRoom, closeReason: string): void;
  releaseAliases(docId: string): void;
  pathFor(docId: string): string;
  forgetActivityMtime(docId: string): void;
  setIndexEntry(docId: string, entry: DocIndexEntry): void;
  deleteIndexEntry(docId: string): void;
}

export class DocStoreWorkspaces {
  constructor(private readonly p: DocStoreWorkspacePersistence) {}

  /**
   * All threads across a workspace's member docs in one call — so an agent
   * watching a folder or diff review can poll ONE endpoint instead of one
   * per file (a 64-file diff review would otherwise mean 64 polls). Each
   * thread is tagged with its docId + relPath so replies/resolves know
   * where to go. Sorted most-recent-activity first.
   */
  listWorkspaceThreads(
    setId: string,
    opts?: { status?: 'open' | 'resolved' },
  ): Array<Thread & { docId: string; relPath?: string }> {
    const out: Array<Thread & { docId: string; relPath?: string }> = [];
    for (const meta of this.p.list()) {
      if (attachmentIdOf(meta) !== setId) continue;
      for (const t of this.p.listThreads(meta.docId, opts)) {
        out.push({ ...t, docId: meta.docId, relPath: meta.relPath });
      }
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out;
  }

  /**
   * The grouped-diff sidebar model: a diff review's CHANGED files organized
   * into their logical groups (agent-supplied at bind time or heuristic),
   * ordered by group rank then churn. Context files opened from the
   * all-files view (type 'code') are deliberately excluded — this view is
   * "what changed", not "what's open".
   */
  listGroupedDiff(setId: string): {
    setId: string;
    /** Same value as `setId`, deprecated for one release: this payload goes
     *  over the wire to clients built before a review stopped being called a
     *  workspace. A key must never change MEANING, so the old one stays. */
    workspaceId: string;
    totalOpen: number;
    groups: Array<{
      title: string;
      openCount: number;
      details?: string;
      files: WorkspaceFileNode[];
    }>;
  } {
    const byGroup = new Map<
      string,
      { rank: number; details?: string; files: WorkspaceFileNode[] }
    >();
    // Companion editor docs (openEditableFile) are type 'markdown' but hold
    // threads left in the .md File view — those must count toward the diff
    // member's badge even though only diff members get rows here. Context
    // files never share a relPath with a member (openContextFile
    // short-circuits when one exists), so summing by relPath is safe.
    const companionThreads = new Map<string, { open: number; total: number }>();
    for (const meta of this.p.list()) {
      if (attachmentIdOf(meta) !== setId || meta.type === 'diff' || !meta.relPath) continue;
      const { open, total } = this.p.threadCounts(meta.docId);
      if (open === 0 && total === 0) continue;
      const prev = companionThreads.get(meta.relPath) ?? { open: 0, total: 0 };
      companionThreads.set(meta.relPath, { open: prev.open + open, total: prev.total + total });
    }
    let totalOpen = 0;
    for (const meta of this.p.list()) {
      if (attachmentIdOf(meta) !== setId || meta.type !== 'diff') continue;
      const relPath = meta.relPath ?? meta.docId;
      const extra = companionThreads.get(relPath) ?? { open: 0, total: 0 };
      const counts = this.p.threadCounts(meta.docId);
      const openCount = counts.open + extra.open;
      const threadCount = counts.total + extra.total;
      totalOpen += openCount;
      const decorated = this.p.decorate(meta);
      const node: WorkspaceFileNode = {
        type: 'file',
        docId: meta.docId,
        name: relPath.split('/').pop() ?? relPath,
        relPath,
        fileType: meta.type,
        openCount,
        threadCount,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        lastActivityAt: meta.lastActivityAt,
        ...(meta.stale ? { stale: true } : {}),
        ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
        ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
        ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
      };
      const title = meta.diffGroup ?? 'Files';
      let g = byGroup.get(title);
      if (!g) {
        g = { rank: meta.diffGroupRank ?? Number.MAX_SAFE_INTEGER, files: [] };
        byGroup.set(title, g);
      }
      g.rank = Math.min(g.rank, meta.diffGroupRank ?? Number.MAX_SAFE_INTEGER);
      // Every member of a group shares the same details; take the first
      // non-empty one so a member bound before the details were set can't
      // blank it out.
      if (g.details === undefined && meta.diffGroupDetails) g.details = meta.diffGroupDetails;
      g.files.push(node);
    }
    const groups = Array.from(byGroup.entries())
      .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
      .map(([title, g]) => {
        g.files.sort((a, b) => a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath));
        return {
          title,
          openCount: g.files.reduce((s, f) => s + f.openCount, 0),
          ...(g.details !== undefined ? { details: g.details } : {}),
          files: g.files,
        };
      });
    return { setId, workspaceId: setId, totalOpen, groups };
  }

  /**
   * Every reviewable file in the workspace's repo folder (gitignore-aware
   * scan), with changed files marked — powers the "Show All Files" context
   * view. Files that are already docs carry their reviewUrl; anything else
   * can be opened on demand via `openContextFile`.
   */
  listRepoFiles(setId: string): {
    ok: boolean;
    root?: string;
    truncated?: boolean;
    files?: Array<{
      relPath: string;
      changed: boolean;
      docId?: string;
      reviewUrl?: string;
      stale?: boolean;
      status?: DocMeta['diffStatus'];
    }>;
    error?: 'not-found';
  } {
    const members = this.p.list().filter((m) => attachmentIdOf(m) === setId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root || !existsSync(root)) return { ok: false, error: 'not-found' };
    // A changed file can carry BOTH its diff member and its companion
    // editable markdown doc on the same relPath — the diff member is the
    // reviewable surface this list must point at.
    const byRel = new Map<string, DocMeta>();
    for (const m of members) {
      const key = m.relPath ?? '';
      const prev = byRel.get(key);
      if (!prev || (prev.type !== 'diff' && m.type === 'diff')) byRel.set(key, m);
    }
    const MAX_FILES = 10_000;
    const excluded = workspaceExcludes(members);
    const scanned = scanFolderPaths(root).filter((rel) => !isExcludedPath(rel, excluded));
    const truncated = scanned.length > MAX_FILES;
    const files = scanned.slice(0, MAX_FILES).map((relPath) => {
      const member = byRel.get(relPath);
      if (!member) return { relPath, changed: false };
      const decorated = this.p.decorate(member);
      return {
        relPath,
        // A STALE diff member is no longer changed — its change was reverted
        // or the file left the review. Still reporting it as changed here
        // would contradict the grouped view, which already dims it.
        changed: member.type === 'diff' && !member.stale,
        docId: member.docId,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        ...(member.stale ? { stale: true } : {}),
        ...(member.diffStatus !== undefined ? { status: member.diffStatus } : {}),
      };
    });
    return { ok: true, root, truncated, files };
  }

  /**
   * Open an UNCHANGED repo file for context from the all-files view: bind it
   * lazily as a read-only code doc in the same workspace (deterministic
   * docId, so repeat opens reuse the doc and any comments on it survive).
   * relPath is validated against the workspace root — no traversal.
   */
  async openContextFile(
    setId: string,
    relPath: string,
  ): Promise<
    | { ok: true; docId: string; meta: DocMeta }
    | {
        ok: false;
        error: 'not-found' | 'bad-path' | 'not-listed' | 'attach-failed' | 'unavailable';
      }
  > {
    const members = this.p.list().filter((m) => attachmentIdOf(m) === setId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root) return { ok: false, error: 'not-found' };
    const clean = normalizeRel(relPath);
    const abs = join(root, clean);
    // Traversal guard: the resolved path must stay under the root.
    if (clean.split('/').includes('..') || !`${abs}/`.startsWith(`${root}/`)) {
      return { ok: false, error: 'bad-path' };
    }
    // The workspace's exclude is a scope, not a display filter: a path the
    // caller kept out must not be bindable on demand either, or "excluded"
    // would only mean "not listed by default".
    if (isExcludedPath(clean, workspaceExcludes(members))) {
      return { ok: false, error: 'bad-path' };
    }
    // The tree's rule, not the filesystem's: a path opens only if
    // `git ls-files --cached --others --exclude-standard` lists it, and
    // nothing under `.git/` ever does. Before this, an ignored `.env` under a
    // diff review's root — a whole repository — opened for anyone who could
    // reach the review, share visitors included, because "it exists" was the
    // only question asked. Answered `not-listed` rather than `bad-path` so the
    // route can say 404: whether the hidden file exists is itself the leak.
    // (Urgent-fixes ticket, 2026-09-02.)
    if (!isListedFile(root, clean)) return { ok: false, error: 'not-listed' };
    // Existence and content in one pool call, off the main thread. This
    // endpoint is a click in the all-files sidebar, so `abs` is whatever the
    // caller's tree holds — `existsSync` on a path whose provider has stopped
    // answering parks the only thread that runs JavaScript just as a read
    // does, and the sidebar of a review rooted in a cloud-sync folder is full
    // of such paths. A file that will not answer is refused as 'unavailable'
    // rather than reported missing: it is there, it is quarantined for the
    // backoff, and the next click after that tries again.
    const read = await boundFiles.read(abs, { keep: false });
    if (read.status !== 'ok') return { ok: false, error: 'unavailable' };
    if (!read.exists) return { ok: false, error: 'not-found' };
    // The guard above is lexical, so a symlink INSIDE the root that points
    // outside it passes: `join` never touches the filesystem. Resolve what
    // the path really points at before reading it — this endpoint is
    // reachable by a share visitor, and a diff review's root is a whole repo.
    // Ordered after the read so a missing file still reads 'not-found'.
    if (!isWithinRoot(root, abs)) return { ok: false, error: 'bad-path' };
    const existing = members.find((m) => m.relPath === clean);
    if (existing) return { ok: true, docId: existing.docId, meta: existing };
    const owner = members.find((m) => m.owner)?.owner;
    const docId = memberDocId(setId, clean);
    // Markdown opens as the full WYSIWYG editable doc (same as bind_folder
    // always did); everything else is read-only highlighted source.
    const isMd = clean.toLowerCase().endsWith('.md');
    const room = this.p.getOrCreate(docId, {
      type: isMd ? 'markdown' : 'code',
      sourceUrl: abs,
      setId,
      owner,
      // The persisted DocMeta field keeps its name: it is on disk in every
      // .ydoc already, and `attachmentIdOf` reads it as the fallback.
      workspaceId: setId,
      workspaceRoot: root,
      relPath: clean,
      title: clean,
    });
    const attached = isMd
      ? await this.p.attachFileAsync(docId, abs)
      : await this.p.attachReadonlyFileAsync(docId, abs);
    if (!attached.ok) return { ok: false, error: 'attach-failed' };
    return { ok: true, docId: room.docId, meta: room.meta };
  }

  /**
   * Open (or reuse) the companion EDITABLE markdown doc for a `.md` member
   * of a LIVE working-tree diff review. The member stays the flat
   * diff/redline surface; the companion is a full prose doc bound to the
   * same working-tree file via attachFile, so File-view edits flow
   * prose → disk (debounced write-back) → the member's mtime poll →
   * redline/diff re-render. Unchanged `.md` files delegate to
   * openContextFile (already a full markdown doc); pinned reviews refuse —
   * their content is a commit, not a file.
   */
  async openEditableFile(
    setId: string,
    relPath: string,
  ): Promise<
    | { ok: true; docId: string; meta: DocMeta }
    | {
        ok: false;
        error:
          | 'not-found'
          | 'bad-path'
          | 'not-listed'
          | 'pinned'
          | 'not-markdown'
          | 'attach-failed'
          | 'unavailable';
      }
  > {
    const members = this.p.list().filter((m) => attachmentIdOf(m) === setId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root) return { ok: false, error: 'not-found' };
    const clean = normalizeRel(relPath);
    const abs = join(root, clean);
    if (clean.split('/').includes('..') || !`${abs}/`.startsWith(`${root}/`)) {
      return { ok: false, error: 'bad-path' };
    }
    if (isExcludedPath(clean, workspaceExcludes(members))) {
      return { ok: false, error: 'bad-path' };
    }
    if (!clean.toLowerCase().endsWith('.md')) return { ok: false, error: 'not-markdown' };
    // Same rule as openContextFile, and checked here too rather than only on
    // the delegation below: a member's relPath is git-derived, but the tree
    // is the one source of "may this open", and two doors with one lock is
    // the shape that drifts. (Urgent-fixes ticket, 2026-09-02.)
    if (!isListedFile(root, clean)) return { ok: false, error: 'not-listed' };
    const member = members.find((m) => m.relPath === clean);
    if (!member) return await this.openContextFile(setId, clean);
    if (member.type !== 'diff') return { ok: true, docId: member.docId, meta: member };
    if (member.diffTarget) return { ok: false, error: 'pinned' };
    // Off the main thread, for the reason openContextFile spells out. A diff
    // member's path is git-derived rather than typed by the caller, which
    // says nothing about whether the folder holding it still answers.
    const read = await boundFiles.read(abs, { keep: false });
    if (read.status !== 'ok') return { ok: false, error: 'unavailable' };
    if (!read.exists) return { ok: false, error: 'not-found' };
    // Same symlink escape as openContextFile — see the note there. A member's
    // relPath is git-derived rather than caller-supplied, but git tracks
    // symlinks, so the member path is not self-evidently safe either.
    if (!isWithinRoot(root, abs)) return { ok: false, error: 'bad-path' };
    const owner = members.find((m) => m.owner)?.owner;
    const companionId = memberDocId(`${setId}:edit`, clean);
    const room = this.p.getOrCreate(companionId, {
      type: 'markdown',
      sourceUrl: abs,
      setId,
      owner,
      // The persisted DocMeta field keeps its name: it is on disk in every
      // .ydoc already, and `attachmentIdOf` reads it as the fallback.
      workspaceId: setId,
      workspaceRoot: root,
      relPath: clean,
      title: clean,
    });
    const attached = await this.p.attachFileAsync(companionId, abs);
    if (!attached.ok) return { ok: false, error: 'attach-failed' };
    return { ok: true, docId: room.docId, meta: room.meta };
  }

  /**
   * The companion editor doc of a `.md` diff member, if one has been opened
   * (`openEditableFile`), or undefined. The ids are deterministic — member
   * `<setId>:<relPath>`, companion `<setId>:edit:<relPath>` — so this is a
   * lookup, not a search.
   */
  companionOf(docId: string): string | undefined {
    // Metadata and existence, not residency: after a lazy boot neither doc is
    // loaded, and equating "not in memory" with "no companion" dropped the
    // companion's comments out of `GET /api/docs/:id/threads` and out of the
    // member's event fan-out until somebody happened to open both.
    const meta = this.p.peekMeta(docId);
    if (!meta || meta.type !== 'diff' || !meta.relPath) return undefined;
    const attachmentId = attachmentIdOf(meta);
    if (!attachmentId) return undefined;
    const companionId = memberDocId(`${attachmentId}:edit`, meta.relPath);
    return this.p.docExists(companionId) ? companionId : undefined;
  }

  /**
   * The diff member a companion editor doc belongs to, or undefined when
   * `docId` is not a companion. Inverse of `companionOf`.
   */
  memberOfCompanion(docId: string): string | undefined {
    const meta = this.p.peekMeta(docId);
    if (!meta || meta.type !== 'markdown' || !meta.relPath) return undefined;
    const attachmentId = attachmentIdOf(meta);
    if (!attachmentId || docId !== memberDocId(`${attachmentId}:edit`, meta.relPath))
      return undefined;
    const memberId = memberDocId(attachmentId, meta.relPath);
    return this.p.peekMeta(memberId)?.type === 'diff' ? memberId : undefined;
  }

  /**
   * Build the file-tree view for a workspace: every doc tagged with
   * review, arranged into a nested directory tree by its `relPath`,
   * with per-file unresolved-comment counts and folder roll-ups.
   *
   * Each FILE node carries `{docId, name, relPath, fileType, openCount,
   * threadCount, reviewUrl?, lastActivityAt}`. Each DIR node carries a
   * rolled-up `openCount` = sum of every descendant file's openCount.
   *
   * Sort within each level: directories first, then open-count desc, then
   * name asc — so the folders/files that need attention float up, matching
   * the landing page's "what needs my review?" ordering.
   *
   * `reviewUrl` is filled in by the caller via the doc-store decorator
   * (`decorateDocMeta`) so the URL machinery stays in the server layer.
   */
  buildWorkspaceTree(setId: string): WorkspaceTree {
    const root: WorkspaceDirNode = { type: 'dir', name: '', openCount: 0, children: [] };
    let totalOpen = 0;
    let workspaceRoot: string | undefined;

    // One node per relPath: an editable .md gives the workspace TWO docs for
    // the same file (the diff member + its companion editor doc, see
    // openEditableFile). The diff member stays the face of the file — its
    // docId is what the diff-nav and reviewUrl point at — but threads land on
    // whichever doc the reviewer commented in, so badges merge across both.
    const byRel = new Map<string, { meta: DocMeta; openCount: number; threadCount: number }>();
    for (const meta of this.p.list()) {
      if (attachmentIdOf(meta) !== setId) continue;
      if (!workspaceRoot && meta.workspaceRoot) workspaceRoot = meta.workspaceRoot;
      const key = meta.relPath ?? meta.docId;
      const { open, total } = this.p.threadCounts(meta.docId);
      const prev = byRel.get(key);
      if (!prev) {
        byRel.set(key, { meta, openCount: open, threadCount: total });
      } else {
        prev.openCount += open;
        prev.threadCount += total;
        if (prev.meta.type !== 'diff' && meta.type === 'diff') prev.meta = meta;
      }
    }

    for (const { meta, openCount, threadCount } of byRel.values()) {
      const relPath = meta.relPath ?? meta.docId;
      totalOpen += openCount;
      const decorated = this.p.decorate(meta);
      const fileNode: WorkspaceFileNode = {
        type: 'file',
        docId: meta.docId,
        name: relPath.split('/').pop() ?? relPath,
        relPath,
        fileType: meta.type,
        openCount,
        threadCount,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        lastActivityAt: meta.lastActivityAt,
        ...(meta.stale ? { stale: true } : {}),
        ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
        ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
        ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
      };
      // Walk/create the directory chain, accumulating openCount as we go.
      const parts = relPath.split('/');
      const dirs = parts.slice(0, -1);
      let cursor = root;
      cursor.openCount += openCount;
      for (const part of dirs) {
        let next = cursor.children.find(
          (c): c is WorkspaceDirNode => c.type === 'dir' && c.name === part,
        );
        if (!next) {
          next = { type: 'dir', name: part, openCount: 0, children: [] };
          cursor.children.push(next);
        }
        next.openCount += openCount;
        cursor = next;
      }
      cursor.children.push(fileNode);
    }

    sortTreeChildren(root);
    return { setId, workspaceId: setId, root: workspaceRoot, totalOpen, tree: root };
  }

  /**
   * List the bound workspaces with rolled-up triage signals — so the daily
   * cleanup can treat a folder bind as ONE unit instead of nagging per file.
   * Each entry aggregates its member docs (`attachmentIdOf(meta) === id`):
   *   - `fileCount`     number of member docs
   *   - `openThreads`   sum of every member's open-thread count
   *   - `allIdle`       true iff EVERY member is idle (lastActivityAt older
   *                     than 24h) — a workspace is only idle when nothing in
   *                     it has moved recently
   *   - `owner`         the creating agent's cwd (first member that has one)
   *   - `lastActivityAt` max member lastActivityAt (most recent touch)
   */
  listWorkspaces(now: number = Date.now()): Array<{
    setId: string;
    /** Same value as `setId`, deprecated for one release. */
    workspaceId: string;
    root?: string;
    title?: string;
    owner?: string;
    fileCount: number;
    openThreads: number;
    allIdle: boolean;
    lastActivityAt?: number;
  }> {
    const IDLE_MS = 24 * 60 * 60 * 1000;
    const byId = new Map<
      string,
      {
        setId: string;
        workspaceId: string;
        root?: string;
        title?: string;
        owner?: string;
        fileCount: number;
        openThreads: number;
        allIdle: boolean;
        lastActivityAt?: number;
      }
    >();
    for (const meta of this.p.list()) {
      // `isAttachmentMember`, not just "has a review id": `setId` predates binds
      // as a batch-registration tag, so 129 docs in the live data dir share a
      // set without belonging to any folder or diff. Listing those would
      // invent reviews nobody made, each with no root and nothing to refresh.
      if (!isAttachmentMember(meta)) continue;
      const id = attachmentIdOf(meta) as string;
      let entry = byId.get(id);
      if (!entry) {
        entry = {
          setId: id,
          workspaceId: id,
          root: meta.workspaceRoot,
          title: meta.title,
          owner: meta.owner,
          fileCount: 0,
          openThreads: 0,
          allIdle: true,
          lastActivityAt: undefined,
        };
        byId.set(id, entry);
      }
      if (!entry.root && meta.workspaceRoot) entry.root = meta.workspaceRoot;
      if (!entry.owner && meta.owner) entry.owner = meta.owner;
      entry.fileCount += 1;
      entry.openThreads += this.p.threadCounts(meta.docId).open;
      const last = meta.lastActivityAt ?? meta.createdAt;
      if (entry.lastActivityAt === undefined || last > entry.lastActivityAt) {
        entry.lastActivityAt = last;
      }
      // A member is idle if its last activity is older than 24h. The
      // workspace is idle only when every member is — so a single recently
      // touched file keeps the whole workspace out of the cleanup queue.
      if (now - last < IDLE_MS) entry.allIdle = false;
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.openThreads !== b.openThreads) return b.openThreads - a.openThreads;
      return a.workspaceId.localeCompare(b.workspaceId);
    });
  }

  /**
   * Delete a whole workspace (a bound folder) as one unit: loop its member
   * docs and `deleteDoc` each, applying the per-file open-thread guardrail.
   *
   * Semantics are ALL-OR-NOTHING:
   *   - WITHOUT `force`: if ANY member still has open threads, abort the
   *     entire delete (nothing is removed) and return the offending files.
   *   - WITH `force`: delete every member regardless of open threads.
   *
   * The bound SOURCE files on disk are left untouched (same as deleteDoc).
   */
  deleteWorkspace(
    setId: string,
    opts?: { force?: boolean },
  ):
    | { ok: true; deleted: number }
    | { ok: false; error: 'not-found' }
    | {
        ok: false;
        error: 'has-open-threads';
        files: Array<{ docId: string; openThreads: number }>;
      } {
    const members = this.p.list().filter((m) => attachmentIdOf(m) === setId);
    if (members.length === 0) return { ok: false, error: 'not-found' };
    if (!opts?.force) {
      // Pre-flight the guardrail across ALL members before deleting any, so a
      // workspace with even one open thread is left fully intact.
      const blocked: Array<{ docId: string; openThreads: number }> = [];
      for (const m of members) {
        const openThreads = this.p.listThreads(m.docId, { status: 'open' }).length;
        if (openThreads > 0) blocked.push({ docId: m.docId, openThreads });
      }
      if (blocked.length > 0) return { ok: false, error: 'has-open-threads', files: blocked };
    }
    let deleted = 0;
    for (const m of members) {
      const res = this.p.deleteDoc(m.docId, { force: true });
      if (res.ok) deleted += 1;
    }
    return { ok: true, deleted };
  }

  /**
   * RETIRE a review without destroying it: move every member's persisted
   * state into `data/_archive/` and unbind the live rooms.
   *
   * This is the soft counterpart to `deleteWorkspace`, and it is the one to
   * reach for when a review is finished — a merged diff review that keeps
   * presenting its unresolved threads forever is the problem it exists to
   * solve. What archiving buys, mechanically:
   *
   *   - `hydrateFromDisk` reads only the TOP LEVEL of the data dir, so an
   *     archived member stops loading at every restart and stops costing a
   *     file poll and a room's worth of memory.
   *   - `activity-backfill` scans `_archive` explicitly, so the `.ydoc` keeps
   *     feeding the Weekly Review analyses. The stream over an archived doc is
   *     byte-identical to the stream before it was archived; that is the
   *     property the suite pins, because it is the whole reason this verb is
   *     not a delete.
   *   - `unarchiveReview` puts it back, so nothing here needs to be right the
   *     first time.
   *
   * Open threads do NOT block it. The guardrail on `deleteWorkspace` exists
   * because deleting strands someone's unread feedback; archiving strands
   * nothing, and a review is usually retired precisely because its remaining
   * threads have stopped mattering.
   *
   * ALL-OR-NOTHING on a docId that is already in `_archive`: rather than write
   * over an older snapshot of the same id — the state a handful of ids on the
   * production box are in, from a hand-move that predates this verb — the
   * whole archive is refused and the colliding ids are named. Unarchive the
   * older copy first, or purge it deliberately; nothing here decides for you
   * which of two snapshots is worth less.
   */
  archiveReview(
    setId: string,
    opts: { archivedBy: string; reason?: string; linkedWorkspaces?: string[] },
  ):
    | { ok: true; archived: number; docIds: string[]; manifest: ArchivedReview }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'archive-collision' | 'move-failed'; docIds: string[] } {
    const members = this.p.list().filter((m) => attachmentIdOf(m) === setId);
    if (members.length === 0) return { ok: false, error: 'not-found' };
    const dir = ensureArchiveDir(this.p.dataDir());

    // Pre-flight the collision check across ALL members before moving any.
    const collisions = members
      .map((m) => m.docId)
      .filter((docId) => existsSync(join(dir, `${docId}.ydoc`)));
    if (collisions.length > 0) return { ok: false, error: 'archive-collision', docIds: collisions };

    const moved: string[] = [];
    for (const m of members) {
      const room = this.p.residentRoom(m.docId);
      // Flush BEFORE tearing down: the pending debounced write is cancelled by
      // teardown, so without this the archived snapshot is up to 200ms stale —
      // and for a doc edited right up to the moment it was retired, that is
      // the edit the reviewer just made.
      if (room) this.p.persistRoomNow(room);
      if (!this.moveDocFiles(m.docId, this.p.dataDir(), dir)) {
        // Undo every move so a failed archive costs nothing — not even to a
        // restart that lands right after it. Nothing has been torn down yet,
        // so the live rooms are still exactly as they were.
        for (const done of moved) this.moveDocFiles(done, dir, this.p.dataDir());
        return { ok: false, error: 'move-failed', docIds: [m.docId] };
      }
      moved.push(m.docId);
    }
    // Commit point passed: every file is parked. Now unbind the rooms.
    for (const m of members) {
      const room = this.p.residentRoom(m.docId);
      if (room) {
        this.p.teardownRoom(room, 'review archived');
        continue;
      }
      // A member nobody had opened has no room to tear down, but its alias
      // was claimed from the index at boot and would outlive its file:
      // `claimAlias` then refuses to give that name to a NEW doc, so a reused
      // review name resolves for ever to something archived. `teardownRoom`
      // released these back when every doc was resident.
      this.p.releaseAliases(m.docId);
    }

    const entry = members.find((m) => attachmentIdOf(m) === setId);
    const manifest: ArchivedReview = {
      setId,
      archivedAt: toUtcIso(Date.now()),
      archivedBy: opts.archivedBy,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(entry?.title !== undefined ? { title: entry.title } : {}),
      ...(entry?.workspaceRoot !== undefined ? { root: entry.workspaceRoot } : {}),
      docIds: moved,
      linkedWorkspaces: opts.linkedWorkspaces ?? [],
    };
    writeArchiveManifest(this.p.dataDir(), manifest);
    this.recordReviewLifecycle('archive', setId, moved, opts);
    return { ok: true, archived: moved.length, docIds: moved, manifest };
  }

  /**
   * Put an archived review back exactly where it was: move each member's
   * persisted state up out of `_archive`, hydrate the rooms, re-arm the file
   * bindings, and drop the manifest.
   *
   * Refuses, all-or-nothing, if any member id has been re-minted at the top
   * level while the review was away — restoring over a live doc would destroy
   * the newer one, which is the failure this whole feature exists to avoid.
   */
  unarchiveReview(
    setId: string,
    opts: { archivedBy: string },
  ):
    | { ok: true; restored: number; docIds: string[]; manifest: ArchivedReview }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'restore-collision' | 'move-failed'; docIds: string[] } {
    const manifest = readArchiveManifest(this.p.dataDir(), setId);
    if (!manifest) return { ok: false, error: 'not-found' };
    const dir = archiveDirPath(this.p.dataDir());

    const collisions = manifest.docIds.filter((docId) => existsSync(this.p.pathFor(docId)));
    if (collisions.length > 0) return { ok: false, error: 'restore-collision', docIds: collisions };

    const moved: string[] = [];
    for (const docId of manifest.docIds) {
      if (!this.moveDocFiles(docId, dir, this.p.dataDir())) {
        for (const done of moved) this.moveDocFiles(done, this.p.dataDir(), dir);
        return { ok: false, error: 'move-failed', docIds: [docId] };
      }
      moved.push(docId);
    }
    for (const docId of moved) this.p.hydrateDoc(docId);
    removeArchiveManifest(this.p.dataDir(), setId);
    this.recordReviewLifecycle('unarchive', setId, moved, opts);
    return { ok: true, restored: moved.length, docIds: moved, manifest };
  }

  /**
   * RETIRE ONE free-standing doc: flush it, move its persisted state into
   * `data/_archive/`, and unbind the room.
   *
   * `archiveReview` is the same act over a member list, and it is the verb for
   * anything that HAS a member list. This one exists for what that cannot
   * express — a markdown doc from `create_review_doc`, a mockup from
   * `bind_mock`: a few hundred docs on the production box whose only removal
   * path was `delete_doc`, which purges the `.ydoc` the activity analyses are
   * rebuilt from. Everything mechanical is shared with the review path
   * (`moveDocFiles`, `teardownRoom`, `hydrateDoc`), so the two cannot drift
   * about what archiving means.
   *
   * Three refusals, each because the right verb is a different one:
   *
   *   - `review-member` — the doc carries a review id, so `archiveReview` would
   *     sweep it up with its siblings. The test is deliberately the broad
   *     `attachmentIdOf` rather than `isAttachmentMember`: the question is not "is this
   *     a proper review" but "would `archiveReview` move this file", and that
   *     selector is `attachmentIdOf`. Answering the narrower question would let two
   *     verbs both claim the same doc.
   *   - `board-owned` — a `task:` body or a `ws:` board room is live furniture
   *     the board re-creates, not a document anyone archives.
   *   - `archive-collision` — an older snapshot of this id is already parked.
   *     Nothing here decides which of two snapshots is worth less.
   *
   * Open threads do not block it, for the same reason they do not block
   * `archiveReview`: archiving strands nothing, and `unarchiveDoc` puts it
   * back with its threads intact.
   */
  archiveDoc(
    docId: string,
    opts: { archivedBy: string; reason?: string; linkedWorkspaces?: string[] },
  ):
    | { ok: true; docId: string; manifest: ArchivedDoc }
    | { ok: false; error: 'not-found' | 'board-owned' | 'archive-collision' | 'move-failed' }
    | { ok: false; error: 'review-member'; setId: string } {
    if (isBoardOwnedDoc(docId)) return { ok: false, error: 'board-owned' };
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'not-found' };
    // From here on the CANONICAL id: everything below names files, writes a
    // manifest and reports back, and an alias names none of them.
    const id = room.docId;
    const setId = attachmentIdOf(room.meta);
    if (setId !== undefined) return { ok: false, error: 'review-member', setId };

    const dir = ensureArchiveDir(this.p.dataDir());
    if (existsSync(join(dir, `${id}.ydoc`))) return { ok: false, error: 'archive-collision' };

    // Flush BEFORE tearing down: teardown cancels the pending debounced write,
    // so without this the archived snapshot is up to 200ms stale — and for a
    // doc edited right up to the moment it was retired, that is the edit the
    // reviewer just made.
    this.p.persistRoomNow(room);
    if (!this.moveDocFiles(id, this.p.dataDir(), dir)) return { ok: false, error: 'move-failed' };
    // Commit point passed: the files are parked. Now unbind the room.
    this.p.teardownRoom(room, 'doc archived');

    const manifest: ArchivedDoc = {
      docId: id,
      archivedAt: toUtcIso(Date.now()),
      archivedBy: opts.archivedBy,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(room.meta.title !== undefined ? { title: room.meta.title } : {}),
      linkedWorkspaces: opts.linkedWorkspaces ?? [],
    };
    writeDocArchiveManifest(this.p.dataDir(), manifest);
    this.recordArchiveLifecycle('archive', id, {}, opts);
    return { ok: true, docId: id, manifest };
  }

  /**
   * Put an archived doc back where it was: move its persisted state up out of
   * `_archive`, hydrate the room, re-arm the file binding, drop the manifest.
   *
   * Refuses if the id has been re-minted at the top level while the doc was
   * away — restoring over a live doc would destroy the newer one, which is the
   * failure this whole feature exists to avoid.
   */
  unarchiveDoc(
    docId: string,
    opts: { archivedBy: string },
  ):
    | { ok: true; docId: string; manifest: ArchivedDoc }
    | { ok: false; error: 'not-found' | 'restore-collision' | 'move-failed' } {
    const manifest = readDocArchiveManifest(this.p.dataDir(), docId);
    if (!manifest) return { ok: false, error: 'not-found' };
    if (existsSync(this.p.pathFor(docId))) return { ok: false, error: 'restore-collision' };

    const dir = archiveDirPath(this.p.dataDir());
    if (!this.moveDocFiles(docId, dir, this.p.dataDir()))
      return { ok: false, error: 'move-failed' };
    this.p.hydrateDoc(docId);
    removeDocArchiveManifest(this.p.dataDir(), docId);
    this.recordArchiveLifecycle('unarchive', docId, {}, opts);
    return { ok: true, docId, manifest };
  }

  /**
   * Move a doc's `.ydoc` and its private-meta sidecar between the data dir and
   * `_archive`. Rename, not copy: it is atomic within the volume and it is
   * undoable by calling this with the directories swapped.
   *
   * A missing sidecar is fine — plenty of docs never had one, and it is a
   * cache of host-side facts rather than content. A missing `.ydoc` is also
   * fine, and is what a doc that has never been persisted looks like.
   */
  private moveDocFiles(docId: string, fromDir: string, toDir: string): boolean {
    this.p.forgetActivityMtime(docId);
    const ydocFrom = join(fromDir, `${docId}.ydoc`);
    const ydocTo = join(toDir, `${docId}.ydoc`);
    try {
      if (existsSync(ydocFrom)) renameSync(ydocFrom, ydocTo);
    } catch (err) {
      console.error(`[doc-store] failed to move ${docId}.ydoc to ${toDir}:`, err);
      return false;
    }
    const sidecarFrom = privateMetaPath(fromDir, docId);
    const sidecarTo = privateMetaPath(toDir, docId);
    try {
      if (existsSync(sidecarFrom)) renameSync(sidecarFrom, sidecarTo);
    } catch (err) {
      // The sidecar is recoverable state, so a failure here is logged and the
      // move stands — but put the .ydoc back first so the pair never splits.
      console.error(`[doc-store] failed to move sidecar for ${docId} to ${toDir}:`, err);
      try {
        if (existsSync(ydocTo)) renameSync(ydocTo, ydocFrom);
      } catch {}
      return false;
    }
    // Membership of the resident index map follows the FILE, in the one place
    // that knows the direction. Without this, archiving moved the .ydoc out
    // and dropped the room while the row stayed behind — and `list()` went on
    // reporting a doc that had just been archived, which is the whole failure
    // an archive is supposed to produce the opposite of.
    const carried = moveDocIndex(fromDir, toDir, docId);
    if (toDir === this.p.dataDir()) {
      // Coming back. A failure here really is harmless: the doc is resident
      // again, so `list()` sees it either way, and the next persist writes
      // the row.
      const restored = readDocIndex(this.p.dataDir(), docId);
      if (restored) this.p.setIndexEntry(docId, restored);
    } else {
      this.p.deleteIndexEntry(docId);
      // Leaving. A row left behind in the LIVE directory outlives the archive
      // and comes back as a doc on the next restart, so it does not get to
      // fail quietly. Deleting it destroys nothing — it is derived state, and
      // the .ydoc it describes is safe in `toDir`.
      if (!carried) {
        console.error(`[doc-store] could not move index for ${docId} to ${toDir}; dropping it`);
        deleteDocIndex(fromDir, docId);
        if (existsSync(docIndexPath(fromDir, docId))) {
          console.error(
            `[doc-store] index for ${docId} is STILL in ${fromDir} — a restart will list it as live`,
          );
        }
      }
    }
    return true;
  }

  /**
   * Record an `archive` / `unarchive` row in the activity log: who retired the
   * review, when, and why.
   *
   * Live-capture only, like `read_session` and `doc_open` — a backfill cannot
   * reconstruct it, because nothing about a moved file says who moved it. That
   * is exactly why it is written at the moment it happens.
   */
  private recordReviewLifecycle(
    type: 'archive' | 'unarchive',
    setId: string,
    docIds: string[],
    opts: { archivedBy: string; reason?: string },
  ): void {
    this.recordArchiveLifecycle(type, setId, { reviewId: setId, memberCount: docIds.length }, opts);
  }

  /**
   * Write the row itself. Shared by the review and single-doc paths so a log
   * that mixes them cannot disagree with itself about the shape of an
   * `archive`. The subject id is the docId on the event either way — a review's
   * id, or the doc's own — and `reviewId` in the payload is what tells a reader
   * which kind of thing was retired.
   */
  private recordArchiveLifecycle(
    type: 'archive' | 'unarchive',
    subjectId: string,
    extra: Event['payload'],
    opts: { archivedBy: string; reason?: string },
  ): void {
    try {
      const ts = toUtcIso(Date.now());
      const payload: Event['payload'] = {
        ...extra,
        ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      };
      const event: Event = {
        eventId: eventId({
          ts,
          actor: 'agent',
          docId: subjectId,
          type,
          payloadDigest: payloadDigest(opts.reason),
        }),
        ts,
        type,
        actor: 'agent',
        actorName: opts.archivedBy,
        isOwner: false,
        doc: buildEventDoc({ docId: subjectId } as DocMeta),
        payload,
      };
      appendActivity(this.p.dataDir(), event);
    } catch (err) {
      console.error('[doc-store] recordArchiveLifecycle failed:', err);
    }
  }
}

/**
 * A caller-supplied relPath in the tree's own spelling: no leading slashes,
 * no `.` segments, no empty segments. `./.git/config` and `.git//config` must
 * be judged as `.git/config` — the listing is compared by string, so a
 * spelling the listing would never use has to be folded before the compare
 * rather than trusted to fail it. `..` is left in place for the traversal
 * guard to refuse.
 */
function normalizeRel(relPath: string): string {
  return relPath
    .replace(/^\/+/, '')
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/** The workspace's stored exclude prefixes, normalized. Replicated on every
 *  member (there is no workspace registry), so any member answers. */
function workspaceExcludes(members: DocMeta[]): string[] {
  const raw = members.find((m) => m.workspaceExclude)?.workspaceExclude ?? [];
  return raw.map((p) => p.replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean);
}

function isExcludedPath(relPath: string, excludes: string[]): boolean {
  return excludes.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

/**
 * Sort a workspace dir node's children in place, recursively: directories
 * first, then by open-count descending (attention floats up), then by name
 * ascending. Mirrors the landing page's "what needs my review?" ordering.
 */
function sortTreeChildren(node: WorkspaceDirNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === 'dir') sortTreeChildren(child);
  }
}
