import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type Anchor,
  type DocHome,
  type DocMeta,
  type DocType,
  type ReviewItemJudgement,
  type ReviewPayload,
  type Thread,
  type User,
  type WebhookPayload,
  contentKind,
  initDocMeta,
  listThreads,
  prose,
  readDocMeta,
  reviewIdOf,
  setThreadSummary,
  suggestOps,
} from '@feedback/core';
import { wordCount } from '@feedback/core/word-count';
import type { ServerWebSocket } from 'bun';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { DocEditOps, type DocEditPersistence } from './doc-edit-ops.ts';
import { type DocThreadPersistence, DocThreads } from './doc-threads.ts';
import { type RoomsWorkspacePersistence, RoomsWorkspaces } from './rooms-workspaces.ts';

export { randomId } from './doc-threads.ts';
/** Moved to `doc-ids.ts`, one line from the prefix list it reads — re-exported
 *  under the name it was first published as. */
export { isHubOwnedRoom } from './doc-ids.ts';

import { type StoredSummary, needsCall } from '@feedback/core/summary-prompt';
import {
  type ActivityType,
  type Event,
  appendActivity,
  buildEventDoc,
  clampReadPayload,
  eventId,
  payloadDigest,
  toUtcIso,
} from './activity.ts';
import { classifyActor, isOwnerActor } from './actor-identity.ts';
import {
  type BindDiffOpts,
  type BindDiffResult,
  type BindFolderOpts,
  type BindFolderResult,
  type RefreshWorkspaceResult,
  type SetWorkspaceGroupsResult,
  bindDiff as bindDiffImpl,
  bindFolder as bindFolderImpl,
  refreshWorkspace as refreshWorkspaceImpl,
  setWorkspaceGroups as setWorkspaceGroupsImpl,
} from './binds.ts';
import {
  canonicalRepoRoot,
  normalizeDocHome,
  resolveHomeCheckout,
  verifyPathInHome,
} from './doc-home.ts';
import {
  type DocIdAuthority,
  ReservedDocIdError,
  isHubOwnedRoom,
  isReservedDocId,
  newDocId,
} from './doc-ids.ts';
import {
  DOC_INDEX_VERSION,
  type DocIndexEntry,
  deleteDocIndex,
  dropStagedDocIndex,
  readAllDocIndexes,
  readDocIndex,
  stageDocIndex,
  unstageDocIndex,
  writeDocIndex,
} from './doc-index.ts';
import { newEventId } from './event-id.ts';
import { showFile } from './git-diff.ts';
import { gitConflictHint } from './git-provenance.ts';
import { deleteMockupCapture } from './mockup-capture.ts';
import {
  deletePrivateMeta,
  isPrivateMetaKey,
  liftPrivateMetaFromYdoc,
  readPrivateMeta,
  writePrivateMeta,
} from './private-meta.ts';
import { type ArchivedDoc, type ArchivedReview } from './review-archive.ts';
import { ROOM_TIMINGS } from './room-timings.ts';
import { isWithinRoot } from './safe-path.ts';
import type { SseHub } from './sse.ts';
import type { ScheduleArgs, ThreadSummarizer } from './summarize.ts';
import type { WebhookDispatcher } from './webhooks.ts';

export type WsCtx = {
  docId: string;
  /**
   * Which socket protocol this connection speaks. Bun hands every path to ONE
   * websocket handler object, so `/audio/<docId>` and `/y/<docId>` arrive at
   * the same `open`/`message`/`close`, and the only thing that can tell them
   * apart is what the upgrade attached. Absent means the editing socket —
   * every existing upgrade predates this field and none of them should have
   * to be touched to keep meaning what they meant.
   */
  kind?: 'yjs' | 'audio' | 'recall';
  /**
   * The per-bot token the `/recall/<token>` upgrade matched. Only ever set
   * on a `recall` socket; it is that socket's whole identity, since Recall
   * dials in with no doc in the path and no origin to check.
   */
  token?: string;
  isAwarenessOrigin: symbol;
  /**
   * The share that authorized this socket, when it came from a share
   * visitor. Authorization is checked at the HTTP upgrade and then never
   * again for the life of the connection — so without this, revoking a
   * share left every socket it had opened still connected and still
   * writable. Absent for a socket opened over the tailnet.
   */
  shareId?: string;
  /**
   * This socket may READ the doc and may not change it.
   *
   * Set at the upgrade when `CW_REQUIRE_SIGNIN_TO_WRITE` is on and the
   * browser opening it has proven nobody (server.ts). Absent — the case for
   * every socket that predates the flag, and every socket while it is off —
   * means fully writable, so nothing had to be touched to keep meaning what
   * it meant.
   *
   * Enforced in `yjs-protocol.ts`: sync step 1 is answered (that is the
   * read), and a sync step 2 or update frame is dropped. Awareness still
   * flows both ways — presence is not content, and a reader who cannot be
   * seen in the room is a worse review surface, not a safer one.
   */
  readOnly?: boolean;
};

export type FeedbackWs = ServerWebSocket<WsCtx>;

export interface DocRoom {
  docId: string;
  ydoc: Y.Doc;
  /**
   * Presence state for this room, CREATED ON FIRST READ.
   *
   * y-protocols' `Awareness` starts a 3s `setInterval` in its constructor and
   * never unrefs it, so one instance per hydrated room meant thousands of
   * timers firing forever on a server whose rooms are, almost all of them,
   * nobody's open tab. Every reader of this field is on a websocket path
   * (`yjs-protocol.ts`), so deferring construction to the first read is
   * exactly "created on first connection" without any caller having to know.
   * Use `peekAwareness()` when you must NOT bring one into being.
   */
  awareness: awarenessProtocol.Awareness;
  /**
   * The Awareness instance if this room has one, else null — the read that
   * does not construct. Teardown uses it so closing an untouched room does
   * not create the very object it is about to destroy.
   */
  peekAwareness(): awarenessProtocol.Awareness | null;
  conns: Set<FeedbackWs>;
  meta: DocMeta;
  webhookUrl?: string;
  /** incremented per webhook event. */
  seq: number;
  /**
   * Wall-clock time of the last prose edit that arrived over a live
   * websocket — i.e. a person typing in the browser editor (agents write
   * through HTTP routes, whose transactions carry string origins). Feeds
   * `staleWriteCheck` so a whole-doc rewrite from an agent's stale
   * in-context copy is refused instead of silently destroying their work.
   * In-memory only: after a restart there are no live edits to protect yet.
   */
  lastHumanEditAt?: number;
  /**
   * Wall-clock time of the last change to this doc's CONTENT made by a
   * person or an agent — the signal the stall loop reads so that a row whose
   * whole current work is somebody rewriting its doc does not read as
   * silent (see `isAuthoringOrigin`).
   *
   * Stamped from the room's single `ydoc.on('update')` hook, so it covers
   * every writer — browser websocket, MCP edit tool, HTTP route — without a
   * per-path call anyone can forget to add. Deliberately NOT any of the
   * three timestamps that already existed and each lie in a different
   * direction: `meta.lastActivityAt` is a `.ydoc` mtime that server-side
   * snapshot rewrites refresh (landing.ts rule 1), `lastTouchedAt` is set by
   * `touchDoc` on mere READS, and `lastHumanEditAt` above is browser-typing
   * only, which excludes exactly the agent MCP edits this is for.
   *
   * In-memory only, like `lastHumanEditAt`: after a restart no edit has been
   * seen yet, so a doc under active editing goes unexonerated for at most one
   * stall interval. That is the safe direction to be wrong in — it can only
   * cause the wake this removes, never suppress a real one.
   */
  lastContentChangeAt?: number;
  /**
   * An authoring edit has been seen and its `contentRevision` bump has not
   * been committed yet — the debounce is running. Read by
   * `settledContentRevision`, which commits early so a task derived from the
   * doc mid-burst stamps the POST-edit revision (otherwise the debounce
   * firing a second later would immediately flag the task the creator just
   * derived from those very edits).
   */
  pendingRevisionBump?: boolean;
  /** The debounce timer for the pending bump, so an early commit can cancel it. */
  revisionTimer?: ReturnType<typeof setTimeout> | null;
}

/** A file leaf in the workspace tree (a single bound review doc). */
export interface WorkspaceFileNode {
  type: 'file';
  docId: string;
  /** Basename of relPath. */
  name: string;
  relPath: string;
  fileType: DocType;
  /** Open (unresolved) thread count on this file. */
  openCount: number;
  /** Total thread count (open + resolved). */
  threadCount: number;
  reviewUrl?: string;
  lastActivityAt?: number;
  /** No longer part of the review (file deleted, or its change reverted) as
   *  of the last `refresh_workspace`. Still listed — it holds comments —
   *  but rendered dimmed so nobody reviews a ghost. */
  stale?: boolean;
  /** Diff-review extras (present only on `type:'diff'` members). */
  diffStatus?: DocMeta['diffStatus'];
  diffAdditions?: number;
  diffDeletions?: number;
}

/** A directory node in the workspace tree; `openCount` is rolled up from
 *  all descendant files. */
export interface WorkspaceDirNode {
  type: 'dir';
  /** Path segment name; empty string for the tree root. */
  name: string;
  openCount: number;
  children: Array<WorkspaceDirNode | WorkspaceFileNode>;
}

/** Result of `buildWorkspaceTree` — a nested directory tree plus totals. */
export interface WorkspaceTree {
  setId: string;
  /** Same value as `setId`. Deprecated for one release — this shape goes to
   *  clients built before a review stopped being called a workspace. */
  workspaceId: string;
  /** Absolute workspace root, when known (from member docs' workspaceRoot). */
  root?: string;
  totalOpen: number;
  tree: WorkspaceDirNode;
}

export interface RoomsConfig {
  dataDir: string;
  /** Called on new thread / reply / status change to dispatch webhooks + SSE. */
  sse: SseHub;
  webhooks: WebhookDispatcher;
  /** Decorate doc metadata on the way out (e.g. with a reachable reviewUrl). */
  decorateDocMeta?: (meta: DocMeta) => DocMeta & { reviewUrl?: string };
  /**
   * Generates thread summary lines. Optional on purpose: without it every
   * card falls back to its deterministic lines and nothing else changes.
   */
  summarizer?: ThreadSummarizer;
  /**
   * Called for every thread/comment event, alongside the room's own fan-out.
   * A doc can belong to something that wants to hear about its discussion
   * without being a member of a review — a task's
   * body room is one — and this is the seam for that, so Rooms stays
   * ignorant of what a `task:` docId means.
   */
  onRoomEvent?: (docId: string, payload: WebhookPayload) => void;
  /**
   * The clock the RESIDENCY policy reads — the idle/eviction window and the
   * file poll's fast lane, both of which are keyed on `lastTouchedAt`.
   *
   * Injectable so a test can prove a two-day window in a millisecond, and so
   * the property under test is the real `touchDoc` path rather than a value
   * written into the map behind it. One clock for the whole policy: two would
   * make "recently touched" mean different things a few lines apart.
   *
   * Deliberately NOT the clock for content — comment timestamps, thread
   * activity and mtimes stay on the real one, because they are data.
   */
  now?: () => number;
}

/**
 * Per-room binding to a markdown file on disk. Maintained by
 * `attachFile` — every prose change debounces a write of the
 * serialized fragment back to the file. First attach seeds from disk
 * if the fragment is empty.
 */
/**
 * What a caller can tell an attach that the files cannot.
 *
 * `liveWins`: the live doc holds content the file does not — an un-flushed
 * write-back the index row recorded at shutdown, or the very edit that
 * triggered this attach — so the at-rest arbitration reasserts the doc
 * (disk version backed up) instead of asking the clock. Without it a fresh
 * attach with no bookkeeping compares the file's mtime against the persisted
 * `.ydoc`'s, and EQUAL goes to disk. The two are routinely written inside one
 * file-timestamp tick (~4ms on a stock Linux kernel): an evict-flush right after
 * the bind, a `git worktree add` a few ms before the rebind's persist. Both
 * reverted a live edit with the file's stale copy — the doc-home-binding and
 * doc-eviction reds of 2026-08-31/09-01 — and read as a bare timeout.
 */
interface AttachOpts {
  liveWins?: boolean;
}

interface FileBinding {
  path: string;
  writeTimer?: ReturnType<typeof setTimeout> | null;
  readTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this binding takes part in the shared mtime sweep (see
   * `armFileWatcher`). There is no per-binding interval any more: 4,228 of
   * them were the 2026-08-29 timer storm. The sweep stats every ARMED
   * binding whose doc is active, plus a rotating slice of the idle ones.
   */
  pollArmed?: boolean;
  /** Last file mtime (ms) we observed, so the poll reacts only to changes. */
  lastMtimeMs?: number;
  /** The serialized markdown we last wrote or last read from disk.
   *  Both directions guard against this to break echo loops. */
  lastWritten?: string;
  /** Set when the most recent disk→doc reconcile failed (parse threw or
   *  produced zero blocks) or hit a conflict. Cleared on the next successful
   *  reconcile. Surfaced via getDoc AND on edit-tool responses so a wedged
   *  doc reports WHY it's stale instead of silently serving pre-edit
   *  content. */
  lastSyncError?: { message: string; at: number };
  /** The observeDeep callback wired by attachFile. Kept so a re-attach can
   *  unobserve it — without this, every re-attach (hydrate, re-run
   *  create_review_doc) stacked another write-back scheduler holding stale
   *  binding state. */
  observer?: Parameters<Y.XmlFragment['observeDeep']>[0];
  /** True when this flat binding writes doc edits back to the file (the
   *  editable File view). Absent/false = classic read-only code binding. */
  writeBack?: boolean;
  /** The content-Y.Text observer wired by attachFlatFile({writeBack:true}).
   *  Kept so a re-attach can unobserve it (same stacking hazard as
   *  `observer` above). */
  contentObserver?: (event: Y.YTextEvent, tr: Y.Transaction) => void;
}

/**
 * Decide what a disk→doc reconcile should do, given the file's current
 * content (`disk`), the markdown we last wrote/read (`lastWritten`), and the
 * live doc's current serialization (`currentSerialized`).
 *
 *   - `in-sync`   disk is byte-identical to our last write → nothing to do.
 *   - `catch-up`  disk differs from lastWritten but already equals the live
 *                 doc → just advance bookkeeping, don't touch the fragment.
 *   - `apply`     disk changed externally and the live doc is clean (still
 *                 equals lastWritten) → safe to pull disk into the doc.
 *   - `conflict`  disk changed externally AND the live doc has its own
 *                 un-flushed edits (diverged from lastWritten) → a blind
 *                 replace would clobber the human's in-progress work. The
 *                 caller keeps the live edits (the editor is the runtime
 *                 source of truth) and reasserts them to disk.
 *
 * Pure + exported so the policy is unit-tested without timing races.
 */
export function decideReconcile(args: {
  disk: string;
  lastWritten: string | undefined;
  currentSerialized: string;
}): 'in-sync' | 'catch-up' | 'apply' | 'conflict' {
  const { disk, lastWritten, currentSerialized } = args;
  if (disk === lastWritten) return 'in-sync';
  if (disk === currentSerialized) return 'catch-up';
  // disk diverges from BOTH our last write and the live doc.
  if (currentSerialized !== lastWritten) return 'conflict';
  return 'apply';
}

/** Yjs origin for the private-meta guard's own deletes, so it never
 *  re-enters on its own transaction. */
const PRIVATE_META_GUARD_ORIGIN = 'private-meta-guard';

/**
 * Does this transaction origin mean a PERSON or an AGENT changed the doc, as
 * opposed to the server writing to itself? Feeds `DocRoom.lastContentChangeAt`.
 *
 * An ALLOW-list, and the difference is the whole correctness argument. Yjs
 * stamps a bare `undefined` origin on any transaction that does not name one,
 * and a great deal of server bookkeeping does exactly that: the meta and
 * diff-meta writes in `binds.ts`, every thread create / resolve / re-anchor
 * write in `packages/core/src/schema.ts`, the `summaryPendingTs` marker in
 * this file, the `setId` backfill above. A deny-list of known-synthetic
 * origins counted all of them as somebody working — which is the same failure
 * as the `.ydoc` mtime the stall loop already had to learn not to trust
 * (landing.ts rule 1), reached by a different road. Caught in review; the
 * first version of this hook had that bug.
 *
 * Two shapes count:
 *  - the CONNECTION OBJECT of one of this room's live websockets — a person
 *    typing in the browser editor. `lastHumanEditAt` identifies them the
 *    same way, a few hundred lines below.
 *  - an `agent…` string. Every server-side writer acting FOR an agent stamps
 *    one: plain `agent` from `packages/core/src/prose.ts`, which is every
 *    prose edit tool (`find_and_replace`, `rewrite_thread_region`,
 *    `edit_at_anchor`, …), plus `agent-set-content`, `agent-queued`,
 *    `agent-meeting-assistant`.
 *
 * `agent-reanchor` is the one agent-shaped exception: it is the server's own
 * thread re-anchor sweep, which runs in REACTION to an edit, so counting it
 * would let a single real edit keep re-arming the clock by itself.
 *
 * Excluding the undefined-origin THREAD writes costs the stall loop nothing —
 * a comment already reaches the same clock as `thread.lastActivity`; see the
 * caller in server.ts. And hydration is excluded twice over: `wireEvents` is
 * wired after `loadFromDisk`, so a room's load never reaches the hook at all.
 */
const REANCHOR_ORIGIN = 'agent-reanchor';

/** Yjs origin for the server's own `contentRevision` / plan-state meta
 *  writes. Deliberately NOT agent-shaped: these land in the room's update
 *  hook, and an authoring origin would re-arm the debounce that fired them. */
const CONTENT_REVISION_ORIGIN = 'content-revision';

/** How long a doc must go quiet before an authoring burst commits one
 *  `contentRevision` bump. Same order as the ~1s write-back flush: a burst
 *  is a person or agent mid-thought, not N revisions. */
const REVISION_SETTLE_MS = ROOM_TIMINGS.revisionSettleMs;

/**
 * Meta keys ONLY the server may write, though they live in the synced CRDT
 * map (they must: planState is what the doc page renders, and contentRevision
 * has to survive a restart). The map is writable by any connected editor —
 * share visitors included — so without a guard a peer could set
 * `planState: 'approved'` and file rows past the hold, or move
 * `contentRevision` and suppress or fabricate stale flags. `guardServerMeta`
 * reverts any write to these keys whose transaction origin is not the
 * server's own.
 */
const SERVER_META_KEYS = [
  'planState',
  'planApprovedBy',
  'planApprovedAt',
  'planRequestedAt',
  'planRequestedBy',
  'reviewRequestedAt',
  'reviewRequestedBy',
  'reviewThreadId',
  'contentRevision',
] as const;

function isAuthoringOrigin(room: DocRoom, origin: unknown): boolean {
  if (typeof origin === 'string') return origin.startsWith('agent') && origin !== REANCHOR_ORIGIN;
  if (typeof origin !== 'object' || origin === null) return false;
  return room.conns.has(origin as FeedbackWs);
}

/** How long after a human's live edit an UNTRACKED caller's whole-doc
 *  rewrite is refused (callers with a tracked read are judged by order,
 *  not the clock). See `Rooms.staleWriteCheck`. */
const STALE_WRITE_WINDOW_MS = 10 * 60_000;

/**
 * How long a doc may sit untouched in memory before it is dropped.
 *
 * Two days, and it is Bryan's number, not a tuning parameter: *"drop idle
 * docs after two days, but if the user opens the doc again or interacts with
 * it that resets the clock"*. The reason it is long is that he is unwilling
 * to have a doc he touched recently disappear from memory, so err towards
 * keeping rather than towards a smaller process.
 *
 * THE WINDOW IS THE AUTHORITATIVE RULE. An earlier design carried a resident
 * cap of ~500 docs alongside it; roughly 600 docs are touched in a single
 * day, so a two-day window legitimately holds more than that cap allows. If
 * a count-based cap is ever added here, it must yield: a doc somebody touched
 * yesterday is never evicted to satisfy a number. There is deliberately no
 * such cap in this file today, and adding one is a decision, not a tweak.
 */
const IDLE_EVICT_MS = 2 * 24 * 60 * 60 * 1000;

/** How often the idle sweep runs. A two-day window does not need a fast
 *  clock; this only bounds how late an eviction is, never whether it
 *  happens. */
const EVICT_SWEEP_MS = 10 * 60_000;

/** How often the shared mtime sweep runs — the cadence the old per-binding
 *  interval ran at, kept so external-edit latency is unchanged for a doc
 *  anyone is actually looking at. */
const FILE_POLL_MS = ROOM_TIMINGS.filePollMs;

/** Settle time before a changed file is read, so no half-written save is parsed. */
const READ_DEBOUNCE_MS = ROOM_TIMINGS.readDebounceMs;

/** Doc → disk: how long a prose change waits before the serialize+write. */
const WRITE_BACK_MS = ROOM_TIMINGS.writeBackMs;

/** Doc → `.ydoc`: how long a change waits before the CRDT snapshot is persisted. */
const PERSIST_MS = ROOM_TIMINGS.persistMs;

/** How long after a content change the thread re-anchor sweep runs. */
const REANCHOR_MS = ROOM_TIMINGS.reanchorMs;

/** How long after an access a bound doc counts as ACTIVE — stat'd on every
 *  tick. Long enough that a person reading, thinking and typing never falls
 *  out of it; short enough that a doc touched once by a bulk operation goes
 *  quiet again. */
const FILE_POLL_ACTIVE_MS = 60_000;

/**
 * How many IDLE bindings the sweep may stat per tick.
 *
 * This is the cap that turns an unbounded per-doc cost into a constant one.
 * Idle bindings are visited round-robin, so the syscall rate is
 * `IDLE_SWEEP_BUDGET / FILE_POLL_MS` (256/s) no matter how many bound docs
 * exist — what grows with the corpus is how long an UNWATCHED external edit
 * waits to be noticed, not how hard the server works. Below the budget
 * (every dev machine, every test) each idle binding is still visited on every
 * tick, so the old 500ms guarantee is unchanged there.
 */
const IDLE_SWEEP_BUDGET = 128;

/** y-protocols' own presence constants, restated because its per-instance
 *  interval is replaced by one shared ticker (see `maintainAwareness`).
 *  `outdatedTimeout` is not exported from the package's typings. */
const AWARENESS_OUTDATED_MS = 30_000;
const AWARENESS_TICK_MS = AWARENESS_OUTDATED_MS / 10;

/** How often the always-on memory line is written. */
const MEMORY_LOG_MS = 5 * 60_000;

/**
 * How many distinct activation tags to keep. Everything past the cap folds
 * into `other`, so a pathological caller cannot grow this map without bound.
 */
const ACTIVATION_TAG_CAP = 32;
/** How many to report. The question is "who is doing this", not a census. */
const ACTIVATION_TAGS_REPORTED = 8;

