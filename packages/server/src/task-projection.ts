import { decodeEntities, listThreads, prose, readTaskReviewItem } from '@feedback/core';
import type { TaskReviewItem } from '@feedback/core';
import * as Y from 'yjs';
import { TASK_NOTES_READ_CAP } from './agent-notes.ts';
import type { Rooms } from './rooms.ts';
import {
  type OwnerKind,
  attachedAgentResolver,
  attachedAgentTest,
  resolveOwnerKind,
} from './task-owner.ts';
import type { PremiseNote } from './task-staleness.ts';
import {
  type AttachmentState,
  type GoalRow,
  type Task,
  type TaskStore,
  type TaskStoreEvent,
  type WorkspaceSubgoal,
  goalStatusMeta,
  taskAskedBy,
} from './tasks.ts';

/**
 * The session behind a task's owner: which one, when it was last heard from,
 * when it was last seen working, and what bundle it runs.
 *
 * Deliberately NOT the whole attachment. `endpoint` is host-machine data that
 * never leaves REST unredacted, and the rest is noise for the question this
 * answers — so the shape is the answer rather than the record.
 */
export interface OwnerSession {
  agentId: string;
  /** Last time the session SAID it was alive. */
  lastHeartbeat: number;
  /** Last time the server SAW it do something. The pair disagreeing is the
   *  usage-limit outage signature — one field cannot show it. */
  lastToolCallAt: number;
  state: AttachmentState;
  stateLabel: string;
  pluginVersion?: string;
}

/**
 * The session that TOOK a row, and when — the question `OwnerSession` cannot
 * answer.
 *
 * `ownerSession` is keyed on the owner, and `task_transition` never touches
 * `assignee`: a session that pulls a row off the queue and works it for hours
 * leaves the owner field exactly as it found it. So on 2026-08-17 two sessions
 * built two complete answers to the same ticket while every owner-keyed read
 * of that row honestly answered "nobody". This reads the other half — the
 * actor on the row's most recent move INTO `in-progress`, matched against the
 * board's roster.
 *
 * Same shape as `OwnerSession` plus `at`, and named field by field for the
 * same reason: `endpoint` is host-machine data that a spread would carry onto
 * every queue row the moment somebody adds a field.
 *
 * What it does NOT claim: that the session is still working THIS row. It says
 * a named session took it at a known moment and how recently the server has
 * seen that session at all. The reader decides what to do about it — this is
 * one-directional by construction and nothing here refuses a second taker.
 */
export interface ClaimSession extends OwnerSession {
  /** When the claim was made — the row's latest transition into in-progress. */
  at: number;
}

/**
 * Ydoc projection of the hub task store (plan §3.3).
 *
 * The sidecar-backed TaskStore is the source of truth for everything the
 * system is accountable for; the `ws:<workspaceId>` room's `tasks` and
 * `workspace` Y.Maps are a PROJECTION of it so the board renders in
 * realtime. Two rules make "only the server writes" true rather than
 * aspirational (§3.3, ultrareview):
 *
 *  - The server observes both maps and REVERTS any transaction whose Yjs
 *    origin is not its own (`PROJECTION_ORIGIN`). A client write — buggy or
 *    malicious — is reasserted away, and NO task.* event fires for it:
 *    events originate exclusively from store mutations, never from map
 *    observation.
 *  - On hydrate the sidecar is authoritative: the ws room's .ydoc persists
 *    like any doc room, and `init()` reasserts the projection from the
 *    store after load, so a crash can't leave forged or stale board state
 *    standing.
 *
 * Task BODIES are EDITED in a deliberate exception to "tasks live in the
 * store": each body is a live collaborative doc in its own `task:<taskId>`
 * room (no file binding), which is what makes every existing edit tool,
 * thread store, REST route, and SSE event apply unchanged (they're all
 * keyed by docId). The store's `body` string is a debounced SNAPSHOT of
 * that room — a snapshot never re-seeds a live fragment, so fragment
 * identity (and every thread anchor in it) survives projection refreshes
 * and restarts.
 *
 * That snapshot IS projected (capped, see BODY_PROJECTION_LIMIT). It was
 * not, originally, and the cost was that a task read as a bare title and
 * "what is this for" meant navigating to a second page — the
 * store-has-it/surface-can't-show-it failure this codebase has hit before.
 * Note what this widens: the ws room syncs to workspace-share visitors, and
 * Yjs is a state exchange with no per-connection projection, so a
 * description is now readable by anyone holding a workspace share.
 *
 * What the ws room syncs is otherwise the §3.3 visitor-contract list:
 * titles, status, order, transitions with actor DISPLAY names (no ids),
 * token usage, goal text, and verbatim quote/answer
 * fields. AgentAttachment records never enter any ydoc.
 */

/** Yjs transaction origin for every projection write. Anything else
 *  touching the projected maps is foreign and gets reverted. */
export const PROJECTION_ORIGIN = 'task-projection';

