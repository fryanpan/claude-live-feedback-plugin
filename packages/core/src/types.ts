/** Kinds of surfaces the feedback core can power.
 *  - markdown: WYSIWYG prose editing (Tiptap), bidirectional file sync.
 *  - mockup/dev: HTML / running surfaces reviewed via the injectable widget.
 *  - code: read-only source file (Java/Kotlin/TS/Python/JSON…) shown with
 *    syntax highlighting; the agent edits the file on disk, the view re-renders.
 *  - diff: one changed file of a git diff review (base..target). Content is
 *    the file at the TARGET commit — immutable, so anchors never drift; the
 *    diff itself is a client-side rendering against the base text.
 */
export type DocType = 'markdown' | 'mockup' | 'code' | 'diff';

/**
 * Which Yjs content surface a doc kind uses — THE derived concept most
 * server code actually branches on. New doc kinds fill in this table
 * instead of adding `type === '…'` checks at every call site.
 *  - prose: editable `prose` XmlFragment (Tiptap), markdown file write-back.
 *  - flat:  read-only `content` Y.Text (code viewer / diff viewer).
 *  - none:  no LF-held content — the surface is a host page (widget).
 */
export type ContentKind = 'prose' | 'flat' | 'none';

export function contentKind(type: DocType): ContentKind {
  switch (type) {
    case 'markdown':
      return 'prose';
    case 'code':
    case 'diff':
      return 'flat';
    default:
      return 'none';
  }
}

/** File change kind within a git diff review (git --name-status letter). */
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DocMeta {
  docId: string;
  type: DocType;
  sourceUrl?: string;
  title?: string;
  /**
   * Optional grouping tag. Docs that share a `setId` show up in each
   * other's sidebar in the markdown editor — lets an agent register
   * a batch of related files for one review session.
   */
  setId?: string;
  createdAt: number;
  /**
   * Identifier of the agent that created the doc — the live-feedback MCP
   * child's cwd, which is the agent's project directory and matches how
   * claude-hive keys peers (`from_cwd`). Lets a cleanup job route a "still
   * needed?" prompt to the owning agent. Persisted; absent on legacy docs.
   */
  owner?: string;
  /**
   * Epoch ms of the doc's last activity (edit or thread change). DERIVED
   * server-side from the persisted `.ydoc` mtime, not stored in the CRDT —
   * so it can't churn the doc history on every keystroke. Used to find
   * idle docs for cleanup. Absent until the server populates it.
   */
  lastActivityAt?: number;
  /**
   * Workspace (bound folder/worktree) this doc belongs to, when it was
   * created by `bind_folder`. Equals `setId` for folder members, so the
   * existing set-sidebar lights up. Absent for standalone docs.
   */
  workspaceId?: string;
  /**
   * POSIX-style path of this file RELATIVE to the workspace root, e.g.
   * "packages/core/src/types.ts". Drives the file-tree UI. Absent for
   * standalone / mockup / dev docs.
   */
  relPath?: string;
  /**
   * Absolute folder that is the workspace root (= bind_folder's folderPath),
   * stored on every member doc so the tree is derivable without a registry.
   */
  workspaceRoot?: string;
  /**
   * Optional provenance passthrough captured at create/bind time, so the
   * activity event stream can attribute a doc to the agent + session that
   * produced it. `agentId` / `sessionId` are best-effort: supplied by the
   * caller of create_review_doc / bind_folder. Absent on legacy docs and on
   * any doc created without an explicit producedBy — in which case the
   * activity stream falls back to deriving agentId from `owner` and leaves
   * sessionId null.
   */
  producedBy?: { agentId?: string; sessionId?: string };
  /**
   * Git diff review fields — present only on `type: 'diff'` docs (one doc per
   * changed file, grouped under `workspaceId` = the review id, with
   * `workspaceRoot` = the repo path and `relPath` = the file's path at target).
   * `diffBase`/`diffTarget` are the resolved full commit hashes so the review
   * stays pinned even if the refs move later.
   */
  diffBase?: string;
  diffTarget?: string;
  diffStatus?: DiffFileStatus;
  /** Path at the BASE commit when the file was renamed (baseText source). */
  diffOldPath?: string;
  diffAdditions?: number;
  diffDeletions?: number;
  /**
   * Logical group for the sidebar's grouped-diff view (e.g. "Routing",
   * "Tests"). Supplied by the creating agent or derived heuristically at
   * bind time; refreshed on re-bind. `diffGroupRank` orders groups.
   */
  diffGroup?: string;
  diffGroupRank?: number;
  /**
   * Optional per-group prose shown under the group title in the sidebar — a
   * short "chapter intro" (e.g. the commit message body a group was derived
   * from). Every member of a group carries the same value. Capped at 500
   * chars at bind time.
   */
  diffGroupDetails?: string;
}

