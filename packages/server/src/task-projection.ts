import { listThreads, prose } from '@feedback/core';
import * as Y from 'yjs';
import type { Rooms } from './rooms.ts';
import type { Task, TaskStore, TaskStoreEvent } from './tasks.ts';

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
 * evidence commit hashes, token usage, goal text, and verbatim quote/answer
 * fields. AgentAttachment records never enter any ydoc.
 */

/** Yjs transaction origin for every projection write. Anything else
 *  touching the projected maps is foreign and gets reverted. */
export const PROJECTION_ORIGIN = 'task-projection';

/** The workspace board room's docId. */
export function workspaceRoomId(workspaceId: string): string {
  return `ws:${workspaceId}`;
}

/** The docId of a task's live body room. */
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
): Record<string, unknown> {
  return {
    id: task.id,
    ...(commentCount > 0 ? { commentCount } : {}),
    workspaceId: task.workspaceId,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    ...(task.needs !== undefined ? { needs: task.needs } : {}),
    // Options and info-requests are workspace CONTENT — the board's decision
    // strip and its batch walkthrough render straight off this projection, so
    // withholding them would be the store-has-it/surface-can't-show-it bug by
    // construction. Everything in a workspace is available to everyone in it.
    ...(task.options !== undefined ? { options: task.options } : {}),
    ...(task.infoRequests !== undefined ? { infoRequests: task.infoRequests } : {}),
    goal: task.goal,
    order: task.order,
    after: task.after,
    ...(task.afterEnforce !== undefined ? { afterEnforce: task.afterEnforce } : {}),
    ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}),
    links: task.links,
    ...(task.origin !== undefined ? { origin: task.origin } : {}),
    ...(task.quote !== undefined ? { quote: task.quote } : {}),
    ...(task.answer !== undefined ? { answer: task.answer } : {}),
    ...(task.triagedAgainst !== undefined ? { triagedAgainst: task.triagedAgainst } : {}),
    ...(task.triagePendingTs !== undefined ? { triagePendingTs: task.triagePendingTs } : {}),
    ...(task.riskTier !== undefined ? { riskTier: task.riskTier } : {}),
    transitions: task.transitions.map((t) => ({
      ts: t.ts,
      from: t.from,
      to: t.to,
      by: { name: t.by.name, kind: t.by.kind },
      ...(t.note !== undefined ? { note: t.note } : {}),
      ...(t.evidence !== undefined ? { evidence: t.evidence } : {}),
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
    })),
    bodyDocId: taskBodyDocId(task.id),
    ...projectBody(task.body),
    createdAt: task.createdAt,
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
      const taskIds = this.tasks.listTasks(ws.id).map((t) => t.id);
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
   * Make the workspace's board room exist, guarded, and current. Safe to
   * call repeatedly — server.ts calls it from the create/attach routes
   * (which mutate the store without emitting events) and `onEvent` calls it
   * for everything else.
   */
  ensureWorkspace(workspaceId: string): void {
    const ws = this.tasks.getWorkspace(workspaceId);
    if (!ws) return;
    const room = this.rooms.getOrCreate(workspaceRoomId(workspaceId), {
      type: 'workspace',
      title: ws.name,
    });
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
      for (const t of this.tasks.listTasks(workspaceId)) this.ensureTaskBody(t);
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
    const room = this.rooms.getOrCreate(workspaceRoomId(workspaceId), {
      type: 'workspace',
      title: ws.name,
    });
    const tasksMap = room.ydoc.getMap('tasks');
    const wsMap = room.ydoc.getMap('workspace');
    const want = new Map(
      this.tasks.listTasks(workspaceId).map((t) => [t.id, projectTask(t, this.commentCount(t.id))]),
    );
    const pending = this.tasks.getPendingRetriage(workspaceId);
    const wsFields: Record<string, unknown> = {
      id: ws.id,
      name: ws.name,
      goal: ws.goal,
      goalUpdatedAt: ws.goalUpdatedAt,
      // The ≤20-word display line. Conditional for the same reason the lead
      // is: the refresh deletes projected keys absent from this object, so
      // clearing the summary in the store must clear it on every open board
      // rather than leaving the last one rendered forever.
      ...(ws.goalSummary !== undefined ? { goalSummary: ws.goalSummary } : {}),
      goals: ws.goals,
      docIds: ws.docIds,
      // Who is responsible for this board. Conditional, never `undefined`:
      // the refresh deletes projected keys that aren't in this object, so an
      // absent lead removes the key and the surface renders the vacancy
      // instead of a stale name. An agentId is not host-machine-describing —
      // it already rides agent.attached on the visitor-facing SSE feed.
      ...(ws.leadAgentId !== undefined ? { leadAgentId: ws.leadAgentId } : {}),
      ...(ws.leadAgentSince !== undefined ? { leadAgentSince: ws.leadAgentSince } : {}),
      // A goal edit nobody has picked up yet. Projected so the board can SAY
      // it is waiting — an undelivered request that only exists in a sidecar
      // is the store-has-it/surface-can't-show-it failure by construction.
      // Trimmed to what the strip renders: no actor id (display name only),
      // and no goal text, which the board already carries in full.
      ...(pending
        ? {
            pendingRetriage: {
              batchId: pending.batchId,
              taskIds: pending.taskIds,
              ts: pending.ts,
              byName: pending.actor.name,
            },
          }
        : {}),
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
    const room = this.rooms.getOrCreate(docId, { type: 'markdown', title: task.title });
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
  private commentCount(taskId: string): number {
    const room = this.rooms.get(taskBodyDocId(taskId));
    if (!room) return 0;
    return listThreads(room.ydoc).reduce((n, t) => n + t.comments.length, 0);
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
    const taskId = taskIdOfBodyDoc(docId);
    if (!taskId) return;
    try {
      const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      if (!this.tasks.updateBodySnapshot(taskId, md)) return;
      // The board renders the description from the projection, and
      // `updateBodySnapshot` deliberately fires no task.* event (body typing
      // is not board activity) — so without this push nothing would ever
      // refresh it and every board would show the description as of task
      // creation, forever. `refresh` is diff-aware, so an unchanged body
      // costs an empty transaction.
      const workspaceId = this.tasks.getTask(taskId)?.workspaceId;
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