/** The workspace board room's docId. */
export function workspaceRoomId(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

/**
 * The docId of a task's live body room.
 *
 * DECIDED, so nobody has to re-derive it: `task:<taskId>` is a RESERVED
 * PATTERN, not an alias and not a caller-chosen doc id. The `task:` and `ws:`
 * prefixes belong to the server, and everything after the prefix is an
 * already-opaque generated id (`t-…`, `w-…`) — so the address inherits its
 * opacity from the task rather than needing an identity of its own. There is
 * nothing here for a readable-alias layer to protect: no person bookmarks a
 * body room, it is derived on demand from a task the reader already has, and
 * it changes only when the task itself ceases to exist.
 *
 * What that settles, deliberately: a body room never gets a second, prettier
 * name, so the alias layer that generated DOC ids need does not extend here.
 * `isHubOwnedRoom` (rooms.ts) is already the prefix authority; making the
 * prefixes unwritable by an outside caller belongs with the doc-id half of
 * this work, and is noted there rather than claimed here.
 */
export function taskBodyDocId(taskId: string): string {
  return `task:${taskId}`;
}

/** taskId ⇦ its body room docId (inverse of taskBodyDocId). */
/** The task a body docId belongs to, or null if the docId isn't one.
 *  One spelling of "not found" — callers that hold a body room and callers
 *  handed an arbitrary docId ask the same question and read the same answer. */
export function taskIdOfBodyDoc(docId: string): string | null {
  return docId.startsWith('task:') ? docId.slice('task:'.length) : null;
}

/**
 * How much of a description the board projection carries.
 *
 * A task body is a live doc anyone can paste a plan into, and the ws room
 * re-syncs to every board viewer on every debounced snapshot — so an
 * uncapped body makes the board's sync cost proportional to the longest
 * thing anyone ever pasted. Past the cap the panel shows the head and says
 * so; the doc link carries the rest. The cap is on the PROJECTION only: the
 * store keeps the whole body.
 */
export const BODY_PROJECTION_LIMIT = 4_000;

/** The projected slice of a body, plus the flag that keeps the truncation
 *  honest on the surface. */
function projectBody(body: string | undefined): {
  body?: string;
  bodyTruncated?: boolean;
} {
  const text = body?.trim();
  if (!text) return {};
  if (text.length <= BODY_PROJECTION_LIMIT) return { body: text };
  return { body: text.slice(0, BODY_PROJECTION_LIMIT), bodyTruncated: true };
}

/** The ticket's review items, normalized, or nothing at all. Absent rather
 *  than empty: `refresh` deletes projected keys missing from the object, so an
 *  empty array would be a key every board carries forever saying nothing. */
function projectReviews(reviews: TaskReviewItem[] | undefined): {
  reviews?: TaskReviewItem[];
} {
  if (!reviews || reviews.length === 0) return {};
  const rows: TaskReviewItem[] = [];
  for (const raw of reviews) {
    const item = readTaskReviewItem(raw);
    if (item) rows.push(item);
  }
  return rows.length > 0 ? { reviews: rows } : {};
}

/**
 * The agent's own one-liners on the row, NEWEST FIRST and capped at
 * `TASK_NOTES_READ_CAP` — the pane reads "what did this agent do lately",
 * and a row worked for a week has more history than any pane wants. Display
 * fields only: the session id stays in the store, like actor ids do on
 * transitions. Absent when there are none, so a row without notes projects
 * exactly as it did before the field existed.
 */
function projectNotes(notes: Task['notes']): { notes?: Record<string, unknown>[] } {
  if (!notes || notes.length === 0) return {};
  return {
    notes: notes
      .slice(-TASK_NOTES_READ_CAP)
      .reverse()
      .map((n) => ({ at: n.ts, kind: n.kind, text: n.text, agent: n.agent })),
  };
}

/** The plain-JSON shape of one task inside the `tasks` Y.Map — the §3.3
 *  visitor-contract fields, stated here so it's a decision, not an
 *  accident. No actor ids (display names only); the body is the capped
 *  snapshot, and the live one stays in its own room. */
export function projectTask(
  task: Task,
  /**
   * How many comments the task's discussion holds. Lives outside `Task`
   * because the discussion lives in the task's body ROOM, not in the store —
   * but the row has to say a discussion exists, or the only way to find one
   * is to open every task.
   */
  commentCount = 0,
  /**
   * Person, agent, or nobody-has-said — resolved by the SERVER, because half
   * the evidence is the workspace's agent roster and that never enters a
   * ydoc. Deriving it in the browser would give a share visitor a different
   * answer from the owner's, and the review strip is one shared read of the
   * workspace: its count has to be the same number for every reader.
   *
   * Omitted by the one caller that legitimately cannot know (the SSE event
   * redactor, which holds a task and no workspace). Every reader treats an
   * absent value as `unknown`, which is what it is.
   */
  ownerKind?: OwnerKind,
  /**
   * The owner's roster id, resolved by the server for the same reason as
   * `ownerKind`: the roster never enters a ydoc. Defaults to what the row
   * stored; the projection loop passes the read-time resolution so rows
   * older than the field, and rows whose id was merged away, carry the
   * surviving id.
   */
  assigneeId: string | undefined = task.assigneeId,
): Record<string, unknown> {
  return {
    id: task.id,
    ...(commentCount > 0 ? { commentCount } : {}),
    workspaceId: task.workspaceId,
    // Decoded here because this is the board's ONLY source of task titles, and
    // the browser renders every one of them through `textContent` — so a
    // caller that stored "Decisions &amp; open questions" reaches the screen
    // with the entity intact. It matters beyond the row: the Home queue builds
    // its DECISION items in the browser, off these projected titles rather
    // than off `GET /review-items`, so a title left raw here is a review row
    // with a raw entity in it however carefully the REST queue normalizes its
    // own. See `decodeEntities` — one pass, so a deliberate `&amp;amp;` still
    // shows as `&amp;`.
    title: decodeEntities(task.title),
    // The title above is a placeholder; the board draws the row as empty and
    // focuses its title field. Conditional like every flag here, so naming
    // the row removes the key from the projection.
    ...(task.untitled ? { untitled: true } : {}),
    status: task.status,
    assignee: task.assignee,
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(ownerKind !== undefined ? { ownerKind } : {}),
    ...(task.needs !== undefined ? { needs: task.needs } : {}),
    // Options and info-requests are workspace CONTENT — the board's decision
    // strip and its batch walkthrough render straight off this projection, so
    // withholding them would be the store-has-it/surface-can't-show-it bug by
    // construction. Everything in a workspace is available to everyone in it.
    ...(task.options !== undefined ? { options: task.options } : {}),
    ...(task.infoRequests !== undefined ? { infoRequests: task.infoRequests } : {}),
    // The ticket's review items — 0..n, each with its own blurb above its own
    // options. Beside `options`/`answer` rather than instead of them: nothing
    // is replaced and nothing is purged, so every surface reading the legacy
    // fields keeps reading them. Read through the loose reader so a row
    // corrupted on disk drops out here instead of reaching a renderer that
    // never touched this ticket. The DERIVED legacy row is deliberately absent
    // — the browser already has `options`/`answer` on this same object, and
    // projecting both spellings would list one decision twice.
    ...projectReviews(task.reviews),
    goal: task.goal,
    order: task.order,
    after: task.after,
    ...(task.afterEnforce !== undefined ? { afterEnforce: task.afterEnforce } : {}),
    ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}),
    // Soft-deleted, by whom, and why. Conditional like everything else here,
    // and the refresh deletes projected keys absent from this object — so a
    // RESTORE removes the keys and the row rejoins its lane with nothing
    // having to clear a flag. This is the field the browser filters lanes on.
    ...(task.archivedAt !== undefined ? { archivedAt: task.archivedAt } : {}),
    ...(task.archivedBy !== undefined ? { archivedBy: task.archivedBy } : {}),
    ...(task.archiveReason !== undefined ? { archiveReason: task.archiveReason } : {}),
    links: task.links,
    ...(task.origin !== undefined ? { origin: task.origin } : {}),
    ...(task.quote !== undefined ? { quote: task.quote } : {}),
    ...(task.answer !== undefined ? { answer: task.answer } : {}),
    // Narrowed to the declared shape, never spread: the pre-fix writer
    // stamped the ENTIRE workspace goal text into this marker, and 187 rows
    // on the live hub board still carry ~3KB each — 546KB of the board ydoc
    // shipped to every reader on every open. The store
    // keeps whatever the sidecar recorded; the wire gets { goalId, ts } —
    // same precedent as `evidence` two fields down.
    ...(task.triagedAgainst !== undefined
      ? { triagedAgainst: { goalId: task.triagedAgainst.goalId, ts: task.triagedAgainst.ts } }
      : {}),
    // Nobody has named this task's band, and since when. Projected so the
    // board and the queue can say the sentence out loud without new plumbing
    // — a field only the store can see is the "flag nobody renders" bug.
    ...(task.unplacedSince !== undefined ? { unplacedSince: task.unplacedSince } : {}),
    transitions: task.transitions.map((t) => ({
      ts: t.ts,
      from: t.from,
      to: t.to,
      by: { name: t.by.name, kind: t.by.kind },
      ...(t.note !== undefined ? { note: t.note } : {}),
      // `evidence` and `amendments` are deliberately NOT projected. Evidence
      // support was removed 2026-08-25: the store still holds what older
      // transitions recorded, and no surface reads it.
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
    })),
    ...projectNotes(task.notes),
    bodyDocId: taskBodyDocId(task.id),
    ...projectBody(task.body),
    createdAt: task.createdAt,
    // Who filed it, already resolved through the one reader the derived
    // review item uses — so the Home card (built in the browser off this
    // row) and the REST queue say the same name. Omitted when nothing is
    // known, and the card states the clock alone rather than a guess.
    ...(taskAskedBy(task) !== '' ? { createdBy: taskAskedBy(task) } : {}),
    // The effort model's two numbers, and the measured attention behind one
    // of them. Projected because the GOAL BAR is computed in the browser
    // (`@feedback/core/goal-effort`): the board already holds every row and
    // its trail over this ydoc, so the bar and the finish date recompute the
    // instant an estimate lands, with no fetch and no second implementation
    // of the arithmetic to keep in step with this one.
    //
    // Conditional, like every other optional key here, and that is the whole
    // contract rather than a style rule. Both fields are documented on `Task`
    // as absent-means-not-measured, never zero; projecting `{ totalSeconds: 0 }`
    // for a ticket nobody has read, or a zeroed estimate for one nobody has
    // scored, would erase that distinction at the last step before the screen.
    // `refresh` deletes projected keys absent from this object, so an estimate
    // that is later withdrawn takes its key with it.
    //
    // The FAILED variant is projected too, in full. A row that says "we tried
    // and got nothing" is a different thing to show than a row that was never
    // scored, and the board can only draw the difference if the difference
    // reaches it.
    ...(task.effortEstimate !== undefined ? { effortEstimate: task.effortEstimate } : {}),
    ...(task.readingTime !== undefined ? { readingTime: task.readingTime } : {}),
    updatedAt: task.updatedAt,
  };
}

