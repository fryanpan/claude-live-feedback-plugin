/**
 * The board registry: creating, naming, retiring and deleting a workspace,
 * who holds its lead seat, and which docs are linked to it.
 *
 * Split out of `tasks.ts` because none of it is about a task row. What it
 * needs from the store — the workspace map, the debounced writers, the
 * sidecar files, the event bus — arrives through `WorkspaceStorePersistence`
 * rather than through a `this` that reaches the whole store, so the seam is
 * a list you can read instead of a class you have to trust.
 *
 * The type imports below point back at `tasks.ts` and are erased at build
 * time; nothing here imports a VALUE from it, which is what keeps the two
 * files from forming a runtime cycle. The pure retired/name helpers live
 * here for the same reason: `task-agents.ts` needs them and cannot import
 * the file that imports it.
 */

import type { Task, TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { cryptoId } from './task-fields.ts';
import { AUTHOR_REQUIRED_MESSAGE, isCategoryAuthor } from './task-owner.ts';
import type {
  GoalRow,
  HubWorkspace,
  RenameWorkspaceResult,
  RetiredNotice,
  SameNamedWorkspace,
  SetLeadAgentResult,
  SetWorkspaceRetiredResult,
  WorkspaceLeadChangedEvent,
  WorkspaceRenamedEvent,
  WorkspaceRetiredChangedEvent,
  WorkspaceState,
} from './tasks.ts';

/**
 * The three rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose: the whole union would let this
 * file emit anything the board can say, which is the reach the split exists
 * to take away. Assignable INTO `TaskStoreEvent`, so the store forwards it
 * without a cast.
 */
export type WorkspaceStoreEvent =
  | WorkspaceLeadChangedEvent
  | WorkspaceRenamedEvent
  | WorkspaceRetiredChangedEvent;

/**
 * Is this board stood down? The single reader of `retiredAt`, so the
 * absent/false/0 question is answered in one place rather than at each of the
 * dozen enumeration sites that now ask it.
 */
export function isRetired(workspace: HubWorkspace): boolean {
  return workspace.retiredAt !== undefined;
}

/** The reason clause, or empty — factored out so the refusal and the notice
 *  can never disagree about whether there was one. */
function retiredBecause(workspace: HubWorkspace): string {
  return workspace.retiredReason ? ` Reason given: ${workspace.retiredReason}.` : '';
}

/**
 * Why a write to a retired board was refused, written to land verbatim in an
 * agent's context. It names the board, replays the operator's reason, and
 * states the two ways forward — because a refusal an agent cannot act on
 * produces a retry loop or a giving-up, and both look like the tool is broken.
 */
export function retiredRefusal(workspace: HubWorkspace): string {
  return (
    `"${workspace.name}" (${workspace.id}) is RETIRED and is not taking new work.` +
    `${retiredBecause(workspace)} Nothing on it was deleted — every task, doc and thread ` +
    'is still there to read. File this on the board that replaced it, or un-retire this ' +
    'one first if it is the live board after all.'
  );
}

/** What an agent reading or attaching to a retired board is told. */
export function retiredNotice(workspace: HubWorkspace): RetiredNotice {
  return {
    since: workspace.retiredAt ?? 0,
    ...(workspace.retiredReason ? { reason: workspace.retiredReason } : {}),
    notice:
      `This board is RETIRED — it is not ranked and takes no new work.${retiredBecause(workspace)} ` +
      'Everything on it survives and is readable; if this is the board you meant to work, ' +
      'un-retire it before filing anything.',
  };
}

/**
 * The key two board names are THE SAME under.
 *
 * Case and surrounding whitespace are not how a person tells two boards
 * apart, so a warning that only fired on an exact byte match would miss
 * `Harbor-Relay` beside `harbor-relay` — which is the same lost night with a
 * shift key involved.
 */
export function normalizeWorkspaceName(name: string): string {
  return name.trim().toLowerCase();
}

/** The workspace rows a board delete or rename touches, named so this file
 *  never reaches past them into the rest of the store. Every row handed back
 *  is LIVE — mutated in place, then handed to `scheduleSave`. */
export interface WorkspaceStorePersistence {
  state(workspaceId: string): WorkspaceState | undefined;
  states(): Iterable<WorkspaceState>;
  register(workspaceId: string, state: WorkspaceState): void;
  forget(workspaceId: string): void;
  /** Drop the deleted board's rows from the store's lookup indexes. */
  forgetRows(taskIds: Iterable<string>, goalIds: Iterable<string>): void;
  scheduleSave(workspaceId: string): void;
  scheduleAttachmentsSave(workspaceId: string): void;
  /** Cancel this board's debounced writes and say which were pending, so a
   *  delete that then refuses can re-arm exactly the ones it stopped. */
  cancelPendingSaves(workspaceId: string): { tasks: boolean; attachments: boolean };
  /** Remove the tasks sidecar — the resurrection source. `false` means the
   *  file is still there and the delete must refuse. */
  removeTasksSidecar(workspaceId: string): boolean;
  /** Remove every OTHER per-workspace file. Failures are litter, not lies,
   *  so this reports nothing and the delete stands. */
  removeSidecars(workspaceId: string): void;
  getTask(taskId: string): Task | undefined;
  getGoalRow(goalId: string): GoalRow | undefined;
  hasLiveLeadAttachment(workspaceId: string): boolean;
  emit(event: WorkspaceStoreEvent): void;
}

/** The board registry. One per `TaskStore`, holding no state of its own. */
export class WorkspaceStore {
  constructor(private readonly p: WorkspaceStorePersistence) {}

  createWorkspace(name: string, opts?: { leadAgentId?: string }): HubWorkspace {
    const now = Date.now();
    const lead = opts?.leadAgentId?.trim();
    const workspace: HubWorkspace = {
      id: cryptoId('w'),
      name,
      goals: [],
      docIds: [],
      // The creating agent is the lead by default. No event: nothing is
      // subscribed to a workspace that did not exist a line ago.
      ...(lead ? { leadAgentId: lead, leadAgentSince: now } : {}),
      createdAt: now,
    };
    this.p.register(workspace.id, {
      workspace,
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map(),
    });
    this.p.scheduleSave(workspace.id);
    return workspace;
  }

  getWorkspace(id: string): HubWorkspace | undefined {
    return this.p.state(id)?.workspace;
  }

  /**
   * How many of a board's tasks are still open — the guard `deleteWorkspace`
   * applies, exposed so a caller can check it BEFORE doing work the refusal
   * would waste (the route tears down rooms first). `null` when there is no
   * such board, which is a different answer from zero.
   */
  openTaskCount(workspaceId: string): number | null {
    const state = this.p.state(workspaceId);
    if (!state) return null;
    return Array.from(state.tasks.values()).filter((t) => t.status !== 'done').length;
  }

  /**
   * Remove a hub workspace and everything this store holds for it.
   *
   * Guarded by open tasks the way `DocStore.deleteWorkspace` is guarded by open
   * threads: the mistake to make hard is discarding a board somebody is
   * working, and a bare id with no confirmation is exactly the call an agent
   * makes by accident. `force` is the deliberate override, and the refusal
   * carries the count so the caller does not have to go and look.
   *
   * Deletion has to reach DISK, not just the map: the sidecar is
   * authoritative on hydrate, so an in-memory-only delete looks completely
   * successful until the next restart brings the board back. The events log
   * goes with it — an audit trail for a board nobody can see is a file that
   * only grows.
   *
   * Returns the task ids so the caller can tear down each one's body room;
   * this store owns no rooms and deliberately does not reach into them.
   */
  deleteWorkspace(
    workspaceId: string,
    opts?: { force?: boolean },
  ):
    | { ok: true; deletedTasks: number; taskIds: string[] }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'has-open-tasks'; openTasks: number }
    | { ok: false; error: 'persist-failed' } {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'not-found' };

    const taskIds = Array.from(state.tasks.keys());
    if (!opts?.force) {
      const openTasks = this.openTaskCount(workspaceId) ?? 0;
      if (openTasks > 0) return { ok: false, error: 'has-open-tasks', openTasks };
    }

    // Cancel pending writes BEFORE removing the files, or a debounced save
    // still in flight recreates the sidecar milliseconds after the delete
    // reports success.
    const cancelled = this.p.cancelPendingSaves(workspaceId);
    // If the delete goes on to refuse, the workspace stays live and those
    // writes are still owed. Nothing else would re-arm them until the next
    // mutation, so the edits inside the debounce window would be lost at the
    // next restart — a cancelled save is only free when the delete succeeds.
    const restorePendingWrites = () => {
      if (cancelled.tasks) this.p.scheduleSave(workspaceId);
      if (cancelled.attachments) this.p.scheduleAttachmentsSave(workspaceId);
    };

    // The tasks sidecar is the resurrection source, so it comes off FIRST and
    // its failure is the whole operation's failure. Reporting success with
    // that file intact would promise a deletion the next restart undoes —
    // silently, and hours later. Nothing in memory has changed yet at this
    // point, so refusing here leaves a coherent board rather than a half-
    // deleted one. (The cancelled save is the cost: at most one debounce
    // window of unwritten changes, which the next mutation reschedules.)
    if (!this.p.removeTasksSidecar(workspaceId)) {
      restorePendingWrites();
      return { ok: false, error: 'persist-failed' };
    }

    // Leak hygiene, and deliberately NOT load-bearing for the goal half:
    // `getGoalRow` re-reads the workspace map, so a stale entry there already
    // resolves to undefined and no caller can observe the difference. What it
    // prevents is the index growing without bound across a server's lifetime
    // of board deletes. Said plainly because a test cannot tell this line from
    // its absence — the one below pins the lookup CONTRACT, not this sweep.
    this.p.forgetRows(taskIds, state.goalRows.keys());
    this.p.forget(workspaceId);

    // None of these can resurrect the board, so a failure here is litter
    // rather than a lie — log it and let the delete stand. The list is every
    // OTHER per-workspace path this file exports; a new sidecar belongs here
    // the day it is added, or it becomes a file nothing can reach.
    this.p.removeSidecars(workspaceId);
    return { ok: true, deletedTasks: taskIds.length, taskIds };
  }

  listWorkspaces(): HubWorkspace[] {
    return Array.from(this.p.states()).map((s) => s.workspace);
  }

  /**
   * Stand a board down, or bring it back. The REVERSIBLE middle between a
   * live board and `deleteWorkspace`.
   *
   * Nothing is written but this one field, and that is the design rather than
   * an economy: the tasks sidecar is serialized wholesale, so the retirement
   * rides along with everything it holds and un-retiring is a second write of
   * the same field. There is no staging directory, no rename, no file to
   * restore from — which means there is nothing that can half-fail and leave
   * a board neither retired nor live.
   *
   * What retirement CHANGES is small and enumerable: the board stops ranking
   * on the workspace list (it folds into a labelled, counted `Retired`
   * section rather than vanishing — a cut list states what it cut), it
   * refuses new tasks, and it says so on read and on attach. Everything
   * already on it stays readable and its in-flight tasks stay transitionable,
   * because freezing those would strand whatever was running when somebody
   * retired the board and the only exit would be un-retiring it — which is
   * the ambiguity the feature exists to remove.
   */
  setWorkspaceRetired(
    workspaceId: string,
    retired: boolean,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetWorkspaceRetiredResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    // Already in the requested state: report it and stamp nothing. Restamping
    // `retiredAt` would move the "since" every surface reports, so a second
    // retire — which an agent re-running a cleanup makes by accident — would
    // rewrite the board's history to say it was stood down just now.
    if (isRetired(workspace) === retired) return { ok: true, workspace, changed: false };

    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const ts = Date.now();
    // Cleared to `undefined` rather than deleted, which is the same thing to
    // every reader here: `isRetired` and the projection both test `!==
    // undefined`, and `JSON.stringify` drops an undefined-valued key entirely,
    // so the sidecar holds no `retiredAt` at all and hydrate reads it as live.
    // What must NOT happen is writing `null` — that is a present value and
    // would read as retired forever.
    const reason = retired ? opts.reason?.trim() : undefined;
    workspace.retiredAt = retired ? ts : undefined;
    workspace.retiredBy = retired ? actor : undefined;
    workspace.retiredReason = reason ? reason : undefined;
    this.p.scheduleSave(workspaceId);
    this.p.emit({
      type: 'workspace.retired_changed',
      workspaceId,
      retired,
      ...(retired && workspace.retiredReason ? { reason: workspace.retiredReason } : {}),
      actor,
      ts,
    });
    return { ok: true, workspace, changed: true };
  }

  /**
   * Rename a board.
   *
   * `createWorkspace` set the name once and nothing changed it, so two boards
   * could carry one name forever — and a name is how an agent picks. This is
   * the other half of the fix: retiring stands the stale one down, renaming
   * tells the two apart while both are live.
   *
   * The rename is not gated on uniqueness. Refusing a duplicate would block
   * the legitimate middle of a cleanup (rename A, then rename B) and would
   * not undo the duplicates already on disk. Instead the result NAMES the
   * boards that now share the name, so a caller that collided finds out from
   * the call rather than from a lost night.
   */
  renameWorkspace(
    workspaceId: string,
    name: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RenameWorkspaceResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    const next = name.trim();
    if (next.length === 0) return { ok: false, error: 'empty-name' };

    const sameName = this.liveWorkspacesNamed(next, { exclude: workspaceId });
    if (next === workspace.name) {
      return { ok: true, workspace, changed: false, ...(sameName.length > 0 ? { sameName } : {}) };
    }
    const oldName = workspace.name;
    workspace.name = next;
    this.p.scheduleSave(workspaceId);
    this.p.emit({
      type: 'workspace.renamed',
      workspaceId,
      oldName,
      name: next,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      ts: Date.now(),
    });
    return { ok: true, workspace, changed: true, ...(sameName.length > 0 ? { sameName } : {}) };
  }

  /**
   * Every LIVE board carrying this name, minus one. Retired boards are
   * deliberately not counted: standing a duplicate down is exactly the fix,
   * so counting it would leave the operator doing the right thing and being
   * told nothing changed.
   */
  private liveWorkspacesNamed(name: string, opts: { exclude: string }): SameNamedWorkspace[] {
    const key = normalizeWorkspaceName(name);
    const out: SameNamedWorkspace[] = [];
    for (const state of this.p.states()) {
      const ws = state.workspace;
      if (ws.id === opts.exclude || isRetired(ws)) continue;
      if (normalizeWorkspaceName(ws.name) === key) out.push({ workspaceId: ws.id, name: ws.name });
    }
    return out;
  }

  /**
   * Hand the board's lead-agent seat to `leadAgentId`. Reassignment is a
   * first-class operation rather than a side effect of attaching, because
   * "who is responsible" outlives any one session: the agent that holds it
   * may be away, and the next goal edit still has an addressee.
   */
  setLeadAgent(
    workspaceId: string,
    leadAgentId: string,
    opts: { actor: { id: string; name: string; kind?: string }; takeover?: boolean },
  ): SetLeadAgentResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    const next = leadAgentId.trim();
    // The seat must route somewhere REAL — this method is the addressing
    // authority for every lead-addressed delivery (queued voice notes, goal
    // re-triage, bucket and task reviews), and it used to accept ANY trimmed
    // string. A typo'd or fabricated id took the seat and the queue silently
    // stopped draining: nothing anywhere reported that the addressee did not
    // exist. Checked FIRST, before the same-id no-op, so '' can never equal
    // anything — it used to trim to '' and be assigned.
    if (next.length === 0) {
      return {
        ok: false,
        error: 'empty-lead-agent-id',
        message: 'leadAgentId is empty — the lead seat needs a real agent id.',
      };
    }
    // The seat routes deliveries to SOMEBODY. The shared category — as the
    // proposed holder or as the caller — is nobody in particular, and a seat
    // held by it is exactly the state this refusal was written against
    // (one live board, lead seat "known-agent", 1,031 unattributed rows).
    if (isCategoryAuthor({ id: next }) || isCategoryAuthor(opts.actor)) {
      return { ok: false, error: 'author-required', message: AUTHOR_REQUIRED_MESSAGE };
    }
    if (next === workspace.leadAgentId) return { ok: true, workspace, changed: false };
    // Naming a THIRD PARTY is a deliberate handover, and a handover needs an
    // addressee this workspace has a record of. The record is the attachments
    // map: an agent that attached and went AWAY is still in it (recovering a
    // dead session's seat is a supported flow — dead sessions do not detach),
    // while an id nobody ever attached is not. SELF-declaration is exempt by
    // definition — `next === actor.id` is a real, live caller, and the
    // bootstrap order must not matter (older bundles declare before they
    // attach; the store cannot assume attach came first).
    if (next !== opts.actor.id && !state.attachments.has(next)) {
      return {
        ok: false,
        error: 'unknown-lead-agent',
        message:
          `no agent "${next}" has ever attached to this workspace — a lead the board has ` +
          'no record of would receive none of the deliveries addressed to the seat. ' +
          'Name an agent that has attached here, or have that agent declare itself lead.',
      };
    }
    const previousLeadAgentId = workspace.leadAgentId;
    /**
     * DO NOT let an agent quietly take a seat somebody LIVE is sitting in.
     *
     * `attachAgent` refuses this on purpose — "an occupied seat is a standing
     * decision and a second agent attaching is not a reassignment" — and
     * `set_workspace_lead` had no such guard, which was survivable while it
     * meant "hand the board to a named peer" and became a hazard the moment
     * the skills started telling every session to declare itself at startup.
     * The displaced lead keeps its watch and its attachment, is told nothing
     * it acts on, and simply never receives the re-triage it was waiting for;
     * the declaring agent cannot tell a takeover from an empty seat, because
     * `changed: true` is the same answer for both.
     *
     * Narrow on purpose. It fires only when an agent is claiming the seat FOR
     * ITSELF (a declaration) — naming a third party is a deliberate handover
     * and keeps its old meaning exactly. And only against a LIVE incumbent: a
     * dead session's seat is exactly what a new lead should be able to
     * recover, which is most of why declaring works at all.
     */
    if (
      previousLeadAgentId !== undefined &&
      previousLeadAgentId !== next &&
      next === opts.actor.id &&
      opts.takeover !== true &&
      this.p.hasLiveLeadAttachment(workspaceId)
    ) {
      return { ok: true, workspace, changed: false, previousLeadAgentId, declined: 'lead-held' };
    }
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // Its own operation, so its own moment — nothing else in this call is
    // stamped, and there is no sibling clock for it to disagree with.
    this.assignLead(state, next, actor, Date.now());
    return {
      ok: true,
      workspace,
      changed: true,
      ...(previousLeadAgentId !== undefined ? { previousLeadAgentId } : {}),
    };
  }

  /** The seat change itself, shared by `setLeadAgent` and the attach-time
   *  claim so both persist and announce it identically.
   *
   *  `ts` is the CALLER's, and passing it is not a style choice. A seat claim
   *  emits `workspace.lead_changed`, which is a non-`agent.*` row, so
   *  `noteObservedWork` observes it and stamps the actor's work clock with
   *  this exact `ts`. When the caller is `attachAgent`, that work clock and
   *  the attachment's `lastHeartbeat` are the SAME fact — one operation, one
   *  moment — and a `Date.now()` taken here instead landed a millisecond
   *  later, pushing `lastToolCallAt` past `lastHeartbeat` and breaking the
   *  "a new attachment's two clocks are equal" contract on ~1 run in 37.
   *
   *  So the parameter is required rather than defaulted: a future third
   *  caller has to say which moment this seat change belongs to, and cannot
   *  re-read the wall clock by omission. */
  assignLead(state: WorkspaceState, leadAgentId: string, actor: TaskActor, ts: number): void {
    const workspace = state.workspace;
    const oldLeadAgentId = workspace.leadAgentId;
    workspace.leadAgentId = leadAgentId;
    workspace.leadAgentSince = ts;
    this.p.scheduleSave(workspace.id);
    this.p.emit({
      type: 'workspace.lead_changed',
      workspaceId: workspace.id,
      ...(oldLeadAgentId !== undefined ? { oldLeadAgentId } : {}),
      leadAgentId,
      actor,
      ts,
    });
  }

  /** Link an existing doc or review to a hub workspace. A link only — the
   *  doc's own metadata and URLs are untouched (nothing is migrated). */
  attachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true } | { ok: false; error: 'workspace-not-found' } {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    if (!state.workspace.docIds.includes(docId)) {
      state.workspace.docIds.push(docId);
      this.p.scheduleSave(workspaceId);
    }
    return { ok: true };
  }

  /** Unlink a doc from a hub workspace. `removed` distinguishes "it was
   *  linked and now isn't" from "it was never linked" — the caller filing a
   *  doc out of the holding-pen workspace needs to know whether anything
   *  actually moved before it refreshes a projection. */
  detachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true; removed: boolean } | { ok: false; error: 'workspace-not-found' } {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const i = state.workspace.docIds.indexOf(docId);
    if (i === -1) return { ok: true, removed: false };
    state.workspace.docIds.splice(i, 1);
    this.p.scheduleSave(workspaceId);
    return { ok: true, removed: true };
  }

  /**
   * The hub workspace this docId belongs to for SHARE-SCOPE purposes, or
   * null (§3.12 commit 8): a doc linked via attachDoc, or a task's own body
   * room (`task:<taskId>`). Deliberately NOT the `ws:<id>` board room — its
   * share allowance is explicit in host-guard, so granting the board stays
   * a decision rather than a resolver side effect. Also deliberately not
   * transitive: attachDoc can link a whole review (diff review) by
   * its review id, and this resolver does not widen to that review's
   * member docs.
   */
  workspaceOfDoc(docId: string): string | null {
    if (docId.startsWith('task:')) {
      // A `task:` room is a TASK's body or a GOAL's — one prefix, two kinds of
      // row (see `ensureGoalBody` in task-projection.ts). Asking only
      // `getTask` answered null for every goal, and null here is not a
      // harmless miss: it is what the back-link, the review URL and SHARE
      // SCOPING resolve against, so a goal's description opened with no way
      // back to its board and a share visitor was refused it outright.
      const rowId = docId.slice('task:'.length);
      return (this.p.getTask(rowId) ?? this.p.getGoalRow(rowId))?.workspaceId ?? null;
    }
    for (const state of this.p.states()) {
      if (state.workspace.docIds.includes(docId)) return state.workspace.id;
    }
    return null;
  }
}
