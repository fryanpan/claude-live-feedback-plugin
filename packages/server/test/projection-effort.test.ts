import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import type { TaskEffortEstimate } from '../src/tasks.ts';

const AGENT = { id: 'agent-x', name: 'Estimator Test', kind: 'agent' };

/**
 * The effort model's numbers have to REACH the board, because the goal bar
 * is computed in the browser off this projection. Until this change neither
 * `effortEstimate` (#486) nor `readingTime` (#482) was projected, so both
 * were server-side-only: readable through `GET /api/workspaces/:id/tasks`,
 * which spreads the whole stored row, and invisible to the one surface that
 * needs them.
 *
 * The thing these tests are really guarding is the three-state contract.
 * Both fields are documented on `Task` as absent-means-not-measured, and a
 * projection that emitted a zero — or that dropped the `failed` variant —
 * would collapse three distinguishable states into two at the last step
 * before the screen.
 */
describe('the board projection carries the effort model', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

  const mkTask = async (title: string): Promise<string> => {
    const res = await fetch(`${base}/api/workspaces/${wsId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AGENT, title, goal: 'chores' }),
    });
    return ((await res.json()) as { task: { id: string } }).task.id;
  };

  const row = (taskId: string): Record<string, unknown> => {
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room was not created');
    return room.ydoc.getMap('tasks').get(taskId) as Record<string, unknown>;
  };

  /** The provenance a run must carry to survive the staleness guard. */
  const runFor = (taskId: string): Omit<TaskEffortEstimate, 'status'> => {
    const task = handle.tasks.getTask(taskId);
    if (!task) throw new Error('task vanished');
    return {
      model: 'test-model',
      promptVersion: 1,
      estimatedAt: Date.now(),
      forTitleWrittenAt: task.titleWrittenAt ?? task.createdAt,
      ...(task.bodyWrittenAt !== undefined ? { forBodyWrittenAt: task.bodyWrittenAt } : {}),
      forGoal: task.goal,
    } as Omit<TaskEffortEstimate, 'status'>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'proj-effort-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const mk = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'effort board', goal: 'Ship it.' }),
    });
    wsId = ((await mk.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('projects a successful estimate with both numbers in seconds', async () => {
    const id = await mkTask('A scored ticket');
    const rec = handle.tasks.recordEffortEstimate(id, {
      status: 'ok',
      handsOnSeconds: 900,
      wallClockSeconds: 86_400,
      ...runFor(id),
    } as TaskEffortEstimate);
    // Positive control on the fixture: a `stale` refusal here would leave the
    // row unscored, and the assertion below would then be testing nothing.
    expect(rec.ok).toBe(true);
    handle.projection.refresh(wsId);
    const projected = row(id).effortEstimate as Record<string, unknown>;
    expect(projected?.status).toBe('ok');
    expect(projected?.handsOnSeconds).toBe(900);
    expect(projected?.wallClockSeconds).toBe(86_400);
  });

  it('projects a FAILED run, so the board can say so instead of saying nothing', async () => {
    const id = await mkTask('A ticket the scorer could not read');
    const rec = handle.tasks.recordEffortEstimate(id, {
      status: 'failed',
      reason: 'the scorer could not produce an estimate',
      ...runFor(id),
    } as TaskEffortEstimate);
    expect(rec.ok).toBe(true);
    handle.projection.refresh(wsId);
    const projected = row(id).effortEstimate as Record<string, unknown>;
    expect(projected?.status).toBe('failed');
    expect(projected?.reason).toBe('the scorer could not produce an estimate');
    // The distinction this whole feature rests on: a failure is not a zero.
    expect(projected?.handsOnSeconds).toBeUndefined();
    expect(projected?.wallClockSeconds).toBeUndefined();
  });

  it('leaves the key OFF a ticket nobody scored — absent, not zero', async () => {
    const id = await mkTask('An unscored ticket');
    handle.projection.refresh(wsId);
    const projected = row(id);
    expect('effortEstimate' in projected).toBe(false);
    expect('readingTime' in projected).toBe(false);
  });

  it('projects reading time, and keeps its absence absent', async () => {
    const read = await mkTask('A ticket someone read');
    const unread = await mkTask('A ticket nobody opened');
    const rec = handle.tasks.recordReadingTime(read, 300);
    expect(rec.ok).toBe(true);
    handle.projection.refresh(wsId);
    const projected = row(read).readingTime as Record<string, unknown>;
    expect(projected?.totalSeconds).toBe(300);
    expect(projected?.sessionCount).toBe(1);
    // Not `{ totalSeconds: 0 }`. The type doc says no reader may default this
    // to zero, and the projection is a reader.
    expect('readingTime' in row(unread)).toBe(false);
  });

  it('drops the key again if a row loses its estimate', async () => {
    const id = await mkTask('A ticket whose estimate goes away');
    handle.tasks.recordEffortEstimate(id, {
      status: 'ok',
      handsOnSeconds: 60,
      wallClockSeconds: 600,
      ...runFor(id),
    } as TaskEffortEstimate);
    handle.projection.refresh(wsId);
    expect('effortEstimate' in row(id)).toBe(true);
    const task = handle.tasks.getTask(id);
    if (!task) throw new Error('task vanished');
    task.effortEstimate = undefined;
    handle.projection.refresh(wsId);
    // `refresh` deletes projected keys absent from the object, so a withdrawn
    // estimate takes its key with it rather than freezing on the last value.
    expect('effortEstimate' in row(id)).toBe(false);
  });
});
