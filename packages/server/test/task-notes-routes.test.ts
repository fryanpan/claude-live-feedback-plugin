/**
 * Status notes with an EXPLICIT task: `POST /api/tasks/:id/notes`. The hooks
 * post to `/api/agent-notes` and let the server find the agent's current row;
 * an MCP verb knows which row it is reporting on and names it. Same body
 * validation as the hook route (`parseAgentNote` — a shared agent name is
 * refused the same way), same store append, same projection; the only new
 * answers are 404 for a row that does not exist and the third kind, `status`.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TASK_NOTES_READ_CAP } from '../src/agent-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

const PERSON = { id: 'known-sam', name: 'Sam Reviewer', kind: 'person' };
const AGENT = { id: 'agent-beacon-bot', name: 'Beacon Bot', kind: 'agent' };

type ProjectedNote = { at: number; kind: string; text: string; agent: string };
type ProjectedTask = { id: string; notes?: ProjectedNote[] };

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('task status notes route', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-notes-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function board(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'archive-index', leadAgentId: AGENT.id }),
    );
    return workspace.id;
  }

  /** A todo row nobody has claimed — the hook route would find NO current
   *  task for the agent, which is exactly why an explicit route exists. */
  async function todoRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        author: PERSON,
      }),
    );
    return task.id;
  }

  function projected(workspaceId: string, taskId: string): ProjectedTask {
    const room = handle.rooms.get(workspaceRoomId(workspaceId));
    if (!room) throw new Error('ws room was not created');
    const row = room.ydoc.getMap('tasks').get(taskId) as ProjectedTask | undefined;
    if (!row) throw new Error('task was not projected');
    return row;
  }

  it('appends a status note to the named row and projects it, kind intact', async () => {
    const wsId = await board();
    const taskId = await todoRow(wsId, 'Index the archive');
    const before = handle.tasks.getTask(taskId)?.updatedAt ?? 0;
    await settle(5);

    const r = await post(`/api/tasks/${taskId}/notes`, {
      agent: AGENT.name,
      kind: 'status',
      text: 'PR open, waiting on CI.\n\n- typecheck green\n- lint green',
      sessionId: 'sess-9',
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, taskId, workspaceId: wsId });
    await settle();

    const stored = handle.tasks.getTask(taskId);
    expect(stored?.notes?.map((n) => [n.kind, n.agent, n.sessionId])).toEqual([
      ['status', AGENT.name, 'sess-9'],
    ]);
    // Multi-line text is stored verbatim: the full update, not a one-liner.
    expect(stored?.notes?.[0]?.text).toContain('- lint green');
    // The row moved — the stall clock's secondary signal.
    expect(stored?.updatedAt ?? 0).toBeGreaterThan(before);

    const row = projected(wsId, taskId);
    expect(row.notes?.map((n) => [n.kind, n.text.split('\n')[0], n.agent])).toEqual([
      ['status', 'PR open, waiting on CI.', AGENT.name],
    ]);
    expect(JSON.stringify(row.notes)).not.toContain('sess-9');

    // And the per-agent ring saw it too, tagged with the row.
    const ring = await jj<{ notes: Array<{ kind: string; taskId?: string }> }>(
      await fetch(`${base}/api/agents/${encodeURIComponent(AGENT.name)}/notes`),
    );
    expect(ring.notes.map((n) => [n.kind, n.taskId])).toEqual([['status', taskId]]);
  });

  it('404s an unknown row, 400s a bad body, 405s the wrong method', async () => {
    const wsId = await board();
    const taskId = await todoRow(wsId, 'Index the archive');

    const missing = await post('/api/tasks/t-nope/notes', {
      agent: AGENT.name,
      kind: 'status',
      text: 'x',
    });
    expect(missing.status).toBe(404);

    const bad: Array<[string, unknown]> = [
      ['not json', '{nope'],
      ['no agent', { kind: 'status', text: 'x' }],
      ['shared agent name', { agent: 'agent', kind: 'status', text: 'x' }],
      ['bad kind', { agent: AGENT.name, kind: 'shout', text: 'x' }],
      ['missing text', { agent: AGENT.name, kind: 'status' }],
      ['empty text', { agent: AGENT.name, kind: 'status', text: '  ' }],
    ];
    for (const [label, body] of bad) {
      const r = await post(`/api/tasks/${taskId}/notes`, body);
      expect(r.status, label).toBe(400);
    }
    expect((await fetch(`${base}/api/tasks/${taskId}/notes`)).status).toBe(405);
    // Nothing above landed on the row.
    expect(handle.tasks.getTask(taskId)?.notes ?? []).toHaveLength(0);
  });

  it('the hook route accepts kind "status" too, still resolving the current row', async () => {
    const wsId = await board();
    const taskId = await todoRow(wsId, 'Index the archive');
    await jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId: AGENT.id,
        runtime: 'claude-code-local',
      }),
    );
    await jj(
      await post(`/api/tasks/${taskId}/transition`, {
        to: 'in-progress',
        author: AGENT,
        workspaceId: wsId,
      }),
    );
    const r = await post('/api/agent-notes', {
      agent: AGENT.name,
      kind: 'status',
      text: 'Branch pushed.',
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, taskId });
    expect(handle.tasks.getTask(taskId)?.notes?.map((n) => n.kind)).toEqual(['status']);
  });

  it('the projection read cap holds for status notes', async () => {
    const wsId = await board();
    const taskId = await todoRow(wsId, 'Index the archive');
    for (let i = 0; i < TASK_NOTES_READ_CAP + 3; i++) {
      const r = await post(`/api/tasks/${taskId}/notes`, {
        agent: AGENT.name,
        kind: 'status',
        text: `update ${i}`,
      });
      expect(r.status).toBe(202);
    }
    await settle();
    const row = projected(wsId, taskId);
    expect(row.notes).toHaveLength(TASK_NOTES_READ_CAP);
    expect(row.notes?.[0]?.text).toBe(`update ${TASK_NOTES_READ_CAP + 2}`);
    expect(row.notes?.every((n) => n.kind === 'status')).toBe(true);
  });

  it('ignores a body taskId — the URL names the row', async () => {
    const wsId = await board();
    const target = await todoRow(wsId, 'Wire the index');
    const other = await todoRow(wsId, 'Another row');
    const r = await post(`/api/tasks/${target}/notes`, {
      agent: AGENT.name,
      kind: 'status',
      text: 'On the URL row',
      // Not even a string: this route predates the field and must not start
      // validating it (the hook route is where a body taskId means something).
      taskId: 42,
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, taskId: target });
    await settle();
    expect(handle.tasks.getTask(target)?.notes?.map((n) => n.text)).toEqual(['On the URL row']);
    expect(handle.tasks.getTask(other)?.notes ?? []).toHaveLength(0);
  });
});
