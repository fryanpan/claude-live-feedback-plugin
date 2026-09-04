/**
 * Effort scoring: what one ticket is estimated to cost, and the pass that
 * re-asks when the question itself changes.
 *
 * Two halves of one thing. Scoring is event-driven — it fires on create, on a
 * retitle, on a body edit and on a re-triage — and none of those events
 * happen when the PROMPT changes, so the boot pass exists to re-ask every
 * open row whose estimate predates the current ask. Both call the same
 * `runEffortEstimate`, and the re-project after a write is the same rule in
 * both: `recordEffortEstimate` is deliberately quiet, so a score nobody
 * refreshes is a score that did not happen.
 *
 * Nothing here can block or fail a request. A server with no estimator wired
 * does nothing at all, every call records its own failure on the row, and the
 * boot pass is deliberately sequential with a gap so it cannot spend the rate
 * limit live edits need.
 *
 * Lifted verbatim out of `createServer`.
 */
import { EFFORT_ESTIMATE_PROMPT_VERSION } from '@feedback/core/effort-estimate-prompt';
import {
  EFFORT_ESTIMATE_MODEL,
  type EffortEstimateVerdict,
  type EffortEstimator,
} from './effort-estimator.ts';
import type { TaskProjection } from './task-projection.ts';
import type { Task, TaskEffortEstimate, TaskStore } from './tasks.ts';
import { wordsRevisionOf } from './tasks.ts';

export interface EffortScoringContext {
  /** The hub store — the rows scored, and where a verdict is recorded. */
  taskStore: TaskStore;
  /** The ydoc projection. Refreshed by hand after every recorded estimate,
   *  because `recordEffortEstimate` emits no store event on purpose. */
  taskProjection: TaskProjection;
  /**
   * The one `ServerOptions` field this module reads. Structural rather than
   * importing `ServerOptions`, which lives in server.ts and imports this
   * module back. Absent means the whole feature is off.
   */
  opts: { effortEstimator?: EffortEstimator };
}

