/** Kinds of surfaces the feedback core can power.
 *  - markdown: WYSIWYG prose editing (Tiptap), bidirectional file sync.
 *  - mockup/dev: HTML / running surfaces reviewed via the injectable widget.
 *  - code: read-only source file (Java/Kotlin/TS/Python/JSON…) shown with
 *    syntax highlighting; the agent edits the file on disk, the view re-renders.
 */
export type DocType = 'markdown' | 'mockup' | 'dev' | 'code';

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