/**
 * Where the current `touchDoc` came from, as `packages/<path>:<line>`.
 *
 * Only ever called when a binding goes idle -> active, which in a healthy
 * server is rare and in the case this exists to catch is exactly the thing
 * worth paying for. Frames inside rooms.ts are skipped — every touch passes
 * through `get` / `getOrCreate`, so the useful frame is the first one
 * outside.
 *
 * Deliberately relative to `packages/`: the absolute path is a host-machine
 * fact and this string is served by `GET /api/metrics`.
 */
function activationTag(): string {
  const stack = new Error().stack;
  if (!stack) return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/[/\\]packages[/\\]([^\s)]+?):(\d+):\d+/);
    if (!m) continue;
    const where = m[1].replace(/\\/g, '/');
    if (where.endsWith('/rooms.ts')) continue;
    return `packages/${where}:${m[2]}`;
  }
  return 'external';
}

/**
 * The maintenance y-protocols' `Awareness` constructor would run on its own
 * 3s interval: renew the local clock before it goes outdated, and evict
 * remote clients that have stopped reporting.
 *
 * Reimplemented over the public surface (`getLocalState` / `setLocalState` /
 * `meta` / `states` / `removeAwarenessStates`) so ONE ticker can drive every
 * room. The library's version is per instance and never unref'd; on a server
 * that hydrates every persisted doc that was thousands of timers firing
 * forever for rooms with no sockets on them.
 *
 * Exported so the equivalence is testable rather than asserted.
 */
export function maintainAwareness(aw: awarenessProtocol.Awareness, now = Date.now()): void {
  const local = aw.getLocalState();
  const localMeta = aw.meta.get(aw.clientID);
  if (local !== null && localMeta && AWARENESS_OUTDATED_MS / 2 <= now - localMeta.lastUpdated) {
    aw.setLocalState(local);
  }
  const remove: number[] = [];
  aw.meta.forEach((meta, clientId) => {
    if (
      clientId !== aw.clientID &&
      AWARENESS_OUTDATED_MS <= now - meta.lastUpdated &&
      aw.states.has(clientId)
    ) {
      remove.push(clientId);
    }
  });
  if (remove.length > 0) awarenessProtocol.removeAwarenessStates(aw, remove, 'timeout');
}

export class Rooms {
  private rooms = new Map<string, DocRoom>();
  private fileBindings = new Map<string, FileBinding>();
  /** Last attempt to re-resolve an UNBOUND home-pinned doc on an edit
   *  (`maybeRebindHome`) — the probe is cheap, but not per-keystroke. */
  private homeRebindAttemptAt = new Map<string, number>();
  /**
   * docId → reader key → last time that reader fetched the doc's content
   * (GET /api/docs/:id/content?reader=…). Pairs with `lastHumanEditAt` in
   * `staleWriteCheck`: a reader whose last read predates the last human edit
   * is holding a stale copy. In-memory, like the marker it is compared to.
   */
  private agentReads = new Map<string, Map<string, number>>();
  /**
   * Readable alias → the doc id it was minted alongside.
   *
   * Rebuilt from `meta.alias` on every `getOrCreate`, so it comes back from
   * disk with the docs at boot and travels with a `.ydoc` through archive and
   * restore. There is deliberately no separate alias file to fall out of step
   * with the rooms it describes.
   *
   * Write-once: `claimAlias` refuses a name already held. That is what makes
   * a captured URL a promise rather than a hint — a link that resolved
   * yesterday cannot be pointed at somebody else's document today.
   */
  private aliases = new Map<string, string>();

  /**
   * docId → `.ydoc` mtime (ms), the value `withActivity` reports.
   *
   * This file is written by exactly one process — us — so the cache is
   * authoritative between writes, and `persistRoomNow` refreshes it. Before
   * this, every `list()` stat'd every doc: `GET /api/docs` alone was ~11k
   * syscalls per request against the measured corpus, and `list()` is called
   * two or three times over by the workspace-thread and grouped-diff views.
   * Deleting an entry is always safe — the next read re-stats.
   */
  private activityMtime = new Map<string, number>();

  /**
   * Activation tag → how many times a binding went idle -> ACTIVE from there.
   *
   * The file poll's cost is driven entirely by how many bindings are active,
   * and twice now a whole-corpus scan has quietly put every one of them in
   * the fast lane by reading metadata through `get`. Both times the caller
   * was found by instrumenting this path by hand on a copy of the production
   * data directory; this makes the running server answer instead. Cumulative
   * since boot, capped, and reported by `GET /api/metrics`.
   */
  private activations = new Map<string, number>();

  /** docId → last time anything reached for this doc (see `touchDoc`). */
  private lastTouchedAt = new Map<string, number>();

  /** Rooms that have a live Awareness instance, i.e. the ones the shared
   *  presence ticker has to visit. */
  private awarenessRooms = new Set<DocRoom>();

  private awarenessTicker: ReturnType<typeof setInterval> | null = null;
  private filePollTicker: ReturnType<typeof setInterval> | null = null;
  /** Round-robin position in the idle half of the file sweep. */
  private idleCursor = 0;
  private memoryTicker: ReturnType<typeof setInterval> | null = null;
  private evictTicker: ReturnType<typeof setInterval> | null = null;
  /**
   * When each resident room entered memory. The eviction clock reads
   * `lastTouchedAt` first — a real reach — and falls back to this, so a doc
   * that was just created or just hydrated is never evicted before anyone
   * has had a chance to touch it.
   */
  private hydratedAt = new Map<string, number>();

  /**
   * Docs whose last bound-file write-back THREW. Sticky, and read by
   * `indexEntryFor`, so the doc's row keeps `pendingFileWrite` and the next
   * boot reasserts it — `writeBoundFileNow` swallows its own errors, so
   * without this a failed write looked exactly like a completed one to
   * everything downstream and the `.md` stayed stale until somebody opened
   * the doc, which for a cold doc is never.
   */
  private failedFileWrites = new Set<string>();

  /** The eviction policy's clock. See `RoomsConfig.now`. */
  /** The thread verbs, and this store seen through the contract they need. */
  private readonly docThreads = new DocThreads(this.docThreadPersistence());

  private docThreadPersistence(): DocThreadPersistence {
    return {
      room: (docId) => this.resolveRoom(docId),
      residentRoom: (docId) => this.rooms.get(docId),
      fireThreadEvent: (room, event, thread, comment, opts, actor) =>
        this.fireEvent(room, event, thread, comment, opts, actor),
      recordActivity: (room, type, author, threadId, opts) =>
        this.recordActivity(room, type, author, threadId, opts),
    };
  }

  /** The editing verbs, and this store seen through the contract they need. */
  private readonly docEdits = new DocEditOps(this.docEditPersistence());

  private docEditPersistence(): DocEditPersistence {
    return {
      dataDir: () => this.cfg.dataDir,
      room: (docId) => this.resolveRoom(docId),
      thread: (docId, threadId) => this.getThread(docId, threadId),
      announceSuggestion: (room, event, sid, summary) =>
        this.fireSuggestionEvent(room, event, sid, summary),
    };
  }

  private readonly workspaces = new RoomsWorkspaces(this.workspacePersistence());

  private workspacePersistence(): RoomsWorkspacePersistence {
    return {
      dataDir: () => this.cfg.dataDir,
      decorate: (meta) => this.cfg.decorateDocMeta?.(meta) ?? meta,
      list: () => this.list(),
      threadCounts: (docId) => this.threadCounts(docId),
      listThreads: (docId, filter) => this.listThreads(docId, filter),
      peekMeta: (docId) => this.peekMeta(docId),
      docExists: (docId) => this.docExists(docId),
      room: (docId) => this.resolveRoom(docId),
      residentRoom: (docId) => this.rooms.get(docId),
      getOrCreate: (docId, init) => this.getOrCreate(docId, init),
      attachFile: (docId, filePath) => this.attachFile(docId, filePath),
      attachReadonlyFile: (docId, filePath) => this.attachReadonlyFile(docId, filePath),
      deleteDoc: (docId, opts) => this.deleteDoc(docId, opts),
      hydrateDoc: (docId) => this.hydrateDoc(docId),
      persistRoomNow: (room) => this.persistRoomNow(room),
      teardownRoom: (room, closeReason) => this.teardownRoom(room, closeReason),
      releaseAliases: (docId) => this.releaseAliases(docId),
      pathFor: (docId) => this.pathFor(docId),
      forgetActivityMtime: (docId) => this.activityMtime.delete(docId),
      setIndexEntry: (docId, entry) => this.docIndex.set(docId, entry),
      deleteIndexEntry: (docId) => this.docIndex.delete(docId),
    };
  }

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  /** How many docs are actually in memory. The number lazy hydration exists
   *  to keep small, and the one a test has to be able to read. */
  residentCount(): number {
    return this.rooms.size;
  }

  /**
   * Drop ONE doc from memory without losing anything it was holding.
   *
   * This is not `teardownRoom` and must never become it. `teardownRoom` is
   * for a doc that is going away — it CANCELS the pending save and write-back
   * timers, closes the sockets, and releases the aliases. Every one of those
   * is wrong here, because the doc is coming back:
   *
   *  - Pending writes are FLUSHED, not cancelled. A cancelled write-back is
   *    the keystrokes between the last flush and now, silently gone.
   *  - Aliases stay. `teardownRoom` releases them; a captured review URL
   *    would then 404 on a doc that is merely not loaded.
   *  - The index row stays, so the doc is still listed, still resolvable,
   *    still countable — it is out of memory, not out of existence.
   *  - The file binding is dropped WHOLE, so a re-attach runs `attachFile`'s
   *    non-empty-fragment arbitration from a clean slate — the same path a
   *    restart takes, where the file is the source of truth at rest. That is
   *    what merges an edit somebody made while the doc was out of memory.
   *
   *    Honest note on this one: the ticket asked for `lastMtimeMs` to be
   *    cleared here, and it is (with the binding). But once the flush above
   *    exists, doc and file are EQUAL at eviction, and the merge test passes
   *    whether the binding is dropped or left behind — measured both ways.
   *    So the flush is the guard doing the work, and this is hygiene: it
   *    stops a stale `lastWritten`/`lastMtimeMs` from being reachable at all,
   *    rather than fixing a failure that is currently reachable.
   *
   * Returns false if the doc was not in memory to begin with.
   */
  evictRoom(docId: string): boolean {
    const room = this.rooms.get(docId);
    if (!room) return false;
    const binding = this.fileBindings.get(docId);

    // 0. Settle the revision debounce BEFORE the flush below persists the
    //    doc: a pending bump lost at eviction is an edit burst whose derived
    //    tasks would never learn the plan moved.
    this.commitRevisionBump(room);

    // 1. FLUSH. Same order and same calls as `flush()`, so a doc leaving
    //    memory is saved exactly the way a shutdown saves it.
    if (binding?.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
      try {
        this.writeBoundFileNow(room, binding);
      } catch (err) {
        // Loud, and the eviction still proceeds: the `.ydoc` write below is
        // the durable record, and refusing to evict here would pin a wedged
        // doc in memory forever.
        console.error(`[rooms] evict ${docId}: write-back failed:`, err);
      }
    }
    const pendingSave = this.saveTimers.get(docId);
    if (pendingSave) {
      clearTimeout(pendingSave);
      this.saveTimers.delete(docId);
      this.persistRoomNow(room);
    } else if (this.failedFileWrites.has(docId)) {
      // The flush above threw. Nothing else will write this doc's row, and
      // the row is the only thing that tells the next boot to come back for
      // it — so pay the mtime refresh here rather than lose the repair.
      this.persistRoomNow(room);
    }
    // No pending save means the `.ydoc` and its index row already match this
    // doc — every mutation schedules one. Rewriting anyway would refresh the
    // file's mtime, and `lastActivityAt` is that mtime: 600 evictions a day
    // would each look like activity on a doc nobody touched.

    // 2. Let go of the file. `pollArmed: false` takes it out of the shared
    //    sweep; clearing lastMtimeMs is the write-loss guard described above.
    if (binding) {
      if (binding.readTimer) clearTimeout(binding.readTimer);
      binding.readTimer = null;
      binding.pollArmed = false;
      this.fileBindings.delete(docId);
    }

    // 3. Out of memory. Aliases and the index row are deliberately untouched;
    //    `activityMtime` stays too, so a listing still answers without a stat.
    this.rooms.delete(docId);
    this.lastTouchedAt.delete(docId);
    this.hydratedAt.delete(docId);
    // The row written above carries the marker now, so the in-memory copy has
    // done its job; a doc that comes back re-derives it from its own binding.
    this.failedFileWrites.delete(docId);
    this.awarenessRooms.delete(room);
    try {
      // peek, not `room.awareness`: the getter would construct an Awareness
      // purely to destroy it.
      room.peekAwareness()?.destroy();
      room.ydoc.destroy();
    } catch {}
    return true;
  }

  /**
   * Why this doc cannot be dropped right now, or null if it can.
   *
   * These are the ways eviction loses work, so each one is a named string
   * rather than a boolean — when a doc will not leave memory, the reason is
   * the first thing anyone asks.
   *
   * NOT a hold, and worth knowing: an agent's `watch_doc` subscription. A
   * watched doc that nobody opens for two days is evicted, and while its
   * COMMENT events still arrive — a comment goes through `get`, which
   * hydrates — an external edit to its bound `.md` no longer does, because
   * an evicted doc has no file binding to poll. The doc is not resident, so
   * nothing is watching the file for it. There is no per-doc subscriber
   * count to hold on today; when there is, it belongs in this list.
   */
  private evictionHold(docId: string, room: DocRoom, now: number): string | null {
    // Somebody is in it. Their next keystroke belongs to this Y.Doc.
    if (room.conns.size > 0) return 'connected';
    const binding = this.fileBindings.get(docId);
    // The last write-back failed or collided. A wedged doc has a backup and
    // an unresolved disagreement with its file; dropping it now would leave
    // that to be rediscovered by whoever opens it next.
    if (binding?.lastSyncError) return 'sync-error';
    // A write is in flight. `evictRoom` would flush it correctly, but a doc
    // mid-write is by definition a doc something is doing work on.
    if (this.saveTimers.has(docId) || binding?.writeTimer) return 'pending-write';
    // A person edited it inside the stale-write window — the same window
    // `staleWriteCheck` uses to refuse an agent's overwrite. If an agent's
    // write is not safe yet, neither is dropping the doc it would land on.
    if (room.lastHumanEditAt !== undefined && now - room.lastHumanEditAt < STALE_WRITE_WINDOW_MS) {
      return 'human-edit';
    }
    return null;
  }

  /**
   * Drop every doc nobody has touched for two days. Returns what went.
   *
   * Public because the sweep timer and the tests must exercise the same
   * pass — a test that reimplemented the policy would prove only that the
   * test agrees with itself.
   */
  evictIdleRooms(): string[] {
    const now = this.now();
    const evicted: string[] = [];
    // Snapshot: `evictRoom` mutates the map being walked.
    for (const [docId, room] of [...this.rooms]) {
      const last = this.lastTouchedAt.get(docId) ?? this.hydratedAt.get(docId) ?? now;
      if (now - last < IDLE_EVICT_MS) continue;
      if (this.evictionHold(docId, room, now) !== null) continue;
      if (this.evictRoom(docId)) evicted.push(docId);
    }
    return evicted;
  }

  private startEvictionSweep(): void {
    if (this.evictTicker) return;
    const timer = setInterval(() => {
      try {
        const gone = this.evictIdleRooms();
        if (gone.length > 0) console.error(`[rooms] evicted ${gone.length} idle doc(s)`);
      } catch (err) {
        console.error('[rooms] eviction sweep failed:', err);
      }
    }, EVICT_SWEEP_MS);
    timer.unref?.();
    this.evictTicker = timer;
  }

  /**
   * Stop this Rooms' background timers. Every one of them is `unref`'d, so
   * this is not needed to let a process exit — it is here so a test can build
   * several Rooms over one data dir without their sweeps overlapping, and so
   * a shutdown stops sweeping before `flush` runs.
   */
  stop(): void {
    if (this.memoryTicker) clearInterval(this.memoryTicker);
    this.memoryTicker = null;
    if (this.evictTicker) clearInterval(this.evictTicker);
    this.evictTicker = null;
    if (this.filePollTicker) clearInterval(this.filePollTicker);
    this.filePollTicker = null;
    // The presence ticker stops itself when the last Awareness goes, but a
    // shutdown does not wait for that: leaving it running holds callbacks
    // into a Rooms nobody is using any more.
    if (this.awarenessTicker) clearInterval(this.awarenessTicker);
    this.awarenessTicker = null;
  }

  /**
   * docId → its listing row, resident.
   *
   * The rows are what a board actually reads, and they are ~400 bytes each
   * against 62-125 KB for the CRDT they were being decoded out of. Held in
   * memory deliberately: `list()` is on the board's hot path and must not
   * become a directory walk, and the index is small enough that keeping all
   * of it costs less than keeping one percent of the documents.
   *
   * Maintained by the same write that persists the doc, and by every path
   * that stages, restores, purges or moves one — see `doc-index.ts`.
   */
  private docIndex = new Map<string, DocIndexEntry>();

