/**
 * Effort-estimate scoring, through the real routes (BRY t-go5Wj0kOcz_7,
 * chunk 2 of the effort model).
 *
 * The estimator is a STUB throughout — never the real API. What is asserted
 * is everything around it: that scoring fires in the BACKGROUND on create
 * and on every edit (never slowing the route that triggered it), that a
 * bad reply is recorded as a visible failure rather than silence, that a
 * slow answer to old words cannot clobber a newer edit's own answer, and
 * that the two workspace-settings prompts can be tuned independently.
 *
 * All fixtures are synthetic — invented names and generic personas. The
 * repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_EFFORT_ESTIMATE_PROMPT,
  EFFORT_ESTIMATE_PROMPT_VERSION,
} from '@feedback/core/effort-estimate-prompt';
import {
  EFFORT_ESTIMATE_MODEL,
  type EffortEstimateVerdict,
  type EffortEstimatorInput,
} from '../src/effort-estimator.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };

describe('effort-estimate scoring', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** What the stub answers next. `null` is "no usable estimate" (the
   *  positive control); `'throw'` is the scorer blowing up; `'defer'`
   *  parks the call for the test to release in its own order. */
  let verdict: EffortEstimateVerdict | null | 'throw' | 'defer';
  let calls: EffortEstimatorInput[];
  let parked: Array<(v: EffortEstimateVerdict | null) => void>;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'effort-estimate-gate-'));
    verdict = { handsOnSeconds: 900, wallClockSeconds: 86_400 };
    calls = [];
    parked = [];
    handle = createServer({
      port: 0,
      dataDir,
      effortEstimator: async (input) => {
        calls.push(input);
        if (verdict === 'throw') throw new Error('estimator exploded');
        if (verdict === 'defer') return new Promise((resolve) => parked.push(resolve));
        return verdict;
      },
      stallNudgeQuietMs: 60 * 60_000,
    });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function until<T>(read: () => T | undefined): Promise<T> {
    for (let i = 0; i < 80; i++) {
      const v = read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition never held');
  }

  async function board(): Promise<{ workspaceId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'launch-board' }),
    );
    return { workspaceId: workspace.id };
  }

  async function newTask(
    workspaceId: string,
    opts: { title?: string; body?: string } = {},
  ): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: opts.title ?? 'Rebuild the index nightly',
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        author: FILER,
      }),
    );
    return task.id;
  }

  it('scores a new ticket in the background and stores both numbers in seconds', async () => {
    const { workspaceId } = await board();
    const taskId = await newTask(workspaceId, {
      title: 'Rebuild the index nightly',
      body: 'Agent can rebuild the index so that search stays fresh.',
    });
    const est = await until(() => handle.tasks.getTask(taskId)?.effortEstimate);
    expect(est).toMatchObject({
      status: 'ok',
      handsOnSeconds: 900,
      wallClockSeconds: 86_400,
      model: EFFORT_ESTIMATE_MODEL,
      promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
    });
    expect(calls[0]?.ticket.title).toBe('Rebuild the index nightly');
    expect(calls[0]?.ticket.body).toContain('search stays fresh');
    // Backlog — the default goal — is never in `workspace.goals`, so the
    // fallback is the raw id, and the prompt still gets a goal field.
    expect(calls[0]?.ticket.goal).toBe('chores');
    expect(calls[0]?.prompt).toBe(DEFAULT_EFFORT_ESTIMATE_PROMPT);
  });

  it('re-scores on a title-only edit', async () => {
    const { workspaceId } = await board();
    const taskId = await newTask(workspaceId);
    await until(() => handle.tasks.getTask(taskId)?.effortEstimate);
    const callsBefore = calls.length;
    verdict = { handsOnSeconds: 60, wallClockSeconds: 600 };
    await jj(
      await post(`/api/tasks/${taskId}/title`, {
        title: 'Rebuild the index hourly',
        author: PERSON,
      }),
    );
    const est = await until(() => {
      const e = handle.tasks.getTask(taskId)?.effortEstimate;
      return e && e.status === 'ok' && e.handsOnSeconds === 60 ? e : undefined;
    });
    expect(est.wallClockSeconds).toBe(600);
    expect(calls.length).toBe(callsBefore + 1);
    expect(calls.at(-1)?.ticket.title).toBe('Rebuild the index hourly');
  });

  it('re-scores on a body edit', async () => {
    const { workspaceId } = await board();
    const taskId = await newTask(workspaceId, { body: 'Original description.' });
    await until(() => handle.tasks.getTask(taskId)?.effortEstimate);
    verdict = { handsOnSeconds: 1_200, wallClockSeconds: 3_600 };
    await jj(
      await post(`/api/tasks/${taskId}/body`, {
        markdown: 'A much bigger rewrite of the description.',
        author: PERSON,
      }),
    );
    const est = await until(() => {
      const e = handle.tasks.getTask(taskId)?.effortEstimate;
      return e && e.status === 'ok' && e.handsOnSeconds === 1_200 ? e : undefined;
    });
    expect(est.wallClockSeconds).toBe(3_600);
    expect(calls.at(-1)?.ticket.body).toContain('bigger rewrite');
  });

  // The positive control this feature was built under: a reply the scorer
  // cannot turn into a usable estimate must read as "no estimate, here's
  // why" on the row — never a silent absence and never a guessed number.
  it('a bad reply is recorded as a visible failure, not silence and not a guess', async () => {
    const { workspaceId } = await board();
    verdict = null;
    const taskId = await newTask(workspaceId);
    const est = await until(() => handle.tasks.getTask(taskId)?.effortEstimate);
    expect(est.status).toBe('failed');
    expect((est as { reason: string }).reason.length).toBeGreaterThan(0);
    expect((est as { handsOnSeconds?: number }).handsOnSeconds).toBeUndefined();
  });

  it('a thrown estimator is recorded as a failure too, never left as an unhandled rejection', async () => {
    const { workspaceId } = await board();
    verdict = 'throw';
    const taskId = await newTask(workspaceId);
    const est = await until(() => handle.tasks.getTask(taskId)?.effortEstimate);
    expect(est.status).toBe('failed');
  });

  it('no estimator wired at all leaves the row untouched — never scored, not a failure', async () => {
    const unscored = createServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), 'no-scorer-')) });
    try {
      const b2 = `http://localhost:${unscored.port}`;
      const { workspace } = await jj<{ workspace: { id: string } }>(
        await fetch(`${b2}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'no-scorer-board' }),
        }),
      );
      const { task } = await jj<{ task: { id: string } }>(
        await fetch(`${b2}/api/workspaces/${workspace.id}/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'Untouched ticket', author: FILER }),
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect(unscored.tasks.getTask(task.id)?.effortEstimate).toBeUndefined();
    } finally {
      await unscored.stop();
    }
  });

  it('the route answers before the estimator resolves — scoring never slows an edit', async () => {
    const { workspaceId } = await board();
    verdict = 'defer';
    const started = Date.now();
    const res = await post(`/api/workspaces/${workspaceId}/tasks`, {
      title: 'A ticket whose scoring never returns',
      author: FILER,
    });
    expect(res.status).toBe(200);
    // The estimator promise is still parked — nothing has resolved it — so
    // a route that waited on scoring would still be hanging right now.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parked.length).toBe(1);
  });

  it("a slow answer to OLDER words never overwrites a newer edit's own answer", async () => {
    const { workspaceId } = await board();
    verdict = 'defer';
    const taskId = await newTask(workspaceId, { title: 'Original title' });
    const createCall = await until(() => (parked.length >= 1 ? parked[0] : undefined));

    // A second edit lands before the create's scoring run has answered.
    verdict = 'defer';
    await jj(await post(`/api/tasks/${taskId}/title`, { title: 'Renamed title', author: PERSON }));
    const renameCall = await until(() => (parked.length >= 2 ? parked[1] : undefined));

    // The NEWER run answers first — ordinary, since a network call has no
    // guaranteed order — and its answer stands.
    renameCall?.({ handsOnSeconds: 111, wallClockSeconds: 222 });
    const est = await until(() => {
      const e = handle.tasks.getTask(taskId)?.effortEstimate;
      return e && e.status === 'ok' ? e : undefined;
    });
    expect(est).toMatchObject({ handsOnSeconds: 111, wallClockSeconds: 222 });

    // The OLDER run for "Original title" answers late. It must be refused:
    // overwriting the newer run's answer would silently regress the row.
    createCall?.({ handsOnSeconds: 999, wallClockSeconds: 999 });
    await new Promise((r) => setTimeout(r, 150));
    expect(handle.tasks.getTask(taskId)?.effortEstimate).toMatchObject({
      handsOnSeconds: 111,
      wallClockSeconds: 222,
    });
  });

  describe('settings — both prompts are independently tunable', () => {
    it('reads the defaults until somebody writes, and round-trips a write to each', async () => {
      const { workspaceId } = await board();
      const before = await jj<{
        reviewItemCriteria: { value: string; isDefault: boolean };
        effortEstimatePrompt: { value: string; isDefault: boolean };
      }>(await get(`/api/workspaces/${workspaceId}/settings`));
      expect(before.effortEstimatePrompt.isDefault).toBe(true);
      expect(before.effortEstimatePrompt.value).toBe(DEFAULT_EFFORT_ESTIMATE_PROMPT);

      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          effortEstimatePrompt: 'Weigh review overhead heavily.',
          author: PERSON,
        }),
      );
      const after = await jj<{ effortEstimatePrompt: { value: string; isDefault: boolean } }>(
        await get(`/api/workspaces/${workspaceId}/settings`),
      );
      expect(after.effortEstimatePrompt).toMatchObject({
        value: 'Weigh review overhead heavily.',
        isDefault: false,
      });
    });

    it('writing one prompt never clobbers the other back to its default', async () => {
      const { workspaceId } = await board();
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: 'Every headline is a question.',
          author: PERSON,
        }),
      );
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          effortEstimatePrompt: 'Weigh review overhead heavily.',
          author: PERSON,
        }),
      );
      const after = await jj<{
        reviewItemCriteria: { value: string; isDefault: boolean };
        effortEstimatePrompt: { value: string; isDefault: boolean };
      }>(await get(`/api/workspaces/${workspaceId}/settings`));
      expect(after.reviewItemCriteria).toMatchObject({
        value: 'Every headline is a question.',
        isDefault: false,
      });
      expect(after.effortEstimatePrompt).toMatchObject({
        value: 'Weigh review overhead heavily.',
        isDefault: false,
      });
    });

    it('a null write returns the prompt to the default without touching the other', async () => {
      const { workspaceId } = await board();
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: 'custom criteria',
          effortEstimatePrompt: 'custom effort prompt',
          author: PERSON,
        }),
      );
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          effortEstimatePrompt: null,
          author: PERSON,
        }),
      );
      const after = await jj<{
        reviewItemCriteria: { value: string; isDefault: boolean };
        effortEstimatePrompt: { isDefault: boolean };
      }>(await get(`/api/workspaces/${workspaceId}/settings`));
      expect(after.effortEstimatePrompt.isDefault).toBe(true);
      expect(after.reviewItemCriteria).toMatchObject({
        value: 'custom criteria',
        isDefault: false,
      });
    });

    it('refuses a non-string prompt', async () => {
      const { workspaceId } = await board();
      const bad = await put(`/api/workspaces/${workspaceId}/settings`, {
        effortEstimatePrompt: 42,
        author: PERSON,
      });
      expect(bad.status).toBe(400);
    });

    it('the changed prompt is what the scorer is asked with', async () => {
      const { workspaceId } = await board();
      await newTask(workspaceId);
      await until(() => (calls.length > 0 ? calls.length : undefined));
      expect(calls[0]?.prompt).toBe(DEFAULT_EFFORT_ESTIMATE_PROMPT);
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          effortEstimatePrompt: 'Weigh review overhead heavily.',
          author: PERSON,
        }),
      );
      const callsBefore = calls.length;
      await newTask(workspaceId);
      await until(() => (calls.length > callsBefore ? calls.length : undefined));
      expect(calls.at(-1)?.prompt).toBe('Weigh review overhead heavily.');
    });
  });
});
