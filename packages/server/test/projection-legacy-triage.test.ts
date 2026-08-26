import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

const AGENT = { id: 'agent-x', name: 'Search Revamp', kind: 'agent' };

/**
 * Legacy `triagedAgainst` rows carry the ENTIRE workspace goal text — the
 * writer stamped `goal: state.workspace.goal` until it was narrowed to
 * `{ goalId, ts }`. The data outlived the fix: measured on the live hub
 * board, 187 of 339 tasks each carry a ~3KB goal blob, 546KB of the board
 * ydoc that every open ships to every reader (t-scWMQmOZcpu1, the iPad
 * 10-second load). The projection is the cut point — same precedent as
 * `evidence`: the STORE keeps whatever the sidecar recorded, and the wire
 * gets the declared shape.
 */
describe('projection narrows legacy triagedAgainst rows', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  let taskId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'proj-triage-'));
    // Phase 1: a normal board with one placed task, then stop the server so
    // the sidecar can be aged into the legacy shape by hand.
    let seed: ServerHandle | null = createServer({ port: 0, dataDir });
    const seedBase = `http://localhost:${seed.port}`;
    const mk = await fetch(`${seedBase}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'aged board', goal: 'Ship it.' }),
    });
    wsId = ((await mk.json()) as { workspace: { id: string } }).workspace.id;
    const mkTask = await fetch(`${seedBase}/api/workspaces/${wsId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AGENT, title: 'Old row', goal: 'chores' }),
    });
    taskId = ((await mkTask.json()) as { task: { id: string } }).task.id;
    await seed.stop();
    seed = null;

    // Age the sidecar: the shape the pre-fix writer produced.
    const sidecar = join(dataDir, 'workspaces', `${wsId}.tasks.json`);
    const parsed = JSON.parse(readFileSync(sidecar, 'utf8'));
    const row = parsed.tasks.find((t: { id: string }) => t.id === taskId);
    row.triagedAgainst = {
      goalId: 'chores',
      goal: 'The whole goal body, three kilobytes of it. '.repeat(64),
      ts: 1755400000000,
    };
    writeFileSync(sidecar, JSON.stringify(parsed));

    // Phase 2: the server every reader actually talks to.
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the board ydoc row carries only { goalId, ts }', () => {
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room was not created');
    const row = room.ydoc.getMap('tasks').get(taskId) as {
      triagedAgainst?: Record<string, unknown>;
    };
    expect(row.triagedAgainst).toEqual({ goalId: 'chores', ts: 1755400000000 });
  });

  it('the store record keeps what the sidecar held — narrowing is wire-only', async () => {
    const res = await fetch(`${base}/api/workspaces/${wsId}/tasks`);
    const body = (await res.json()) as {
      tasks: Array<{ id: string; triagedAgainst?: { goal?: string } }>;
    };
    const row = body.tasks.find((t) => t.id === taskId);
    // Positive control on the aging itself: if the fat field never survived
    // hydrate, the first test would pass vacuously.
    expect(row?.triagedAgainst?.goal).toContain('three kilobytes');
  });
});
