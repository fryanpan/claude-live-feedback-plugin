/**
 * Evidence support was removed from the product. Two promises outlive it, and
 * this file is the only place either one is pinned:
 *
 *  1. **The shared server keeps accepting the old payload.** A peer running a
 *     plugin bundle from a session that has not restarted goes on POSTing
 *     `evidence` on every forward transition, and goes on calling the amend
 *     route. Neither may start failing: a caller nobody can restart, getting
 *     an unexplainable error from its own version, is the exact hazard
 *     CLAUDE.md names. Accept and ignore — never 400, never 500.
 *  2. **Evidence already on disk stays on disk.** The chosen option was
 *     "existing transitions keep their stored evidence but nothing reads or
 *     renders it". Reading stops; the record does not move. Nothing here is
 *     satisfied by an assertion that no migration was written — the fixture is
 *     a sidecar with real evidence on it, and the check is what the sidecar
 *     holds after the store has hydrated, written, and persisted over it.
 *
 * All fixtures are synthetic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Task, TaskStore, tasksSidecarPath } from '../src/tasks.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

/** What an older bundle puts on the wire, verbatim. */
const LEGACY_EVIDENCE = {
  commit: 'abc1234def',
  threadRef: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-2' },
};

describe('a legacy evidence payload on the transition route', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

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

  const mkTask = async (title: string): Promise<Task> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
    return ((await r.json()) as { task: Task }).task;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'legacy-evidence-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'legacy-evidence-ws' });
    wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('applies the move and never refuses over the field', async () => {
    const t = await mkTask('an old bundle still sends evidence');
    const r = await post(`/api/tasks/${t.id}/transition`, {
      to: 'done',
      author: AGENT,
      note: 'shipped',
      evidence: LEGACY_EVIDENCE,
      usage: { inputTokens: 900, outputTokens: 120 },
    });
    // The whole compatibility promise, in one number.
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.status).toBe('done');

    // Positive control on the rest of the payload: the fields that DID survive
    // the removal still land, so a green status above is not a route that
    // quietly dropped everything.
    const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
      tasks: Task[];
    };
    const stored = listed.tasks.find((x) => x.id === t.id);
    expect(stored?.transitions.at(-1)?.note).toBe('shipped');
    expect(stored?.transitions.at(-1)?.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
  });

  it('accepts the retired amend route without an error the caller cannot explain', async () => {
    const t = await mkTask('an old bundle still amends');
    await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });

    const r = await post(`/api/tasks/${t.id}/evidence`, {
      author: AGENT,
      evidence: { commit: '621f371abc' },
      note: 'wrote the sha from memory',
    });
    // Not a 404, not a 400, not a 500. The route is a no-op, and a no-op that
    // answers 2xx is the only kind an un-restartable caller can survive.
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('still answers an unknown task the way it always did', async () => {
    // 404 is not the hazard — it is what this route already said, and what
    // the transition route says next door, so an old caller has always had to
    // handle it. What must never appear is a NEW refusal (a 400 over the
    // payload) or a 500, either of which reads to the caller as its own
    // version being broken.
    const r = await post('/api/tasks/t-ghost/evidence', {
      author: AGENT,
      evidence: { commit: '621f371abc' },
    });
    expect(r.status).toBe(404);
  });
});

describe('evidence already stored on a transition', () => {
  let dataDir: string;
  let store: TaskStore;
  const wsId = 'w-storedevid1';
  const taskId = 't-stored-evidence';
  const OLD_TS = 1_700_000_000_000;

  /** A sidecar written by a build that still recorded evidence — a transition
   *  carrying its own `evidence`, plus an after-the-fact `amendments` entry. */
  const seeded = () => ({
    workspace: {
      id: wsId,
      name: 'stored-evidence',
      goals: [{ id: 'g1-loop', title: '1. Close the loop' }],
      docIds: [],
      createdAt: OLD_TS,
    },
    tasks: [
      {
        id: taskId,
        workspaceId: wsId,
        title: 'a move recorded back when evidence was a thing',
        status: 'in-progress',
        goal: 'g1-loop',
        order: 1,
        assignee: 'Jordan',
        createdAt: OLD_TS,
        updatedAt: OLD_TS,
        links: [],
        after: [],
        transitions: [
          {
            ts: OLD_TS,
            from: 'todo',
            to: 'in-progress',
            by: { id: 'agent-old', name: 'Old Bundle', kind: 'agent' },
            note: 'started',
            evidence: { commit: 'b2ba21edef' },
            amendments: [
              {
                ts: OLD_TS + 1000,
                by: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
                evidence: { commit: '621f371abc' },
                note: 'the first sha resolved to nothing',
                supersedes: { commit: 'b2ba21edef' },
              },
            ],
          },
        ],
      },
    ],
  });

  /** The stored transition, exactly as the sidecar on disk holds it. */
  const rowOnDisk = (): Record<string, unknown> => {
    const raw = JSON.parse(readFileSync(tasksSidecarPath(dataDir, wsId), 'utf8')) as {
      tasks?: { id: string; transitions?: Record<string, unknown>[] }[];
    };
    const task = raw.tasks?.find((t) => t.id === taskId);
    const row = task?.transitions?.find((t) => t.ts === OLD_TS);
    if (!row) throw new Error('the seeded transition is not on disk at all');
    return row;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'stored-evidence-'));
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(tasksSidecarPath(dataDir, wsId), `${JSON.stringify(seeded(), null, 2)}\n`);
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('survives a hydrate, a later transition, and the persist that follows', async () => {
    // Positive control: the fixture really is on disk with evidence on it,
    // before anything has had a chance to rewrite the file.
    expect(rowOnDisk().evidence).toEqual({ commit: 'b2ba21edef' });

    const res = store.transition(taskId, 'done', { actor: AGENT });
    expect(res.ok).toBe(true);
    // The debounced save rewrites the WHOLE sidecar from memory, so this is
    // the moment a dropped field would be destroyed on disk rather than merely
    // hidden from a reader.
    await new Promise((r) => setTimeout(r, 60));

    const row = rowOnDisk();
    expect(row.evidence).toEqual({ commit: 'b2ba21edef' });
    expect(row.amendments).toEqual([
      {
        ts: OLD_TS + 1000,
        by: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
        evidence: { commit: '621f371abc' },
        note: 'the first sha resolved to nothing',
        supersedes: { commit: 'b2ba21edef' },
      },
    ]);
    // And the new move recorded none of its own — the write path is what was
    // removed, not the record.
    const fresh = store.getTask(taskId)?.transitions.at(-1);
    expect(fresh?.to).toBe('done');
    expect(fresh?.evidence).toBeUndefined();
  });
});