/** Build the scorer once per server. */
export function createEffortScoring(ctx: EffortScoringContext): {
  /** Score one ticket in the background. Fire-and-forget. */
  scoreEffortEstimate: (task: Task) => void;
  /** The boot pass over every open row whose estimate predates the ask. */
  rescoreStaleEffortEstimates: () => Promise<void>;
  /** Stop the boot pass at its next checkpoint — called on shutdown, so a
   *  closing server does not keep a hundred API calls in flight. */
  stopEffortRescore: () => void;
} {
  const { taskStore, taskProjection, opts } = ctx;
  /**
   * The words a goal id resolves to, for the scorer's prompt — a small
   * local copy of `task-queue.ts`'s private `goalTitleOf` (not exported,
   * and not worth widening its module's surface for one more caller).
   * Falls back to the raw id, the same as an unresolved `after` edge
   * elsewhere: an id nothing can spell out is still something to hand the
   * prompt rather than nothing, and `CHORES_GOAL_ID` — Backlog — is never
   * in `workspace.goals` at all, so this is also how a backlogged ticket's
   * goal renders as "chores" rather than empty.
   */
  function goalTitleFor(workspaceId: string, goalId: string): string {
    const goals = taskStore.getWorkspace(workspaceId)?.goals ?? [];
    for (const g of goals) {
      if (g.id === goalId) return g.title;
    }
    return goalId;
  }

  /** Process-wide, so a thrown estimator is named once, not once per ticket. */
  let warnedEstimatorThrew = false;

  /**
   * Score one ticket's effort in the background (chunk 2 of the effort
   * model). Fire-and-forget, the same contract as
   * `announceReviewItem`: the write that triggered this is already durable
   * and its route has already answered by the time this runs, so nothing
   * here may block or slow an edit.
   *
   * A produced estimate and a recorded failure are BOTH written — the
   * positive control this feature was built under: a bad prompt must say
   * so on the row, not read as data nobody tried to fetch. Only "no
   * estimator wired at all" (no key, or `CW_EFFORT_ESTIMATE=0`) leaves the
   * row untouched, the "gate off" contract `judgeReviewItem` also uses.
   *
   * Reads the row's provenance BEFORE the await, not after — it describes
   * the words this run is ABOUT, and `recordEffortEstimate` refuses the
   * write if the ticket has moved on by the time the call returns, so a
   * slow answer to old words can never overwrite a newer run's answer.
   *
   * `wordsRevision` is the token that decision is made on; the three
   * timestamps ride along as the human-readable half. Every mutator bumps
   * the counter before emitting the event that lands here, so this read
   * sees the post-edit value and the run it overtook holds a smaller one.
   */
  function scoreEffortEstimate(task: Task): void {
    void runEffortEstimate(task);
  }

  /**
   * The same run, awaitable — for the boot pass, which must space its calls
   * out rather than firing one per open ticket at once.
   *
   * Resolves once the record has been written (or refused). The event-driven
   * caller above throws the promise away, which is the fire-and-forget
   * contract it has always had; only the backfill awaits it.
   */
  async function runEffortEstimate(task: Task): Promise<void> {
    const estimator = opts.effortEstimator;
    if (!estimator) return;
    const prompt = taskStore.effortEstimatePrompt(task.workspaceId);
    if (!prompt) return; // workspace gone
    const forTitleWrittenAt = task.titleWrittenAt ?? task.createdAt;
    const forBodyWrittenAt = task.bodyWrittenAt;
    const forGoal = task.goal;
    const forWordsRevision = wordsRevisionOf(task);
    {
      let verdict: EffortEstimateVerdict | null = null;
      try {
        verdict = await estimator({
          prompt: prompt.value,
          ticket: {
            title: task.title,
            ...(task.body !== undefined ? { body: task.body } : {}),
            goal: goalTitleFor(task.workspaceId, task.goal),
          },
        });
      } catch (err) {
        if (!warnedEstimatorThrew) {
          warnedEstimatorThrew = true;
          console.error(
            '[effort-estimate] estimator threw; row marked failed:',
            err instanceof Error ? err.message : err,
          );
        }
        verdict = null;
      }
      const base = {
        model: EFFORT_ESTIMATE_MODEL,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
        estimatedAt: Date.now(),
        forTitleWrittenAt,
        ...(forBodyWrittenAt !== undefined ? { forBodyWrittenAt } : {}),
        forGoal,
        forWordsRevision,
      };
      const record: TaskEffortEstimate =
        verdict === null
          ? { status: 'failed', reason: 'the scorer could not produce an estimate', ...base }
          : {
              status: 'ok',
              handsOnSeconds: verdict.handsOnSeconds,
              wallClockSeconds: verdict.wallClockSeconds,
              ...base,
            };
      // A `stale` refusal here is expected under concurrent edits, not a
      // bug — see the doc comment above — so it is silently dropped rather
      // than logged.
      const written = taskStore.recordEffortEstimate(task.id, record);
      // Re-project the board, because NOTHING ELSE WILL. `recordEffortEstimate`
      // is deliberately quiet — no store event, no `updatedAt` bump, or the
      // write would re-trigger its own scorer forever — and the projection
      // refreshes off store events. So an estimate landed in the store and the
      // board kept drawing the goal it drew before, until some unrelated edit
      // happened to refresh the workspace. The bar is the only surface these
      // numbers appear on; a score nobody can see is a score that did not
      // happen. Refresh is diff-aware, so a projection already in step is a
      // no-op transaction.
      if (written.ok) taskProjection.refresh(task.workspaceId);
    }
  }

  /**
   * Re-score every OPEN ticket whose estimate predates the current ask.
   *
   * Scoring is otherwise event-driven — it fires on create, on a retitle, on
   * a body edit and on a re-triage — and none of those events happen when
   * the PROMPT changes. Without this pass a prompt bump reaches only tickets
   * somebody happens to edit afterwards, so a board keeps forecasting from
   * answers to a question nobody is asking any more, indefinitely and
   * silently. `EFFORT_ESTIMATE_PROMPT_VERSION` is the token that makes the
   * staleness decidable; this is the thing that acts on it.
   *
   * Open rows only. A closed ticket's estimate is HISTORY — it is one half
   * of a calibration sample whose other half already happened, and
   * re-scoring it under a new prompt would be scoring a ticket whose outcome
   * is known, which is the one thing the effort plan's backfill section says
   * never to do ("blind scoring is the whole point"). The calibrator drops
   * old-generation samples instead (`isCurrentGenerationEstimate`), which
   * costs the board its learned factors and is why the priors exist.
   *
   * SEQUENTIAL, with a gap between calls. A hundred open rows is a hundred
   * API calls, and firing them together on boot would spend the rate limit
   * that live edits need on work nobody is waiting for. Nothing is waiting
   * on this loop, so it can afford to be slow.
   *
   * Never blocks startup and never fails one: the promise is thrown away,
   * every call already records its own failure on the row, and a server with
   * no estimator wired does nothing here at all.
   */
  const EFFORT_RESCORE_GAP_MS = 250;
  let effortRescoreStopped = false;
  async function rescoreStaleEffortEstimates(): Promise<void> {
    if (!opts.effortEstimator) return;
    const stale: Task[] = [];
    for (const ws of taskStore.listWorkspaces()) {
      for (const task of taskStore.listTasks(ws.id)) {
        if (task.status === 'done') continue;
        // Absent AND older-generation, both. A never-scored open ticket is
        // the same problem from the other side — it contributes nothing to
        // its goal's bar and says "not scored" forever unless somebody edits
        // it — and this loop is already walking past it.
        if (task.effortEstimate?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION) continue;
        stale.push(task);
      }
    }
    if (stale.length === 0) return;
    console.log(
      `[effort-estimate] re-scoring ${stale.length} open ticket${stale.length === 1 ? '' : 's'} under prompt version ${EFFORT_ESTIMATE_PROMPT_VERSION}`,
    );
    for (const task of stale) {
      if (effortRescoreStopped) return;
      // Re-read: the row may have been edited, archived or closed since the
      // list was taken, and a rescore of a row that moved on is wasted at
      // best — `recordEffortEstimate` would refuse it as stale anyway.
      const current = taskStore.getTask(task.id);
      if (!current || current.status === 'done' || current.archivedAt !== undefined) continue;
      // And re-ask the question this loop exists to answer. A row queued
      // behind a hundred others can be edited while it waits, and an edit
      // triggers its own scoring — so by the time the loop reaches it the row
      // may already carry a current-generation estimate. Without this check
      // the pass spends a second call and can land its answer on top of the
      // newer one, which `recordEffortEstimate`'s guard does not catch
      // because no words changed between the two reads.
      if (current.effortEstimate?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION) continue;
      await runEffortEstimate(current);
      if (effortRescoreStopped) return;
      await new Promise((r) => setTimeout(r, EFFORT_RESCORE_GAP_MS));
    }
    console.log('[effort-estimate] re-scoring pass done');
  }

  return {
    scoreEffortEstimate,
    rescoreStaleEffortEstimates,
    stopEffortRescore: () => {
      effortRescoreStopped = true;
    },
  };
}
