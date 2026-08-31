import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * POST /api/refs/backfill + the settle-time doc scan (src/refs-backfill.ts):
 * links people already wrote — in doc prose, task/goal bodies, and stored
 * url-kind refs — become structured doc refs, idempotently.
 *
 * The promises under test, end to end over real HTTP:
 *  1. dryRun counts what would land and writes NOTHING.
 *  2. The real run mines all four sources; refs land under the doc's
 *     CANONICAL id even when the body linked an alias; a row whose origin
 *     already ties it to the doc is skipped, not duplicated.
 *  3. A second run creates nothing (the idempotency contract).
 *  4. A settled authoring edit on a doc scans just that doc, so a link
 *     written today needs no backfill tomorrow.
 *
 * Fixtures are synthetic (the jordan@partner.example register — the repo is
 * public); negative assertions keep positive controls beside them.
 */
import { prose } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Ref } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };

interface Stats {
  dryRun: boolean;
  docsScanned: number;
  taskRefsCreated: number;
  goalRefsCreated: number;
  urlRefsUpgraded: number;
  skippedExisting: number;
  workspacesTouched: string[];
}

describe('refs backfill (route + settle scan)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  let goalId: string;
  /** Rows the fixtures link to. */
  let plainTaskId: string; // linked from doc A's prose, no origin of its own
  let originTaskId: string; // filed from doc A via sourceDoc — origin covers it
  let bodyTaskId: string; // its own body links doc B
  let urlRefTaskId: string; // carries a stored url-kind ref to doc B
  let docAId: string; // canonical id of the doc bound under alias `refs-doc-a`
  let docBId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const backfill = async (dryRun: boolean): Promise<Stats> => {
    const r = await post('/api/refs/backfill', { dryRun });
    expect(r.status).toBe(200);
    return (await r.json()) as Stats;
  };

  const docRefsOf = (refs: readonly Ref[] | undefined): string[] =>
    (refs ?? []).filter((r) => r.kind === 'doc').map((r) => (r as { docId: string }).docId);

  const makeTask = async (title: string): Promise<string> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, {
      title,
      goal: 'chores',
      assignee: 'human',
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'refs-backfill-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'refs-backfill-ws', goal: 'Mine the links.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const goals = await local(`/api/workspaces/${wsId}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goals: [{ title: 'Ship the linked flow' }], author: PERSON }),
    });
    expect(goals.status).toBe(200);
    goalId = ((await goals.json()) as { created: Array<{ id: string }> }).created[0]?.id ?? '';

    plainTaskId = await makeTask('Linked from the plan prose');
    bodyTaskId = await makeTask('Body links doc B');
    urlRefTaskId = await makeTask('Carries a url ref to doc B');

    // Doc B first — its id appears in fixtures for the other sources.
    const mdB = join(dataDir, 'refs-doc-b.md');
    writeFileSync(mdB, '# Doc B\n\nSupporting notes.\n');
    const docB = await post('/api/docs', { docId: 'refs-doc-b', type: 'markdown', sourceUrl: mdB });
    docBId = ((await docB.json()) as { docId: string }).docId;

    // Doc A's prose links the plain task and the goal — the ALIAS is what a
    // person pastes, so the doc itself is created under one.
    const mdA = join(dataDir, 'refs-doc-a.md');
    writeFileSync(
      mdA,
      [
        '# Plan A',
        '',
        `First [the plain task](/workspaces/${wsId}?task=${plainTaskId}).`,
        `Toward /workspaces/${wsId}?goal=${goalId} overall.`,
        '',
      ].join('\n'),
    );
    const docA = await post('/api/docs', { docId: 'refs-doc-a', type: 'markdown', sourceUrl: mdA });
    docAId = ((await docA.json()) as { docId: string }).docId;

    // A row filed FROM doc A: its origin already ties it — the backfill must
    // skip it even though doc A's prose does not mention it.
    const batch = await post(`/api/workspaces/${wsId}/tasks/batch`, {
      tasks: [{ title: 'Filed from doc A', assignee: 'human' }],
      sourceDoc: { docId: 'refs-doc-a', mode: 'discussion' },
    });
    expect(batch.status).toBe(200);
    originTaskId = ((await batch.json()) as { tasks: Array<{ id: string }> }).tasks[0]?.id ?? '';

    // bodyTask's body carries a bare legacy link to doc B, BY ALIAS.
    expect(handle.tasks.updateBodySnapshot(bodyTaskId, 'Details in /review/refs-doc-b now.')).toBe(
      true,
    );
    // urlRefTask holds doc B only as a pasted-URL ref — the untraversable
    // spelling the ticket measured at 25-of-36.
    const link = await post(`/api/tasks/${urlRefTaskId}/links`, {
      ref: { kind: 'url', url: `${base}/workspaces/${wsId}/docs/${docBId}` },
    });
    expect(link.status).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('dry run counts every recoverable ref and writes nothing', async () => {
    const stats = await backfill(true);
    expect(stats.dryRun).toBe(true);
    // plain task (from doc A prose) + body task + url-ref task = 3.
    expect(stats.taskRefsCreated).toBe(3);
    expect(stats.goalRefsCreated).toBe(1);
    expect(stats.urlRefsUpgraded).toBe(1);
    // The origin-covered row registers as existing, not as a create.
    expect(stats.skippedExisting).toBeGreaterThanOrEqual(0);
    // Nothing landed: the control that dryRun is actually dry.
    expect(docRefsOf(handle.tasks.getTask(plainTaskId)?.links)).toEqual([]);
    expect(docRefsOf(handle.tasks.getGoalRow(goalId)?.links)).toEqual([]);
  });

  it('the real run lands refs under canonical ids and honours origin ties', async () => {
    const stats = await backfill(false);
    expect(stats.taskRefsCreated).toBe(3);
    expect(stats.goalRefsCreated).toBe(1);
    expect(stats.urlRefsUpgraded).toBe(1);
    expect(stats.workspacesTouched).toEqual([wsId]);

    // Doc A was linked in prose by deep link; the ref stores its canonical id.
    expect(docRefsOf(handle.tasks.getTask(plainTaskId)?.links)).toEqual([docAId]);
    // The goal's tie rides the goal row.
    expect(docRefsOf(handle.tasks.getGoalRow(goalId)?.links)).toEqual([docAId]);
    // Alias in the body, canonical in the store.
    expect(docRefsOf(handle.tasks.getTask(bodyTaskId)?.links)).toEqual([docBId]);
    // The url ref stays (refs are annotations) AND the structured tie exists.
    const urlTask = handle.tasks.getTask(urlRefTaskId);
    expect(docRefsOf(urlTask?.links)).toEqual([docBId]);
    expect((urlTask?.links ?? []).some((r) => r.kind === 'url')).toBe(true);
    // Origin-covered row gained no duplicate links entry.
    expect(docRefsOf(handle.tasks.getTask(originTaskId)?.links)).toEqual([]);
  });

  it('a second run creates nothing — the idempotency contract', async () => {
    const again = await backfill(false);
    expect(again.taskRefsCreated).toBe(0);
    expect(again.goalRefsCreated).toBe(0);
    expect(again.urlRefsUpgraded).toBe(0);
    expect(again.workspacesTouched).toEqual([]);
    // Everything it saw the first time reads as already existing.
    expect(again.skippedExisting).toBeGreaterThanOrEqual(4);
    expect(docRefsOf(handle.tasks.getTask(plainTaskId)?.links)).toEqual([docAId]);
  });

  it('a settled edit scans just that doc: a link written today needs no backfill', async () => {
    const lateTaskId = await makeTask('Linked after the sweep');
    // Write the link into doc A's live prose the way an editor would, then
    // settle the authoring burst (the same commit the debounce timer makes).
    const room = handle.rooms.get(docAId);
    expect(room).toBeDefined();
    const before = docRefsOf(handle.tasks.getTask(lateTaskId)?.links);
    expect(before).toEqual([]); // control
    room?.ydoc.transact(() => {
      const frag = prose.getProseFragment(room.ydoc);
      frag.insert(
        0,
        prose.parseMarkdownBlocks(`Also /workspaces/${wsId}?task=${lateTaskId} here.`),
      );
    }, 'agent');
    handle.rooms.settledContentRevision(docAId);
    expect(docRefsOf(handle.tasks.getTask(lateTaskId)?.links)).toEqual([docAId]);
  });

  it("backfilled refs — the goal row's especially — survive a restart", async () => {
    // GoalRow.links is row-owned: `syncGoalRows` must not rebuild it away on
    // hydrate, or every backfill would silently undo itself at the next boot.
    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    expect(docRefsOf(handle.tasks.getGoalRow(goalId)?.links)).toEqual([docAId]);
    expect(docRefsOf(handle.tasks.getTask(plainTaskId)?.links)).toEqual([docAId]);
  });
});
