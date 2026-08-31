/**
 * What a PROMPT BUMP does to a board that is already full of estimates.
 *
 * Scoring is event-driven — create, retitle, body edit, re-triage — and a
 * change to the prompt is none of those. So `EFFORT_ESTIMATE_PROMPT_VERSION`
 * exists to make staleness decidable, and the boot pass is the thing that
 * acts on it: without one, a new ask reaches only the tickets somebody
 * happens to edit afterwards and the board forecasts indefinitely from
 * answers to a question nobody is asking any more.
 *
 * Two halves, and they fail independently:
 *  - the right rows get re-scored (open ones, never closed ones, and the
 *    never-scored ones too), and
 *  - the answer REACHES THE BOARD. `recordEffortEstimate` is deliberately
 *    quiet — no store event, or the write would re-trigger its own scorer
 *    forever — and the ydoc projection refreshes off store events, so an
 *    estimate could land in the store and change nothing a reader sees.
 *
 * The estimator is a stub throughout; all fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFORT_ESTIMATE_PROMPT_VERSION } from '@feedback/core/effort-estimate-prompt';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };

/** What version 1 of the ask produced on this board: a human-sized guess. */
const OLD = { handsOnSeconds: 2_592_000, wallClockSeconds: 5_184_000 };
/** What version 2 produces for the same ticket. */
const NEW = { handsOnSeconds: 900, wallClockSeconds: 86_400 };

describe('a prompt bump re-scores the open rows on boot', () => {
  let dataDir: string;
  let handle: ServerHandle | null = null;
  let calls: string[];

  const boot = (verdict: typeof NEW | null): ServerHandle =>
    createServer({
      port: 0,
      dataDir,
      effortEstimator: async (input) => {
        calls.push(input.ticket.title);
        return verdict;
      },
      stallNudgeQuietMs: 60 * 60_000,
    });

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'effort-rescore-boot-'));
    calls = [];
  });

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board on disk: three rows, two open and one closed, every estimate
   *  stamped with the PREVIOUS generation — the state a prompt bump lands
   *  on. Written as a store file rather than driven through the routes,
   *  because what is under test is what the NEXT process does with it. */
  async function seedOldGenerationBoard(): Promise<{
    workspaceId: string;
    ids: { open: string; alsoOpen: string; closed: string; unscored: string };
  }> {
    handle = boot(NEW);
    const base = `http://localhost:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await fetch(`${base}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'rescore-board' }),
      }),
    );
    const mk = async (title: string): Promise<string> => {
      const { task } = await jj<{ task: { id: string } }>(
        await fetch(`${base}/api/workspaces/${workspace.id}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, author: FILER }),
        }),
      );
      return task.id;
    };
    const ids = {
      open: await mk('An open ticket scored under the old ask'),
      alsoOpen: await mk('A second open ticket scored under the old ask'),
      closed: await mk('A ticket that already closed'),
      unscored: await mk('A ticket nobody ever scored'),
    };
    await handle.stop();
    handle = null;

    const file = join(dataDir, 'workspaces', `${workspace.id}.tasks.json`);
    const state = JSON.parse(readFileSync(file, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    for (const row of state.tasks) {
      const id = row.id as string;
      if (id === ids.unscored) {
        row.effortEstimate = undefined;
        continue;
      }
      if (id === ids.closed) row.status = 'done';
      row.effortEstimate = {
        ...(row.effortEstimate as Record<string, unknown>),
        ...OLD,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
      };
    }
    writeFileSync(file, JSON.stringify(state));
    // The seeding server scored every row on create. Those calls are fixture
    // setup, not the pass under test — a `calls` array carrying them would
    // make "the closed row was never asked about" pass or fail on which
    // server made the call.
    calls = [];
    return { workspaceId: workspace.id, ids };
  }

  async function until<T>(read: () => T | undefined): Promise<T> {
    for (let i = 0; i < 200; i++) {
      const v = read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition never held');
  }

  it('re-scores every open row, leaves the closed one alone, and reaches the board', async () => {
    const { workspaceId, ids } = await seedOldGenerationBoard();
    handle = boot(NEW);
    const h = handle;

    const current = (id: string) => {
      const e = h.tasks.getTask(id)?.effortEstimate;
      return e?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION ? e : undefined;
    };
    await until(() => current(ids.open));
    await until(() => current(ids.alsoOpen));
    await until(() => current(ids.unscored));

    // The open rows carry the new generation's numbers…
    expect(current(ids.open)).toMatchObject({ status: 'ok', ...NEW });
    // …including the one that had never been scored at all. It is the same
    // problem from the other side: it contributed nothing to its goal's bar
    // and read "not scored" forever unless somebody edited it.
    expect(current(ids.unscored)).toMatchObject({ status: 'ok', ...NEW });

    // …and the CLOSED row is untouched. Its estimate is one half of a
    // calibration sample whose other half already happened; re-scoring a
    // ticket whose outcome is known is the one thing the effort plan says
    // never to do. The calibrator drops it as an old generation instead.
    const closed = h.tasks.getTask(ids.closed)?.effortEstimate;
    expect(closed).toMatchObject({ ...OLD, promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1 });
    expect(calls).not.toContain('A ticket that already closed');

    // The second half: the answer reaches the BOARD, with nobody calling
    // refresh. The goal bar is computed in the browser off this projection,
    // so an estimate the projection never picked up is an estimate that did
    // not happen as far as any reader is concerned.
    const room = h.rooms.get(workspaceRoomId(workspaceId));
    if (!room) throw new Error('ws room was not created');
    const projected = room.ydoc.getMap('tasks').get(ids.open) as Record<string, unknown>;
    expect((projected.effortEstimate as Record<string, unknown>)?.wallClockSeconds).toBe(
      NEW.wallClockSeconds,
    );
    expect((projected.effortEstimate as Record<string, unknown>)?.promptVersion).toBe(
      EFFORT_ESTIMATE_PROMPT_VERSION,
    );
  });

  it('leaves a current-generation board alone — no calls, no writes', async () => {
    // The negative control the pass needs, and the reason it keys on the
    // version rather than on "has this row been scored recently": a restart
    // must not re-score a board that is already current, or every bounce of
    // the server spends the rate limit re-answering settled questions.
    const { workspaceId } = await seedOldGenerationBoard();
    handle = boot(NEW);
    const first = handle;
    await until(() =>
      first.tasks
        .listTasks(workspaceId)
        .filter((t) => t.status !== 'done')
        .every((t) => t.effortEstimate?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION)
        ? true
        : undefined,
    );
    await first.stop();
    handle = null;

    calls = [];
    handle = boot(NEW);
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
  });

  it('does nothing at all when no estimator is wired', async () => {
    // Same contract as the event-driven scorer: no key, or the kill switch,
    // and the row is left exactly as it was — never scored is a state, and
    // a boot pass must not turn it into a failure.
    const { ids } = await seedOldGenerationBoard();
    handle = createServer({ port: 0, dataDir, stallNudgeQuietMs: 60 * 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    const h = handle;
    // Each row asserted for what it WAS, not for "not the new version" — a
    // never-scored row satisfies that by being absent, which would let this
    // pass on a board the seed failed to write.
    expect(h.tasks.getTask(ids.open)?.effortEstimate).toMatchObject({
      ...OLD,
      promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
    });
    expect(h.tasks.getTask(ids.closed)?.effortEstimate).toMatchObject({
      promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
    });
    // Still never scored — not turned into a recorded failure, which is what
    // a pass that ran without an estimator would produce.
    expect(h.tasks.getTask(ids.unscored)?.effortEstimate).toBeUndefined();
  });
});
