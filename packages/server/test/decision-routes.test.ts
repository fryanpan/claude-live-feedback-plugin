/**
 * HTTP-level tests for every param this feature adds — through the REAL
 * routes, because the route layer hand-copies body fields into the store call
 * and is the one layer nothing type-checks. This repo has shipped the
 * "accepted it, returned 200, discarded it" bug twice; one test per new param
 * here is the standing answer.
 *
 * Every assertion reads the stored EFFECT back through a second request, not
 * the response body of the call that made it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task, TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

const DECISION_BODY =
  'Ship now or wait for the index rebuild? Waiting costs a week and removes the stale-results risk. Blocked until answered: the launch note.';

describe('decision routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

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

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    return workspace.id;
  }
  async function getTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }
  async function seedDecision(
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'ship now or wait?',
        assignee: 'human',
        needs: 'decision',
        body: DECISION_BODY,
        ...extra,
      }),
    );
    return task;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'decision-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── POST /api/workspaces/:id/tasks — `options` ──────────────────────────

  describe('create forwards `options`', () => {
    it('stores them with ids, readable back through the list route', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId, {
        options: [
          { label: 'Ship now', detail: 'stale results for a week' },
          { label: 'Wait for the rebuild' },
        ],
      });
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.options?.map((o) => o.label)).toEqual(['Ship now', 'Wait for the rebuild']);
      expect(stored?.options?.[0]?.detail).toBe('stale results for a week');
      expect(stored?.options?.[0]?.id.length ?? 0).toBeGreaterThan(0);
    });

    it('400s a malformed options array rather than dropping it silently', async () => {
      const wsId = await seedWorkspace();
      for (const options of [
        'Ship now', // not an array
        [{ detail: 'no label' }],
        [{ label: '  ' }],
      ]) {
        const r = await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'x',
          assignee: 'human',
          needs: 'decision',
          body: DECISION_BODY,
          options,
        });
        expect(r.status).toBe(400);
      }
      // Positive control: the well-formed array is accepted at the same route.
      const good = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'x',
        assignee: 'human',
        needs: 'decision',
        body: DECISION_BODY,
        options: [{ label: 'a' }, { label: 'b' }],
      });
      expect(good.status).toBe(200);
    });
  });

  // ── the decision-shape gate, through the route ──────────────────────────

  describe('create gates a decision body at the route', () => {
    it('400s a progress report and names the shape in the message', async () => {
      const wsId = await seedWorkspace();
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'The name',
        assignee: 'human',
        needs: 'decision',
        body: 'Round 5 delivered: 133 candidates ranked. Still open, still #3 on the status page.',
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; message?: string };
      expect(body.error).toBe('decision-body-required');
      expect(body.message).toContain('question');
      // …and nothing was created.
      expect((await getTasks(wsId)).some((t) => t.title === 'The name')).toBe(false);
    });

    it('returns the advisory gaps alongside a task it DID create', async () => {
      const wsId = await seedWorkspace();
      const r = await jj<{ task: Task; shapeGaps?: string[] }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'Badge colour',
          assignee: 'human',
          needs: 'decision',
          body: 'Blue or green?',
        }),
      );
      expect(r.shapeGaps).toContain('stakes');
      expect((await getTasks(wsId)).some((t) => t.id === r.task.id)).toBe(true);
    });

    it('holds promote_to_task to the same gate — the store is where it lives', async () => {
      const wsId = await seedWorkspace();
      // A doc + thread whose quote has no question in it.
      const docId = 'decision-promote';
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, '# Doc\n\nthe ranking clause\n');
      await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
      const { thread } = await jj<{ thread: { id: string } }>(
        await post(`/api/docs/${docId}/threads`, {
          author: PERSON,
          text: 'Round 5 delivered 133 candidates.',
          // An ELEMENT anchor: a text-range one carries encoded Yjs relative
          // positions, and a hand-written empty pair blows up the room's
          // re-anchor sweep on every later save.
          anchor: {
            kind: 'element',
            fingerprint: { tag: 'P', classes: [], text: 'the ranking clause', index: 0 },
            snippet: { text: 'the ranking clause' },
          },
        }),
      );
      const asDecision = await post(`/api/docs/${docId}/threads/${thread.id}/promote`, {
        workspaceId: wsId,
        needs: 'decision',
        author: PERSON,
      });
      expect(asDecision.status).toBe(400);
      // Positive control: the SAME promote without needs:'decision' succeeds,
      // so the refusal is the gate and not a broken promote.
      const asAction = await post(`/api/docs/${docId}/threads/${thread.id}/promote`, {
        workspaceId: wsId,
        author: PERSON,
      });
      expect(asAction.status).toBe(200);
    });
  });

  // ── POST /api/tasks/:id/answer — `optionId` ─────────────────────────────

  describe('answer forwards `optionId`', () => {
    it('records the picked option on the stored task and the event', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId, {
        options: [{ label: 'Ship now' }, { label: 'Wait for the rebuild' }],
      });
      const picked = task.options?.[1];
      expect(picked).toBeDefined();
      if (!picked) return;

      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        await jj(
          await post(`/api/tasks/${task.id}/answer`, {
            text: picked.label,
            optionId: picked.id,
            author: PERSON,
          }),
        );
      } finally {
        off();
      }
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.answer?.text).toBe('Wait for the rebuild');
      expect(stored?.answer?.optionId).toBe(picked.id);
      const answered = events.find((e) => e.type === 'decision.answered');
      expect(answered).toBeDefined();
      if (answered?.type === 'decision.answered') expect(answered.optionId).toBe(picked.id);
    });

    it('400s an optionId the decision does not carry, and writes nothing', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId, { options: [{ label: 'Ship now' }] });
      const r = await post(`/api/tasks/${task.id}/answer`, {
        text: 'Ship now',
        optionId: 'o-ghost',
        author: PERSON,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('unknown-option');
      expect((await getTasks(wsId)).find((t) => t.id === task.id)?.answer).toBeUndefined();
    });

    it('still records plain free text with no option — the shortcut is not the only path', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId, { options: [{ label: 'Ship now' }] });
      await jj(
        await post(`/api/tasks/${task.id}/answer`, {
          text: 'neither — split it in two',
          author: PERSON,
        }),
      );
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.answer?.text).toBe('neither — split it in two');
      expect(stored?.answer?.optionId).toBeUndefined();
    });
  });

  // ── POST /api/tasks/:id/answer/undo ─────────────────────────────────────

  describe('POST /api/tasks/:id/answer/undo', () => {
    it('reopens the decision and KEEPS the withdrawn words', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId, { options: [{ label: 'Ship now' }] });
      const picked = task.options?.[0];
      expect(picked).toBeDefined();
      if (!picked) return;
      await jj(
        await post(`/api/tasks/${task.id}/answer`, {
          text: picked.label,
          optionId: picked.id,
          author: PERSON,
        }),
      );
      // Positive control: it really was answered before the undo, so the
      // absence asserted below is the undo's doing and not a failed answer.
      expect((await getTasks(wsId)).find((t) => t.id === task.id)?.answer?.text).toBe('Ship now');

      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        await jj(await post(`/api/tasks/${task.id}/answer/undo`, { author: PERSON }));
      } finally {
        off();
      }
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.answer).toBeUndefined();
      // The soft-delete half: the words, who said them, which option, and who
      // took it back. A hard delete would pass the line above and lose all of
      // it.
      expect(stored?.answerHistory?.length).toBe(1);
      expect(stored?.answerHistory?.[0]?.text).toBe('Ship now');
      expect(stored?.answerHistory?.[0]?.by).toBe('Jordan');
      expect(stored?.answerHistory?.[0]?.optionId).toBe(picked.id);
      expect(stored?.answerHistory?.[0]?.withdrawnBy).toBe('Jordan');
      expect(stored?.answerHistory?.[0]?.withdrawnAt).toBeGreaterThan(0);

      const withdrawn = events.find((e) => e.type === 'decision.answer_withdrawn');
      expect(withdrawn).toBeDefined();
      if (withdrawn?.type === 'decision.answer_withdrawn') {
        expect(withdrawn.answer).toBe('Ship now');
        expect(withdrawn.answeredBy).toBe('Jordan');
      }
    });

    it('lets the decision be answered again, and keeps both rounds', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId);
      await jj(await post(`/api/tasks/${task.id}/answer`, { text: 'wait', author: PERSON }));
      await jj(await post(`/api/tasks/${task.id}/answer/undo`, { author: PERSON }));
      await jj(await post(`/api/tasks/${task.id}/answer`, { text: 'ship', author: PERSON }));
      await jj(await post(`/api/tasks/${task.id}/answer/undo`, { author: PERSON }));
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.answerHistory?.map((a) => a.text)).toEqual(['wait', 'ship']);
    });

    it('404s an unknown task, 400s a missing author, an unanswered decision, or a plain task', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId);
      const { task: plain } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'plain' }),
      );
      expect((await post('/api/tasks/t-missing/answer/undo', { author: PERSON })).status).toBe(404);
      expect((await post(`/api/tasks/${task.id}/answer/undo`, {})).status).toBe(400);
      // Nothing to withdraw is a refusal, not a vacuous success — two readers
      // racing the same undo must not both be told they took something back.
      const none = await post(`/api/tasks/${task.id}/answer/undo`, { author: PERSON });
      expect(none.status).toBe(400);
      expect(((await none.json()) as { error: string }).error).toBe('no-answer');
      expect((await post(`/api/tasks/${plain.id}/answer/undo`, { author: PERSON })).status).toBe(
        400,
      );
      // Positive control: the same route on the same task DOES work once
      // there is an answer to take back.
      await jj(await post(`/api/tasks/${task.id}/answer`, { text: 'ship', author: PERSON }));
      expect((await post(`/api/tasks/${task.id}/answer/undo`, { author: PERSON })).status).toBe(
        200,
      );
    });
  });

  // ── POST /api/tasks/:id/more-info ───────────────────────────────────────

  describe('POST /api/tasks/:id/more-info', () => {
    it('records the question and leaves the decision unanswered', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId);
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        await jj(
          await post(`/api/tasks/${task.id}/more-info`, {
            question: 'what breaks if we wait?',
            author: PERSON,
          }),
        );
      } finally {
        off();
      }
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.infoRequests?.map((r) => r.text)).toEqual(['what breaks if we wait?']);
      expect(stored?.answer).toBeUndefined();
      expect(stored?.status).toBe('todo');
      const asked = events.find((e) => e.type === 'decision.info_requested');
      expect(asked).toBeDefined();
      if (asked?.type === 'decision.info_requested')
        expect(asked.question).toBe('what breaks if we wait?');
    });

    it('404s an unknown task, 400s a missing question or author, 400s a non-decision', async () => {
      const wsId = await seedWorkspace();
      const task = await seedDecision(wsId);
      const { task: plain } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'plain' }),
      );
      expect(
        (await post('/api/tasks/t-missing/more-info', { question: 'x', author: PERSON })).status,
      ).toBe(404);
      expect((await post(`/api/tasks/${task.id}/more-info`, { author: PERSON })).status).toBe(400);
      expect((await post(`/api/tasks/${task.id}/more-info`, { question: 'x' })).status).toBe(400);
      expect(
        (await post(`/api/tasks/${plain.id}/more-info`, { question: 'x', author: PERSON })).status,
      ).toBe(400);
    });
  });

  // ── POST /api/tasks/:id/after ───────────────────────────────────────────

  describe('POST /api/tasks/:id/after', () => {
    it('forwards after + afterEnforce, proved by the transition gate refusing', async () => {
      const wsId = await seedWorkspace();
      const gate = await seedDecision(wsId);
      const { task: work } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Open the PR' }),
      );
      // Presence first: with no edge, the transition goes through.
      expect(
        (await post(`/api/tasks/${work.id}/transition`, { to: 'in-progress', author: AGENT }))
          .status,
      ).toBe(200);
      await post(`/api/tasks/${work.id}/transition`, { to: 'todo', author: AGENT });

      await jj(
        await post(`/api/tasks/${work.id}/after`, {
          after: [gate.id],
          afterEnforce: [gate.id],
          author: AGENT,
        }),
      );
      const stored = (await getTasks(wsId)).find((t) => t.id === work.id);
      expect(stored?.after).toEqual([gate.id]);
      expect(stored?.afterEnforce).toEqual([gate.id]);

      const refused = await post(`/api/tasks/${work.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(refused.status).toBe(409);
    });

    it('clears the edges when handed an empty array', async () => {
      const wsId = await seedWorkspace();
      const gate = await seedDecision(wsId);
      const { task: work } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Open the PR' }),
      );
      await jj(await post(`/api/tasks/${work.id}/after`, { after: [gate.id], author: AGENT }));
      expect((await getTasks(wsId)).find((t) => t.id === work.id)?.after).toEqual([gate.id]);
      await jj(await post(`/api/tasks/${work.id}/after`, { after: [], author: AGENT }));
      expect((await getTasks(wsId)).find((t) => t.id === work.id)?.after).toEqual([]);
    });

    it('404s an unknown task; 400s a bad edge, a self edge, and a missing author', async () => {
      const wsId = await seedWorkspace();
      const { task: work } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Open the PR' }),
      );
      expect((await post('/api/tasks/t-missing/after', { after: [], author: AGENT })).status).toBe(
        404,
      );
      expect((await post(`/api/tasks/${work.id}/after`, { after: [] })).status).toBe(400);
      expect((await post(`/api/tasks/${work.id}/after`, { author: AGENT })).status).toBe(400);
      const ghost = await post(`/api/tasks/${work.id}/after`, {
        after: ['t-ghost'],
        author: AGENT,
      });
      expect(ghost.status).toBe(400);
      expect(((await ghost.json()) as { error: string }).error).toBe('unknown-after');
      const self = await post(`/api/tasks/${work.id}/after`, { after: [work.id], author: AGENT });
      expect(self.status).toBe(400);
      expect(((await self.json()) as { error: string }).error).toBe('self-dependency');
    });
  });
});
