/**
 * The stored ≤20-word goal summary, driven through the real route table.
 *
 * The display rule itself is pure and lives in `@feedback/core/goal-summary`
 * (unit-tested there). What this file proves is the part no unit test can:
 * that the route forwards `summary`, that the store keeps it, that it reaches
 * the projection every board renders from — and that a goal edit does not
 * leave a summary behind describing the goal it replaced.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { goalTextHash } from '@feedback/core/goal-summary';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const LONG_GOAL = [
  'Make the intake queue smooth for the whole crew, then prove it with a week of real traffic.',
  'After that, wire the reporting surface so nobody has to ask where a request went.',
  'Everything else waits until those two hold under load.',
].join('\n\n');

interface StoredSummaryView {
  text: string;
  goalHash: string;
  ts: number;
}

describe('workspace goal summary', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

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

  const put = (path: string, body: unknown) =>
    local(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const readWorkspace = async (id: string) => {
    const r = await local(`/api/workspaces/${id}`);
    const { workspace } = (await r.json()) as {
      workspace: { goal: string; goalSummary?: StoredSummaryView };
    };
    return workspace;
  };

  const newWorkspace = async (goal: string): Promise<string> => {
    const r = await post('/api/workspaces', { name: 'intake', goal });
    const { workspace } = (await r.json()) as { workspace: { id: string } };
    return workspace.id;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goalsum-data-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores a summary sent alongside the goal, and reads it back', async () => {
    const id = await newWorkspace('Old goal.');
    const r = await put(`/api/workspaces/${id}/goal`, {
      goal: LONG_GOAL,
      summary: 'Smooth intake first, reporting second, everything else after.',
      author: PERSON,
    });
    expect(r.status).toBe(200);

    const ws = await readWorkspace(id);
    expect(ws.goal).toBe(LONG_GOAL);
    expect(ws.goalSummary?.text).toBe(
      'Smooth intake first, reporting second, everything else after.',
    );
    // Stamped against the goal it describes, so a later edit can invalidate it.
    expect(ws.goalSummary?.goalHash).toBe(goalTextHash(LONG_GOAL));
  });

  it('accepts a summary on its own, without restating the goal', async () => {
    const id = await newWorkspace(LONG_GOAL);
    const r = await put(`/api/workspaces/${id}/goal`, {
      summary: 'Intake, then reporting, then the rest.',
      author: PERSON,
    });
    expect(r.status).toBe(200);

    const ws = await readWorkspace(id);
    // The goal is untouched — a summary-only write must not be able to
    // overwrite the north star with a stale copy of it.
    expect(ws.goal).toBe(LONG_GOAL);
    expect(ws.goalSummary?.text).toBe('Intake, then reporting, then the rest.');
  });

  it('drops a summary the goal edit did not replace', async () => {
    const id = await newWorkspace(LONG_GOAL);
    await put(`/api/workspaces/${id}/goal`, {
      summary: 'Intake, then reporting, then the rest.',
      author: PERSON,
    });
    // Positive control: it is really stored before we assert it goes away.
    expect((await readWorkspace(id)).goalSummary?.text).toBe(
      'Intake, then reporting, then the rest.',
    );

    await put(`/api/workspaces/${id}/goal`, {
      goal: 'Actually: stop everything and fix the outage.',
      author: PERSON,
    });
    const ws = await readWorkspace(id);
    expect(ws.goal).toBe('Actually: stop everything and fix the outage.');
    expect(ws.goalSummary).toBeUndefined();
  });

  it('keeps a summary supplied in the same call as the goal it describes', async () => {
    const id = await newWorkspace(LONG_GOAL);
    await put(`/api/workspaces/${id}/goal`, {
      goal: 'Actually: stop everything and fix the outage, then write the postmortem.',
      summary: 'Fix the outage, then write it up.',
      author: PERSON,
    });
    const ws = await readWorkspace(id);
    expect(ws.goalSummary?.text).toBe('Fix the outage, then write it up.');
    expect(ws.goalSummary?.goalHash).toBe(goalTextHash(ws.goal));
  });

  it('clears the summary when an empty one is sent', async () => {
    const id = await newWorkspace(LONG_GOAL);
    await put(`/api/workspaces/${id}/goal`, { summary: 'Intake first.', author: PERSON });
    expect((await readWorkspace(id)).goalSummary?.text).toBe('Intake first.');

    await put(`/api/workspaces/${id}/goal`, { summary: '   ', author: PERSON });
    expect((await readWorkspace(id)).goalSummary).toBeUndefined();
  });

  it('still refuses a request that names neither a goal nor a summary', async () => {
    const id = await newWorkspace(LONG_GOAL);
    const r = await put(`/api/workspaces/${id}/goal`, { author: PERSON });
    expect(r.status).toBe(400);
  });

  it('projects the summary into the board every browser renders from', async () => {
    const id = await newWorkspace(LONG_GOAL);
    await put(`/api/workspaces/${id}/goal`, {
      summary: 'Intake, then reporting, then the rest.',
      author: PERSON,
    });
    // The board reads the workspace map of the hub room, not the REST payload.
    const room = handle.rooms.getOrCreate(workspaceRoomId(id), {
      type: 'workspace',
      title: 'intake',
    });
    const wsMap = room.ydoc.getMap('workspace');
    // Positive control: the map is populated at all before asserting a field.
    expect(wsMap.get('goal')).toBe(LONG_GOAL);
    expect((wsMap.get('goalSummary') as StoredSummaryView | undefined)?.text).toBe(
      'Intake, then reporting, then the rest.',
    );
  });
});
