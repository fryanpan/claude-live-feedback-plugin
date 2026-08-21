import type { ReviewPayload } from './review-item.ts';

/** Kinds of surfaces the feedback core can power.
 *  - markdown: WYSIWYG prose editing (Tiptap), bidirectional file sync.
 *  - mockup/dev: HTML / running surfaces reviewed via the injectable widget.
 *  - code: read-only source file (Java/Kotlin/TS/Python/JSON…) shown with
 *    syntax highlighting; the agent edits the file on disk, the view re-renders.
 *  - diff: one changed file of a git diff review (base..target). Content is
 *    the file at the TARGET commit — immutable, so anchors never drift; the
 *    diff itself is a client-side rendering against the base text.
 *  - workspace: a hub workspace's board room (`ws:<workspaceId>`). Carries
 *    no LF-held content surface of its own — its `tasks`/`workspace` maps
 *    are a server-written projection of the task store (see the server's
 *    task-projection module), never edited through a content editor.
 */
export type DocType = 'markdown' | 'mockup' | 'code' | 'diff' | 'workspace';

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
   * Identifier of the agent that created the doc — the claude-workspaces MCP
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
   * The workspace's own bind-time configuration, replicated onto every
   * member the same way `workspaceRoot` is — there is no workspace registry,
   * so the members ARE the record. `refresh_workspace` reads these back and
   * re-applies them, which is what stops a refresh from silently widening
   * the review's scope (an excluded vendored file walking back in the moment
   * it starts differing) or scattering newly-changed files into heuristic
   * buckets when the caller had organized the sidebar by hand.
   */
  workspaceExclude?: string[];
  workspaceGroups?: Array<{ title: string; paths: string[]; details?: string }>;
  workspaceMaxFiles?: number;
  /**
   * Set by `refresh_workspace` when this member is no longer part of the
   * review: its file was deleted (browse workspace), or its change was
   * reverted so it no longer differs from the diff base. The doc is kept —
   * it still holds its comment threads, and the file may well come back —
   * but the tree renders it dimmed so nobody reviews a ghost. Cleared by
   * the next refresh that finds it again. Absent = live.
   */
  stale?: boolean;
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
   * True when every changed line in this file differs only in whitespace —
   * a formatter run, a reindent. Derived at bind time by diffing twice, the
   * second time with `-w --ignore-blank-lines`.
   *
   * Persisted rather than recomputed on demand because `setWorkspaceGroups`
   * re-runs the grouping heuristic from stored metadata alone, with no repo
   * in hand; without this the file would silently climb back out of the
   * "Whitespace only" group the next time an agent set groups.
   */
  diffWhitespaceOnly?: boolean;
  /**
   * Logical group for the sidebar's grouped-diff view (e.g. "Routing",
   * "Tests"). Supplied by the creating agent or derived heuristically at
   * bind time; refreshed on re-bind. `diffGroupRank` orders groups.
   */
  diffGroup?: string;
  diffGroupRank?: number;
  /**
   * Optional per-group prose shown under the group title in the sidebar — a
   * short "chapter intro" the author writes for the group. Every member of a
   * group carries the same value. Hard-capped at 500 chars — a longer value is
   * rejected at bind time (deliberately forcing a short intro), never
   * truncated, so a stored value is always within the limit.
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

/**
 * A thread about the document itself rather than a span inside it.
 *
 * Every other kind points INTO content, so none of them can express "this
 * comment is about the thing as a whole" — which is the only kind of comment a
 * task discussion can be, and a new task's description is empty, so there is
 * nothing in it to point at. A subject anchor cannot break, so it is never
 * re-anchored and never orphaned.
 */
export interface SubjectAnchor {
  kind: 'subject';
}

export type Anchor = TextRangeAnchor | ElementAnchor | OrphanAnchor | SubjectAnchor;

