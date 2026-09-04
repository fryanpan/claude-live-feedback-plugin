/**
 * What a session RECORDS about a row without changing it: the pinned
 * one-liner, the effort estimate a scoring run produced, the done-artifact
 * verdict, and reading time.
 *
 * Split out of `tasks.ts` with the other four verb families. The family is
 * defined by what it does NOT do rather than by the shape of its records:
 * with the single exception of
 * `appendNote` — which emits `task.noted` so the board re-projects and the
 * actor's work clock moves — nothing here emits a store event and nothing
 * here bumps `updatedAt`. That is deliberate and it is the same reason four
 * times over: an observation ABOUT a ticket must not read as progress ON it,
 * or attention and machine bookkeeping would keep resetting the staleness
 * clock and the ready-nudger's idle clock. Keeping them together is what
 * makes that rule one reading instead of four comments.
 */
import { agentIdForName } from '@feedback/core';
import type {
  ArtifactCheck,
  Task,
  TaskEffortEstimate,
  TaskNote,
  TaskReadingTime,
} from '@feedback/core/task-wire';
import { TASK_NOTES_STORE_CAP } from '@feedback/core/task-wire';
import { wordsRevisionOf } from './task-fields.ts';
import type { TaskNotedEvent } from './tasks.ts';

/** What a note verb may reach in the store. Every row handed back is LIVE —
 *  mutated in place, then handed to `scheduleSave`. */
export interface TaskNotesPersistence {
  getTask(taskId: string): Task | undefined;
  scheduleSave(workspaceId: string): void;
  emit(event: TaskNotedEvent): void;
}

/** The quiet records. One per `TaskStore`, holding no state of its own. */
export class TaskNotesStore {
  constructor(private readonly p: TaskNotesPersistence) {}

  /**
   * Pin an agent's one-liner to a row. No status change and no gate: the
   * note records what the session said or was refused, not where the row
   * is. Bounded at `TASK_NOTES_STORE_CAP` from the old end, emitted as
   * `task.noted` so the board re-projects, the audit log has it, and the
   * actor's work clock moves — but NOT broadcast on the workspace stream
   * (server.ts keeps it off), because one frame per turn would wake every
   * other attached agent.
   */
  appendNote(
    taskId: string,
    input: { kind: TaskNote['kind']; text: string; agent: string; ts: number; sessionId?: string },
  ): { ok: true; task: Task; note: TaskNote } | { ok: false; error: 'not-found' } {
    // Tasks only: `resolveNoteTarget` never hands this a goal row, and a
    // goal's trail is its children's, not a session's one-liners.
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const note: TaskNote = {
      ts: input.ts,
      kind: input.kind,
      text: input.text,
      agent: input.agent,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    const notes = task.notes ?? [];
    notes.push(note);
    if (notes.length > TASK_NOTES_STORE_CAP) notes.splice(0, notes.length - TASK_NOTES_STORE_CAP);
    task.notes = notes;
    const now = Date.now();
    task.updatedAt = now;
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.noted',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: agentIdForName(input.agent), name: input.agent, kind: 'agent' },
      kind: note.kind,
      text: note.text,
      ts: now,
    });
    return { ok: true, task, note };
  }

  // ── Review items ─────────────────────────────────────────────────────────

  /**
   * Record one scoring run's read on a ticket — a produced estimate or a
   * recorded failure. Quiet like `recordReadingTime`: no store event, no
   * `updatedAt` bump, and for the same class of reason — a score is
   * metadata ABOUT the ticket, not an edit OF it — plus one that reading
   * time does not have: scoring itself is triggered off `task.created` /
   * `task.retitled` / `task.body_edited` (server.ts), so a write here that
   * emitted one of those would re-trigger its own scorer forever.
   *
   * Refused as `stale` when the words (or the goal) this run read are no
   * longer the ticket's current words: `estimate.forWordsRevision` must
   * still equal the row's `wordsRevision`. Guards against a slow call
   * landing after a NEWER edit — or a re-triage to a different goal, which
   * changes the goal title the scorer weighed — already started (or
   * finished) its own re-score: that newer run's answer must stand, not be
   * overwritten by a late answer to older words or an old goal.
   *
   * ONE token, and a monotonic one. This used to compare the three
   * timestamps the estimate still carries — `forTitleWrittenAt` /
   * `forBodyWrittenAt` / `forGoal` against `titleWrittenAt` /
   * `bodyWrittenAt` / `goal` — and a millisecond is not fine enough to
   * separate a create from the rename that follows it: land both in one
   * tick and the older run's captured token still equals the row's current
   * one, the guard reads "not stale", and the stale answer wins. See
   * `forWordsRevision`. The timestamps are kept on the record as
   * provenance a person reads; they are no longer asked a question they
   * cannot answer.
   *
   * A record that somehow carries no revision at all compares `undefined`
   * against a number and is REFUSED, which is the safe direction: an
   * estimate whose provenance cannot be established must not overwrite one
   * whose provenance can.
   */
  recordEffortEstimate(
    taskId: string,
    estimate: TaskEffortEstimate,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' | 'stale' } {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (estimate.forWordsRevision !== wordsRevisionOf(task)) {
      return { ok: false, error: 'stale' };
    }
    task.effortEstimate = estimate;
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Record what the done-artifact check concluded about this row's links.
   *
   * Deliberately quiet on both clocks: no store event (§3.6's table is
   * exhaustive by contract, and a subscriber-visible event here would restart
   * the ready-nudger's idle clock on machine bookkeeping) and no `updatedAt`
   * bump (the row did not change in any sense a person acts on). The visible
   * half of a bad verdict is the system comment the checker posts on the
   * task's discussion, which rides the ordinary thread pipeline. Last write
   * wins: a row done twice keeps the latest check, which is the one that
   * matches its current claim.
   */
  recordArtifactCheck(
    taskId: string,
    result: ArtifactCheck,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    task.artifactCheck = result;
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Fold one interaction-bounded `read_session` into a task's cumulative
   * reading time. The LIVE path — called once per session flush, right
   * where the server already accepts the browser's `read_session` POST
   * (see `rooms.recordReadEvent` and its caller in server.ts).
   *
   * Quiet like `recordArtifactCheck` and for the identical reason: no store
   * event, no `updatedAt` bump. A person reading a ticket must not reset
   * its own staleness clock — that would let attention masquerade as
   * progress on the row.
   *
   * `deltaSeconds` is expected already server-clamped (`clampReadPayload`)
   * before it reaches here; a non-finite or non-positive value is a no-op
   * rather than an error, since it typically means the payload had nothing
   * to record instead of nothing found.
   */
  recordReadingTime(
    taskId: string,
    deltaSeconds: number,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return { ok: true, task };
    const prev = task.readingTime;
    task.readingTime = {
      totalSeconds: (prev?.totalSeconds ?? 0) + deltaSeconds,
      sessionCount: (prev?.sessionCount ?? 0) + 1,
      lastSessionAt: Date.now(),
    };
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Overwrite a task's `readingTime` with an already-computed total — the
   * RECONCILIATION path, used by `reading-time-backfill.ts` to fold in
   * `read_session` events that were live-captured (since #468) but never
   * rolled up onto the task record before this field existed. A full
   * replace, not an add: the caller recomputes each task's total from the
   * complete activity log every run, so calling this twice with the same
   * inputs is a no-op and calling it after `recordReadingTime` has already
   * added some of the same events cannot double-count — the recompute
   * already includes them. Quiet for the same reason as `recordArtifactCheck`.
   */
  setReadingTime(
    taskId: string,
    readingTime: TaskReadingTime,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    task.readingTime = readingTime;
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }
}