export interface User {
  /** stable id (localStorage or query param). */
  id: string;
  /** display name. */
  name: string;
  /** anonymous users have `kind: 'anon'`, known users have `'known'`. */
  kind: 'known' | 'anon';
  /** computed accent color (#rrggbb). */
  color: string;
}

/** Snippet used to display an orphaned anchor in the "All Threads" panel. */
export interface AnchorSnippet {
  text: string;
  rect?: { x: number; y: number; w: number; h: number };
}

/**
 * Page / app-state snapshot captured at anchor-create time. Lets a single
 * docId span a multi-page site or an SPA — when the current context
 * doesn't match an anchor's captured context, the widget hides the pin
 * (the thread is still listed, just not overlaid on a page where it
 * doesn't belong).
 */
export interface AnchorContext {
  /** Usually `location.pathname + location.search + location.hash` at capture time. */
  url?: string;
  /** App-declared view key — e.g. `modal=settings` or `tab=billing`. Opaque. */
  view?: string;
}

/**
 * Text range anchor backed by Yjs RelativePosition (auto-adjusts across edits).
 * `startRel` / `endRel` are serialized `Y.RelativePosition`.
 */
export interface TextRangeAnchor {
  kind: 'text-range';
  startRel: Uint8Array;
  endRel: Uint8Array;
  snippet: AnchorSnippet;
  context?: AnchorContext;
  /**
   * Set when the thread was created on text that exists only on the BASE side
   * of a diff — i.e. struck-through text in the markdown redline view.
   *
   * Deleted text has no position in `content`, so there is nothing for a
   * RelativePosition to point at. The anchor instead snaps to the nearest
   * FOLLOWING retained line, and this records what the comment was actually
   * about ("why did you cut this?" being one of the most natural redline
   * comments). The redline view re-finds the deletion by matching this snippet
   * near the anchor line — the same technique as the auto-reanchor sweep — and
   * renders the thread back on the deletion where the reviewer put it. Other
   * views use it to label the thread, rather than showing it as a comment on an
   * unrelated surviving line.
   *
   * Persisted for free: the REST route passes `anchor` through as an opaque
   * object and `createThread` stores it wholesale as frozen JSON, so no route
   * or rooms change is needed. `deleted-snippet.test.ts` guards that at the
   * HTTP level in case the route is ever "tightened" into hand-copying fields.
   */
  deletedSnippet?: string;
}

/** Fingerprint of a DOM element for anchor recovery after DOM changes. */
export interface ElementFingerprint {
  /** element id, if present. */
  id?: string;
  /** tagName (uppercased, e.g. BUTTON). */
  tag: string;
  /** stable attrs — role, aria-label, name, data-testid. */
  stableAttrs: Record<string, string>;
  /** class tokens (sorted, deduped). */
  classes: string[];
  /** short text snippet of the element's textContent (first 60 chars, collapsed whitespace). */
  text: string;
  /** index-based path walking up to 5 ancestors: "BUTTON[1] > DIV[0] > MAIN[0]". */
  path: string;
  /** data-* attrs (sorted keys). */
  dataAttrs: Record<string, string>;
  /** optional normalized bounding rect at capture time. */
  rect?: { x: number; y: number; w: number; h: number };
}

export interface ElementAnchor {
  kind: 'element';
  fingerprint: ElementFingerprint;
  /** short text for orphan display. */
  snippet: AnchorSnippet;
  context?: AnchorContext;
}

/** Wraps a non-orphan anchor when recovery fails. */
export interface OrphanAnchor {
  kind: 'orphan';
  original: TextRangeAnchor | ElementAnchor;
  lastSeenAt: number;
}

export type Anchor = TextRangeAnchor | ElementAnchor | OrphanAnchor;

export interface Comment {
  id: string;
  author: User;
  text: string;
  ts: number;
}

export type ThreadStatus = 'open' | 'resolved';

export interface ThreadSummary {
  id: string;
  status: ThreadStatus;
  anchor: Anchor;
  commentCount: number;
  lastActivity: number;
  createdBy: User;
}

export interface Thread extends ThreadSummary {
  comments: Comment[];
}

/** Payload POSTed to a host integration webhook. */
export interface WebhookPayload {
  event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened';
  docId: string;
  threadId: string;
  thread: Thread;
  doc: DocMeta;
  /** the comment that triggered the event (undefined for resolve/reopen). */
  comment?: Comment;
  /** monotonically-increasing sequence within a doc. */
  seq: number;
}