  constructor(private cfg: RoomsConfig) {
    if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true });
    // The index IS the boot. Nothing is hydrated here: a start now costs one
    // read per doc of a small JSON row instead of decoding every CRDT ever
    // written, and a doc enters memory when somebody reaches for it.
    this.docIndex = readAllDocIndexes(cfg.dataDir);
    // Names first. A doc that is not resident still has to answer to the
    // readable alias in a link somebody saved, and `claimAlias` normally runs
    // inside `getOrCreate` — which no longer runs at boot.
    this.seedAliasesFromIndex();
    this.indexUnindexedDocs();
    this.reassertPendingWrites();
    this.startMemoryLog();
    this.startEvictionSweep();
  }

  /**
   * Put every alias in the index into the resolver table.
   *
   * Aliases used to be a side effect of hydration, so the table was complete
   * because everything was loaded. With lazy hydration nothing is loaded, and
   * a table built on demand would 404 the first request for a name — the one
   * failure a captured URL cannot survive.
   */
  private seedAliasesFromIndex(): void {
    for (const [docId, entry] of this.docIndex) {
      const alias = entry.meta.alias;
      if (!alias) continue;
      // A doc whose PRIMARY id is this string beats an alias that spells it:
      // the primary is the older address and the one saved links use. Boot
      // used to settle this by loading every `.ydoc` first, so the primary
      // was already resident when the alias was claimed. Nothing is resident
      // now, so the file on disk is what has to be consulted — including the
      // pre-index `.ydoc`s this pass runs before.
      if (docId !== alias && existsSync(this.pathFor(alias))) {
        console.warn(
          `[rooms] alias "${alias}" is also a doc id on disk; leaving it to that doc (${docId} keeps its own id)`,
        );
        continue;
      }
      this.claimAlias(alias, docId);
    }
  }

  /**
   * Hydrate the docs the server went down on mid-write, so their edit still
   * reaches disk.
   *
   * The one case a lazy boot cannot leave to the next open. Everything else
   * a doc is holding survives in its `.ydoc` and is arbitrated back into
   * agreement the moment somebody reaches for it — but a doc nobody opens
   * again is never reached, and its last edit would sit in the `.ydoc` while
   * the `.md` on disk stayed stale indefinitely. The old boot covered this
   * by loading every doc; this covers it by loading the handful that were
   * actually mid-write, which after a clean shutdown is none.
   *
   * Hydration re-attaches the file, and `attachFile`'s arbitration does the
   * reassert — this method only decides WHO to open.
   */
  private reassertPendingWrites(): void {
    const pending = [...this.docIndex]
      .filter(([, entry]) => entry.pendingFileWrite)
      .map(([docId]) => docId);
    if (pending.length === 0) return;
    console.warn(
      `[rooms] ${pending.length} doc(s) had an un-flushed file write at shutdown; reasserting`,
    );
    for (const docId of pending) {
      try {
        this.hydrateDoc(docId);
      } catch (err) {
        console.error(`[rooms] could not reassert ${docId}:`, err);
      }
    }
  }

  /**
   * Give a row to every `.ydoc` that has none, then let it go again.
   *
   * This is the whole migration for the docs written before the index
   * existed: hydrate once, write the row, evict. There is no separate
   * backfill script to remember to run, and no second code path that could
   * produce a different row than `persistRoomNow` does — the row comes from
   * the same `indexEntryFor`.
   *
   * A doc that already has a row is never opened, which is the point: the
   * cost of this pass falls to zero the first time it runs.
   */
  private indexUnindexedDocs(): void {
    let written = 0;
    let files: string[];
    try {
      files = readdirSync(this.cfg.dataDir);
    } catch (err) {
      console.error('[rooms] could not read the data dir:', err);
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.ydoc')) continue;
      const docId = file.slice(0, -'.ydoc'.length);
      if (!docId || this.docIndex.has(docId)) continue;
      try {
        this.hydrateDoc(docId);
        const room = this.rooms.get(docId);
        if (!room) continue;
        const entry = this.indexEntryFor(room);
        writeDocIndex(this.cfg.dataDir, docId, entry);
        this.docIndex.set(docId, entry);
        written++;
      } catch (err) {
        // Loud: a doc with no row is invisible to every listing, so this is
        // not a cosmetic failure. It is also self-healing — the next write to
        // that doc writes its row — which is why it does not abort the boot.
        console.error(`[rooms] failed to index ${docId}:`, err);
      } finally {
        // Straight back out. Writing a row is not somebody opening the doc,
        // and a migration that left 5,000 docs resident would be the very
        // boot this change exists to stop.
        this.evictRoom(docId);
      }
    }
    if (written > 0) {
      console.error(`[rooms] wrote ${written} missing doc index row(s) at startup`);
    }
  }

  /**
   * One line every few minutes: resident memory, how many rooms are in it,
   * and how many timers this process is actually holding.
   *
   * It exists because the 2026-08-29 jetsam kill left nothing to read — the
   * server was at 2.6 GB and the only evidence of how it got there was the
   * absence of the process. Cheap enough to leave on forever: `memoryUsage()`
   * once per five minutes plus a few map sizes.
   */
  private startMemoryLog(): void {
    if (this.memoryTicker) return;
    const timer = setInterval(() => {
      const s = this.stats();
      console.error(
        `[rooms] mem rss=${s.rssMb}MB rooms=${s.rooms} bindings=${s.bindings} ` +
          `activeBindings=${s.activeBindings} awareness=${s.awareness} timers=${s.timers} ` +
          // The busiest activator, so a log-only reading of an incident still
          // names a caller instead of only a count.
          `top=${s.activations[0]?.tag ?? 'none'}x${s.activations[0]?.count ?? 0}`,
      );
    }, MEMORY_LOG_MS);
    timer.unref?.();
    this.memoryTicker = timer;
  }

  /**
   * What this Rooms currently costs: resident memory, how many rooms are in
   * it, and how many timers it actually holds.
   *
   * Public because the memory line and the tests that pin these numbers must
   * read the SAME counters — an assertion against a privately-computed number
   * proves nothing about the line an incident is read from. Cheap: map sizes
   * plus one `memoryUsage()`, no syscalls per doc.
   */
  stats(): {
    rssMb: number;
    rooms: number;
    bindings: number;
    /** Bindings the sweep would stat on this tick (see `bindingIsActive`). */
    activeBindings: number;
    /** Rooms holding a live Awareness instance. */
    awareness: number;
    /** Timers owned by this Rooms: pending saves + file debounces + tickers. */
    timers: number;
    /**
     * Who has been promoting bindings into the file poll's fast lane, since
     * boot, busiest first. Source locations and counts only — the whole point
     * is to name a CALLER, and nothing here is derived from a doc.
     */
    activations: { tag: string; count: number }[];
    /** Every activation, including the tags not listed above. */
    activationsTotal: number;
  } {
    const now = Date.now();
    let activeBindings = 0;
    let bindingTimers = 0;
    for (const [docId, binding] of this.fileBindings) {
      if (this.bindingIsActive(docId, binding, now)) activeBindings++;
      if (binding.writeTimer) bindingTimers++;
      if (binding.readTimer) bindingTimers++;
    }
    return {
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      rooms: this.rooms.size,
      bindings: this.fileBindings.size,
      activeBindings,
      awareness: this.awarenessRooms.size,
      timers:
        this.saveTimers.size +
        bindingTimers +
        (this.awarenessTicker ? 1 : 0) +
        (this.filePollTicker ? 1 : 0) +
        (this.memoryTicker ? 1 : 0) +
        (this.evictTicker ? 1 : 0),
      activations: [...this.activations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, ACTIVATION_TAGS_REPORTED)
        .map(([tag, count]) => ({ tag, count })),
      activationsTotal: [...this.activations.values()].reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Drop the two derived caches: access stamps and `.ydoc` mtimes.
   *
   * Both re-derive on the next read, so this is always safe — it is not a
   * repair, it is a way to reach the cold path on demand. Tests use it to
   * exercise "nobody has touched this doc" without waiting out
   * `FILE_POLL_ACTIVE_MS`, and it is equally the thing to call if a cache
   * ever needs clearing at runtime.
   */
  resetDerivedCaches(): void {
    this.lastTouchedAt.clear();
    this.activityMtime.clear();
  }

  /**
   * Build this room's Awareness and enrol it in the shared presence ticker.
   *
   * The library instance's own interval is stopped immediately: it is the
   * per-room timer this whole change exists to remove, and `maintainAwareness`
   * does its work from one place instead.
   */
  private createAwareness(room: DocRoom): awarenessProtocol.Awareness {
    const aw = new awarenessProtocol.Awareness(room.ydoc);
    clearInterval(
      (aw as unknown as { _checkInterval: ReturnType<typeof setInterval> })._checkInterval,
    );
    this.awarenessRooms.add(room);
    if (!this.awarenessTicker) {
      const timer = setInterval(() => this.sweepAwareness(), AWARENESS_TICK_MS);
      timer.unref?.();
      this.awarenessTicker = timer;
    }
    return aw;
  }

  /**
   * Presence maintenance for every room that HAS an Awareness — including the
   * ones with no sockets left on them.
   *
   * Skipping socketless rooms looked free and was not (codex, P2): a peer
   * whose socket went away without its cleanup running leaves its state
   * behind, and `onOpen` hands `getStates()` to the next joiner before any
   * sweep can fire. That joiner would see a ghost. The library's timer
   * expired those states whether or not anyone was connected, and this must
   * too — the count of rooms holding an Awareness is the count that have ever
   * been opened, tens rather than thousands, so there was nothing to save.
   *
   * A room whose last socket has gone keeps its Awareness rather than
   * destroying it: `yjs-protocol.ts` registers the room's broadcast handler
   * against that instance once, in a WeakMap keyed by room, so a replacement
   * instance would never get an `update` listener and presence would stop
   * working silently on the next connection.
   */
  private sweepAwareness(): void {
    const now = Date.now();
    let live = 0;
    for (const room of this.awarenessRooms) {
      const aw = room.peekAwareness();
      if (!aw) {
        this.awarenessRooms.delete(room);
        continue;
      }
      live++;
      maintainAwareness(aw, now);
    }
    if (live === 0 && this.awarenessTicker) {
      clearInterval(this.awarenessTicker);
      this.awarenessTicker = null;
    }
  }

  /**
   * Every doc on this server, as listing rows.
   *
   * A resident room is authoritative — it may hold changes the last write
   * has not carried into the index yet. A doc that is NOT resident is served
   * from its index row, which is the whole point: answering "what docs are
   * there" must not require decoding every CRDT that has ever been written.
   *
   * Today hydration still loads everything, so the second branch is only
   * reached for a doc whose `.ydoc` went missing while its row survived. It
   * is written now because the listing contract has to be settled BEFORE
   * anything stops being resident, not at the same time.
   */
  list(): DocMeta[] {
    const out: DocMeta[] = [];
    for (const room of this.rooms.values()) out.push(this.withActivity(room.meta));
    for (const [docId, entry] of this.docIndex) {
      if (this.rooms.has(docId)) continue;
      out.push(this.withActivity(entry.meta));
    }
    return out;
  }

  /**
   * The same listing built ONLY from index rows, never from resident rooms.
   *
   * Exists so the equality that everything else rests on can be asserted
   * directly: an index-backed listing must equal the hydrated one field for
   * field. Without a seam that refuses to consult the rooms, a test of that
   * property would read the rooms through `list()` and pass no matter what
   * the index said.
   */
  listFromIndex(): DocMeta[] {
    return [...this.docIndex.values()].map((e) => this.withActivity(e.meta));
  }

  /**
   * A doc's open and total thread counts from its index row, without loading
   * it. Null when there is no row — the caller reads the doc instead.
   */
  threadCountsFromIndex(docId: string): { open: number; total: number } | null {
    const entry = this.docIndex.get(docId);
    return entry ? { ...entry.threads } : null;
  }

  /** The most recent comment timestamp on a doc, from its index row. */
  lastThreadActivityFromIndex(docId: string): number | undefined {
    return this.docIndex.get(docId)?.lastThreadActivityAt;
  }

  /**
   * A doc's open and total thread counts, for the listings that render badges.
   *
   * Prefers the index row, which costs a map lookup, over decoding the doc's
   * thread map — which the diff tree and the landing page were doing once per
   * doc per render, twice per doc in the tree's case.
   *
   * The row is skipped only while `saveTimers` holds a pending write for that
   * doc, which is exactly the window in which the doc has changes the index
   * has not been given yet. Outside that window the two cannot differ,
   * because the same debounced write produces both. So this is not "close
   * enough for a badge": it is the same number, found more cheaply.
   */
  threadCounts(docId: string): { open: number; total: number } {
    if (!this.saveTimers.has(docId)) {
      const entry = this.docIndex.get(docId);
      if (entry) return { ...entry.threads };
    }
    const room = this.rooms.get(docId);
    if (!room) return { open: 0, total: 0 };
    const all = listThreads(room.ydoc);
    return { open: all.filter((t) => t.status === 'open').length, total: all.length };
  }

  /**
   * The newest comment timestamp on a doc — what the landing page ranks by.
   * Same index-first rule as `threadCounts`; 0 when the doc has no comments.
   */
  lastThreadActivity(docId: string): number {
    if (!this.saveTimers.has(docId)) {
      const entry = this.docIndex.get(docId);
      if (entry) return entry.lastThreadActivityAt ?? 0;
    }
    const room = this.rooms.get(docId);
    if (!room) return 0;
    return listThreads(room.ydoc).reduce((max, t) => Math.max(max, t.lastActivity), 0);
  }

  /**
   * Stamp a doc's meta with `lastActivityAt`, derived from the persisted
   * `.ydoc` mtime. saveToDisk rewrites that file on every prose/thread
   * change (200ms debounced), so its mtime tracks real activity without a
   * CRDT field that would churn the doc history on every keystroke. Falls
   * back to `createdAt` when the file isn't on disk yet.
   */
  private withActivity(meta: DocMeta): DocMeta {
    return { ...meta, lastActivityAt: this.lastActivityFor(meta.docId, meta.createdAt) };
  }

  /**
   * The `.ydoc` mtime for a doc, stat'd at most once per write.
   *
   * Same number `withActivity` always reported — this only stops asking the
   * filesystem for it on every row of every list. `persistRoomNow` refreshes
   * the entry (it is the only writer of that file), and every path that moves
   * or removes the file drops the entry so the next read re-stats.
   */
  private lastActivityFor(docId: string, createdAt: number): number {
    const cached = this.activityMtime.get(docId);
    if (cached !== undefined) return cached;
    let lastActivityAt = createdAt;
    try {
      const p = this.pathFor(docId);
      if (existsSync(p)) lastActivityAt = Math.round(statSync(p).mtimeMs);
    } catch {}
    this.activityMtime.set(docId, lastActivityAt);
    return lastActivityAt;
  }

  /**
   * Permanently remove a review doc: drop the in-memory room, cancel its
   * timers, and delete the persisted `.ydoc` so it doesn't reload on the
   * next restart. The bound SOURCE file (sourceUrl) is the user's own file
   * and is left untouched.
   *
   * Guardrail: refuses if the doc still has OPEN comment threads (returns
   * `has-open-threads` + the count) unless `force` is set — open threads
   * mean someone is still waiting on that feedback. This is the primary
   * cleanup path for the "doc used for 30 min then obsolete" lifecycle.
   */
  deleteDoc(
    docId: string,
    opts?: { force?: boolean },
  ): { ok: boolean; error?: 'not-found' | 'has-open-threads'; openThreads?: number } {
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const openThreads = listThreads(room.ydoc).filter((t) => t.status === 'open').length;
    if (openThreads > 0 && !opts?.force) {
      return { ok: false, error: 'has-open-threads', openThreads };
    }
    this.teardownRoom(room, 'doc deleted');
    // `room.docId`, not `docId`: an alias resolves to the room but names no
    // file, so purging the raw argument deleted nothing and reported success
    // — the doc came back on the next boot.
    this.purgePersisted(room.docId);
    return { ok: true };
  }

  /**
   * Unbind a room from this process: cancel its pending persistence, drop its
   * file binding and every timer that binding owns, close live viewers, and
   * take it out of memory.
   *
   * Shared by the two verbs that stop serving a doc — `deleteDoc`, which then
   * removes the persisted state, and `archiveReview`, which then moves it into
   * `_archive`. They differ only in what happens to the FILE; everything about
   * unhooking the room is the same, and keeping one copy is what stops an
   * archive from leaving a poll running against a doc nobody can open.
   *
   * Cancelling the save timer is load-bearing rather than tidy: a pending
   * debounced write fires 200ms later and re-creates `<docId>.ydoc` at the top
   * level, which for an archive means the doc quietly comes back at the next
   * restart. Callers that need the CURRENT state on disk must flush BEFORE
   * calling this.
   */
  private teardownRoom(room: DocRoom, closeReason: string): void {
    const docId = room.docId;
    this.releaseAliases(docId);
    // A doc being deleted has no derived-task bookkeeping left to do — but a
    // live timer firing on a destroyed ydoc does. Drop the debounce, not
    // commit it: this path destroys the doc.
    if (room.revisionTimer) clearTimeout(room.revisionTimer);
    room.revisionTimer = null;
    room.pendingRevisionBump = false;
    const saveTimer = this.saveTimers.get(docId);
    if (saveTimer) clearTimeout(saveTimer);
    this.saveTimers.delete(docId);
    const binding = this.fileBindings.get(docId);
    if (binding) {
      if (binding.writeTimer) clearTimeout(binding.writeTimer);
      if (binding.readTimer) clearTimeout(binding.readTimer);
      binding.pollArmed = false;
      this.fileBindings.delete(docId);
    }
    for (const ws of room.conns) {
      try {
        ws.close(1000, closeReason);
      } catch {}
    }
    this.rooms.delete(docId);
    this.activityMtime.delete(docId);
    this.lastTouchedAt.delete(docId);
    this.hydratedAt.delete(docId);
    this.awarenessRooms.delete(room);
    try {
      // peek, not `room.awareness`: the getter would construct an Awareness
      // (and register a fresh sweep entry) purely to destroy it.
      room.peekAwareness()?.destroy();
      room.ydoc.destroy();
    } catch {}
  }

  /**
   * Remove a docId's persisted state whether or not the room is in memory,
   * and report whether the disk is now clean.
   *
   * `deleteDoc` answers about the ROOM: it logs a failed unlink and still
   * returns ok, and on a second attempt the room is already out of memory so
   * it returns 'not-found' without touching disk at all. A caller that must
   * not leave an orphan `.ydoc` behind — one that reloads on every restart,
   * under an id whose owner may be gone — has to ask about the FILE.
   */
  /**
   * Move a docId's persisted `.ydoc` aside, reversibly, so a multi-step
   * delete can prove the file is removable before it does anything it can't
   * take back.
   *
   * `rename` is the whole point: unlinking is not reversible from a live
   * room (its state re-reaches disk only on the next write, and a restart in
   * between loses it), while a staged file can be moved straight back. The
   * staged name deliberately does not end in `.ydoc`, so `hydrateFromDisk`
   * skips it — a leftover is inert litter rather than a room that reloads
   * under an id whose owner is gone.
   *
   * Returns false only if the file is there and could not be moved.
   */
  stagePersisted(docId: string): boolean {
    this.activityMtime.delete(docId);
    // The row goes with the doc, or a listing keeps describing something
    // that is no longer there.
    stageDocIndex(this.cfg.dataDir, docId);
    this.docIndex.delete(docId);
    const path = this.pathFor(docId);
    if (!existsSync(path)) return true;
    try {
      renameSync(path, `${path}.deleting`);
      return true;
    } catch (err) {
      console.error(`[rooms] failed to stage ${docId} for deletion:`, err);
      return false;
    }
  }

  /** Put a staged `.ydoc` back — the delete didn't commit. */
  unstagePersisted(docId: string): void {
    this.activityMtime.delete(docId);
    unstageDocIndex(this.cfg.dataDir, docId);
    const restored = readDocIndex(this.cfg.dataDir, docId);
    if (restored) this.docIndex.set(docId, restored);
    const staged = `${this.pathFor(docId)}.deleting`;
    if (!existsSync(staged)) return;
    try {
      renameSync(staged, this.pathFor(docId));
    } catch (err) {
      console.error(`[rooms] failed to restore staged ${docId}:`, err);
    }
  }

  /** Remove a staged `.ydoc` — the delete committed. A failure here leaves
   *  a file nothing loads, so it is litter, not an orphan room. */
  dropStaged(docId: string): void {
    dropStagedDocIndex(this.cfg.dataDir, docId);
    try {
      rmSync(`${this.pathFor(docId)}.deleting`, { force: true });
    } catch (err) {
      console.error(`[rooms] failed to remove staged ${docId}:`, err);
    }
  }

  purgePersisted(docId: string): boolean {
    this.activityMtime.delete(docId);
    this.docIndex.delete(docId);
    try {
      const p = this.pathFor(docId);
      if (existsSync(p)) rmSync(p);
      deletePrivateMeta(this.cfg.dataDir, docId);
      deleteDocIndex(this.cfg.dataDir, docId);
      // A mockup's captured HTML is the reviewer's copy of somebody's page.
      // Archiving leaves it alone (see mockup-capture.ts); a purge is the one
      // caller that has actually been asked for the bytes to be gone, so it
      // goes with the .ydoc rather than outliving it in the data dir.
      deleteMockupCapture(this.cfg.dataDir, docId);
      return !existsSync(p);
    } catch (err) {
      console.error(`[rooms] failed to remove persisted ${docId}:`, err);
      return false;
    }
  }

  /**
   * Load ONE persisted doc into memory and re-arm its file binding. Returns
   * whether a binding was re-established.
   *
   * Extracted from `hydrateFromDisk` so `unarchiveReview` restores a doc the
   * same way a restart would. A doc that came back into memory without its
   * binding would read fine and never write back — the exact 2026-05-09 bug
   * hydration exists to prevent — so a second, drifting copy of this logic is
   * the thing most worth not having.
   */
  private hydrateDoc(docId: string): boolean {
    // Server authority: hydration re-admits ids that ALREADY EXIST on disk,
    // including the `task:` and `ws:` rooms the projection wrote. Refusing
    // them here would not close a hole — the room is already persisted — it
    // would only make the board fail to come back after a restart.
    const room = this.getOrCreate(docId, undefined, { authority: 'server' });
    const src = room.meta.sourceUrl;
    // The index row remembers a write-back that had not landed at shutdown:
    // the doc holds content the file does not, whatever the two mtimes say.
    const liveWins = this.docIndex.get(docId)?.pendingFileWrite === true;
    // A hub-owned room is never file-bound (§3.3), so a sourceUrl on one
    // can only have arrived from a peer's ydoc write. Refusing to bind
    // here is the second, independent stop behind `guardPrivateMeta` —
    // binding is what turns a stray meta key into "read (then overwrite)
    // any file this process can reach".
    if (src && isHubOwnedRoom(docId)) {
      console.error(`[rooms] ${docId}: ignoring a sourceUrl on a server-owned hub room`);
      return false;
    }
    // A home-pinned doc re-resolves its home rather than trusting the path
    // it was bound to when the server went down — worktrees move between
    // restarts. Unplaced parks exactly like a live park: content is in the
    // .ydoc, no binding, the pin persists for the next resolve.
    const home = room.meta.docHome;
    if (home && !isHubOwnedRoom(docId) && contentKind(room.meta.type) === 'prose') {
      const placement = resolveHomeCheckout(home);
      if (!placement.placed) {
        console.warn(
          `[rooms] ${docId}: doc home unplaced at hydrate (${placement.reason}); writes parked`,
        );
        return false;
      }
      this.retargetHomeBinding(room, placement.absPath, { liveWins });
      return this.fileBindings.has(docId);
    }
    if (!src || !existsSync(src)) return false;
    if (contentKind(room.meta.type) === 'prose') {
      return this.attachFile(docId, src, { liveWins }).ok;
    }
    if (contentKind(room.meta.type) === 'flat') {
      // Working-tree diff docs have a sourceUrl and re-arm their live
      // poll like code docs. Pinned diff docs have no sourceUrl and
      // need no binding — content is already in the .ydoc. Editable
      // (write-back) members must come back editable: binding
      // hydration ≠ state hydration, and a read-only re-attach here
      // silently ate every post-restart File-view edit.
      const writeBack =
        room.meta.type === 'diff' &&
        !room.meta.diffTarget &&
        !(room.meta.relPath ?? '').toLowerCase().endsWith('.md');
      return this.attachFlatFile(docId, src, { writeBack, liveWins }).ok;
    }
    return false;
  }

  getOrCreate(
    docId: string,
    init?: {
      type?: DocType;
      sourceUrl?: string;
      title?: string;
      setId?: string;
      webhookUrl?: string;
      owner?: string;
      workspaceId?: string;
      relPath?: string;
      workspaceRoot?: string;
      producedBy?: { agentId?: string; sessionId?: string };
      diffBase?: string;
      diffTarget?: string;
      diffStatus?: DocMeta['diffStatus'];
      diffOldPath?: string;
      diffAdditions?: number;
      diffDeletions?: number;
      diffWhitespaceOnly?: boolean;
      /** The readable name this doc was created under. Written at creation
       *  and never again — see `claimAlias`. */
      alias?: string;
      /** A huddle doc — see `DocMeta.huddle`. */
      huddle?: boolean;
      /** Which entry flow made it — see `DocMeta.huddleKind`. */
      huddleKind?: 'plan' | 'discussion';
    },
    /**
     * Who is asking. Defaults to `caller`, which is what closes the two
     * namespace holes: a door that forgets to declare itself gets the
     * restricted answer rather than the permissive one.
     */
    opts?: { authority?: DocIdAuthority },
  ): DocRoom {
    // THE SEAM. Every path that can bring a docId into existence funnels
    // here — the three creation routes, both bind paths, the lazy sidebar
    // open, the task projection, and hydration — so the entitlement question
    // is asked once. Deliberately not an enumeration of entry points: the
    // enumeration is what missed `POST /api/docs`.
    if ((opts?.authority ?? 'caller') === 'caller' && isReservedDocId(docId)) {
      throw new ReservedDocIdError(docId);
    }
    const existing = this.rooms.get(docId);
    if (existing) {
      this.touchDoc(docId);
      if (init?.webhookUrl !== undefined) existing.webhookUrl = init.webhookUrl;
      // Allow re-tagging an existing doc into a different set without a
      // server restart — agents may rebatch their review queue.
      if (init?.setId !== undefined && init.setId !== existing.meta.setId) {
        const m = existing.ydoc.getMap('meta');
        existing.ydoc.transact(() => m.set('setId', init.setId));
        existing.meta.setId = init.setId;
      }
      // Re-binding: bind_mock(docId, newPath) is documented as repointing an
      // existing doc, but this branch used to drop init.sourceUrl — the doc
      // kept serving the old file while the call reported success. sourceUrl
      // is private-sidecar meta (never CRDT), so the whole repoint is the
      // in-memory field plus the same debounced persist creation uses. Hub
      // rooms stay excluded for the same reason hydrateFromDisk refuses a
      // sourceUrl on them: a server-owned room is never file-bound.
      if (
        init?.sourceUrl !== undefined &&
        init.sourceUrl !== existing.meta.sourceUrl &&
        !isHubOwnedRoom(docId)
      ) {
        existing.meta.sourceUrl = init.sourceUrl;
        this.saveToDisk(existing);
      }
      return existing;
    }
    const ydoc = new Y.Doc();
    this.loadFromDisk(docId, ydoc);
    // Private fields live in a sidecar, not the CRDT (see private-meta.ts).
    // A `.ydoc` written before that change still carries them: lift them out
    // — which also DELETES them from the doc, so the next share visitor to
    // sync this room doesn't receive them — and let the sidecar win where
    // both exist, since the sidecar is the one being maintained.
    const legacyPrivate = liftPrivateMetaFromYdoc(ydoc);
    const storedPrivate = { ...legacyPrivate, ...readPrivateMeta(this.cfg.dataDir, docId) };
    const restored = { ...readDocMeta(ydoc), ...storedPrivate };
    const isNew = !restored.docId;
    const meta: DocMeta = (() => {
      if (!isNew) {
        // Restored doc; allow init to override setId (set membership
        // is editorial, not part of the persisted CRDT contract).
        if (init?.setId !== undefined && init.setId !== restored.setId) {
          const m = ydoc.getMap('meta');
          ydoc.transact(() => m.set('setId', init.setId));
          restored.setId = init.setId;
        }
        return restored;
      }
      const now: DocMeta = {
        docId,
        type: init?.type ?? 'markdown',
        sourceUrl: init?.sourceUrl,
        title: init?.title,
        setId: init?.setId,
        owner: init?.owner,
        workspaceId: init?.workspaceId,
        relPath: init?.relPath,
        workspaceRoot: init?.workspaceRoot,
        producedBy: init?.producedBy,
        diffBase: init?.diffBase,
        diffTarget: init?.diffTarget,
        diffStatus: init?.diffStatus,
        diffOldPath: init?.diffOldPath,
        diffAdditions: init?.diffAdditions,
        diffDeletions: init?.diffDeletions,
        alias: init?.alias,
        ...(init?.huddle ? { huddle: true } : {}),
        ...(init?.huddleKind ? { huddleKind: init.huddleKind } : {}),
        createdAt: Date.now(),
      };
      initDocMeta(ydoc, now);
      return now;
    })();
    // Index the readable name — for a doc just minted, and for one coming
    // back off disk at boot. Same call either way, so the alias table cannot
    // be complete at creation and empty after a restart.
    if (meta.alias) this.claimAlias(meta.alias, docId);
    // Captured so the `awareness` getter below can reach the Rooms instance:
    // inside a getter, `this` is the room, not the map that owns it.
    const owner = this;
    let awareness: awarenessProtocol.Awareness | null = null;
    const room: DocRoom = {
      docId,
      ydoc,
      get awareness(): awarenessProtocol.Awareness {
        if (!awareness) awareness = owner.createAwareness(this as DocRoom);
        return awareness;
      },
      peekAwareness: () => awareness,
      conns: new Set(),
      meta,
      webhookUrl: init?.webhookUrl,
      seq: 0,
    };
    this.rooms.set(docId, room);
    this.hydratedAt.set(docId, this.now());
    this.wireEvents(room);
    // For freshly-created rooms (no on-disk state), the initDocMeta call
    // above fired its update event before wireEvents listened, so nothing
    // would ever flush this room to disk if the user hasn't done another
    // mutation by the next supervisor restart. Force a snapshot now so a
    // create_review_doc immediately followed by a `bun --watch` reload
    // doesn't lose the doc.
    //
    // A migrated legacy doc needs the same forced snapshot for the same
    // reason — the lift's transaction also ran before wireEvents listened, so
    // without this the private keys would still be in the `.ydoc` on disk and
    // would come straight back on the next restart.
    if (isNew || Object.keys(legacyPrivate).length > 0) this.saveToDisk(room);
    return room;
  }

  /**
   * A room by its id, or by a readable alias that resolves to it.
   *
   * Primary first, alias second — and the order is the migration. Every doc
   * created before minting has a caller-chosen string as its PRIMARY id, so a
   * URL captured back then hits the first branch and never consults the alias
   * table at all. Nothing on disk had to be renamed for that to be true.
   *
   * `claimAlias` refuses a name that any doc already answers to, in either
   * space, so the two branches can never both match.
   */
  get(docId: string): DocRoom | undefined {
    const room = this.resolveRoom(docId);
    if (room) this.touchDoc(room.docId);
    return room;
  }

  /**
   * The room for a docId, LOADING IT FROM DISK if it is not in memory.
   *
   * This is the seam lazy hydration hangs on. Every method that is about to
   * read or write a document's CONTENT goes through here, so "not in memory"
   * and "does not exist" stop being the same answer — which they were when
   * every doc was loaded at boot, and which is why so much code could get
   * away with reaching straight into the room map.
   *
   * Deliberately does NOT touch: hydrating is not the same as somebody
   * reaching for a doc, and a sweep that pulled docs in would otherwise hold
   * every one of them for two days. `get` touches; this does not, so a doc
   * pulled in by machinery goes back out on the next sweep.
   *
   * The `.ydoc` must exist. Hydration LOADS what is on disk — it must never
   * mint an empty doc for an id nobody wrote, which is exactly what
   * `getOrCreate` would do for a stray index row with no file behind it.
   */
  private resolveRoom(docId: string): DocRoom | undefined {
    const resident = this.peek(docId);
    if (resident) return resident;
    const target = this.aliases.get(docId) ?? docId;
    if (!existsSync(this.pathFor(target))) return undefined;
    this.hydrateDoc(target);
    return this.rooms.get(target);
  }

  /**
   * The same lookup as `get`, WITHOUT counting as an access.
   *
   * A scan that merely enumerates docs is not somebody reaching for one, and
   * the difference is not cosmetic: `get` calls `touchDoc`, which puts a
   * bound doc in the file poll's fast lane for `FILE_POLL_ACTIVE_MS`. One
   * route that reads `meta.title` for every docId on a board therefore drags
   * the WHOLE corpus into the fast lane, and a client polling that route
   * keeps it there — measured on a copy of the production data directory,
   * where a single `GET /` moved `activeBindings` from 0 to 122 and
   * production reported all 2,549 bound docs active five minutes after boot
   * with nobody connected.
   *
   * Use `peek` for labels, existence checks and routing metadata. Use `get`
   * when the caller is about to read or write the doc's CONTENT — that is a
   * real access and the poll should speed up for it.
   */
  peek(docId: string): DocRoom | undefined {
    const direct = this.rooms.get(docId);
    if (direct) return direct;
    const aliased = this.aliases.get(docId);
    if (!aliased) return undefined;
    return this.rooms.get(aliased);
  }

  /**
   * A doc's metadata without needing the doc in memory.
   *
   * Almost every `peek` in the server wanted `?.meta` — a title for a link, a
   * `type` for a route, the review id a share scope is computed from. Under
   * lazy hydration `peek` answers undefined for anything not resident, and
   * those callers silently degraded: a share scope came out empty and refused
   * a document it covers, which is a 403 on your own link rather than an
   * error anybody would see in a log.
   *
   * The index row carries the whole `DocMeta`, so this answers for every doc
   * on disk at the cost of a map lookup. Resident first — a live room's meta
   * is newer than the last row written for it.
   */
  /**
   * The file a doc is bound to right now, if any — what the meeting record's
   * `meeting.json` names so a transcript folder can be traced to its doc
   * even after the doc moves or is committed.
   */
  boundPathOf(docId: string): string | undefined {
    const target = this.peek(docId)?.docId ?? this.aliases.get(docId) ?? docId;
    return this.fileBindings.get(target)?.path;
  }

  peekMeta(docId: string): DocMeta | undefined {
    const resident = this.peek(docId);
    if (resident) return resident.meta;
    const target = this.aliases.get(docId) ?? docId;
    return this.docIndex.get(target)?.meta;
  }

  /**
   * The id a name resolves to: an alias's target, or the name itself.
   *
   * The canonicalization half of `peek(x)?.docId ?? x`, which stopped working
   * for docs that are not in memory.
   */
  resolveDocId(docId: string): string {
    if (this.rooms.has(docId)) return docId;
    return this.aliases.get(docId) ?? docId;
  }

  /** Whether a doc exists at all — resident, indexed, or a file on disk. */
  docExists(docId: string): boolean {
    const target = this.resolveDocId(docId);
    return this.rooms.has(target) || this.docIndex.has(target) || existsSync(this.pathFor(target));
  }

  /**
   * A doc's body as markdown, WITHOUT making it resident — the read the ref
   * backfill sweeps every doc with. A resident room is serialized in place;
   * a non-resident one is hydrated, read, and evicted straight back out
   * (the `indexUnindexedDocs` idiom: reading a body is not somebody opening
   * the doc, and a sweep that left every doc resident would be a boot-cost
   * regression). Null for a doc that does not exist or cannot load.
   */
  readMarkdownBody(docId: string): string | null {
    const target = this.resolveDocId(docId);
    const serialize = (room: DocRoom): string =>
      contentKind(room.meta.type) === 'flat'
        ? room.ydoc.getText('content').toString()
        : prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
    const resident = this.rooms.get(target);
    if (resident) return serialize(resident);
    if (!this.docExists(target)) return null;
    try {
      this.hydrateDoc(target);
      const room = this.rooms.get(target);
      return room ? serialize(room) : null;
    } catch (err) {
      console.error(`[rooms] failed to read ${target} for a body sweep:`, err);
      return null;
    } finally {
      this.evictRoom(target);
    }
  }

  /**
   * The doc-creation verb for CALLERS: they name the doc, the server decides
   * its id.
   *
   * Splitting naming from identity is the whole change. A caller-chosen id
   * put the two in one field, so the only way to fix a name was to move the
   * address — and re-keying a doc orphans every thread anchored to it and
   * every link anyone saved. Here the name is an alias, the id is minted, and
   * a doc that wants a better name gets one without moving.
   *
   * Idempotent by resolution rather than by upsert: an already-resolving name
   * returns the doc it already names. That is what keeps `bind_mock(docId,
   * newPath)` repointing one doc instead of minting a second, and what makes
   * a re-run of `create_review_doc` a no-op.
   */
  createForCaller(
    requested: string,
    init?: Parameters<Rooms['getOrCreate']>[1],
  ): { ok: true; room: DocRoom; minted: boolean } | { ok: false; error: 'reserved-namespace' } {
    if (isReservedDocId(requested)) return { ok: false, error: 'reserved-namespace' };
    const existing = this.get(requested);
    if (existing) {
      // Re-tag / repoint the doc this name already resolves to, exactly as
      // before — but under its OWN id, never the name it was asked by.
      return { ok: true, room: this.getOrCreate(existing.docId, init), minted: false };
    }
    const docId = newDocId();
    const room = this.getOrCreate(docId, { ...init, alias: requested });
    return { ok: true, room, minted: true };
  }

  /**
   * Bind a readable name to a doc, ONCE.
   *
   * The refusal is the point. An alias that could be repointed would make
   * every captured review URL provisional: the link in yesterday's task
   * comment would still resolve, silently, to a document nobody meant to
   * send. So a name already held stays with its first doc, and the loser is
   * logged rather than swallowed — two docs claiming one name is a fact
   * somebody needs to see, not a race to win.
   *
   * There is no `repointAlias`, no `setAlias`, and no route that reaches
   * this. A doc that wants a different readable name gets an ADDITIONAL one;
   * the id it lives at does not move either way.
   */
  private claimAlias(alias: string, docId: string): void {
    const held = this.aliases.get(alias);
    if (held !== undefined && held !== docId) {
      console.error(
        `[rooms] alias "${alias}" already resolves to ${held}; leaving it there (${docId} keeps its own id)`,
      );
      return;
    }
    // A doc whose PRIMARY id is this string wins too — that is a
    // pre-migration doc, and its address is the one already written down in
    // links people saved.
    //
    // Belt, not braces: `get` tries the primary id first, so the primary
    // would win the lookup even with a stale entry in this map. Keeping the
    // map honest is still worth a line — a resolver whose table disagrees
    // with its own answers is how the next bug reads as impossible. Measured:
    // removing this line alone turns nothing red.
    if (this.rooms.has(alias) && alias !== docId) return;
    this.aliases.set(alias, docId);
  }

  /** Forget a doc's alias when its room goes away, so the name does not
   *  outlive the doc as a dangling resolution. */
  private releaseAliases(docId: string): void {
    for (const [alias, target] of this.aliases) {
      if (target === docId) this.aliases.delete(alias);
    }
  }

  /** Schedule a persistence pass for a doc whose in-memory meta changed with
   *  no accompanying CRDT update (the private sidecar keys). */
  persistMeta(docId: string): void {
    const room = this.resolveRoom(docId);
    if (room) this.saveToDisk(room);
  }

  // ── Comment threads ──────────────────────────────────────────────────────
  //
  // The verbs live in `doc-threads.ts`; what follows is the store's public
  // surface forwarding onto them, signatures unchanged.

  async postComment(
    docId: string,
    threadId: string | null,
    author: User,
    text: string,
    anchor?: Anchor,
    /**
     * May this write spend the summary API key? Routes pass `false` for share
     * visitors: a public tunnel URL must not be able to run up a bill, and a
     * summary is not worth granting an outsider an outbound call. Defaults to
     * true so local editors and agents keep working unchanged.
     */
    opts?: {
      generate?: boolean;
      /**
       * The Review Item this comment DECLARES, if it declares one.
       *
       * Rides on the ordinary comment path rather than a store of its own,
       * which is what makes every existing mechanism apply to it for free:
       * threads already sync, anchor, resolve, watch and emit the events
       * agents listen to, and a person's reply already ends the unanswered
       * run — which is exactly how a review item leaves the queue.
       *
       * `postComment` is the one choke point all three reply paths funnel
       * through (browser REST, MCP `post_reply`, widget), so this is the
       * layer where the payload has to be accepted, not the routes above it.
       */
      review?: ReviewPayload;
    },
  ): Promise<Thread | null> {
    return this.docThreads.postComment(docId, threadId, author, text, anchor, opts);
  }

  async answerReviewItem(
    docId: string,
    threadId: string,
    commentId: string,
    author: User,
    text: string,
    optionId?: string,
    opts?: { generate?: boolean; onlyIfUnanswered?: boolean },
  ): Promise<{ ok: true; thread: Thread } | { ok: false; error: string }> {
    return this.docThreads.answerReviewItem(
      docId,
      threadId,
      commentId,
      author,
      text,
      optionId,
      opts,
    );
  }

  reviseCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: { actor: User; revisedRange?: { start: number; end: number } },
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: string; message?: string } {
    return this.docThreads.reviseCommentReview(docId, threadId, commentId, patch, opts);
  }

  judgeCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    judgement: ReviewItemJudgement,
    opts: { forVersion?: number; forPendingAt?: number } = {},
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: 'no-doc' | 'not-a-review-item' | 'answered' | 'stale' } {
    return this.docThreads.judgeCommentReview(docId, threadId, commentId, judgement, opts);
  }

  withdrawCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    opts: { actor: User; reason?: string; undo?: boolean },
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: string; message?: string } {
    return this.docThreads.withdrawCommentReview(docId, threadId, commentId, opts);
  }

  undoReviewItemAnswer(
    docId: string,
    threadId: string,
    commentId: string,
    author: User,
    opts?: { generate?: boolean },
  ): { ok: true; thread: Thread } | { ok: false; error: string } {
    return this.docThreads.undoReviewItemAnswer(docId, threadId, commentId, author, opts);
  }

  async createThreadByFind(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
    },
    author: User,
    text: string,
    /**
     * Forwarded verbatim to both `postComment` calls below. Share visitors
     * can reach this route, and the text they post becomes the WHOLE prompt
     * — the worst of the gate's holes, because it needs no pre-existing
     * thread. Defaults to generating, like every other local caller.
     */
    writeOpts?: { generate?: boolean; review?: ReviewPayload },
  ): Promise<
    | { ok: true; thread: Thread }
    | {
        ok: false;
        error: 'no-match' | 'cross-node' | 'ambiguous' | 'no-doc';
        candidates?: Array<{ docOffset: number; preview: string }>;
      }
  > {
    return this.docThreads.createThreadByFind(docId, opts, author, text, writeOpts);
  }

  resolve(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    return this.docThreads.resolve(docId, threadId, author, opts);
  }

  reopen(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    return this.docThreads.reopen(docId, threadId, author, opts);
  }

  reanchor(docId: string, threadId: string, anchor: Anchor): Thread | null {
    return this.docThreads.reanchor(docId, threadId, anchor);
  }

  listThreads(docId: string, filter?: { status?: 'open' | 'resolved' }): Thread[] {
    return this.docThreads.listThreads(docId, filter);
  }

  getThread(docId: string, threadId: string): Thread | null {
    return this.docThreads.getThread(docId, threadId);
  }

  /**
   * Return the current doc as a flat plain-text string plus a thread
   * summary. Used by the MCP `get_doc` tool. The plain text is what
   * `find_and_replace` matches against — markdown structure lives in
   * the Y.XmlFragment tree and is visible via block hints but isn't
   * the editable surface.
   */
  getDoc(docId: string): {
    plainText: string;
    blocks: Array<{
      type: string | null;
      headingLevel?: number;
      text: string;
      startOffset: number;
      endOffset: number;
    }>;
    threads: Thread[];
    syncError?: { message: string; at: number };
  } | null {
    const room = this.resolveRoom(docId);
    if (!room) return null;
    // Code and diff docs are flat read-only text in the `content` Y.Text,
    // not a prose fragment — surface the whole source as one block. (For a
    // diff doc that text is the file at the target commit.)
    if (contentKind(room.meta.type) === 'flat') {
      const text = room.ydoc.getText('content').toString();
      const syncError = this.fileBindings.get(room.docId)?.lastSyncError;
      return {
        plainText: text,
        blocks: [{ type: 'code', text, startOffset: 0, endOffset: text.length }],
        threads: listThreads(room.ydoc),
        ...(syncError ? { syncError } : {}),
      };
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const walk = prose.walkProse(fragment);

    // Group segments by their TOP-LEVEL block — so a table's many cells
    // surface as one `type: "table"` block, not N `type: "paragraph"`
    // cells. Same applies to lists (`bulletList` / `orderedList`) — the
    // agent sees the list as one block.
    const grouped: Array<{
      top: Y.XmlElement | null;
      type: string | null;
      text: string;
      startOffset: number;
      endOffset: number;
      headingLevel?: number;
    }> = [];
    const rawText = (node: Y.XmlText): string => {
      let out = '';
      for (const op of node.toDelta() as Array<{ insert?: string }>) {
        if (typeof op.insert === 'string') out += op.insert;
      }
      return out;
    };
    for (const s of walk.segments) {
      const last = grouped[grouped.length - 1];
      if (last && last.top === s.topBlock && s.topBlock != null) {
        last.text += rawText(s.node);
        last.endOffset = s.docOffset + s.length;
      } else {
        grouped.push({
          top: s.topBlock,
          type: s.topBlockType,
          text: rawText(s.node),
          startOffset: s.docOffset,
          endOffset: s.docOffset + s.length,
          ...(s.headingLevel != null ? { headingLevel: s.headingLevel } : {}),
        });
      }
    }
    // Second pass: re-render every block from its Y.XmlElement so
    // block.text is proper markdown — preserving heading levels,
    // code-block fences with language, list bullets/numbering, table
    // pipes, AND inline marks (**bold**, *italic*, `code`, links).
    // Without this, agents reading get_doc lose all formatting cues
    // because the raw-toDelta concat we use for offset-aligned
    // plainText strips marks deliberately.
    for (const g of grouped) {
      if (g.top) {
        const md = prose.serializeBlockToMarkdown(g.top);
        if (md) g.text = md;
      }
    }
    const blocks = grouped.map(({ top, ...rest }) => {
      void top;
      return rest;
    });

    const syncError = this.fileBindings.get(docId)?.lastSyncError;
    return {
      plainText: walk.plainText,
      blocks,
      threads: listThreads(room.ydoc),
      ...(syncError ? { syncError } : {}),
    };
  }

  /**
   * Cheap doc health check — everything an agent needs to answer "is this
   * doc bound, is it wedged, how big is it, is anything pending" WITHOUT
   * the body. `getDoc` re-renders every block to markdown and has returned
   * 320KB for one doc, which overflows tool-result caps; this returns the
   * metadata the room and binding already hold, plus counts. Deliberately
   * no plainText, no blocks, no thread bodies.
   */
  getDocStatus(docId: string): {
    docId: string;
    type: DocType;
    title?: string;
    /** True when the doc is file-backed (a binding exists). */
    bound: boolean;
    /** Absolute path of the bound file. Route-level: omitted for share
     *  visitors, same rule as `sourceUrl` in PRIVATE_META_KEYS. */
    path?: string;
    syncError?: { message: string; at: number };
    lastActivityAt?: number;
    textLength: number;
    blockCount: number;
    threads: { open: number; resolved: number };
    pendingSuggestions: number;
  } | null {
    const room = this.resolveRoom(docId);
    if (!room) return null;
    const binding = this.fileBindings.get(room.docId);
    const meta = this.withActivity(room.meta);

    let textLength: number;
    let blockCount: number;
    let pendingSuggestions = 0;
    if (contentKind(room.meta.type) === 'flat') {
      textLength = room.ydoc.getText('content').length;
      blockCount = 1;
    } else {
      const fragment = prose.getProseFragment(room.ydoc);
      textLength = prose.walkProse(fragment).plainText.length;
      blockCount = fragment.length;
      pendingSuggestions = suggestOps.listSuggestions(room.ydoc).length;
    }

    let open = 0;
    let resolved = 0;
    for (const t of listThreads(room.ydoc)) {
      if (t.status === 'resolved') resolved += 1;
      else open += 1;
    }

    return {
      docId,
      type: room.meta.type,
      ...(room.meta.title ? { title: room.meta.title } : {}),
      bound: Boolean(binding),
      ...(binding ? { path: binding.path } : {}),
      ...(binding?.lastSyncError ? { syncError: binding.lastSyncError } : {}),
      ...(meta.lastActivityAt !== undefined ? { lastActivityAt: meta.lastActivityAt } : {}),
      textLength,
      blockCount,
      threads: { open, resolved },
      pendingSuggestions,
    };
  }

  listWorkspaceThreads(
    setId: string,
    opts?: { status?: 'open' | 'resolved' },
  ): Array<Thread & { docId: string; relPath?: string }> {
    return this.workspaces.listWorkspaceThreads(setId, opts);
  }

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
    return this.workspaces.listGroupedDiff(setId);
  }

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
    return this.workspaces.listRepoFiles(setId);
  }

  openContextFile(
    setId: string,
    relPath: string,
  ):
    | { ok: true; docId: string; meta: DocMeta }
    | { ok: false; error: 'not-found' | 'bad-path' | 'not-listed' | 'attach-failed' } {
    return this.workspaces.openContextFile(setId, relPath);
  }

  openEditableFile(
    setId: string,
    relPath: string,
  ):
    | { ok: true; docId: string; meta: DocMeta }
    | {
        ok: false;
        error:
          | 'not-found'
          | 'bad-path'
          | 'not-listed'
          | 'pinned'
          | 'not-markdown'
          | 'attach-failed';
      } {
    return this.workspaces.openEditableFile(setId, relPath);
  }

  companionOf(docId: string): string | undefined {
    return this.workspaces.companionOf(docId);
  }

  memberOfCompanion(docId: string): string | undefined {
    return this.workspaces.memberOfCompanion(docId);
  }

  buildWorkspaceTree(setId: string): WorkspaceTree {
    return this.workspaces.buildWorkspaceTree(setId);
  }

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
    return this.workspaces.listWorkspaces(now);
  }

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
    return this.workspaces.deleteWorkspace(setId, opts);
  }

  archiveReview(
    setId: string,
    opts: { archivedBy: string; reason?: string; linkedWorkspaces?: string[] },
  ):
    | { ok: true; archived: number; docIds: string[]; manifest: ArchivedReview }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'archive-collision' | 'move-failed'; docIds: string[] } {
    return this.workspaces.archiveReview(setId, opts);
  }

  unarchiveReview(
    setId: string,
    opts: { archivedBy: string },
  ):
    | { ok: true; restored: number; docIds: string[]; manifest: ArchivedReview }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'restore-collision' | 'move-failed'; docIds: string[] } {
    return this.workspaces.unarchiveReview(setId, opts);
  }

  archiveDoc(
    docId: string,
    opts: { archivedBy: string; reason?: string; linkedWorkspaces?: string[] },
  ):
    | { ok: true; docId: string; manifest: ArchivedDoc }
    | { ok: false; error: 'not-found' | 'hub-owned' | 'archive-collision' | 'move-failed' }
    | { ok: false; error: 'review-member'; setId: string } {
    return this.workspaces.archiveDoc(docId, opts);
  }

  unarchiveDoc(
    docId: string,
    opts: { archivedBy: string },
  ):
    | { ok: true; docId: string; manifest: ArchivedDoc }
    | { ok: false; error: 'not-found' | 'restore-collision' | 'move-failed' } {
    return this.workspaces.unarchiveDoc(docId, opts);
  }

  /**
   * Bind a whole folder/worktree for review. Scans the folder for
   * supported files, creates one review doc per file grouped under a
   * single review id, and returns the resulting file list plus a
   * record of anything skipped.
   *
   * Scan strategy: prefer `git ls-files` (respects .gitignore for free —
   * skips node_modules/dist/etc); fall back to a recursive readdir with a
   * hardcoded skip set when the folder isn't a git repo.
   *
   * Allowlist by extension: .md → markdown (WYSIWYG, editable, write-back);
   * code extensions → read-only syntax-highlighted source. Files that are
   * too big (>512 KB) or look binary (NUL byte in the first 8 KB) are
   * recorded in `skipped[]` and never bound.
   *
   * Guardrail: if the surviving file count exceeds `maxFiles` (default
   * 300), nothing is created — returns `{ ok:false, error:'too-many-files',
   * fileCount }` so a stray bind on a giant tree can't melt the server with
   * thousands of mtime polls.
   *
   * Deterministic docIds (`${setId}:${relPath}`) make re-binding
   * idempotent: the same file maps to the same docId, so threads survive.
   */
  /** Bind a whole folder/worktree for review — see binds.ts. */
  bindFolder(opts: BindFolderOpts): BindFolderResult {
    return bindFolderImpl(this, opts);
  }

  /** Bind a git diff (working-tree or pinned) for review — see binds.ts. */
  bindDiff(opts: BindDiffOpts): BindDiffResult {
    return bindDiffImpl(this, opts);
  }

  /**
   * Close every websocket a given share opened. Revocation and expiry are
   * enforced per HTTP request, but a websocket is authorized ONCE at its
   * upgrade — so an already-connected visitor kept reading and writing the
   * doc after the share was revoked. Verified: the socket stayed open and
   * writable while HTTP returned 401.
   *
   * 1008 is the "policy violation" close code, which is what this is.
   */
  closeSocketsForShare(shareId: string): number {
    let closed = 0;
    // Straight over the room map. `list()` + `get()` walked the same rooms
    // but built a fresh DocMeta for every one of them and then looked each
    // back up by id — and `get` marks a doc ACCESSED, which is what put the
    // whole corpus in the file poll's fast lane. See `closeSocketsForDeadShares`.
    for (const room of this.rooms.values()) {
      for (const ws of room.conns) {
        if (ws.data?.shareId !== shareId) continue;
        try {
          ws.close(1008, 'share revoked');
        } catch {
          // Already gone — the close handler does the bookkeeping.
        }
        closed += 1;
      }
    }
    return closed;
  }

  /** Close sockets whose authorizing share is no longer live (revoked or
   *  expired). Returns the shareIds that were swept. */
  closeSocketsForDeadShares(isLive: (shareId: string) => boolean): string[] {
    const dead = new Set<string>();
    // This runs every 60s for the life of the server, over every room, and it
    // only ever reads `conns`. Two things were wrong with reaching them via
    // `list()` + `get()`:
    //
    //  - `get` counts as an ACCESS. On a 5,624-room server the sweep marked
    //    every bound doc accessed once a minute, and the file poll's active
    //    window is also 60s — so from the first sweep onward the fast lane
    //    never emptied and every bound file was stat'd every 500ms. Measured
    //    on a copy of the production data directory: one sweep took
    //    activeBindings from 0 to 4,196, and production sat pinned at 2,549
    //    from ~90s of uptime onward.
    //  - `list()` allocates a spread DocMeta per room, so the sweep also
    //    produced several MB of garbage a minute for a pass that reads one
    //    field of one Set.
    //
    // The room map is the same set `list()` maps over, so coverage is
    // unchanged.
    for (const room of this.rooms.values()) {
      for (const ws of room.conns) {
        const id = ws.data?.shareId;
        if (!id || isLive(id)) continue;
        dead.add(id);
      }
    }
    for (const id of dead) this.closeSocketsForShare(id);
    return Array.from(dead);
  }

  /** Re-reconcile a workspace against disk, keeping docIds (and therefore
   *  threads) stable — see binds.ts. */
  refreshWorkspace(setId: string): RefreshWorkspaceResult {
    return refreshWorkspaceImpl(this, setId);
  }

  /** Re-group a diff review's sidebar in place — see binds.ts. */
  setWorkspaceGroups(
    setId: string,
    groups: Array<{ title: string; paths: string[]; details?: string }>,
  ): SetWorkspaceGroupsResult {
    return setWorkspaceGroupsImpl(this, setId, groups);
  }

  /**
   * Bind a doc to a file path on disk. After attach:
   *   - if the doc's prose fragment is empty AND the file exists with
   *     content, the file is parsed and seeded into the fragment
   *   - every subsequent prose change debounces a write of the
   *     serialized markdown back to the file (default 800ms)
   *
   * File path is resolved relative to the server's process cwd if
   * relative. An absolute path is strongly recommended.
   *
   * Bidirectional sync:
   *   doc → disk — every prose change debounces an 800ms serialize+write
   *   disk → doc — fs.watch fires on external edits, debounced 300ms,
   *     reads the file, diffs against current serialized output, and if
   *     different applies the new markdown in one 'file-watch' transact.
   *   Echo loop is broken by `binding.lastWritten` on both sides — a
   *   write we initiated won't be re-applied, and a read that matches
   *   our cached content is silently ignored.
   */
  attachFile(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): {
    ok: boolean;
    error?: 'not-found' | 'path-empty' | 'read-failed';
    seeded?: boolean;
    resolvedPath?: string;
  } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const fragment = prose.getProseFragment(room.ydoc);
    let seeded = false;
    if (fragment.length === 0 && existsSync(abs)) {
      try {
        const md = readFileSync(abs, 'utf8');
        const blocks = prose.parseMarkdownBlocks(md);
        if (blocks.length > 0) {
          room.ydoc.transact(() => fragment.push(blocks), 'file-seed');
          seeded = true;
        }
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    const existing = this.fileBindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    // A re-attach must replace the write-back observer, not stack another —
    // each leaked observer is a duplicate scheduler holding a stale binding.
    if (existing?.observer) fragment.unobserveDeep(existing.observer);
    const binding: FileBinding = { path: abs, lastMtimeMs: existing?.lastMtimeMs };
    this.fileBindings.set(docId, binding);
    // sourceUrl records the bound path. It stays OUT of the CRDT (an absolute
    // host path is exactly what a share visitor must not sync) — the sidecar
    // is its home, and saveToDisk is what persists it.
    if (!room.meta.sourceUrl) {
      room.meta.sourceUrl = abs;
      this.saveToDisk(room);
    }

    // Attaching a NON-empty fragment (hydrate after a restart, or a re-run
    // create_review_doc): honor the sync contract's "the file is the source
    // of truth at rest". Without this, an edit made while the server was down
    // was never picked up — and the next flush overwrote it on disk.
    if (!seeded && existsSync(abs)) {
      try {
        const md = readFileSync(abs, 'utf8');
        const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
        const prior = existing?.lastWritten;
        if (md !== currentSerialized) {
          // NB: this byte-equality guard rarely spares the parse below —
          // most real files differ from the serializer's normal form, so
          // hydrate pays one parse+serialize per bound doc (~1ms for a
          // typical doc). Accepted: the alternative was rewriting ~every
          // never-edited bound file on each restart.
          const diskNormalized = prose.normalizeMarkdown(md);
          if (diskNormalized === currentSerialized) {
            // Pure normalization drift: disk parses to exactly the live
            // doc's content, the bytes just differ in formatting the
            // round-trip doesn't preserve. This is the steady state for
            // every bound-but-never-edited doc (binding stamps the .ydoc
            // after the .md, so mtime arbitration below would call the
            // live side newer and rewrite the file). Semantically equal
            // means in-sync — leave the file untouched.
            binding.lastWritten = currentSerialized;
          } else if (prior !== undefined && currentSerialized !== prior) {
            // The live doc has un-flushed edits relative to our last write —
            // we are NOT at rest, so don't pick a winner here. Keep the old
            // bookkeeping; if disk also moved, the poll's reconcile will
            // treat it as a conflict (backup + reassert). If disk did not
            // move, re-arm the flush this re-attach just cancelled. (The
            // conflict case reconciles NOW — armFileWatcher re-baselines the
            // mtime below, so the poll would never see the change.)
            binding.lastWritten = prior;
            // A disk that IS (or normalizes to) our last write hasn't
            // really changed — re-arm the flush this re-attach cancelled.
            // Without the normalized check, a doc whose drift was
            // suppressed at hydrate hit reconcile here and reported a
            // false conflict (backup + syncError) though disk never moved.
            if (md === prior || diskNormalized === prior) this.scheduleFileWrite(room, binding);
            else this.reconcileFromDisk(room, binding);
          } else if (
            prior === undefined &&
            (opts.liveWins || !this.diskNewerThanState(docId, abs))
          ) {
            // Fresh attach with NO bookkeeping (post-restart hydrate) and the
            // .md is OLDER than the persisted .ydoc: the crash happened inside
            // the 800ms write-back window, so the hydrated doc is the newer
            // side. Applying disk here would revert the just-made edit on
            // startup (codex P1). Reassert the live doc to disk instead —
            // snapshotting the disk version first, symmetric with the apply
            // branch below (this is the one writer that replaces content the
            // server never wrote). `liveWins` reaches the same branch on the
            // caller's knowledge instead of the clock — see `AttachOpts`.
            this.backupExternalVersion(docId, md);
            binding.lastWritten = md;
            this.scheduleFileWrite(room, binding);
          } else if (prose.parseMarkdownBlocks(md).length > 0) {
            // At rest: pull disk in as a block diff so anchors on untouched
            // blocks keep resolving. On the no-bookkeeping path we can't
            // PROVE the fragment's extra state was ever flushed, so snapshot
            // it first — restarts are rare enough that a stray backup beats
            // an unrecoverable revert.
            if (prior === undefined) {
              this.backupExternalVersion(docId, currentSerialized, 'live');
            }
            room.ydoc.transact(() => {
              prose.applyMarkdownToFragment(fragment, md);
            }, 'file-watch');
            prose.normalizeHeadingLevels(room.ydoc);
          }
        }
      } catch (err) {
        console.error(`[rooms] attach-time reconcile failed for ${abs}:`, err);
      }
    }

    // doc → disk: every change schedules a debounced write.
    const observer: Parameters<Y.XmlFragment['observeDeep']>[0] = (_events, tr) => {
      // Don't echo our own seed-from-disk or file-watch apply back to disk.
      if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
      this.scheduleFileWrite(room, binding);
    };
    binding.observer = observer;
    fragment.observeDeep(observer);
    // Bookkeeping lives in serializer-space: comparing raw disk bytes against
    // normalized serializer output made every applied external edit look like
    // permanent divergence, so the NEXT external edit was misjudged a
    // conflict and clobbered (2026-08-03 incident, RC1).
    if (binding.lastWritten === undefined) {
      binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    }

    // disk → doc: poll for external edits (see armFileWatcher).
    this.armFileWatcher(room, binding);

    return { ok: true, seeded, resolvedPath: abs };
  }

  /**
   * Bind a READ-ONLY source file (type='code') for review. The file's raw
   * text is seeded into the flat `content` Y.Text (no markdown parse), the
   * mtime poll is armed for disk→doc refresh, and — crucially — there is NO
   * doc→disk write-back: the browser never edits a code file (it only
   * comments), so the file is never rewritten by claude-workspaces. The agent
   * edits the source via its normal tools; the poll re-renders the view.
   */
  attachReadonlyFile(
    docId: string,
    filePath: string,
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    return this.attachFlatFile(docId, filePath);
  }

  /**
   * Bind a flat (code / working-tree diff) doc to a file. Disk→doc always
   * flows via the mtime poll; pass `writeBack: true` to also flow doc→disk
   * through the same debounced atomic writer prose docs use — that is what
   * makes the File view a live editor. Pinned diff docs must never pass
   * writeBack (their content is a commit, not a file).
   */
  attachFlatFile(
    docId: string,
    filePath: string,
    opts: AttachOpts & { writeBack?: boolean } = {},
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const content = room.ydoc.getText('content');
    let text = '';
    if (existsSync(abs)) {
      try {
        text = readFileSync(abs, 'utf8');
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    // Sync content to the file's CURRENT bytes when disk is the newer side.
    // For read-only docs disk is always authoritative (the live doc never
    // holds browser edits). For write-back docs the two can genuinely
    // diverge across a restart, in BOTH directions: a File-view edit whose
    // ~800ms flush the crash beat (doc newer — blindly seeding here silently
    // destroyed it), or an agent editing the working tree while the server
    // was down (disk newer — "doc always wins" would reassert pre-deploy
    // bytes over their work). Arbitrate by mtime via diskNewerThanState;
    // when the doc wins, back up the losing disk version and reassert below.
    // The 'file-watch' origin routes a disk apply through the same reanchor
    // sweep as a live edit.
    let reassertDoc = false;
    if (existsSync(abs) && text !== content.toString()) {
      if (
        opts.writeBack &&
        content.length > 0 &&
        (opts.liveWins || !this.diskNewerThanState(docId, abs))
      ) {
        this.backupExternalVersion(docId, text);
        reassertDoc = true;
      } else {
        const origin = content.length === 0 ? 'file-seed' : 'file-watch';
        room.ydoc.transact(() => {
          if (content.length > 0) content.delete(0, content.length);
          if (text.length > 0) content.insert(0, text);
        }, origin);
      }
    }
    const existing = this.fileBindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    if (existing?.contentObserver) content.unobserve(existing.contentObserver);
    // lastWritten is "what the FILE holds" — when the doc won the arbitration
    // the file still holds the stale disk text, and recording the doc text
    // instead would make the writer's no-op check skip the reassert.
    const binding: FileBinding = {
      path: abs,
      lastWritten: reassertDoc ? text : content.toString(),
    };
    this.fileBindings.set(docId, binding);
    if (!room.meta.sourceUrl) {
      // Sidecar, not CRDT — see attachFile above.
      room.meta.sourceUrl = abs;
      this.saveToDisk(room);
    }
    if (opts.writeBack) {
      // doc → disk: same origin-guarded debounced writer as prose docs —
      // our own seed/poll applies must not echo back out to the file.
      binding.writeBack = true;
      const observer = (_event: Y.YTextEvent, tr: Y.Transaction) => {
        if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
        this.scheduleFileWrite(room, binding);
      };
      binding.contentObserver = observer;
      content.observe(observer);
    }
    this.armFileWatcher(room, binding);
    // Doc won the attach-time arbitration above: push its state back out
    // through the normal debounced writer (which also stamps the poll
    // baseline so the reassert isn't misread as an external edit).
    if (reassertDoc) this.scheduleFileWrite(room, binding);
    return { ok: true, resolvedPath: abs };
  }

  /**
   * Pin a doc to its repo home: repo + branch + relPath (see `DocHome` in
   * core). From here on, the file the doc syncs with is "the declared
   * relPath in whichever worktree has the declared branch checked out" —
   * resolved at pin, at hydrate, and re-verified by `homeGuard` before every
   * flush and every disk→doc apply. A checkout that switches branches under
   * the binding is never written again; the binding follows the branch or
   * parks.
   *
   * Prose docs only: a home is for durable planning/discussion notes. Diff,
   * code and mockup docs follow their surface (the diff's repo, the running
   * server) and pinning them would fight those flows.
   */
  setDocHome(
    docId: string,
    input: unknown,
  ):
    | {
        ok: true;
        home: DocHome;
        placement: { placed: true; path: string } | { placed: false; reason: string };
      }
    | { ok: false; error: 'not-found' | 'invalid-home' | 'not-markdown'; detail?: string } {
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'not-found' };
    if (isHubOwnedRoom(room.docId) || contentKind(room.meta.type) !== 'prose') {
      return {
        ok: false,
        error: 'not-markdown',
        detail: 'a repo home is for markdown docs; code/diff/mockup docs follow their surface',
      };
    }
    const norm = normalizeDocHome(input);
    if (!norm.ok) return { ok: false, error: 'invalid-home', detail: norm.error };
    // The repo must at least exist as a repo — a typo'd repoRoot pinned
    // as-is would park the doc forever with a message blaming the branch.
    // Store the MAIN checkout's root, not the caller's spelling: a home
    // declared from a linked worktree must survive that worktree's removal.
    const canonRoot = canonicalRepoRoot(norm.home.repoRoot);
    if (canonRoot === null) {
      return {
        ok: false,
        error: 'invalid-home',
        detail: `${norm.home.repoRoot} is not a git checkout`,
      };
    }
    const home: DocHome = { ...norm.home, repoRoot: canonRoot };
    room.meta.docHome = home;
    const placement = resolveHomeCheckout(home);
    if (placement.placed) {
      const binding = this.fileBindings.get(room.docId);
      // Already bound to an EXISTING copy of the home: nothing to move. A
      // missing file still retargets — the retarget is what exports it.
      if (binding?.path === placement.absPath && existsSync(placement.absPath)) {
        this.saveToDisk(room);
      } else {
        this.retargetHomeBinding(room, placement.absPath);
      }
      return { ok: true, home, placement: { placed: true, path: placement.absPath } };
    }
    // Unplaced is a legal pin: the doc stays durable in the .ydoc and the
    // guard parks every write until a checkout on the branch appears. An
    // existing binding to some other path is deliberately left in the map —
    // homeGuard is what stops it writing, and keeping it is what lets the
    // next flush attempt re-resolve and recover.
    this.saveToDisk(room);
    return { ok: true, home, placement: { placed: false, reason: placement.reason } };
  }

  /** Unpin: the doc keeps whatever binding it has and goes back to being an
   *  ordinary explicit-path doc. */
  clearDocHome(docId: string): { ok: boolean } {
    const room = this.resolveRoom(docId);
    if (!room || !room.meta.docHome) return { ok: false };
    room.meta.docHome = undefined;
    this.saveToDisk(room);
    return { ok: true };
  }

  /** The pin plus where it resolves RIGHT NOW — for doc status surfaces. */
  docHomeStatus(docId: string):
    | {
        home: DocHome;
        placement: { placed: true; path: string } | { placed: false; reason: string };
        boundPath?: string;
      }
    | undefined {
    const room = this.resolveRoom(docId);
    const home = room?.meta.docHome;
    if (!room || !home) return undefined;
    const placement = resolveHomeCheckout(home);
    const boundPath = this.fileBindings.get(room.docId)?.path;
    return {
      home,
      placement: placement.placed
        ? { placed: true, path: placement.absPath }
        : { placed: false, reason: placement.reason },
      ...(boundPath ? { boundPath } : {}),
    };
  }

  /**
   * Point a home-pinned doc's binding at `absPath` (the freshly-resolved
   * home) with a CLEAN attach. The old binding's bookkeeping is about the
   * old file — letting `attachFile` read its `lastWritten` as `prior` would
   * arbitrate the new checkout's file against another file's history — so it
   * is dropped whole and the attach runs the same mtime arbitration a
   * restart does (losing side backed up, never silently discarded).
   */
  private retargetHomeBinding(room: DocRoom, absPath: string, opts: AttachOpts = {}): void {
    const docId = room.docId;
    const old = this.fileBindings.get(docId);
    if (old) {
      if (old.writeTimer) clearTimeout(old.writeTimer);
      if (old.readTimer) clearTimeout(old.readTimer);
      old.pollArmed = false;
      if (old.observer) prose.getProseFragment(room.ydoc).unobserveDeep(old.observer);
      this.fileBindings.delete(docId);
    }
    // A branch whose checkout holds no copy yet: the pin (or retarget) IS
    // the export. Write the doc's content first, atomically, so the attach
    // below finds an in-sync file instead of never creating one (attachFile
    // arms nothing for a missing path). A copy the checkout DOES hold is
    // arbitrated by the attach — by the caller's knowledge when it has any
    // (`opts.liveWins`), by mtime otherwise.
    if (!existsSync(absPath)) {
      const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        const tmp = `${absPath}.lf-write~`;
        writeFileSync(tmp, md);
        renameSync(tmp, absPath);
      } catch (err) {
        console.error(`[rooms] ${docId}: could not export doc to its home ${absPath}:`, err);
      }
    }
    // attachFile only records sourceUrl when absent; a retarget must repoint.
    room.meta.sourceUrl = absPath;
    this.attachFile(docId, absPath, opts);
    this.saveToDisk(room);
    console.log(`[rooms] ${docId}: home binding now at ${absPath}`);
  }

  /**
   * A home-pinned doc with NO binding tries to re-place its home. The state
   * exists when hydration found no checkout on the home branch: parking
   * there leaves nothing in `fileBindings`, and every recovery path below
   * this one — homeGuard, the poll sweep — hangs off a binding. Without this
   * hook the park message's promise ("check the branch out and the next
   * edit or reparse resumes syncing") held only for docs parked while LIVE;
   * a doc parked at hydrate stayed parked until a re-pin or restart. Called
   * from the room's update hook (throttled) and from reparseFromDisk
   * (forced). Bound docs return immediately — homeGuard owns them.
   */
  private maybeRebindHome(room: DocRoom, opts?: { force?: boolean }): void {
    const home = room.meta.docHome;
    if (!home || this.fileBindings.has(room.docId)) return;
    if (isHubOwnedRoom(room.docId) || contentKind(room.meta.type) !== 'prose') return;
    const now = Date.now();
    if (!opts?.force && now - (this.homeRebindAttemptAt.get(room.docId) ?? 0) < 1000) return;
    this.homeRebindAttemptAt.set(room.docId, now);
    const placement = resolveHomeCheckout(home);
    if (!placement.placed) return;
    // Persist BEFORE attaching so the .ydoc the attach's at-rest arbitration
    // reads (diskNewerThanState) holds the current state, not the pre-edit
    // one. When the trigger is the edit itself that arbitration is not
    // trusted at all: the live doc is the newer side by construction, and
    // `liveWins` says so instead of letting a clock tie decide (see
    // `AttachOpts`). A forced rebind (reparse) is the caller declaring disk
    // the winner, and the reparse that follows reads disk in regardless.
    this.persistRoomNow(room);
    this.retargetHomeBinding(room, placement.absPath, { liveWins: !opts?.force });
  }

  /**
   * The per-sync-direction gate for home-pinned docs, run before a flush
   * writes AND before a disk change is applied. Cheap (a handful of stat +
   * plumbing-file reads, no subprocess), because it has to run every time:
   * verifying only occasionally is how a triage doc once landed on another
   * session's feature branch — the checkout under the path had switched and
   * both directions kept treating its file as the doc's.
   *
   * 'ok'         the bound path is still the home; proceed.
   * 'retargeted' the home resolves elsewhere now; the binding was moved
   *              there (exporting the file if the new checkout has none)
   *              and a flush was re-armed. The caller must NOT touch the
   *              old binding it was handed.
   * 'parked'     the home resolves nowhere; nothing was read or written,
   *              and a syncError names why and how to resume.
   */
  private homeGuard(room: DocRoom, binding: FileBinding): 'ok' | 'retargeted' | 'parked' {
    const home = room.meta.docHome;
    if (!home) return 'ok';
    if (verifyPathInHome(binding.path, home) === 'ok') return 'ok';
    const placement = resolveHomeCheckout(home);
    if (placement.placed) {
      // Resolution landing on the very path the verify refused (a nested
      // repo under relPath can split the two): writing there is what the
      // home declares, so treat it as placed rather than retarget-looping.
      if (placement.absPath === binding.path) return 'ok';
      this.retargetHomeBinding(room, placement.absPath);
      const next = this.fileBindings.get(room.docId);
      // Re-arm a flush on the NEW binding: its no-op pass is what clears the
      // pending-write bookkeeping the flush this guard interrupted was
      // carrying.
      if (next) this.scheduleFileWrite(room, next);
      return 'retargeted';
    }
    const message =
      placement.reason === 'repo-missing'
        ? `doc home is unreachable: ${home.repoRoot} is not (or no longer) a git checkout. ` +
          'Writes are parked; the live doc stays the source of truth and its content is durable ' +
          'in the workspace. Re-pin the home at a valid checkout to resume.'
        : placement.reason === 'path-escapes-checkout'
          ? `doc home is unsafe: ${home.relPath} passes through a symlink that leaves the ` +
            'checkout, so writing it would land outside the repo. Writes are parked; the live ' +
            'doc stays the source of truth. Re-pin the home at a path contained in the checkout.'
          : `doc home is unplaced: no checkout of the repo has branch "${home.branch}" checked out. ` +
            'Writes are parked; the live doc stays the source of truth and its content is durable ' +
            'in the workspace. Check the branch out in some worktree (git worktree add <path> ' +
            `"${home.branch}") and the next edit or reparse resumes syncing there.`;
    if (binding.lastSyncError?.message !== message) {
      this.recordSyncError(room, binding, message);
    }
    return 'parked';
  }

  /**
   * Watch the bound file for external edits via an mtime poll.
   *
   * We deliberately do NOT use fs.watch. A file-level fs.watch is bound to
   * the inode present at watch-creation time (kqueue on macOS, inotify on
   * Linux). Editors — and Claude Code's own Edit tool — save via
   * write-temp-then-rename, which atomically replaces the file's inode, so
   * the watch goes stale and only the FIRST external edit ever reaches the
   * live doc (deterministic repro on Bun + Node). Watching the parent
   * directory dodges the inode problem on macOS but proved unreliable under
   * Bun-on-Linux. A stat-mtime poll is immune to all of it — inode
   * replacement, platform, and runtime — and ~1s latency matches the doc's
   * existing sync contract.
   *
   * What changed on 2026-08-29: the poll is no longer an interval PER
   * binding. Arming enrols the binding in one shared sweep (`sweepFilePolls`)
   * which visits active docs every tick and idle docs on a budget. Same
   * mechanism, same immunity, a constant number of timers.
   */
  private armFileWatcher(_room: DocRoom, binding: FileBinding): void {
    binding.pollArmed = false;
    if (!existsSync(binding.path)) return;
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    binding.pollArmed = true;
    // Armed, but deliberately not marked as ACCESSED. Hydration re-binds
    // every bound doc at boot; if arming warmed them, the first minute of
    // every restart would put the whole corpus in the fast lane — the storm
    // this change exists to remove. It joins the idle rotation instead, and
    // the first real `get` / `getOrCreate` promotes it.
    this.ensureFilePollTicker();
  }

  /**
   * Is somebody looking at this doc — i.e. does it belong in the fast lane,
   * stat'd on every 500ms tick rather than on the idle rotation?
   *
   * "Looking at" is one of three things, all of them pushed to us rather
   * than polled for:
   *   - a live websocket on the room (someone has the editor open),
   *   - a write-back or reconcile still inside its debounce window, or
   *   - an access within the last `FILE_POLL_ACTIVE_MS` — any `get` /
   *     `getOrCreate`, which is every REST read, every MCP edit tool, and the
   *     websocket upgrade itself.
   *
   * An IDLE binding is not unwatched — it is watched more slowly, on the
   * round-robin budget (see `IDLE_SWEEP_BUDGET`), and re-stat'd immediately
   * by `touchDoc` the moment anyone reaches for the doc. That matters
   * because a git checkout / stash / pull against a bound file nobody has
   * open must still reach the live doc: it is the documented behaviour and
   * `git-ops-vs-bound.test.ts` pins it. `reparseFromDisk` remains the
   * explicit force-pull.
   */
  private bindingIsActive(docId: string, binding: FileBinding, now: number): boolean {
    if (!binding.pollArmed) return false;
    if (binding.writeTimer || binding.readTimer) return true;
    const room = this.rooms.get(docId);
    if (room && room.conns.size > 0) return true;
    const touched = this.lastTouchedAt.get(docId);
    return touched !== undefined && now - touched < FILE_POLL_ACTIVE_MS;
  }

  /**
   * One stat of one bound file, and the reconcile it may schedule. Extracted
   * from the old per-binding interval body so the shared sweep and the
   * on-access edge check run byte-identical logic.
   */
  private pollBinding(docId: string, binding: FileBinding): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    let mtimeMs: number;
    try {
      // One syscall, not `existsSync` + `statSync`: the sweep runs this for
      // every bound file, so the second stat was half the cost of the poll.
      // A file that has gone is the ordinary case (a deleted worktree), and
      // it is silent — only a real error is worth a line.
      mtimeMs = statSync(binding.path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`[rooms] stat failed for ${binding.path}:`, err);
      }
      return;
    }
    if (mtimeMs === binding.lastMtimeMs) return;
    binding.lastMtimeMs = mtimeMs;
    // An external write IS somebody reaching for the doc — the editor or the
    // git operation that made it is usually about to make another. Promote
    // the binding to the fast lane so the next few writes are seen in one
    // tick rather than one rotation, and let it decay like any other access.
    // `this.now()`, not `Date.now()`: residency runs on ONE clock, or an
    // externally edited doc ages against an epoch the policy never sees.
    this.lastTouchedAt.set(docId, this.now());
    // Debounce so we don't read a half-written file mid-save.
    if (binding.readTimer) clearTimeout(binding.readTimer);
    binding.readTimer = setTimeout(() => {
      // Null it FIRST. `bindingIsActive` reads `readTimer` as "a reconcile is
      // still pending"; a handle left behind after the callback fired made
      // that permanently true, so one external edit pinned the binding in the
      // fast lane for the life of the process. `writeTimer` has always nulled
      // itself here for the same reason.
      binding.readTimer = null;
      this.reconcileFromDisk(room, binding);
    }, READ_DEBOUNCE_MS);
  }

  /**
   * ONE interval for every bound file on the server, instead of one per
   * binding. The measured corpus had 4,228 bound docs; at 500ms each that was
   * thousands of stat syscalls a second, almost all of them for docs nobody
   * had open, plus 4,228 entries on the timer heap that never came off.
   */
  private ensureFilePollTicker(): void {
    if (this.filePollTicker) return;
    const timer = setInterval(() => this.sweepFilePolls(), FILE_POLL_MS);
    // Don't let the poll keep the process (or a test runner) alive.
    timer.unref?.();
    this.filePollTicker = timer;
  }

  /**
   * One pass over the bound files: every ACTIVE binding, plus a slice of the
   * idle ones.
   *
   * The two halves answer different questions. An active binding belongs to a
   * doc somebody is in, so it keeps the original 500ms latency. An idle one
   * belongs to a doc that is nonetheless allowed to change under us — a git
   * checkout, a branch switch, an editor save — so it must still be visited,
   * just not all of them every half-second. `idleCursor` walks the binding
   * map so each idle doc comes round in turn.
   */
  private sweepFilePolls(): void {
    const now = this.now();
    const idle: string[] = [];
    let armed = 0;
    for (const [docId, binding] of this.fileBindings) {
      if (!binding.pollArmed) continue;
      armed++;
      if (this.bindingIsActive(docId, binding, now)) this.pollBinding(docId, binding);
      else idle.push(docId);
    }
    if (armed === 0) {
      if (this.filePollTicker) clearInterval(this.filePollTicker);
      this.filePollTicker = null;
      this.idleCursor = 0;
      return;
    }
    const take = Math.min(IDLE_SWEEP_BUDGET, idle.length);
    for (let i = 0; i < take; i++) {
      const docId = idle[(this.idleCursor + i) % idle.length];
      const binding = this.fileBindings.get(docId);
      if (binding) this.pollBinding(docId, binding);
    }
    this.idleCursor = idle.length === 0 ? 0 : (this.idleCursor + take) % idle.length;
  }

  /**
   * Record that somebody just reached for this doc, and — on the idle→active
   * edge — pull any external edit in before they read it.
   *
   * Called from `get` / `getOrCreate`, which every route, MCP tool and
   * websocket upgrade funnels through. The edge check is rate-limited to one
   * stat per `FILE_POLL_MS` per doc, so a burst of requests against one doc
   * costs no more syscalls than the old always-on poll did.
   */
  private touchDoc(docId: string): void {
    const binding = this.fileBindings.get(docId);
    if (!binding?.pollArmed) {
      // Nothing to poll — but still remember the access, so a doc that is
      // bound later starts out warm rather than cold.
      this.lastTouchedAt.set(docId, this.now());
      return;
    }
    const now = this.now();
    // Asked BEFORE the stamp moves: afterwards every touch looks active.
    const wasActive = this.bindingIsActive(docId, binding, now);
    const prev = this.lastTouchedAt.get(docId);
    this.lastTouchedAt.set(docId, now);
    this.ensureFilePollTicker();
    if (!wasActive) this.noteActivation();
    if (prev === undefined || now - prev >= FILE_POLL_MS) this.pollBinding(docId, binding);
  }

  /** One idle -> active transition, filed under where it came from. */
  private noteActivation(): void {
    const tag = activationTag();
    const seen = this.activations.get(tag);
    if (seen !== undefined) {
      this.activations.set(tag, seen + 1);
      return;
    }
    if (this.activations.size >= ACTIVATION_TAG_CAP) {
      this.activations.set('other', (this.activations.get('other') ?? 0) + 1);
      return;
    }
    this.activations.set(tag, 1);
  }

  /**
   * Force a re-parse of the bound file into the live doc, ignoring
   * the currentSerialized match and lastWritten guards. Useful when
   * the parser itself changed (e.g. after a fix) and the on-disk
   * content would parse differently now even though its bytes are
   * unchanged.
   */
  reparseFromDisk(docId: string): { ok: boolean; error?: 'not-found' | 'no-binding' | 'missing' } {
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'not-found' };
    this.touchDoc(room.docId);
    // PINNED diff docs have no file binding — their content is pinned to a
    // commit. Recover by re-reading the file at the target hash from the
    // repo. (Working-tree diff docs have a live binding and fall through to
    // the normal flat-text path below.)
    if (room.meta.type === 'diff' && room.meta.diffTarget) {
      const { workspaceRoot, diffTarget, relPath, diffStatus } = room.meta;
      if (!workspaceRoot || !diffTarget || !relPath) return { ok: false, error: 'no-binding' };
      if (diffStatus === 'deleted') return { ok: true };
      const text = showFile(workspaceRoot, diffTarget, relPath);
      if (text === null) return { ok: false, error: 'missing' };
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, text);
      }, 'file-watch');
      return { ok: true };
    }
    // A pinned doc re-resolves its home before the reparse reads anything.
    // The old path's checkout may have switched branches since the binding
    // was made — an unguarded read here would pull that branch's copy
    // straight into the live doc, the exact incident homeGuard closes on
    // the poll path — and a doc parked at hydrate has no binding at all,
    // with reparse documented as one of its two recovery verbs.
    if (
      room.meta.docHome &&
      !isHubOwnedRoom(room.docId) &&
      contentKind(room.meta.type) === 'prose'
    ) {
      const bound = this.fileBindings.get(docId);
      if (!bound) this.maybeRebindHome(room, { force: true });
      else if (this.homeGuard(room, bound) === 'parked') return { ok: false, error: 'missing' };
    }
    const binding = this.fileBindings.get(docId);
    if (!binding) return { ok: false, error: 'no-binding' };
    if (!existsSync(binding.path)) return { ok: false, error: 'missing' };
    // The caller is declaring disk the winner. A pending write-back holds a
    // PRE-reparse serialization — letting it fire would rewrite the file the
    // caller just forced ("its stale in-memory copy flushed to disk and the
    // reparse pulled that back", 2026-08-03 incident).
    if (binding.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
    }
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch {
      return { ok: false, error: 'missing' };
    }
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return { ok: true };
    }
    if (prose.parseMarkdownBlocks(md).length === 0) return { ok: false, error: 'missing' };
    const fragment = prose.getProseFragment(room.ydoc);
    room.ydoc.transact(() => {
      // Block-level diff, not delete-all + push: blocks the rewrite didn't
      // touch keep their Y.XmlText identity, so their thread anchors keep
      // resolving instead of every thread in the doc orphaning.
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    // The diff above keys blocks by their serialized markdown, so a block
    // whose only defect is an ATTRIBUTE (a legacy string heading level, which
    // serializes to the same `## …`) is correctly seen as unchanged and kept.
    // reparse is the documented recovery tool, so repair those here — without
    // it, force-pulling a legacy doc still left its headings rendering as h1.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, not raw disk bytes — see attachFile (RC1).
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    binding.lastSyncError = undefined;
    return { ok: true };
  }

  /**
   * External file changed — read it, compare to what we think is
   * canonical, and apply the delta to the live doc if different.
   * Applies in one transact origin='file-watch' so the doc→disk
   * observer knows not to re-flush (which would bounce back here).
   */
  private reconcileFromDisk(
    room: DocRoom,
    binding: FileBinding,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'missing' {
    // The disk→doc side of the home gate. Without it, `git checkout` under a
    // pinned doc's old path rewrites the file, the poll sees an mtime change,
    // and the OTHER branch's copy gets applied into the live doc — the read
    // half of the same incident the write half guards against.
    if (this.homeGuard(room, binding) !== 'ok') return 'missing';
    if (!existsSync(binding.path)) return 'missing';
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch (err) {
      console.error(`[rooms] read failed for ${binding.path}:`, err);
      return 'missing';
    }
    // Code and working-tree diff docs are flat text — replace the whole
    // `content` Y.Text on change. Read-only bindings can't hold live edits,
    // so 'conflict' is impossible for them; editable (writeBack) bindings
    // get the same keep-live/backup/reassert arm the prose path has — a
    // blind replace here would eat the reviewer's in-flight keystrokes.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const current = content.toString();
      const decision = decideReconcile({
        disk: md,
        lastWritten: binding.lastWritten,
        currentSerialized: current,
      });
      if (decision === 'in-sync') return decision;
      if (decision === 'catch-up') {
        binding.lastWritten = md;
        return decision;
      }
      if (decision === 'conflict' && binding.writeBack) {
        this.recordConflictReassert(room, binding, md);
        return decision;
      }
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return decision;
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    const decision = decideReconcile({
      disk: md,
      lastWritten: binding.lastWritten,
      currentSerialized,
    });
    // Same content as last round-trip → nothing to do.
    if (decision === 'in-sync') return decision;
    // The live doc already serializes to disk (up to serializer whitespace) —
    // just catch up bookkeeping, don't touch the fragment.
    if (decision === 'catch-up') {
      binding.lastWritten = md;
      return decision;
    }
    // decideReconcile compares BYTES. A formatting-only external save
    // (format-on-save, trailing-newline fixers) changes bytes but not
    // content — without these checks it classified as 'apply' (block
    // rewrite, broken anchors) or, with un-flushed live edits, 'conflict'
    // (backup + syncError + reassert over the human's formatting). Parse
    // cost is fine here: we only get this far on a detected mtime change.
    const diskNormalized = prose.normalizeMarkdown(md);
    if (diskNormalized === currentSerialized) {
      // Formatting-variant of the live content — semantically in-sync.
      // Leave the file as the external tool wrote it.
      binding.lastWritten = currentSerialized;
      return 'in-sync';
    }
    if (decision === 'conflict') {
      if (diskNormalized === binding.lastWritten) {
        // Disk holds a formatting-variant of our LAST write — no semantic
        // external change, so the un-flushed live edits are not in
        // conflict. Re-arm the flush; the pending write carries them out.
        this.scheduleFileWrite(room, binding);
        return 'catch-up';
      }
      // An external write collided with un-flushed live edits. A blind
      // delete+push here would clobber the human's in-progress work (the bug
      // a peer reported). The editor is the runtime source of truth, so keep
      // the live edits and reassert them to disk via the debounced writer.
      // BUT the reassert overwrites the external version on disk — so back it
      // up first, or "recoverable with reparse_from_disk" is a lie (disk
      // would already hold our reassert by the time anyone reparses).
      this.recordConflictReassert(room, binding, md);
      return decision;
    }
    // decision === 'apply' — disk changed externally and the live doc is clean.
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(md);
    } catch (err) {
      // A parse throw used to vanish into the setTimeout callback, leaving
      // the doc silently serving pre-edit content. Record + log instead so
      // getDoc can report WHY it's stale. The fragment is left untouched
      // (we never started the transact), so the next edit retries cleanly.
      const message = err instanceof Error ? err.message : String(err);
      this.recordSyncError(room, binding, `parse failed: ${message}`);
      console.error(`[rooms] ${room.docId}: disk→doc parse failed for ${binding.path}:`, err);
      return decision;
    }
    if (blocks.length === 0) {
      // Don't wipe to empty on a parse that produced nothing — but DON'T
      // do it silently either (the old behavior). Surface it.
      this.recordSyncError(
        room,
        binding,
        'disk content parsed to zero blocks; live doc left unchanged',
      );
      console.warn(
        `[rooms] ${room.docId}: disk→doc reconcile yielded 0 blocks from ${binding.path}; keeping prior state`,
      );
      return decision;
    }
    // Apply as a block-level diff: only blocks whose markdown actually
    // changed are replaced, so anchors on untouched blocks keep resolving.
    // Anchors inside a rewritten block still break — auto-reanchor's
    // snippet-match sweep catches that case on the next tick.
    //
    // Suggestions ride the same block-granularity rule: marks in untouched
    // blocks survive (identity preserved), but an external rewrite of a
    // block CARRYING suggestions replaces the block and its proposals are
    // dropped — accepted-and-surfaced, not silently swallowed. Snapshot the
    // pending sids so the drop can be recorded below (syncError pattern; a
    // snippet-match re-anchor sweep for suggestions is out of scope for v1).
    const sidsBefore = new Set(suggestOps.scanSuggestions(fragment).keys());
    room.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    const sidsAfter = new Set(suggestOps.scanSuggestions(fragment).keys());
    const droppedSids = [...sidsBefore].filter((sid) => !sidsAfter.has(sid));
    // Same as reparseFromDisk: a block whose only defect is a legacy string
    // heading level serializes identically, so the diff keeps it and the
    // attribute has to be repaired separately. Idempotent and cheap.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, NOT the raw disk bytes (RC1): parse→serialize is not
    // byte-identity, so storing `md` here left `currentSerialized ≠
    // lastWritten` forever after — and the NEXT external edit was misjudged
    // a conflict and clobbered by the reassert.
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    if (droppedSids.length > 0) {
      // Same recoverability philosophy as the conflict backups: the reconcile
      // SUCCEEDED, but pending proposals living in a rewritten block were
      // dropped — record which, so agents/UI can report the loss instead of
      // the suggestions just vanishing. Cleared by the next clean reconcile.
      this.recordSyncError(
        room,
        binding,
        `external edit dropped pending suggestion(s): ${droppedSids.join(', ')}`,
      );
      console.warn(
        `[rooms] ${room.docId}: external edit to ${binding.path} dropped suggestion(s) ${droppedSids.join(', ')}`,
      );
    } else {
      binding.lastSyncError = undefined;
    }
    console.log(
      `[rooms] ${room.docId}: applied external edit from ${binding.path} (${blocks.length} blocks)`,
    );
    return decision;
  }

  private scheduleFileWrite(room: DocRoom, binding: FileBinding): void {
    // A pending flush makes the binding active (see `bindingIsActive`), so the
    // sweep must be running to see it — it may have stopped itself while the
    // doc was idle.
    if (binding.pollArmed) this.ensureFilePollTicker();
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = setTimeout(() => {
      binding.writeTimer = null;
      this.writeBoundFileNow(room, binding);
    }, WRITE_BACK_MS);
  }

  /** The write-back body: what the ~800ms debounce runs when it fires, and
   *  what `flush()` runs synchronously on graceful shutdown. */
  private writeBoundFileNow(room: DocRoom, binding: FileBinding): void {
    try {
      // Home-pinned docs re-verify the destination before every write —
      // "persistence never writes to whatever checkout happens to be
      // current". A retarget already carried this flush's content out (the
      // export) or re-armed one on the new binding; parked means the bytes
      // stay in the live doc.
      if (this.homeGuard(room, binding) !== 'ok') return;
      // Guard (RC2): if disk moved since we last read or wrote it, we'd be
      // overwriting bytes we have never seen — the poll just hasn't caught
      // up yet. Reconcile first; apply/conflict decides, and the conflict
      // path both backs up the external version and re-schedules our flush.
      if (binding.lastMtimeMs !== undefined && existsSync(binding.path)) {
        try {
          const mtimeMs = statSync(binding.path).mtimeMs;
          if (mtimeMs !== binding.lastMtimeMs) {
            binding.lastMtimeMs = mtimeMs;
            this.reconcileFromDisk(room, binding);
            return;
          }
        } catch {}
      }
      const md =
        contentKind(room.meta.type) === 'flat'
          ? room.ydoc.getText('content').toString()
          : prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      if (md === binding.lastWritten) {
        // Nothing to write means nothing to reassert after a restart either.
        this.failedFileWrites.delete(room.docId);
        this.clearPendingFileWrite(room.docId);
        return;
      }
      // Atomic: write-temp-then-rename, so a crash mid-write can't leave
      // the user's file truncated and a concurrent reader never sees half
      // a document. (Same save pattern editors use.) Rename onto the
      // REALPATH — renaming onto a symlink would replace the link with a
      // regular file instead of writing through it (codex P2).
      let target = binding.path;
      try {
        target = realpathSync(binding.path);
      } catch {}
      const tmp = `${target}.lf-write~`;
      writeFileSync(tmp, md);
      renameSync(tmp, target);
      binding.lastWritten = md;
      // Record our own write's mtime so the poll doesn't treat the
      // write-back as an external edit and schedule a redundant reconcile.
      try {
        binding.lastMtimeMs = statSync(binding.path).mtimeMs;
      } catch {}
      // The edit is on disk now, so a restart has nothing to repair. Note
      // this is NOT in a `finally`: a write that THREW must keep the flag,
      // because that is exactly the doc a restart still has to reassert.
      this.failedFileWrites.delete(room.docId);
      this.clearPendingFileWrite(room.docId);
    } catch (err) {
      // Sticky, because the caller cannot see this: the throw is swallowed
      // here and the write timer is already cleared, so nothing downstream
      // can tell a failed write from a finished one.
      this.failedFileWrites.add(room.docId);
      console.error(`[rooms] file write failed for ${binding.path}:`, err);
    }
  }

  /**
   * Drop `pendingFileWrite` from a doc's index row, if it is set.
   *
   * Writes the row rather than waiting for the next `persistRoomNow`: the
   * whole value of the flag is that it is accurate at the moment the process
   * dies, and a flag left set only costs one doc's hydration at the next
   * boot, while a flag cleared too eagerly loses the edit it was guarding.
   */
  private clearPendingFileWrite(docId: string): void {
    const entry = this.docIndex.get(docId);
    if (!entry?.pendingFileWrite) return;
    const { pendingFileWrite: _drop, ...rest } = entry;
    this.docIndex.set(docId, rest);
    writeDocIndex(this.cfg.dataDir, docId, rest);
  }

  /**
   * The conflict arm of `reconcileFromDisk`, shared by the prose and flat
   * write-back bindings so the two cannot drift apart: back the external
   * version up, record a `syncError` explaining what happened and where the
   * overwritten bytes went, log it, and re-arm the flush that reasserts the
   * live doc onto disk.
   *
   * The message names GIT when the bytes we are about to overwrite are a blob
   * this repository already holds. The mtime poll cannot distinguish
   * `git checkout` / `git stash` / `git pull` from a person saving in an
   * editor — nothing on the file says which it was — so before this, a git
   * operation against a doc with un-flushed live edits was undone a second
   * later with the operator seeing only a clean `git` exit and, if they
   * happened to look, an unexplained dirty working tree. The provenance check
   * is advisory only: it never changes which side wins.
   */
  private recordConflictReassert(room: DocRoom, binding: FileBinding, external: string): void {
    const backupPath = this.backupExternalVersion(room.docId, external);
    const gitHint = gitConflictHint(binding.path, external);
    this.recordSyncError(
      room,
      binding,
      'external file change collided with un-flushed live edits; kept live edits and reasserted them to disk. ' +
        (backupPath
          ? `The external version was saved to ${backupPath} — restore it and reparse_from_disk to make it win.`
          : 'Backup of the external version FAILED — it survives only in your editor/git history.') +
        gitHint,
      backupPath,
    );
    console.warn(
      `[rooms] ${room.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk` +
        (backupPath ? ` (external version backed up to ${backupPath})` : '') +
        (gitHint ? ' — the overwritten bytes came from git, not an editor save' : ''),
    );
    this.scheduleFileWrite(room, binding);
  }

  /**
   * Record a sync failure on a binding AND announce it on the doc's event
   * channels as a `doc.sync_error` broadcast.
   *
   * Every `lastSyncError` write funnels through here for the same reason
   * thread changes funnel through `fireEvent`: a fifth failure mode added
   * later gets the broadcast for free rather than silently going without.
   * Before this, the error was only readable via get_doc or a later edit
   * response — surfaces the party who just LOST content (whoever ran the
   * `git stash` whose bytes now exist only in clobber-backups/, or saved in
   * an editor) never touches. Watching sessions do, so the loss is announced
   * where the watchers already are (proposed on a board ticket, 2026-08).
   */
  private recordSyncError(
    room: DocRoom,
    binding: FileBinding,
    message: string,
    backupPath?: string | null,
  ): void {
    const at = Date.now();
    binding.lastSyncError = { message, at };
    room.seq++;
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    this.broadcastToRoom(room, {
      event: 'doc.sync_error',
      docId: room.docId,
      doc: decorate(room.meta),
      path: room.meta.relPath ?? binding.path,
      ...(backupPath ? { backupPath } : {}),
      message,
      at,
      seq: room.seq,
    });
  }

  /**
   * Snapshot an external file version we are about to overwrite into
   * `<dataDir>/clobber-backups/`, so a conflict reassert is recoverable
   * instead of destructive. Returns the backup path, or null on failure —
   * never throws (the reconcile must proceed either way).
   */
  private backupExternalVersion(docId: string, content: string, label = 'external'): string | null {
    try {
      const dir = join(this.cfg.dataDir, 'clobber-backups');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(dir, `${safeId}-${label}-${Date.now()}.md`);
      writeFileSync(file, content);
      return file;
    } catch (err) {
      console.error(`[rooms] clobber backup failed for ${docId}:`, err);
      return null;
    }
  }

  /**
   * Is the bound .md at least as new as the persisted .ydoc? Decides who wins
   * a no-bookkeeping attach (post-restart): the .ydoc's mtime marks the live
   * doc's last change, so an older .md means the crash beat the write-back
   * debounce and disk is the STALE side. Errs toward disk (the documented
   * source of truth at rest) when either stat fails.
   */
  private diskNewerThanState(docId: string, filePath: string): boolean {
    try {
      const ydocPath = this.pathFor(docId);
      if (!existsSync(ydocPath)) return true;
      return statSync(filePath).mtimeMs >= statSync(ydocPath).mtimeMs;
    } catch {
      return true;
    }
  }

  /**
   * Run a disk→doc reconcile for a bound doc right now (instead of waiting
   * for the mtime poll) and report the decision. Used by tests to pin the
   * reconcile policy without timing races, and available to routes for an
   * explicit "sync now".
   */
  reconcileNow(
    docId: string,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'no-binding' | 'missing' {
    const room = this.resolveRoom(docId);
    // Every keyed lookup below takes the RESOLVED id: `docId` may be an
    // alias, which resolves to a room but keys no binding and no clock.
    const binding = room ? this.fileBindings.get(room.docId) : undefined;
    if (!room || !binding) return 'no-binding';
    this.touchDoc(room.docId);
    if (!existsSync(binding.path)) return 'missing';
    // Advance the poll baseline the same way the poll itself would, so this
    // manual reconcile doesn't get replayed on the next tick.
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    if (binding.readTimer) {
      clearTimeout(binding.readTimer);
      binding.readTimer = null;
    }
    return this.reconcileFromDisk(room, binding);
  }

  /** The doc's pending sync trouble, if any — conflicts, parse failures. */
  getSyncError(docId: string): { message: string; at: number } | undefined {
    return this.fileBindings.get(docId)?.lastSyncError;
  }

  /**
   * Bound documents whose write-back flush has been scheduled and has not
   * fired yet — i.e. the live doc holds edits that disk does not.
   *
   * This is the window in which an external write to the same file LOSES:
   * the poll classifies it as a conflict, the live doc wins, and the file is
   * reasserted ~800ms later. A `git pull` is such a write, so a deploy asks
   * this before it fast-forwards anything.
   *
   * `root` limits the answer to files under one directory, because the
   * question is only ever about the tree that is about to be rewritten — a
   * document bound from some other repo has no bearing on it. Containment
   * goes through `isWithinRoot`, which realpaths both sides: this machine
   * reaches the same home directory through two paths, and a lexical prefix
   * test answers no for half of them.
   *
   * One consequence of `isWithinRoot` answering closed: a binding whose file
   * has been deleted is not reported. That is the right way round — the
   * caller uses this to decide whether to refuse, and a missing file is not
   * a reason to block a deploy.
   */
  pendingFileWrites(root?: string): { docId: string; path: string }[] {
    const out: { docId: string; path: string }[] = [];
    for (const [docId, binding] of this.fileBindings) {
      if (!binding.writeTimer) continue;
      if (root !== undefined && !isWithinRoot(root, binding.path)) continue;
      out.push({ docId, path: binding.path });
    }
    return out;
  }

  /**
   * Replace the WHOLE document from a markdown payload — the legitimate
   * "comprehensive rewrite" path. Applies as a block-level diff on the live
   * doc (anchors on untouched blocks keep resolving, connected editors
   * update live) and flushes to disk via the normal debounced writer.
   *
   * This is what agents used `Write` + `reparse_from_disk` — or the
   * delete_doc → Write → create_review_doc dance — to approximate, both of
   * which raced the write-back and clobbered (2026-07-15, 2026-08-03).
   */
  /** Record a human (browser-websocket) prose edit. Called by the wireEvents
   *  observer; public so tests can pin the window policy without a socket. */
  /**
   * When this doc's content was last changed by a person or an agent, or
   * undefined if no change has been seen since the room was loaded (a room
   * that was never opened answers undefined, which is the right answer — it
   * has no activity to report).
   *
   * `peek`, not `get`: `get` calls `touchDoc`, and a stall-loop poll must not
   * register as somebody reaching for the doc, or the instrument would move
   * what it measures (and would drag the whole corpus into the file poll's
   * fast lane — see `peek`'s own note). Going through `peek` rather than the
   * raw map is also what makes ALIASES resolve: a task's saved `doc` ref
   * usually holds the caller-chosen name, not the minted id, so a raw
   * `this.rooms.get` answered undefined for exactly the docs this is for.
   */
  lastContentChangeFor(docId: string): number | undefined {
    return this.peek(docId)?.lastContentChangeAt;
  }

  /**
   * Somebody with derived tasks to keep honest — the server wires this to
   * `TaskStore.flagStaleFromDocEdit` plus a projection refresh. Called once
   * per settled authoring burst with the doc's canonical id, its alias when
   * it has one (origin refs routinely hold the caller-chosen name), and the
   * revision the burst landed on.
   */
  onContentRevision?: (docIds: string[], revision: number) => void;

  /**
   * The doc's content revision with any pending bump COMMITTED first — what a
   * create-from-doc stamps onto the task, so words typed before the create
   * can never flag the task they produced (see `DocRoom.pendingRevisionBump`).
   * `peek`, not `get`: a task citing an unloaded doc answers undefined and the
   * task simply never joins the staleness comparison, which is the quiet
   * direction to be wrong in.
   */
  settledContentRevision(docId: string): number | undefined {
    const room = this.peek(docId);
    if (!room) return undefined;
    this.commitRevisionBump(room);
    return room.meta.contentRevision ?? 0;
  }

  /**
   * One bump per authoring BURST, not per keystroke: every Yjs update while
   * somebody types re-arms the timer, and the counter moves once when the
   * doc goes quiet. The burst is the honest unit — "the plan changed" is a
   * statement about an edit session, and per-update bumps would write CRDT
   * meta on every keypress.
   */
  private scheduleRevisionBump(room: DocRoom): void {
    room.pendingRevisionBump = true;
    if (room.revisionTimer) clearTimeout(room.revisionTimer);
    room.revisionTimer = setTimeout(() => this.commitRevisionBump(room), REVISION_SETTLE_MS);
  }

  private commitRevisionBump(room: DocRoom): void {
    if (!room.pendingRevisionBump) return;
    room.pendingRevisionBump = false;
    if (room.revisionTimer) {
      clearTimeout(room.revisionTimer);
      room.revisionTimer = null;
    }
    const revision = (room.meta.contentRevision ?? 0) + 1;
    const m = room.ydoc.getMap('meta');
    // A string origin that does NOT start with 'agent': the meta write lands
    // back in the room's own update hook, and an authoring-shaped origin here
    // would re-arm the very debounce that just fired.
    room.ydoc.transact(() => m.set('contentRevision', revision), CONTENT_REVISION_ORIGIN);
    room.meta.contentRevision = revision;
    const ids = room.meta.alias ? [room.docId, room.meta.alias] : [room.docId];
    this.onContentRevision?.(ids, revision);
  }

  /**
   * Stamp "somebody pressed Make Plan" on the doc. The ask itself is a
   * comment thread the route files through `postComment`; this stamp is only
   * what lets a reopened doc render the requested state. Overwritten by a
   * later press on purpose — asking again is allowed, and the newest ask is
   * the one worth naming.
   */
  setPlanRequested(
    docId: string,
    by: string,
  ): { ok: true; docId: string; requestedAt: number } | { ok: false; error: 'not-found' } {
    const room = this.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const requestedAt = Date.now();
    const m = room.ydoc.getMap('meta');
    room.ydoc.transact(() => {
      m.set('planRequestedAt', requestedAt);
      m.set('planRequestedBy', by);
    }, CONTENT_REVISION_ORIGIN);
    room.meta.planRequestedAt = requestedAt;
    room.meta.planRequestedBy = by;
    return { ok: true, docId: room.docId, requestedAt };
  }

  /**
   * Stamp "somebody pressed Review" on the doc, naming the thread the press
   * filed. The thread is the ask; the stamp is what a reopened doc renders
   * while that thread is open, and the id is how the float sees it close
   * and offers the next ask.
   */
  setReviewRequested(
    docId: string,
    by: string,
    threadId: string,
  ): { ok: true; docId: string; requestedAt: number } | { ok: false; error: 'not-found' } {
    const room = this.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const requestedAt = Date.now();
    const m = room.ydoc.getMap('meta');
    room.ydoc.transact(() => {
      m.set('reviewRequestedAt', requestedAt);
      m.set('reviewRequestedBy', by);
      m.set('reviewThreadId', threadId);
    }, CONTENT_REVISION_ORIGIN);
    room.meta.reviewRequestedAt = requestedAt;
    room.meta.reviewRequestedBy = by;
    room.meta.reviewThreadId = threadId;
    return { ok: true, docId: room.docId, requestedAt };
  }

  /**
   * Move a doc's plan gate. `'pending'` marks the doc a plan whose derived
   * tasks are drafts; `'approved'` records who released it. Releasing the
   * HELD TASKS is the task store's half — the route calls both, because the
   * two stores deliberately do not know each other.
   */
  setPlanState(
    docId: string,
    state: 'pending' | 'approved',
    by?: string,
  ): { ok: true; docId: string; changed: boolean } | { ok: false; error: 'not-found' } {
    const room = this.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    if (room.meta.planState === state) return { ok: true, docId: room.docId, changed: false };
    const m = room.ydoc.getMap('meta');
    const approvedAt = state === 'approved' ? Date.now() : undefined;
    room.ydoc.transact(() => {
      m.set('planState', state);
      if (state === 'approved') {
        if (by !== undefined) m.set('planApprovedBy', by);
        m.set('planApprovedAt', approvedAt);
      } else {
        // Back to pending: the old approval is a claim about a released
        // plan, and keeping it beside `pending` would say two things at once.
        m.delete('planApprovedBy');
        m.delete('planApprovedAt');
      }
    }, CONTENT_REVISION_ORIGIN);
    room.meta.planState = state;
    room.meta.planApprovedBy = state === 'approved' ? by : undefined;
    room.meta.planApprovedAt = approvedAt;
    return { ok: true, docId: room.docId, changed: true };
  }

  noteHumanEdit(docId: string, at: number = Date.now()): void {
    const room = this.get(docId);
    if (room) room.lastHumanEditAt = at;
  }

  /** Record that `reader` fetched this doc's content (their copy is current
   *  as of `at`). Keyed by the author id the same caller sends on writes. */
  noteAgentRead(docId: string, reader: string, at: number = Date.now()): void {
    const key = this.get(docId)?.docId ?? docId;
    let perDoc = this.agentReads.get(key);
    if (!perDoc) {
      perDoc = new Map();
      this.agentReads.set(key, perDoc);
    }
    perDoc.set(reader, at);
  }

  /**
   * Would a whole-doc rewrite from this caller clobber a human's recent
   * edits? Returns `null` when the write is safe, else the evidence for a
   * structured refusal.
   *
   * A caller with a tracked read is judged by ORDER: their last read must be
   * newer than the last human edit, however long ago either happened. A
   * caller the server has no read marker for (old bundle, no author) falls
   * back to a 10-minute window after the last human edit — wide enough to
   * cover a live co-editing session, narrow enough that routine rewrites of
   * an idle doc keep working without new payload fields.
   */
  staleWriteCheck(
    docId: string,
    reader?: string,
    now: number = Date.now(),
  ): { humanEditedAt: number; lastReadAt?: number } | null {
    const room = this.get(docId);
    const humanEditedAt = room?.lastHumanEditAt;
    if (humanEditedAt === undefined || !room) return null;
    const lastReadAt = reader ? this.agentReads.get(room.docId)?.get(reader) : undefined;
    if (lastReadAt !== undefined) {
      // STRICTLY newer. Date.now() ticks in milliseconds, so a read and an
      // edit in the same tick carry no order — `>=` called that tie "read is
      // fresh" and let the write destroy an edit the caller provably never
      // saw. A tie refuses; the caller's re-read lands a tick later and
      // clears it. The no-human-edit happy path never reaches this line.
      return lastReadAt > humanEditedAt ? null : { humanEditedAt, lastReadAt };
    }
    return now - humanEditedAt < STALE_WRITE_WINDOW_MS ? { humanEditedAt } : null;
  }

  // ── Editing the words ────────────────────────────────────────────────────
  //
  // The verbs live in `doc-edit-ops.ts`; what follows is the store's public
  // surface forwarding onto them, signatures unchanged.

  setDocContent(
    docId: string,
    markdown: string,
  ): { ok: true } | { ok: false; error: 'not-found' | 'unsupported' | 'empty' | 'parse-failed' } {
    return this.docEdits.setDocContent(docId, markdown);
  }

  findAndReplace(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      /** Replace EVERY occurrence in one transaction. See prose.findAndReplace. */
      replaceAll?: boolean;
      parseInlineMarks?: boolean;
    },
  ): prose.ReplaceResult {
    return this.docEdits.findAndReplace(docId, opts);
  }

  rewriteThreadRegion(
    docId: string,
    threadId: string,
    replacement: string,
    opts?: { parseInlineMarks?: boolean },
  ): prose.AnchoredEditResult {
    return this.docEdits.rewriteThreadRegion(docId, threadId, replacement, opts);
  }

  createAgentAnchor(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      label?: string;
    },
  ): prose.CreateAnchorResult {
    return this.docEdits.createAgentAnchor(docId, opts);
  }

  editAtAgentAnchor(
    docId: string,
    anchorId: string,
    op: { kind: 'replace'; text: string } | { kind: 'insert_after'; text: string },
  ): prose.AnchoredEditResult {
    return this.docEdits.editAtAgentAnchor(docId, anchorId, op);
  }

  deleteAgentAnchor(docId: string, anchorId: string): boolean {
    return this.docEdits.deleteAgentAnchor(docId, anchorId);
  }

  listSuggestions(docId: string): suggestOps.SuggestionSummary[] {
    return this.docEdits.listSuggestions(docId);
  }

  createSuggestion(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
    },
  ):
    | { ok: true; suggestionId: string }
    | {
        ok: false;
        // `match-in-pending-suggestion`: the find only matched text that is
        // itself an unaccepted proposal — anchoring here would make this
        // proposal vanish when the other one is rejected.
        error: 'not-found' | 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
        candidates?: Array<{ docOffset: number; preview: string }>;
      } {
    return this.docEdits.createSuggestion(docId, opts);
  }

  createSuggestionForThread(
    docId: string,
    threadId: string,
    opts: {
      replacement: string;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
      ts?: number;
    },
  ):
    | { ok: true; suggestionId: string }
    | { ok: false; error: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' } {
    return this.docEdits.createSuggestionForThread(docId, threadId, opts);
  }

  acceptSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    return this.docEdits.acceptSuggestion(docId, sid);
  }

  rejectSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    return this.docEdits.rejectSuggestion(docId, sid);
  }

  resolveAllSuggestions(
    docId: string,
    opts: { action: 'accept' | 'reject'; authorId?: string },
  ): { ok: true; resolved: number; sids: string[] } | { ok: false; error: 'not-found' } {
    return this.docEdits.resolveAllSuggestions(docId, opts);
  }

  insertBlocksAtAnchor(
    docId: string,
    anchorId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    return this.docEdits.insertBlocksAtAnchor(docId, anchorId, markdown, opts);
  }

  insertAfterThread(docId: string, threadId: string, text: string): prose.AnchoredEditResult {
    return this.docEdits.insertAfterThread(docId, threadId, text);
  }

  insertBlocksAfterThread(
    docId: string,
    threadId: string,
    markdown: string,
    opts?: { placement?: prose.BlockPlacement },
  ): prose.AnchoredEditResult {
    return this.docEdits.insertBlocksAfterThread(docId, threadId, markdown, opts);
  }

  deleteBlockAtThread(docId: string, threadId: string): prose.DeleteBlockResult {
    return this.docEdits.deleteBlockAtThread(docId, threadId);
  }

  deleteBlockAtAgentAnchor(docId: string, anchorId: string): prose.DeleteBlockResult {
    return this.docEdits.deleteBlockAtAgentAnchor(docId, anchorId);
  }

  deleteBlocksInRange(
    docId: string,
    opts: {
      startFind: string;
      endFind: string;
      contextBefore?: string;
      contextAfter?: string;
      startOccurrence?: number;
      endOccurrence?: number;
    },
  ): prose.DeleteBlocksInRangeResult {
    return this.docEdits.deleteBlocksInRange(docId, opts);
  }

  deleteSection(
    docId: string,
    opts: { heading: string; level?: number; occurrence?: number },
  ): prose.DeleteSectionResult {
    return this.docEdits.deleteSection(docId, opts);
  }

  autoReanchor(docId: string): { checked: number; reanchored: number; stillOrphan: number } | null {
    return this.docEdits.autoReanchor(docId);
  }

  /**
   * Append a comment-family activity event (comment / reply / resolve /
   * reopen) for a successful thread action. Both person and agent actions are
   * recorded — agent events carry actor:'agent' so the Weekly Review agent can
   * filter them, but person events are never dropped. Best-effort: any failure
   * is swallowed so activity capture can't break the action it observes.
   */
  private recordActivity(
    room: DocRoom,
    type: ActivityType,
    author: User,
    threadId: string,
    opts: { text?: string; tsMs: number },
  ): void {
    try {
      const actor = classifyActor(author);
      const ts = toUtcIso(opts.tsMs);
      const payload: Event['payload'] =
        opts.text !== undefined ? { text: opts.text, wordCount: wordCount(opts.text) } : {};
      const id = eventId({
        ts,
        actor,
        docId: room.docId,
        type,
        threadId,
        payloadDigest: payloadDigest(opts.text),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor,
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        threadId,
        doc: buildEventDoc(room.meta),
        payload,
      };
      appendActivity(this.cfg.dataDir, event);
    } catch (err) {
      console.error('[rooms] recordActivity failed:', err);
    }
  }

  /**
   * Append a browser-originated reading event (read_session / doc_open). The
   * client posts the interaction-bounded payload; the server resolves the doc
   * / repo / producedBy and stamps actor=person, ts=now. Unknown `type`s are
   * rejected so a malformed POST can't poison the stream.
   */
  recordReadEvent(
    docId: string,
    type: 'read_session' | 'doc_open',
    payload: Event['payload'],
    author: User,
  ): { ok: boolean; error?: 'no-doc' | 'bad-type' | 'append-failed' } {
    if (type !== 'read_session' && type !== 'doc_open') {
      return { ok: false, error: 'bad-type' };
    }
    const room = this.resolveRoom(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    try {
      // Re-clamp the browser-supplied duration/scroll fields server-side so a
      // spoofed or buggy POST can't write an inflated read time.
      clampReadPayload(payload);
      const ts = toUtcIso(Date.now());
      const sessionId = payload.sessionId;
      const id = eventId({
        ts,
        actor: 'person',
        docId,
        type,
        threadId: null,
        payloadDigest: payloadDigest(sessionId),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor: 'person',
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        doc: buildEventDoc(room.meta),
        payload,
      };
      appendActivity(this.cfg.dataDir, event);
      return { ok: true };
    } catch (err) {
      console.error('[rooms] recordReadEvent failed:', err);
      return { ok: false, error: 'append-failed' };
    }
  }

  private fireEvent(
    room: DocRoom,
    event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened',
    thread: Thread,
    comment?: { id: string; author: User; text: string; ts: number },
    opts?: { generate?: boolean },
    // Who performed a resolve/reopen. The comment param can't carry it —
    // there is no comment on a status change, and a frame without an actor
    // sent channel renderers to comments[0].author, i.e. the CREATOR.
    actor?: User,
  ): void {
    room.seq++;
    // Every thread change funnels through here, which is exactly why the
    // summary trigger lives here and not at the four call sites: a fifth
    // event added later gets summarization for free rather than silently
    // going without it.
    if (opts?.generate !== false) this.scheduleSummary(room, thread.id);
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      threadId: thread.id,
      thread,
      doc: decorate(room.meta),
      comment,
      ...(actor ? { actor } : {}),
      // A comment ON a review item names the item at the top level, so the
      // owner's channel line can say which item to revise without walking
      // the thread's anchor.
      ...(thread.anchor.kind === 'review-item' ? { reviewItemId: thread.anchor.reviewItemId } : {}),
      seq: room.seq,
    });
  }

  /**
   * Suggestion verdict events (redline-suggestions phase 2, commit 3):
   * `suggestion.created` / `suggestion.accepted` / `suggestion.rejected` on
   * the same doc/workspace channel thread events use, so a suggesting agent
   * hears the outcome via `watch_doc` without polling `list_suggestions`.
   * `summary` is the SuggestionSummary captured BEFORE the mutation for
   * accept/reject (the marks are gone afterward, so there's nothing left to
   * scan) — undefined only if the sid vanished between scan and fire, which
   * shouldn't happen since callers scan and mutate in the same call.
   */
  private fireSuggestionEvent(
    room: DocRoom,
    event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected',
    sid: string,
    summary: suggestOps.SuggestionSummary | undefined,
  ): void {
    room.seq++;
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      sid,
      suggestion: summary,
      doc: decorate(room.meta),
      seq: room.seq,
    });
  }

  /**
   * Summarize every already-existing thread that has no current summary.
   *
   * Generation is triggered by thread CHANGES, so nothing that was written
   * before this feature shipped would ever get a summary — the docs with the
   * worst deterministic topic lines are exactly the old ones. This walks the
   * hydrated rooms once and hands the backlog to the summarizer, which paces
   * it over `windowMs`.
   *
   * Resolved threads are included: their cards still render both lines in the
   * all-threads panel and the outdated-comments flow, and a summary is the
   * whole point there too. They are counted separately so the operator sees
   * what they are agreeing to pay for rather than one opaque total.
   *
   * Returns immediately with the count queued; the drain runs in the
   * background. Never automatic — the caller (bin.ts) decides, because a
   * backfill spends real money and must not fire in a test or a short-lived
   * process.
   */
  backfillSummaries(opts: { windowMs?: number } = {}): {
    queued: number;
    open: number;
    resolved: number;
  } {
    const summarizer = this.cfg.summarizer;
    if (!summarizer?.enabled) return { queued: 0, open: 0, resolved: 0 };
    const tasks: ScheduleArgs[] = [];
    let open = 0;
    let resolved = 0;
    // Every doc on the server, not just the ones that happen to be in memory.
    // Under lazy hydration those are two very different sets, and the whole
    // point of this sweep is the OLD threads — which are exactly the ones in
    // docs nobody has opened.
    for (const docId of new Set([...this.docIndex.keys(), ...this.rooms.keys()])) {
      // The index says how many threads a doc has, so a doc with none is
      // skipped without loading it. On the measured corpus that is most of
      // them, and it is the difference between a sweep that reads a few
      // hundred docs and one that reads five thousand.
      if (this.threadCounts(docId).total === 0) continue;
      const wasResident = this.rooms.has(docId);
      const room = this.resolveRoom(docId);
      if (!room) continue;
      let queuedHere = 0;
      for (const t of listThreads(room.ydoc)) {
        // Ask the same question the live path asks, so a thread summarized a
        // second ago is not paid for twice.
        if (!needsCall(t, t.summary)) continue;
        if (t.status === 'open') open++;
        else resolved++;
        queuedHere++;
        tasks.push({
          docId,
          threadId: t.id,
          getThread: () => this.getThread(docId, t.id),
          apply: (summary) => {
            // Resolved again HERE, not captured above: this runs minutes
            // later, spread over the pacing window, and the room it was
            // collected from may have been evicted since — writing into a
            // destroyed Y.Doc would drop the summary silently.
            const live = this.resolveRoom(docId);
            if (!live) return;
            setThreadSummary(live.ydoc, t.id, summary);
            this.saveToDisk(live);
          },
        });
      }
      // Put back what this sweep pulled in and did not need. A doc that had
      // work queued stays for now — `apply` is about to write to it — and the
      // idle sweep takes it later on the ordinary clock.
      if (!wasResident && queuedHere === 0) this.evictRoom(docId);
    }
    if (tasks.length > 0) {
      void summarizer
        .backfill(tasks, {
          ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
        })
        .then(({ attempted, stored }) => {
          console.log(`[summarize] backfill done: ${stored} stored of ${attempted} attempted`);
        })
        // Nothing observes this promise. Every throw inside `backfill` is
        // caught today, so this cannot fire — but it is one refactor away
        // from being an unhandled rejection on a fire-and-forget path.
        .catch((err) => {
          console.error('[summarize] backfill failed:', err instanceof Error ? err.message : err);
        });
    }
    return { queued: tasks.length, open, resolved };
  }

  /**
   * Store a summary that was generated on demand (REST route / MCP tool).
   * Same write and same persistence as the scheduled path — one way in, so
   * an on-demand summary cannot end up in the doc but not on disk.
   */
  applyThreadSummary(docId: string, threadId: string, summary: StoredSummary): Thread | null {
    const room = this.resolveRoom(docId);
    if (!room) return null;
    const t = setThreadSummary(room.ydoc, threadId, summary);
    if (t) this.saveToDisk(room);
    return t;
  }

  /**
   * Ask for a generated summary for one thread, if generation is configured.
   *
   * Reads the thread fresh at call time rather than capturing it: three
   * seconds of debounce is long enough for two more replies to land, and the
   * summary must describe the thread as it will be, not as it was.
   */
  private scheduleSummary(room: DocRoom, threadId: string): void {
    const summarizer = this.cfg.summarizer;
    if (!summarizer) return;
    // Tell the clients a generation was QUEUED — the synced marker is what
    // lets a card truthfully say "Generating summary…" for exactly the
    // activity that scheduled one. Written per schedule, not per doc,
    // because not all activity generates: share-visitor writes are gated
    // (`generate: false` never reaches this method) and must not pend.
    // Written only when enabled, so a key-less server promises nothing.
    if (summarizer.enabled) {
      const threadMap = (room.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).get(threadId);
      if (threadMap) {
        room.ydoc.transact(() => threadMap.set('summaryPendingTs', Date.now()));
      }
    }
    summarizer.schedule({
      docId: room.docId,
      threadId,
      getThread: () => this.getThread(room.docId, threadId),
      apply: (summary) => {
        // Writes into the SAME ydoc the browsers are synced to, so the new
        // lines appear on every open card without a reload.
        setThreadSummary(room.ydoc, threadId, summary);
        this.saveToDisk(room);
      },
    });
  }

  /** Shared SSE + workspace + webhook fan-out behind fireEvent /
   *  fireSuggestionEvent. Caller stamps `event`/`seq`/`doc` into payload. */
  private broadcastToRoom(room: DocRoom, payload: WebhookPayload): void {
    // ONE id per broadcast, stamped before the fan-out so every channel below
    // carries the same string. That is what lets a subscriber holding two of
    // these channels collapse the copies without having to guess from `seq`,
    // which is per-room AND per-server-epoch and therefore repeats after any
    // restart — a guess whose wrong answer is a comment silently swallowed.
    // See event-id.ts.
    payload.eid = newEventId();
    this.cfg.sse.broadcast(room.docId, payload);
    // A companion editor doc (openEditableFile) is the same FILE as its diff
    // member, opened for prose; the reviewer comments in whichever view they
    // are reading, and the agent watching the member never learned the
    // companion's id — nothing hands it back. So a companion's events ride
    // the member's own channel too. Same eid on every copy, so a watcher
    // holding both collapses them.
    const memberId = this.memberOfCompanion(room.docId);
    if (memberId) this.cfg.sse.broadcast(memberId, payload);
    // Double-broadcast on the REVIEW's channel — the `setId` a diff review or
    // folder bind stamps on each member — so an agent can watch ONE stream per
    // review instead of one per file.
    //
    // The REVIEW, and only the review. A doc filed on a workspace but
    // belonging to no review reaches the workspace's channel from here NEVER,
    // and an agent watching `ws:<workspaceId>` has no way to notice — silence
    // from a subscription you never made is indistinguishable from nobody
    // having commented. The workspace fan-out lives in server.ts's
    // `onDocRoomEvent`, which resolves `workspace.docIds` at broadcast time;
    // rooms.ts has no view of workspaces.
    const reviewId = reviewIdOf(room.meta);
    if (reviewId) {
      this.cfg.sse.broadcast(`ws~${reviewId}`, payload);
    }
    if (room.webhookUrl) {
      void this.cfg.webhooks.send(room.webhookUrl, payload);
    }
    this.cfg.onRoomEvent?.(room.docId, payload);
  }

  /**
   * Delete any private meta key a CONNECTED PEER writes into the doc.
   *
   * `initDocMeta` deliberately never puts sourceUrl / owner / workspaceRoot
   * / producedBy in the CRDT (they describe the host machine, and Yjs sync
   * is all-or-nothing), so a private key appearing in this map arrived over
   * a websocket — from a share visitor as easily as from Bryan's browser.
   * Left standing it is not merely noise: `getOrCreate` lifts private keys
   * out of a loaded `.ydoc` as LEGACY state, and a room with no sidecar —
   * every `ws:<id>` board room, every `task:<id>` body room, any doc never
   * bound to a file — has nothing to outvote it. On the next load
   * `hydrateFromDisk` would bind the room to the injected path, seed the
   * fragment with that file's bytes, and wire the debounced write-back.
   *
   * One-directional by construction: it can only remove keys the server
   * never writes, so its worst failure is a genuinely legacy doc that needs
   * an explicit re-bind — never a lost edit.
   */
  private guardPrivateMeta(room: DocRoom): void {
    const meta = room.ydoc.getMap('meta');
    meta.observe((event, tr) => {
      if (tr.origin === PRIVATE_META_GUARD_ORIGIN) return;
      const injected = Array.from(event.keysChanged).filter(
        (key) => isPrivateMetaKey(key) && meta.has(key),
      );
      if (injected.length === 0) return;
      room.ydoc.transact(() => {
        for (const key of injected) meta.delete(key);
      }, PRIVATE_META_GUARD_ORIGIN);
      console.error(
        `[rooms] ${room.docId}: dropped peer-written private meta key(s): ${injected.join(', ')}`,
      );
    });
  }

  /**
   * Revert any write to a SERVER_META_KEY that did not come from the server.
   *
   * Different repair from `guardPrivateMeta`, because the server DOES write
   * these keys into the CRDT: a bare delete would erase legitimate state, so
   * the guard restores each touched key from the in-memory mirror — which is
   * authoritative here by construction: it is populated from the loaded doc
   * before this observer attaches (`wireEvents` runs after `loadFromDisk`),
   * and every server write to these keys updates it in the same call.
   */
  private guardServerMeta(room: DocRoom): void {
    const meta = room.ydoc.getMap('meta');
    meta.observe((event, tr) => {
      if (tr.origin === CONTENT_REVISION_ORIGIN || tr.origin === PRIVATE_META_GUARD_ORIGIN) return;
      const touched = SERVER_META_KEYS.filter((key) => event.keysChanged.has(key));
      if (touched.length === 0) return;
      room.ydoc.transact(() => {
        for (const key of touched) {
          const want = room.meta[key];
          if (want === undefined) meta.delete(key);
          else meta.set(key, want);
        }
      }, PRIVATE_META_GUARD_ORIGIN);
      console.error(
        `[rooms] ${room.docId}: reverted peer write to server meta key(s): ${touched.join(', ')}`,
      );
    });
  }

  private wireEvents(room: DocRoom): void {
    room.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      // One hook, every writer. See `DocRoom.lastContentChangeAt` for why the
      // three pre-existing timestamps could not be used, and
      // `isAuthoringOrigin` for what counts as somebody working and why.
      if (isAuthoringOrigin(room, origin)) {
        room.lastContentChangeAt = Date.now();
        this.scheduleRevisionBump(room);
        // "The next edit resumes syncing" — see maybeRebindHome. No-op for
        // every doc that has a binding (or no pin), which is all of them
        // outside the hydration-parked state.
        this.maybeRebindHome(room);
      }
      this.saveToDisk(room);
    });
    this.guardPrivateMeta(room);
    this.guardServerMeta(room);
    // Code and diff docs have no prose fragment — the prose-fragment
    // auto-reanchor sweep below would find nothing and orphan every thread.
    // Run the flat-text twin instead: observe the raw `content` Y.Text and
    // re-anchor threads by snippet match. (Diff content is pinned to a
    // commit and normally never changes, but a reparse after data loss
    // re-seeds it, and the sweep re-anchors threads then.)
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      let codeReanchorTimer: ReturnType<typeof setTimeout> | null = null;
      content.observe((_event, tr) => {
        if (tr.origin === 'agent-reanchor') return;
        if (codeReanchorTimer) clearTimeout(codeReanchorTimer);
        codeReanchorTimer = setTimeout(() => {
          const res = prose.autoReanchorCodeDoc(room.ydoc);
          if (res.reanchored > 0 || res.stillOrphan > 0) {
            console.log(
              `[rooms] ${room.docId}: code re-anchor — ${res.reanchored} fixed, ${res.stillOrphan} orphaned`,
            );
          }
        }, REANCHOR_MS);
      });
      const initialCode = prose.autoReanchorCodeDoc(room.ydoc);
      if (initialCode.reanchored > 0) {
        console.log(
          `[rooms] ${room.docId}: on-load code re-anchored ${initialCode.reanchored} thread(s)`,
        );
      }
      return;
    }
    // Every prose change triggers a best-effort sweep that rebuilds
    // Y.RelativePositions for threads whose anchors no longer resolve
    // (e.g. the user split a block or re-typed the anchored text —
    // prosemirror can destroy the original Y.XmlText during those).
    // Debounced so a burst of keystrokes only does one sweep.
    const fragment = prose.getProseFragment(room.ydoc);
    let reanchorTimer: ReturnType<typeof setTimeout> | null = null;
    fragment.observeDeep((_events, tr) => {
      // A prose transaction whose origin is one of this room's live
      // websockets is a person typing in the browser editor — every
      // server-side writer stamps a string origin instead. That marker is
      // what stops set_doc_content from silently rewriting over them.
      if (
        typeof tr.origin === 'object' &&
        tr.origin !== null &&
        room.conns.has(tr.origin as FeedbackWs)
      ) {
        room.lastHumanEditAt = Date.now();
      }
      // Don't re-enter on our own re-anchor writes. NOTE: 'file-watch' must
      // NOT be skipped here — a disk reparse is exactly when anchors inside a
      // rewritten block break, and this sweep is what recovers them. Adding
      // 'file-watch' to this guard (to match the write-back observer's) would
      // silently break reparse recovery.
      if (tr.origin === 'agent-reanchor') return;
      if (reanchorTimer) clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(() => {
        const res = prose.autoReanchorDoc(room.ydoc);
        if (res.reanchored > 0) {
          console.log(`[rooms] ${room.docId}: auto-reanchored ${res.reanchored} thread(s)`);
        }
      }, REANCHOR_MS);
    });
    // Docs seeded from disk before the heading-level fix persisted `level` as
    // a string, which makes Tiptap render every heading as <h1>. Repair them
    // on load so an existing doc doesn't need a reparse to render correctly.
    const fixed = prose.normalizeHeadingLevels(room.ydoc);
    if (fixed > 0) {
      console.log(`[rooms] ${room.docId}: normalized ${fixed} legacy string heading level(s)`);
    }
    // Also sweep once on room load so threads recover after server
    // restart even if no new edits happen.
    const initial = prose.autoReanchorDoc(room.ydoc);
    if (initial.reanchored > 0) {
      console.log(`[rooms] ${room.docId}: on-load auto-reanchored ${initial.reanchored} thread(s)`);
    }
  }

  private pathFor(docId: string): string {
    // keep docId simple; validate in API layer
    return join(this.cfg.dataDir, `${docId}.ydoc`);
  }

  private loadFromDisk(docId: string, ydoc: Y.Doc): void {
    const path = this.pathFor(docId);
    if (!existsSync(path)) return;
    try {
      const buf = readFileSync(path);
      Y.applyUpdate(ydoc, new Uint8Array(buf));
    } catch (err) {
      console.error(`[rooms] failed to load ${docId}:`, err);
    }
  }

  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private saveToDisk(room: DocRoom): void {
    const prev = this.saveTimers.get(room.docId);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(
      room.docId,
      setTimeout(() => {
        this.saveTimers.delete(room.docId);
        this.persistRoomNow(room);
      }, PERSIST_MS),
    );
  }

  private persistRoomNow(room: DocRoom): void {
    try {
      const update = Y.encodeStateAsUpdate(room.ydoc);
      const path = this.pathFor(room.docId);
      writeFileSync(path, update);
      // We are the only writer of this file, so recording the mtime here is
      // what lets `withActivity` stop stat-ing every doc on every list.
      try {
        this.activityMtime.set(room.docId, Math.round(statSync(path).mtimeMs));
      } catch {
        this.activityMtime.delete(room.docId);
      }
      // The sidecar rides the SAME debounced write as the `.ydoc`. Two
      // persistence paths would eventually disagree, and a doc whose
      // sourceUrl went missing stops writing back to disk silently —
      // the failure mode this whole change must not introduce.
      writePrivateMeta(this.cfg.dataDir, room.docId, room.meta);
      // And the listing row, for the same reason and in the same write. A
      // board asks "what is this called, which workspace, how many threads
      // are open" far more often than it asks for a document, and none of
      // those answers needs the CRDT decoded. Written here so the index
      // cannot describe a state the `.ydoc` was never in.
      const entry = this.indexEntryFor(room);
      writeDocIndex(this.cfg.dataDir, room.docId, entry);
      this.docIndex.set(room.docId, entry);
    } catch (err) {
      console.error(`[rooms] failed to persist ${room.docId}:`, err);
    }
  }

  /** The doc's listing row, built from the live room. */
  private indexEntryFor(room: DocRoom): DocIndexEntry {
    const threads = listThreads(room.ydoc);
    let lastThreadActivityAt: number | undefined;
    let open = 0;
    for (const t of threads) {
      if (t.status === 'open') open++;
      for (const c of t.comments) {
        if (lastThreadActivityAt === undefined || c.ts > lastThreadActivityAt) {
          lastThreadActivityAt = c.ts;
        }
      }
    }
    // The ydoc save runs at 200ms and the file write-back at 800ms, so a
    // pending write-back is always visible from here. See `DocIndexEntry`.
    const pendingFileWrite =
      this.fileBindings.get(room.docId)?.writeTimer != null ||
      this.failedFileWrites.has(room.docId);
    return {
      v: DOC_INDEX_VERSION,
      // A copy, not the live object: `room.meta` keeps being mutated and the
      // entry must describe this write.
      meta: { ...room.meta },
      threads: { open, total: threads.length },
      ...(lastThreadActivityAt !== undefined ? { lastThreadActivityAt } : {}),
      ...(pendingFileWrite ? { pendingFileWrite: true } : {}),
    };
  }

  /**
   * Synchronously run every pending debounced write — the 200ms `.ydoc`
   * persist and the ~800ms bound-file write-back — so a graceful shutdown
   * keeps the keystrokes that were still inside a debounce window. bin.ts
   * routes SIGTERM (what the deploy path sends) through `handle.stop()`,
   * which calls this; without it SIGTERM measured identical content loss to
   * SIGKILL. This is a last-resort save on the way down, NOT a deploy gate —
   * the deploy's refusal logic stays on `pendingFileWrites`.
   */
  flush(): void {
    // Settle revision debounces FIRST: the commit writes CRDT meta, which
    // schedules the very saves the passes below persist. After a restart the
    // counter is all that remains of an edit burst — the in-memory clocks are
    // deliberately not durable.
    for (const room of this.rooms.values()) this.commitRevisionBump(room);
    // A write-back can re-arm a timer while flushing (the reconcile guard's
    // conflict path re-schedules the flush it just consumed), so sweep until
    // quiescent — bounded, so a wedged binding cannot loop forever.
    for (let pass = 0; pass < 3; pass++) {
      const saves = [...this.saveTimers.entries()];
      const writes = [...this.fileBindings.entries()].filter(([, b]) => b.writeTimer);
      if (saves.length === 0 && writes.length === 0) break;
      for (const [docId, timer] of saves) {
        clearTimeout(timer);
        this.saveTimers.delete(docId);
        const room = this.rooms.get(docId);
        if (room) this.persistRoomNow(room);
      }
      for (const [docId, binding] of writes) {
        if (!binding.writeTimer) continue;
        clearTimeout(binding.writeTimer);
        binding.writeTimer = null;
        const room = this.rooms.get(docId);
        if (room) this.writeBoundFileNow(room, binding);
      }
    }
  }
}