export class TaskProjection {
  private rooms: Rooms;
  private tasks: TaskStore;
  private snapshotDebounceMs: number;
  /**
   * The DOC a workspace's revert guard is wired to — keyed to the ydoc, not
   * to the workspaceId. `rooms.getOrCreate` hands back a NEW Y.Doc whenever
   * the room is no longer in the map (a `DELETE /api/docs/ws:<id>` drops
   * it), and a workspaceId-keyed "already wired" set then skips observing
   * the replacement: from that moment the board accepts and KEEPS arbitrary
   * client writes, silently, until the process restarts.
   */
  private wired = new Map<string, Y.Doc>();
  /** Same identity rule for body rooms: docId → the ydoc whose snapshot
   *  observer is wired. A recreated room re-arms rather than going quiet. */
  private bodyWired = new Map<string, Y.Doc>();
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void) | null = null;

  constructor(opts: { rooms: Rooms; tasks: TaskStore; snapshotDebounceMs?: number }) {
    this.rooms = opts.rooms;
    this.tasks = opts.tasks;
    this.snapshotDebounceMs = opts.snapshotDebounceMs ?? 300;
  }

  /** Wire everything up. Order matters on hydrate: the rooms have already
   *  loaded whatever the .ydoc files held, so reasserting from the store
   *  here is what makes the sidecar authoritative for gated fields. */
  init(): void {
    this.recoverInterruptedDeletes();
    this.off = this.tasks.onEvent((ev) => this.onEvent(ev));
    for (const ws of this.tasks.listWorkspaces()) this.ensureWorkspace(ws.id);
  }

  /**
   * Undo the staging half of a delete that the process didn't live to
   * finish.
   *
   * A workspace delete renames its room files aside before committing, so a
   * crash in that window leaves the state in `<docId>.ydoc.deleting` — which
   * hydration deliberately skips. Left alone, the body room would come back
   * EMPTY on the next `getOrCreate`, and the only copy of the task's
   * discussion would sit in a file nothing reads.
   *
   * The board's continued existence is the discriminator, and it is the
   * reason this lives here rather than in Rooms: a staged file whose board
   * is GONE is the opposite case — post-commit litter, where restoring
   * would resurrect a room belonging to nothing. So this restores only for
   * boards the store still has, and it runs before anything opens a room.
   */
  private recoverInterruptedDeletes(): void {
    for (const ws of this.tasks.listWorkspaces()) {
      // Archived rows included: an archived task still OWNS a room file, and
      // a recovery that skipped it would leave that file staged forever with
      // nothing left to notice.
      const taskIds = this.tasks.listTasks(ws.id, { includeArchived: true }).map((t) => t.id);
      this.unstageWorkspaceFiles(ws.id, taskIds);
    }
  }

  /** Flush pending body snapshots and unsubscribe. Call before the store's
   *  own stop() so the last keystrokes reach the sidecar. */
  stop(): void {
    this.off?.();
    this.off = null;
    for (const [docId, timer] of this.snapshotTimers) {
      clearTimeout(timer);
      this.snapshotNow(docId);
    }
    this.snapshotTimers.clear();
  }

  private onEvent(ev: TaskStoreEvent): void {
    this.ensureWorkspace(ev.workspaceId);
    if (ev.type === 'task.created') this.ensureTaskBody(ev.task);
  }

  /**
   * The owner-kind reader the BOARD uses, for a route that wants to answer
   * the same question over REST.
   *
   * Agents cannot read the ydoc projection, so without this the resolved
   * kind is visible only in a browser — and an agent that declares an owner
   * has no way to confirm the declaration landed, nor to ask which rows the
   * board is drawing as "not recorded". A success response means "the call
   * didn't error"; this is what makes it mean something.
   *
   * Returns a closure so the workspace's roster is read ONCE per request
   * rather than once per row.
   */
  ownerKindReader(workspaceId: string): (task: Task) => OwnerKind {
    const attached = this.tasks.listAttachments(workspaceId).map((a) => a.agentId);
    const isAttachedAgent = attachedAgentTest(attached);
    // The same roster, read by ID: an owner typed under a spelling only the
    // identity roster knows (a merged-away name, a display name the
    // attachment id shares nothing with) is still the attached agent when
    // both resolve to one id.
    const attachedIds = new Set(attached.map((id) => this.tasks.resolveAgentId(id) ?? id));
    return (task) => {
      const ownerId = this.tasks.ownerIdOf(task);
      return resolveOwnerKind(
        task.assignee,
        task.assigneeKind,
        (name) => isAttachedAgent(name) || (ownerId !== undefined && attachedIds.has(ownerId)),
      );
    };
  }

  /**
   * WHICH session holds this task, and what is known about it right now.
   *
   * The sibling of `ownerKindReader` and built the same way — one roster read
   * per request, closed over. That one answers what an owner IS; this one
   * answers who they ARE, which is the question a "last seen" line needs and
   * the one the board could not previously reach: the owner is a display name
   * and the attachment is an identity id, so the two never met.
   *
   * Fields are named one at a time rather than spread from the attachment.
   * `endpoint` is a host-machine fact with its own redaction rule
   * (`publicAttachment`), and a spread would carry it into every board read
   * the moment somebody adds a field — the private-meta lesson. An explicit
   * allow-list cannot leak a field that did not exist when it was written.
   *
   * Returns undefined for an owner no attachment vouches for, which includes
   * every person and every reserved owner. Absent means "no session to
   * name" — never "away", and never a guess.
   */
  ownerSessionReader(workspaceId: string): (task: Task) => OwnerSession | undefined {
    const attachments = this.tasks.listAttachments(workspaceId);
    const resolve = attachedAgentResolver(attachments);
    const byId = new Map(
      attachments.map((a) => [this.tasks.resolveAgentId(a.agentId) ?? a.agentId, a] as const),
    );
    return (task) => {
      const ownerId = this.tasks.ownerIdOf(task);
      const att = resolve(task.assignee) ?? (ownerId !== undefined ? byId.get(ownerId) : undefined);
      if (!att) return undefined;
      return {
        agentId: att.agentId,
        lastHeartbeat: att.lastHeartbeat,
        lastToolCallAt: att.lastToolCallAt,
        state: att.state,
        stateLabel: att.stateLabel,
        ...(att.pluginVersion !== undefined ? { pluginVersion: att.pluginVersion } : {}),
      };
    };
  }

  /**
   * WHO TOOK this row, from the row's own history rather than from its owner.
   *
   * Built like its two siblings — one roster read per request, closed over —
   * and keyed on the identity id directly, because a transition actor IS an
   * agent id (the MCP child attaches and transitions under one identity).
   * No display-name reconciliation is needed or wanted here: matching a
   * transition actor loosely would attribute a claim to the wrong session,
   * and a confident wrong name is worse than silence.
   *
   * Only `in-progress` rows, and only the LATEST claim: a row handed back and
   * retaken belongs to whoever took it last. Returns undefined when no
   * attachment vouches for the claimant — an actor the board has no record of
   * is a name, not a session, and this may only ever report sessions.
   */
  claimSessionReader(workspaceId: string): (task: Task) => ClaimSession | undefined {
    const roster = new Map(
      this.tasks.listAttachments(workspaceId).map((att) => [att.agentId, att]),
    );
    return (task) => {
      if (task.status !== 'in-progress') return undefined;
      let claim: Task['transitions'][number] | undefined;
      for (const t of task.transitions) if (t.to === 'in-progress') claim = t;
      if (!claim) return undefined;
      const att = roster.get(claim.by.id);
      if (!att) return undefined;
      return {
        agentId: att.agentId,
        lastHeartbeat: att.lastHeartbeat,
        lastToolCallAt: att.lastToolCallAt,
        state: att.state,
        stateLabel: att.stateLabel,
        at: claim.ts,
        ...(att.pluginVersion !== undefined ? { pluginVersion: att.pluginVersion } : {}),
      };
    };
  }

  /**
   * Make the workspace's board room exist, guarded, and current. Safe to
   * call repeatedly — server.ts calls it from the create/attach routes
   * (which mutate the store without emitting events) and `onEvent` calls it
   * for everything else.
   */
  ensureWorkspace(workspaceId: string): void {
    const ws = this.tasks.getWorkspace(workspaceId);
    if (!ws) return;
    const room = this.rooms.getOrCreate(
      workspaceRoomId(workspaceId),
      { type: 'workspace', title: ws.name },
      // The `ws:` namespace is the server's; the projection is the server.
      { authority: 'server' },
    );
    if (this.wired.get(workspaceId) !== room.ydoc) {
      this.wired.set(workspaceId, room.ydoc);
      const guard = (_events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
        if (tr.origin === PROJECTION_ORIGIN) return;
        // A foreign transaction touched server-owned state (client writes
        // arrive with their websocket as the origin). Revert by reasserting
        // from the store. No task.* event fires — events come from store
        // mutations only, so a forged write is invisible to subscribers.
        this.refresh(workspaceId);
      };
      room.ydoc.getMap('tasks').observeDeep(guard);
      room.ydoc.getMap('workspace').observeDeep(guard);
      // Re-arm body rooms after a restart: state hydration ≠ binding
      // hydration, and without this the snapshot observer would be silently
      // missing on every rehydrated task room.
      // Archived rows included — an archived task's discussion is still
      // readable, and its body room has to be armed to stay that way.
      for (const t of this.tasks.listTasks(workspaceId, { includeArchived: true })) {
        this.ensureTaskBody(t);
      }
    }
    this.refresh(workspaceId);
  }

  /** Every room this projection owns for a workspace: the board, plus one
   *  body room per task. The caller passes the ids because after the board
   *  is deleted the store can no longer enumerate them. */
  private workspaceRoomIds(workspaceId: string, taskIds: string[]): string[] {
    return [...taskIds.map(taskBodyDocId), workspaceRoomId(workspaceId)];
  }

  /**
   * Move every room file a workspace owns out of the way, reversibly, and
   * report whether they all moved.
   *
   * This is the pre-commit half of the teardown, and it is staged rather
   * than deleted because the two failure modes pull in opposite directions:
   *  - orphan `.ydoc`s must not outlive the board (once the store entry is
   *    gone the id no longer resolves as a board, so nothing can come back
   *    for them, and they reload on every restart);
   *  - but a body room is NOT derived state — it holds the task's discussion
   *    threads, which live nowhere else — so a delete that goes on to FAIL
   *    must be able to give everything back, including after a restart that
   *    lands in the middle.
   * A rename satisfies both. Unlinking satisfies only the first: a live
   * room's state re-reaches disk on its next write, which may never come.
   *
   * Ask about the FILE, not the room: `deleteDoc` logs a failed unlink and
   * still returns ok, and on a retry it answers 'not-found' without going
   * near the disk, because the first attempt took the room out of memory.
   */
  stageWorkspaceFiles(workspaceId: string, taskIds: string[]): { ok: boolean } {
    let ok = true;
    for (const docId of this.workspaceRoomIds(workspaceId, taskIds)) {
      if (!this.rooms.stagePersisted(docId)) ok = false;
    }
    return { ok };
  }

  /** Put every staged room file back — the delete didn't commit. Runs over
   *  the whole set, including ids that never staged, because a partial
   *  failure leaves a partial staging. */
  unstageWorkspaceFiles(workspaceId: string, taskIds: string[]): void {
    for (const docId of this.workspaceRoomIds(workspaceId, taskIds)) {
      this.rooms.unstagePersisted(docId);
    }
  }

  /**
   * Tear the live rooms down. DESTRUCTIVE — a body room's threads are gone
   * after this — so call it only once the board is out of the store, i.e.
   * once the delete has actually committed and nothing can still refuse.
   *
   * Cancel each snapshot timer BEFORE its room goes: a debounced snapshot
   * firing afterwards would try to write body text back into a task that no
   * longer exists. `deleteDoc` re-purges the persisted file, which covers
   * anything a live room rewrote between the purge above and here.
   */
  dropWorkspaceRooms(workspaceId: string, taskIds: string[]): void {
    for (const taskId of taskIds) {
      const docId = taskBodyDocId(taskId);
      const timer = this.snapshotTimers.get(docId);
      if (timer) clearTimeout(timer);
      this.snapshotTimers.delete(docId);
      this.bodyWired.delete(docId);
    }
    this.wired.delete(workspaceId);
    for (const docId of this.workspaceRoomIds(workspaceId, taskIds)) {
      // force: a task body's discussion threads are part of what's being
      // deleted, so open ones are not a reason to refuse here — the refusal
      // that matters (open TASKS) already happened, before any of this.
      this.rooms.deleteDoc(docId, { force: true });
      // deleteDoc unlinks the LIVE path, which covers anything a room
      // rewrote between the staging and here; the staged copy is the one
      // holding the state, and this is the point of no return for it.
      this.rooms.dropStaged(docId);
    }
  }

  /**
   * Reassert the projection from the store — diff-aware, so an in-sync map
   * is a no-op transaction and a foreign write is surgically overwritten.
   * Never touches task body rooms.
   */
  refresh(workspaceId: string): void {
    const ws = this.tasks.getWorkspace(workspaceId);
    if (!ws) return;
    const room = this.rooms.getOrCreate(
      workspaceRoomId(workspaceId),
      { type: 'workspace', title: ws.name },
      // The `ws:` namespace is the server's; the projection is the server.
      { authority: 'server' },
    );
    const tasksMap = room.ydoc.getMap('tasks');
    const wsMap = room.ydoc.getMap('workspace');
    // The workspace's own agent roster, read once per refresh. `onEvent`
    // funnels every store event through `ensureWorkspace`, and agent.attached
    // / agent.detached are store events — so the derived half of an owner's
    // kind re-projects the moment the roster moves, rather than going stale
    // until something unrelated touches a task.
    const ownerKindOf = this.ownerKindReader(workspaceId);
    // ARCHIVED ROWS ARE PROJECTED, deliberately, and the browser is what
    // leaves them out of the lanes (`taskVisible`). The alternative — dropping
    // them here — would mean the restore list, the ten-second Undo and the
    // "N archived" count all needed a REST round trip to draw something the
    // board already holds, and an archive would visibly evict the row from
    // under the toast offering to put it back.
    const want = new Map(
      this.tasks
        .listTasks(workspaceId, { includeArchived: true })
        .map((t) => [
          t.id,
          projectTask(t, this.commentCount(t.id), ownerKindOf(t), this.tasks.ownerIdOf(t)),
        ]),
    );
    // Each band rides out decorated with its goal ROW's status (and done
    // attribution), read through the store's public API. The board renders
    // bands from this array and nothing else, so a status only the store can
    // see would be the store-has-it/surface-can't-show-it bug for the very
    // field goal rows exist to record. Additive: a client that predates the
    // fields reads exactly the goals it read before.
    //
    // The row's OWNER rides the same way. No verb sets `GoalRow.assignee`
    // yet, so today every band goes out unowned — but the schema carries the
    // field ("the absence has to be representable so the surfaces can render
    // a vacancy"), the client draws an avatar for it, and a projection that
    // dropped it would break silently the day the first verb lands: the
    // store would say who owns the goal while the board kept saying nobody.
    // `ownerKind` resolves through the same roster rules a task's does; a
    // goal row declares no kind, so the roster and the reserved words decide.
    const isAttachedAgent = attachedAgentTest(
      this.tasks.listAttachments(workspaceId).map((a) => a.agentId),
    );
    const goalRows = this.tasks.listGoalRows(workspaceId);
    // A goal's DESCRIPTION and its discussion, projected the way a task's are.
    //
    // The room is brought into existence here rather than on a store event,
    // because there is no `goal.created` event to hang it on the way
    // `task.created` carries `ensureTaskBody` — and every goal write (the four
    // goals routes, the transition gate, hydrate) reaches this refresh, so
    // this is the one place that sees every goal that has ever existed.
    // Idempotent and cheap on the repeat: an existing room is a map hit and
    // an already-wired observer is a reference compare.
    //
    // `bodyDocId` is projected even when the body is empty, because it is the
    // ADDRESS — the panel mounts its editor on it and the discussion is
    // fetched from it, both of which have to work on a goal nobody has
    // described yet. That is the difference between a body and a body room.
    for (const r of goalRows) this.ensureGoalBody(r);
    const goalMeta = new Map(
      goalRows.map((r) => {
        const comments = this.commentCount(r.id);
        return [
          r.id,
          {
            ...goalStatusMeta(r),
            bodyDocId: taskBodyDocId(r.id),
            ...projectBody(r.body),
            ...(comments > 0 ? { commentCount: comments } : {}),
            ...(r.assignee !== undefined
              ? {
                  assignee: r.assignee,
                  ownerKind: resolveOwnerKind(r.assignee, undefined, isAttachedAgent),
                }
              : {}),
            // A band that has been archived rides out SAYING so, the way an
            // archived task does — projected rather than filtered here,
            // because the restore list is drawn from the same projection the
            // board is and a band the projection dropped could never be put
            // back. `boardSections` is the one place "off the board" is
            // applied, exactly as `taskVisible` is for a task.
            ...(r.archivedAt !== undefined
              ? {
                  archivedAt: r.archivedAt,
                  ...(r.archivedBy !== undefined ? { archivedBy: r.archivedBy } : {}),
                  ...(r.archiveReason !== undefined ? { archiveReason: r.archiveReason } : {}),
                  // And WHICH archive took it, when it went as part of a
                  // band's cascade. The restore list needs this to tell a
                  // subgoal somebody archived on its own — restorable, with
                  // its own tasks under it — from one that only went because
                  // its parent did, whose tasks carry the parent's marker and
                  // so come back only when the parent does.
                  ...(r.archivedWithGoal !== undefined
                    ? { archivedWithGoal: r.archivedWithGoal }
                    : {}),
                }
              : {}),
          },
        ];
      }),
    );
    const decorateSubgoal = (s: WorkspaceSubgoal) => ({ ...s, ...(goalMeta.get(s.id) ?? {}) });
    const wsFields: Record<string, unknown> = {
      id: ws.id,
      name: ws.name,
      goals: ws.goals.map((g) => ({
        ...g,
        ...(goalMeta.get(g.id) ?? {}),
        ...(g.subgoals !== undefined ? { subgoals: g.subgoals.map(decorateSubgoal) } : {}),
      })),
      docIds: ws.docIds,
      // Who is responsible for this board. Conditional, never `undefined`:
      // the refresh deletes projected keys that aren't in this object, so an
      // absent lead removes the key and the surface renders the vacancy
      // instead of a stale name. An agentId is not host-machine-describing —
      // it already rides agent.attached on the visitor-facing SSE feed.
      ...(ws.leadAgentId !== undefined ? { leadAgentId: ws.leadAgentId } : {}),
      ...(ws.leadAgentSince !== undefined ? { leadAgentSince: ws.leadAgentSince } : {}),
      // The board has been stood down. Conditional like the lead above and
      // for the same reason — the refresh deletes projected keys absent from
      // this object, so un-retiring removes the key and the badge goes away
      // without anything having to clear it.
      ...(ws.retiredAt !== undefined ? { retiredAt: ws.retiredAt } : {}),
      ...(ws.retiredReason !== undefined ? { retiredReason: ws.retiredReason } : {}),
      createdAt: ws.createdAt,
    };
    room.ydoc.transact(() => {
      for (const key of Array.from(tasksMap.keys())) {
        if (!want.has(key)) tasksMap.delete(key);
      }
      for (const [id, projected] of want) {
        if (!sameJson(tasksMap.get(id), projected)) tasksMap.set(id, projected);
      }
      for (const key of Array.from(wsMap.keys())) {
        if (!(key in wsFields)) wsMap.delete(key);
      }
      for (const [key, value] of Object.entries(wsFields)) {
        if (!sameJson(wsMap.get(key), value)) wsMap.set(key, value);
      }
    }, PROJECTION_ORIGIN);
  }

  /**
   * Make a task's live body room exist and keep the store snapshot fresh.
   * The room seeds ONCE from the stored snapshot — only while the fragment
   * is empty — so a restart rehydrates the .ydoc and the seed path stays
   * cold, preserving fragment identity and every thread anchor in it.
   */
  ensureTaskBody(task: Task): void {
    const docId = taskBodyDocId(task.id);
    const room = this.rooms.getOrCreate(
      docId,
      { type: 'markdown', title: task.title },
      // Likewise `task:` — a body room is minted here or nowhere.
      { authority: 'server' },
    );
    const fragment = prose.getProseFragment(room.ydoc);
    if (fragment.length === 0 && task.body?.trim()) {
      this.rooms.setDocContent(docId, task.body);
    }
    if (this.bodyWired.get(docId) !== room.ydoc) {
      this.bodyWired.set(docId, room.ydoc);
      fragment.observeDeep(() => this.scheduleSnapshot(docId));
    }
  }

  /**
   * The same, for a GOAL row — `task:<goalId>`, deliberately the same prefix.
   *
   * Settled in the approved design against the ticket's `goal:<goalId>`
   * proposal: goal ids are `g-…` and task ids are `t-…`, so one namespace
   * holds both without collision, and reusing the prefix is what makes every
   * piece of body machinery apply unchanged — `isHubOwnedRoom`, the prose edit
   * tools, the thread store, the SSE redactors, the doc routes. A second
   * prefix would have been an edit to each of them buying nothing a reader
   * could see.
   *
   * Shares `bodyWired`, and correctly: that map is keyed on docId, which is
   * the room's identity rather than the row's kind. Two rows cannot claim one
   * docId, so there is nothing for the two kinds to collide over.
   */
  ensureGoalBody(goal: GoalRow): void {
    const docId = taskBodyDocId(goal.id);
    const room = this.rooms.getOrCreate(
      docId,
      { type: 'markdown', title: goal.title },
      { authority: 'server' },
    );
    const fragment = prose.getProseFragment(room.ydoc);
    if (fragment.length === 0 && goal.body?.trim()) {
      this.rooms.setDocContent(docId, goal.body);
    }
    if (this.bodyWired.get(docId) !== room.ydoc) {
      this.bodyWired.set(docId, room.ydoc);
      fragment.observeDeep(() => this.scheduleSnapshot(docId));
    }
  }

  /**
   * Make a task's body room exist and hand back its docId — the entry point
   * for anything that wants to WRITE a body rather than react to one.
   *
   * Rooms are created lazily and re-armed by `ensureWorkspace`, so on a
   * process that hasn't served this workspace yet (i.e. after every deploy)
   * the room for a task nobody has opened does not exist, and a write aimed
   * straight at the doc comes back 'not-found' — which reads as "no such
   * task" to the caller.
   */
  ensureBodyRoom(task: Task): string {
    this.ensureTaskBody(task);
    return taskBodyDocId(task.id);
  }

  /**
   * Push the body room's text into the store snapshot NOW, instead of on the
   * debounce. A caller that rewrote a body and immediately reads the task
   * back (the MCP round trip does exactly this) would otherwise be handed
   * the pre-rewrite text and conclude the write failed.
   */
  flushBodySnapshot(taskId: string): void {
    const prev = this.snapshotTimers.get(taskBodyDocId(taskId));
    if (prev) clearTimeout(prev);
    this.snapshotTimers.delete(taskBodyDocId(taskId));
    this.snapshotNow(taskBodyDocId(taskId));
  }

  /**
   * How many comments the task's discussion holds, read from the body room
   * where they actually live. Zero when the room doesn't exist yet — the
   * common case, since a room is created lazily and an empty one has no
   * threads either way.
   */
  private commentCount(rowId: string): number {
    const room = this.rooms.get(taskBodyDocId(rowId));
    if (!room) return 0;
    return listThreads(room.ydoc).reduce((n, t) => n + t.comments.length, 0);
  }

  /**
   * Every comment on the task, flattened across threads — the discussion the
   * pickup path has always dropped.
   *
   * Reads from memory only, and that is sound rather than lucky: `Rooms`
   * hydrates every `.ydoc` under the data dir at construction, so a task
   * whose body room has ever held content is loaded. A room that genuinely
   * does not exist has no threads either, so the empty answer is the true
   * one rather than a miss.
   *
   * Resolved threads are included deliberately. "The premise moved, here is
   * what is actually true" is exactly the note somebody resolves after
   * acting on it, and dropping it would hide the corrections most likely to
   * have been confirmed.
   */
  discussionNotes(taskId: string): PremiseNote[] {
    const room = this.rooms.get(taskBodyDocId(taskId));
    if (!room) return [];
    const notes: PremiseNote[] = [];
    for (const thread of listThreads(room.ydoc)) {
      for (const c of thread.comments) {
        notes.push({ ts: c.ts, by: c.author?.name ?? 'unknown', text: c.text });
      }
    }
    return notes.sort((a, b) => a.ts - b.ts);
  }

  private scheduleSnapshot(docId: string): void {
    const prev = this.snapshotTimers.get(docId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(docId);
      this.snapshotNow(docId);
    }, this.snapshotDebounceMs);
    timer.unref?.();
    this.snapshotTimers.set(docId, timer);
  }

  private snapshotNow(docId: string): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    const rowId = taskIdOfBodyDoc(docId);
    if (!rowId) return;
    try {
      const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      // A GOAL's body lands in its own row. Tried task-first and goal-second
      // rather than branching on a `kind` lookup because that is the order the
      // ids make true: the two `updateBody*` calls are each a miss on the
      // other kind, so whichever answers is the row that exists.
      const goal = this.tasks.getGoalRow(rowId);
      if (goal) {
        if (!this.tasks.updateGoalBodySnapshot(rowId, md)) return;
        this.refresh(goal.workspaceId);
        return;
      }
      if (!this.tasks.updateBodySnapshot(rowId, md)) return;
      // The board renders the description from the projection, and
      // `updateBodySnapshot` deliberately fires no task.* event (body typing
      // is not board activity) — so without this push nothing would ever
      // refresh it and every board would show the description as of task
      // creation, forever. `refresh` is diff-aware, so an unchanged body
      // costs an empty transaction.
      const workspaceId = this.tasks.getTask(rowId)?.workspaceId;
      if (workspaceId) this.refresh(workspaceId);
    } catch (err) {
      console.error(`[projection] body snapshot failed for ${docId}:`, err);
    }
  }
}

/** JSON-compare a current map value (possibly a foreign-written Yjs type)
 *  against the projected plain object. */
function sameJson(current: unknown, next: unknown): boolean {
  const plain = current instanceof Y.AbstractType ? current.toJSON() : current;
  return JSON.stringify(plain) === JSON.stringify(next);
}
