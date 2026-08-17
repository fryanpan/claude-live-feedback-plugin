/**
 * The premise-drift signal, driven through the REAL work-queue route.
 *
 * task-staleness.test.ts proves the arming rule. It cannot prove the notes
 * survive the trip from the task's body room, through the projection, into
 * `buildQueue`, and out of `GET /api/workspaces/:id/next` — and that trip is
 * where this class of bug lives here: every REST handler hand-copies fields,
 * and the route is the layer nothing type-checks. `groups` was accepted,
 * returned ok:true, and discarded exactly this way.
 *
 * It also pins the thing that made the whole feature necessary: the queue row
 * used to carry `body` and drop the discussion, so a correction a previous
 * reader had already written sat one API call away from every agent that
 * re-derived it from scratch.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('premise drift over the work-queue route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });

  /**
   * A note must be strictly newer than the description it comments on, and
   * with the window overridden to zero these fixtures would otherwise race
   * inside a single millisecond. Real gaps are days; this buys a tick.
   */
  const tick = () => new Promise((r) => setTimeout(r, 5));

  const comment = async (taskId: string, find: string, text: string) => {
    await tick();
    const r = await post(`/api/docs/task:${taskId}/threads/by_find`, {
      find,
      text,
      author: { id: 'known-reviewer', name: 'Reviewer' },
    });
    // by_find resolves the anchor against the doc; a miss is a 409 and would
    // silently leave the task undiscussed, turning every assertion below
    // into a vacuous pass.
    expect(r.status).toBe(200);
  };

  type Row = {
    id: string;
    title: string;
    body: string;
    bodyWrittenAt: number;
    premise?: {
      bodyWrittenAt: number;
      discussedAt: number;
      agedMs: number;
      headline: string;
      advice: string;
      notes: { ts: number; by: string; text: string }[];
    };
  };

  const nextRows = async (workspaceId: string): Promise<Row[]> => {
    const r = await local(`/api/workspaces/${workspaceId}/next?includeBlocked=true`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { tasks: Row[] }).tasks;
  };

  const makeTask = async (workspaceId: string, title: string, body: string): Promise<string> => {
    const r = await post(`/api/workspaces/${workspaceId}/tasks`, {
      title,
      body,
      assignee: 'Reviewer',
      author: { id: 'known-reviewer', name: 'Reviewer' },
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  };

  let workspaceId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'premise-drift-'));
    // Zero window: any note that postdates the description arms the rule.
    // The rule's own threshold is asserted on both sides in the unit tests;
    // here the subject is the plumbing, and a real 24h gap is unwaitable.
    handle = createServer({ port: 0, dataDir, premiseStaleAfterMs: 0 });
    base = `http://localhost:${handle.port}`;
    const w = await post('/api/workspaces', { name: 'queue', goal: 'Ship it.' });
    workspaceId = ((await w.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('dates every description, drifting or not', async () => {
    const id = await makeTask(workspaceId, 'Dated row', 'The widget cannot be embedded twice.');
    const row = (await nextRows(workspaceId)).find((r) => r.id === id);
    expect(row).toBeDefined();
    // A reader needs to know how old the measurement is whether or not
    // anything has contradicted it.
    expect(typeof row!.bodyWrittenAt).toBe('number');
    expect(row!.bodyWrittenAt).toBeGreaterThan(0);
    // …and an undiscussed row carries no notice at all.
    expect(row!.premise).toBeUndefined();
  });

  it('carries the correction a previous reader wrote, verbatim, on the pickup path', async () => {
    const id = await makeTask(
      workspaceId,
      'Overtaken row',
      'There is no route that answers what to pick up next, so ordering lives in each agent head.',
    );

    // Positive control: before anybody says anything, the row is quiet even
    // with a zero-width window. So the assertion below cannot pass vacuously.
    const before = (await nextRows(workspaceId)).find((r) => r.id === id);
    expect(before?.premise).toBeUndefined();

    // A reader reproduces first and records what they found — as a comment on
    // the task, which is what all five real instances did. Anchored via
    // by_find so the anchor is built from the doc rather than hand-written.
    const correction =
      'Reproduced before building: the route exists and answered correctly. The premise has moved.';
    await comment(id, 'There is no route', correction);

    const after = (await nextRows(workspaceId)).find((r) => r.id === id);
    expect(after?.premise).toBeDefined();
    const p = after!.premise!;
    expect(p.notes).toHaveLength(1);
    // Verbatim — not a count, not a preview. Being handed less than the
    // record holds is the failure this exists to remove.
    expect(p.notes[0]!.text).toBe(correction);
    expect(p.notes[0]!.by).toBe('Reviewer');
    expect(p.discussedAt).toBeGreaterThanOrEqual(p.bodyWrittenAt);
    expect(p.bodyWrittenAt).toBe(after!.bodyWrittenAt);
    // The description itself is untouched: this is additive, and the
    // original measurement stays as evidence of when it was taken.
    expect(after!.body).toContain('There is no route that answers');
  });

  it('says nothing about completion, in the copy that reaches the agent', async () => {
    const id = await makeTask(workspaceId, 'Still real work', 'The badge strip clips a glyph.');
    await comment(
      id,
      'badge strip',
      'Half of this shipped already; the width budget is the remaining defect.',
    );
    const row = (await nextRows(workspaceId)).find((r) => r.id === id);
    expect(row!.premise!.advice).toContain('says nothing about whether the task is done');
    // Four of the five real instances still had work in them after the
    // premise was corrected, so the row must stay in the queue.
    expect(row).toBeDefined();
  });

  it('clears itself when the description is rewritten — no separate acknowledge step', async () => {
    const id = await makeTask(workspaceId, 'Corrected row', 'oldGoal is unrecoverable on the live path.');
    await comment(id, 'oldGoal', 'Checked the wire: oldGoal was never missing. One renderer.');
    // Positive control: it is armed right now.
    expect((await nextRows(workspaceId)).find((r) => r.id === id)?.premise).toBeDefined();

    await tick();
    const rewrite = await post(`/api/tasks/${id}/body`, {
      markdown:
        'The live triage payload renders a count where it holds the whole request. Fix the renderer.',
      author: { id: 'known-reviewer', name: 'Reviewer' },
    });
    expect(rewrite.status).toBe(200);

    const row = (await nextRows(workspaceId)).find((r) => r.id === id);
    expect(row!.body).toContain('Fix the renderer');
    // The rewrite is newer than the note, so the author has accounted for it.
    expect(row!.premise).toBeUndefined();
  });
});