export interface Comment {
  id: string;
  author: User;
  text: string;
  ts: number;
  /**
   * Present when this comment DECLARES that it needs a person — the Review
   * Item. Absent on an ordinary comment, which is the overwhelming majority
   * and which no longer enters the review queue at all.
   *
   * It rides on the comment rather than in a store of its own because that is
   * literally what was asked for ("they can be attached as a comment item on a
   * task or a comment item in a doc"), and because threads already sync,
   * anchor, resolve, watch and render — a parallel entity would need a second
   * code path for each. See `review-item.ts`.
   */
  review?: ReviewPayload;
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
  /**
   * Model-generated topic/discussion lines, with the fingerprint of the thread
   * state they describe. Absent until the server has generated one, and
   * ignored by `threadLines` once the fingerprint stops matching — the card
   * falls back to the deterministic lines rather than showing a stale summary.
   */
  summary?: StoredSummary;
  /**
   * When the server last QUEUED a generation for this thread (written into
   * the thread's Yjs map by `scheduleSummary`, synced to every client).
   * Absent on threads whose activity never scheduled one — a key-less
   * server, or gated share-visitor writes.
   */
  summaryPendingTs?: number;
  /**
   * Stamped by a collector (never persisted) when a regenerated summary is
   * believed to be in flight — see `summaryPending()` in thread-summary.ts.
   * Makes the card say "Generating summary…" instead of flashing the
   * deterministic fallback during the regeneration window.
   */
  summaryPending?: boolean;
}

/** A generated summary as stored on a thread. Mirrors `summary-prompt.ts`. */
export interface StoredSummary {
  topic: string;
  discussion: string;
  hash: string;
  /** Prompt generation this was written under; absent = 1. See `needsCall`. */
  promptVersion?: number;
}

/** Payload POSTed to a host integration webhook for a thread event. */
export interface ThreadWebhookPayload {
  event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened';
  docId: string;
  threadId: string;
  thread: Thread;
  doc: DocMeta;
  /** the comment that triggered the event (undefined for resolve/reopen). */
  comment?: Comment;
  /** monotonically-increasing sequence within a doc. NOT unique across a
   *  server restart — the counter lives on the in-memory room and starts at 0
   *  again on every start. Use `eid` to identify an event. */
  seq: number;
  /** Globally unique id for this broadcast, identical on every channel that
   *  carries it and never repeated (see server `event-id.ts`). Optional
   *  because a server older than the stamp does not send one. */
  eid?: string;
}

/**
 * Payload POSTed to a host integration webhook for a suggestion verdict
 * (redline-suggestions phase 2). `suggestion` is untyped here (core's
 * SuggestionSummary lives in suggest-ops.ts, which this module intentionally
 * doesn't import — WebhookPayload is a thin transport shape, not the source
 * of truth) — callers that need the full shape import suggestOps directly.
 */
export interface SuggestionWebhookPayload {
  event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected';
  docId: string;
  sid: string;
  suggestion?: unknown;
  doc: DocMeta;
  /** Per-room and per-epoch; see ThreadWebhookPayload.seq. */
  seq: number;
  /** See ThreadWebhookPayload.eid. */
  eid?: string;
}

/**
 * Broadcast on the doc's event channels when a disk↔doc sync failure is
 * recorded on a bound file (conflict reassert, parse failure, dropped
 * suggestions). Before this event existed the `syncError` was only readable
 * via get_doc or a later edit response — surfaces the party who just LOST
 * content (whoever ran the git command or saved in the editor) never
 * touches. The watching agent does, so the loss is announced where the
 * watchers already are.
 */
export interface DocSyncErrorPayload {
  event: 'doc.sync_error';
  docId: string;
  doc: DocMeta;
  /** The bound file the failure is about — `relPath` when the doc carries
   *  one (diff/folder members), else the binding's path. */
  path: string;
  /** Where the overwritten external bytes were saved (clobber-backups),
   *  absent when no backup applies (parse failures) or the backup failed —
   *  `message` says which. */
  backupPath?: string;
  /** Same text `getDoc().syncError` reports: what happened and how to
   *  recover. */
  message: string;
  /** ms epoch the failure was recorded — mirrors `syncError.at`. */
  at: number;
  /** Per-room and per-epoch; see ThreadWebhookPayload.seq. */
  seq: number;
  /** See ThreadWebhookPayload.eid. */
  eid?: string;
}

/** Payload POSTed to a host integration webhook. */
export type WebhookPayload = ThreadWebhookPayload | SuggestionWebhookPayload | DocSyncErrorPayload;
