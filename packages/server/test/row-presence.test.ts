/**
 * "Is somebody already on this row?" — asked where the pickup decision is
 * actually made.
 *
 * The fixture is the 2026-08-17 collision (`t-K69wxtRLCn2a`): two sessions
 * dispatched onto one task, hours of work each, two complete answers, one
 * thrown away. Neither could detect the other because the surface they pick
 * work from — the queue — carried a bare `assignee` STRING and nothing about
 * whether anyone was behind it.
 *
 * Two properties every assertion here is really about:
 *
 *  - The read is built on RECENCY, never on content identity. Nothing in this
 *    file commits anything, pushes anything, or moves a sha — a session that
 *    thinks for an hour produces no new content and must still read as taken.
 *    A sha-based signal scores zero on every case below.
 *  - It only ever informs. There is no assertion that a second claim is
 *    refused, because a second claim must not be refused: two agents on one
 *    row is sometimes right, and on `t-K69wxtRLCn2a` the disagreement between
 *    the two designs is what made the choice legible.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

interface QueueRow {
  id: string;
  title: string;
  status: string;
  assignee: string;
  ownerSession?: { agentId: string; state: string; stateLabel: string };
  claimedBy?: {
    agentId: string;
    state: string;
    stateLabel: string;
    at: number;
    lastHeartbeat: number;
    lastToolCallAt: number;
    pluginVersion?: string;
  };
}

describe('the queue says who is already on a row', () => {
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

  /** The pair every fixture needs: a session on the board, and the display
   *  name a task can be owned by. Attach sends the identity id; a task owner
   *  is the display name — that join is half of what is under test. */
  const attach = async (workspaceId: string, agentId: string, pluginVersion?: string) =>
    jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId,
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
        ...(pluginVersion !== undefined ? { pluginVersion } : {}),
      }),
    );

  const queue = async (workspaceId: string): Promise<QueueRow[]> => {
    const { tasks } = await jj<{ tasks: QueueRow[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/next`),
    );
    return tasks;
  };

  const setup = async (opts?: { heartbeatFreshMs?: number }) => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-row-presence-'));
    handle = createServer({
      port: 0,
      dataDir,
      ...(opts?.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
    });
    base = `http://localhost:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'atlas', goal: 'Ship the atlas.' }),
    );
    return workspace.id;
  };

  /**
   * A row on the queue. The dispatcher FILES it and a person vets it in the
   * next breath, because an agent's own create lands in `triage` and the queue
   * never returns a triage row — without the second call every case below
   * would be asserting over an empty queue. The vetting move touches neither
   * `assignee` nor any claim, which is what these cases actually read.
   */
  const mkTask = async (workspaceId: string, title: string, assignee?: string) => {
    const created = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        ...(assignee !== undefined ? { assignee } : {}),
        author: { id: 'agent-dispatcher', name: 'Dispatcher', kind: 'agent' },
      }),
    );
    await post(`/api/tasks/${created.task.id}/transition`, {
      to: 'todo',
      author: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
    });
    return created;
  };

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('names the live session behind an owned row, and stays quiet on a free one', async () => {
    const wsId = await setup();
    await attach(wsId, 'agent-cartographer', '0.1.89');

    const taken = await mkTask(wsId, 'redline the atlas', 'Cartographer');
    const free = await mkTask(wsId, 'nobody has this one');

    const rows = new Map((await queue(wsId)).map((r) => [r.id, r]));

    const owned = rows.get(taken.task.id);
    expect(owned?.ownerSession?.agentId).toBe('agent-cartographer');
    expect(owned?.ownerSession?.state).toBe('active');

    // The positive control's other half: the same read, on the same
    // response, saying nothing about a row nobody is on. Without this the
    // assertion above would pass on a payload that stamped every row.
    expect(rows.get(free.task.id)?.ownerSession).toBeUndefined();
    expect(rows.get(free.task.id)?.claimedBy).toBeUndefined();
  });

  it('names the session that CLAIMED a row, even when nobody assigned it', async () => {
    // The collision shape exactly. `task_transition` does not touch
    // `assignee`, so a session that takes a row off the queue and starts
    // working leaves the owner field empty — and every presence read keyed on
    // the owner answers "nobody" while somebody is hours deep.
    const wsId = await setup();
    await attach(wsId, 'agent-first-taker');
    const contested = await mkTask(wsId, 'two sessions, one row');

    await jj(
      await post(`/api/tasks/${contested.task.id}/transition`, {
        to: 'in-progress',
        author: { id: 'agent-first-taker', name: 'First Taker', kind: 'agent' },
      }),
    );

    const row = (await queue(wsId)).find((r) => r.id === contested.task.id);
    // A row nobody assigned carries its FILER as owner, which is the sharp
    // edge: the owner-keyed read names the session that wrote the ticket, not
    // the one working it. Here the filer never attached, so it names nobody —
    // and the row still has somebody on it.
    expect(row?.assignee).toBe('Dispatcher');
    expect(row?.ownerSession).toBeUndefined();
    expect(row?.claimedBy?.agentId).toBe('agent-first-taker');
    expect(row?.claimedBy?.state).toBe('active');
    // WHEN it was taken, which is the number a second dispatcher weighs.
    expect(row?.claimedBy?.at).toBeGreaterThan(0);
  });

  it('the second claim is recorded, never refused', async () => {
    // One-directional by construction: the read informs and the write always
    // goes through. `t-K69wxtRLCn2a` produced two designs whose disagreement
    // made the choice legible — a gate here would have destroyed that.
    const wsId = await setup();
    await attach(wsId, 'agent-first-taker');
    await attach(wsId, 'agent-second-taker');
    const contested = await mkTask(wsId, 'two sessions, one row');

    await jj(
      await post(`/api/tasks/${contested.task.id}/transition`, {
        to: 'in-progress',
        author: { id: 'agent-first-taker', name: 'First Taker', kind: 'agent' },
      }),
    );
    // The second taker cannot re-enter in-progress (the gate refuses a move
    // that changes nothing), so it does what a real second taker does: works
    // the row and reports. The claim it can make is the next transition, and
    // the queue must follow the LATEST claim rather than the first.
    const second = await post(`/api/tasks/${contested.task.id}/transition`, {
      to: 'todo',
      author: { id: 'agent-second-taker', name: 'Second Taker', kind: 'agent' },
    });
    expect(second.ok).toBe(true);
    const reclaim = await post(`/api/tasks/${contested.task.id}/transition`, {
      to: 'in-progress',
      author: { id: 'agent-second-taker', name: 'Second Taker', kind: 'agent' },
    });
    expect(reclaim.ok).toBe(true);

    const row = (await queue(wsId)).find((r) => r.id === contested.task.id);
    expect(row?.claimedBy?.agentId).toBe('agent-second-taker');
  });

  it('reads a session that has gone quiet as quiet, not as gone', async () => {
    // The third state. A row worked continuously with no push still reads as
    // taken — what changes is the LABEL, so a dispatcher can tell "on it and
    // progressing" from "on it and silent for N minutes" and decide for
    // itself. Nothing here produces content, which is the point: a
    // sha-comparing signal reads both of these as abandoned.
    const wsId = await setup({ heartbeatFreshMs: 1 });
    await attach(wsId, 'agent-quiet-one');
    const taken = await mkTask(wsId, 'silently mid-pipeline', 'Quiet One');
    await jj(
      await post(`/api/tasks/${taken.task.id}/transition`, {
        to: 'in-progress',
        author: { id: 'agent-quiet-one', name: 'Quiet One', kind: 'agent' },
      }),
    );

    await new Promise((r) => setTimeout(r, 5));
    const row = (await queue(wsId)).find((r) => r.id === taken.task.id);
    // Still named — absence would read as "free to take".
    expect(row?.ownerSession?.agentId).toBe('agent-quiet-one');
    expect(row?.ownerSession?.state).toBe('away');
    expect(row?.claimedBy?.state).toBe('away');
    expect(row?.claimedBy?.stateLabel).toContain('away');
  });

  it('vouches for nobody it cannot name: a person, and a stranger', async () => {
    const wsId = await setup();
    await attach(wsId, 'agent-cartographer');
    const person = await mkTask(wsId, 'needs Bryan', 'human');
    const stranger = await mkTask(wsId, 'owned by someone unattached', 'Ada Fenwick');

    const rows = new Map((await queue(wsId)).map((r) => [r.id, r]));
    expect(rows.get(person.task.id)?.ownerSession).toBeUndefined();
    expect(rows.get(stranger.task.id)?.ownerSession).toBeUndefined();
    // ...and the control that makes those two mean something: the same
    // response DOES name a session where one is real.
    const owned = await mkTask(wsId, 'owned by the attached one', 'Cartographer');
    const after = (await queue(wsId)).find((r) => r.id === owned.task.id);
    expect(after?.ownerSession?.agentId).toBe('agent-cartographer');
  });

  it('never carries the host-machine endpoint onto a queue row', async () => {
    const wsId = await setup();
    await jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId: 'agent-cartographer',
        runtime: 'managed-agent',
        capabilities: ['tasks.write'],
        endpoint: 'http://192.168.1.44:9999/agent',
      }),
    );
    const taken = await mkTask(wsId, 'redline the atlas', 'Cartographer');
    await jj(
      await post(`/api/tasks/${taken.task.id}/transition`, {
        to: 'in-progress',
        author: { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' },
      }),
    );

    const res = await fetch(`${base}/api/workspaces/${wsId}/next`);
    const raw = await res.clone().text();
    const rows = await jj<{ tasks: QueueRow[] }>(res);
    const row = rows.tasks.find((r) => r.id === taken.task.id);
    // Structural first — this is the assertion, and it cannot be satisfied
    // by a coincidence of formatting.
    expect(row?.ownerSession).not.toHaveProperty('endpoint');
    expect(row?.claimedBy).not.toHaveProperty('endpoint');
    // Then the substring sweep, which is only meaningful because the row it
    // is scanning demonstrably HAS a session on it.
    expect(row?.claimedBy?.agentId).toBe('agent-cartographer');
    expect(raw).not.toContain('192.168.1.44');
  });
});
