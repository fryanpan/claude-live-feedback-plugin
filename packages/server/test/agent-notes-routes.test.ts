/**
 * Agent turn / denial notes over REST: the plugin's Stop and PermissionDenied
 * hooks post one-liners to `POST /api/agent-notes`, the server pins each to
 * the agent's CURRENT task (its latest in-progress claim) and exposes it on
 * the task's projected detail, newest first; a note from an agent holding no
 * task lands only in the per-agent ring buffer behind
 * `GET /api/agents/:name/notes`.
 *
 * The server stores the text VERBATIM — the hook is what reduces a message
 * to a shape. The "secret-looking value survives" case below is the positive
 * control for that: a server that quietly filtered would pass every other
 * test here and still hide the fact from the hook's author.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_NOTE_RING_CAP,
  TASK_NOTES_READ_CAP,
  TASK_NOTES_STORE_CAP,
} from '../src/agent-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

type ProjectedNote = { at: number; kind: string; text: string; agent: string };
type ProjectedTask = { id: string; notes?: ProjectedNote[] };
type RingNote = ProjectedNote & { taskId?: string; sessionId?: string };

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('agent notes routes', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const note = (agent: string, text: string, extra: Record<string, unknown> = {}) =>
    post('/api/agent-notes', { agent, kind: 'turn', text, at: Date.now(), ...extra });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-notes-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(name = 'search-revamp'): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name, leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/api/workspaces/${workspace.id}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    return workspace.id;
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON, workspaceId }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
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

  const ring = async (agent: string) =>
    jj<{ notes: RingNote[] }>(await fetch(`${base}/api/agents/${encodeURIComponent(agent)}/notes`));

  it('refuses a request from a host the server does not recognise', async () => {
    const r = await post(
      '/api/agent-notes',
      { agent: LEAD.name, kind: 'turn', text: 'Opened the PR' },
      { host: 'notes.attacker.example' },
    );
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
    const g = await fetch(`${base}/api/agents/${LEAD.name}/notes`, {
      headers: { host: 'notes.attacker.example' },
    });
    expect(g.status).toBe(403);
  });

  it('400s a malformed body and 405s the wrong method', async () => {
    const bad: Array<[string, unknown]> = [
      ['not json', '{nope'],
      ['no agent', { kind: 'turn', text: 'x' }],
      ['empty agent', { agent: '   ', kind: 'turn', text: 'x' }],
      ['shared agent name', { agent: 'agent', kind: 'turn', text: 'x' }],
      ['bad kind', { agent: 'Cartographer', kind: 'shout', text: 'x' }],
      ['missing text', { agent: 'Cartographer', kind: 'turn' }],
      ['empty text', { agent: 'Cartographer', kind: 'denial', text: '  ' }],
      ['non-string text', { agent: 'Cartographer', kind: 'turn', text: 42 }],
      ['non-numeric at', { agent: 'Cartographer', kind: 'turn', text: 'x', at: 'now' }],
    ];
    for (const [label, body] of bad) {
      const r = await post('/api/agent-notes', body);
      expect(r.status, label).toBe(400);
    }
    expect((await fetch(`${base}/api/agent-notes`)).status).toBe(405);
    expect((await fetch(`${base}/api/agents/${LEAD.name}/notes`, { method: 'POST' })).status).toBe(
      405,
    );
    expect((await fetch(`${base}/api/agents/agent/notes`)).status).toBe(400);
  });

  it('pins a note to the agent’s current task and projects it newest first', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    const first = await note(LEAD.name, 'Read the scout digest', { sessionId: 'sess-1' });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ ok: true, taskId, workspaceId: wsId });
    const second = await post('/api/agent-notes', {
      agent: LEAD.name,
      kind: 'denial',
      text: 'git rm',
      sessionId: 'sess-1',
      cwd: '/somewhere/private',
    });
    expect(second.status).toBe(202);
    await settle();

    // The store: append order, the raw session id kept for the pane.
    const stored = handle.tasks.getTask(taskId);
    expect(stored?.notes?.map((n) => [n.kind, n.text, n.agent, n.sessionId])).toEqual([
      ['turn', 'Read the scout digest', LEAD.name, 'sess-1'],
      ['denial', 'git rm', LEAD.name, 'sess-1'],
    ]);
    // Host paths are not workspace content.
    expect(JSON.stringify(stored?.notes)).not.toContain('/somewhere/private');

    // The board's read: newest first, no session id, no host path.
    const row = projected(wsId, taskId);
    expect(row.notes?.map((n) => [n.kind, n.text, n.agent])).toEqual([
      ['denial', 'git rm', LEAD.name],
      ['turn', 'Read the scout digest', LEAD.name],
    ]);
    expect(JSON.stringify(row.notes)).not.toContain('sess-1');
    expect(JSON.stringify(row.notes)).not.toContain('/somewhere/private');

    // The audit trail carries it as an event of its own.
    const log = await Bun.file(join(dataDir, 'workspaces', `${wsId}.events.jsonl`)).text();
    expect(log).toContain('"event":"task.noted"');
    expect(log).toContain('Read the scout digest');
  });

  it('follows the LATEST claim when the agent holds two in-progress rows, folding the name', async () => {
    const wsId = await boardWithLead();
    const older = await inProgressRow(wsId, 'Older claim');
    await settle(5);
    const newer = await inProgressRow(wsId, 'Newer claim');

    // A lowercase spelling resolves through the claim transition's actor id,
    // not the verbatim assignee string.
    const r = await note('cartographer', 'Pushed the branch');
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ taskId: newer });
    await settle();
    expect(projected(wsId, newer).notes?.map((n) => n.text)).toEqual(['Pushed the branch']);
    expect(projected(wsId, older).notes).toBeUndefined();
    expect(handle.tasks.getTask(older)?.notes ?? []).toHaveLength(0);
  });

  it('the latest claimant wins over the stored assignee on a handed-over row', async () => {
    const OTHER = { id: 'agent-nomad', name: 'Nomad', kind: 'agent' };
    const wsId = await boardWithLead();
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: OTHER.id,
      runtime: 'claude-code-local',
    });
    // Assigned to the lead, but Nomad is the one who took it in-progress.
    const handed = await inProgressRow(wsId, 'Handed over');
    await jj(
      await post(`/api/tasks/${handed}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId: wsId,
      }),
    );
    await jj(
      await post(`/api/tasks/${handed}/transition`, {
        to: 'in-progress',
        author: OTHER,
        workspaceId: wsId,
      }),
    );

    const mine = await note(OTHER.name, 'Nomad is on it');
    expect(await mine.json()).toMatchObject({ taskId: handed });
    const theirs = await note(LEAD.name, 'Lead is elsewhere');
    const body = (await theirs.json()) as { taskId?: string };
    expect(body.taskId).toBeUndefined();
    await settle();
    expect(handle.tasks.getTask(handed)?.notes?.map((n) => n.text)).toEqual(['Nomad is on it']);
  });

  it('a person moving the row in-progress leaves it with its assignee (positive control)', async () => {
    const wsId = await boardWithLead();
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Moved by a person',
        body: 'Agent can pick this up so that the queue keeps moving.',
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: PERSON,
      }),
    );
    // A person-filed row is already `todo`; the person moves it in-progress.
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: PERSON,
        workspaceId: wsId,
      }),
    );
    const r = await note(LEAD.name, 'Picked it up');
    expect(await r.json()).toMatchObject({ taskId: task.id });
  });

  it('keeps a note from an agent with no current task in the per-agent ring only', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Someone else’s row');

    const r = await note('Nomad', 'Compacted the transcript', { sessionId: 'sess-9' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { ok: boolean; taskId?: string };
    expect(body.ok).toBe(true);
    expect(body.taskId).toBeUndefined();
    await settle();
    expect(handle.tasks.getTask(taskId)?.notes ?? []).toHaveLength(0);

    const { notes } = await ring('Nomad');
    expect(notes.map((n) => [n.kind, n.text, n.agent, n.sessionId, n.taskId])).toEqual([
      ['turn', 'Compacted the transcript', 'Nomad', 'sess-9', undefined],
    ]);
    // Name folding on the read side too, and an unknown agent is an empty list.
    expect((await ring('nomad')).notes).toHaveLength(1);
    expect((await ring('Nobody')).notes).toEqual([]);
  });

  it('the ring also carries task-bound notes, tagged with the task, so the pane has one read', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    await note(LEAD.name, 'Bound note');
    const { notes } = await ring(LEAD.name);
    expect(notes.map((n) => [n.text, n.taskId])).toEqual([['Bound note', taskId]]);
  });

  it('caps the ring at the newest entries, newest first', async () => {
    for (let i = 1; i <= AGENT_NOTE_RING_CAP + 5; i++) {
      expect((await note('Nomad', `turn ${i}`)).status).toBe(202);
    }
    const { notes } = await ring('Nomad');
    expect(notes).toHaveLength(AGENT_NOTE_RING_CAP);
    expect(notes[0]?.text).toBe(`turn ${AGENT_NOTE_RING_CAP + 5}`);
    expect(notes.at(-1)?.text).toBe('turn 6');
  });

  it('projects the newest notes only, and bounds what the sidecar keeps', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Long-running row');
    const total = TASK_NOTES_STORE_CAP + 3;
    for (let i = 1; i <= total; i++) {
      expect((await note(LEAD.name, `turn ${i}`)).status).toBe(202);
    }
    await settle();
    const stored = handle.tasks.getTask(taskId)?.notes ?? [];
    expect(stored).toHaveLength(TASK_NOTES_STORE_CAP);
    expect(stored[0]?.text).toBe('turn 4');
    expect(stored.at(-1)?.text).toBe(`turn ${total}`);

    const row = projected(wsId, taskId);
    expect(row.notes).toHaveLength(TASK_NOTES_READ_CAP);
    expect(row.notes?.[0]?.text).toBe(`turn ${total}`);
    expect(row.notes?.at(-1)?.text).toBe(`turn ${total - TASK_NOTES_READ_CAP + 1}`);
  });

  it('stores the text verbatim — a secret-looking value is the hook’s job to keep out', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    // Synthetic: this is the SHAPE of a leak, not a credential.
    const leaky = 'set token to sk-test-FAKE0000000000000000';
    expect((await note(LEAD.name, leaky)).status).toBe(202);
    expect((await note('Nomad', leaky)).status).toBe(202);
    await settle();
    expect(handle.tasks.getTask(taskId)?.notes?.[0]?.text).toBe(leaky);
    expect(projected(wsId, taskId).notes?.[0]?.text).toBe(leaky);
    expect((await ring('Nomad')).notes[0]?.text).toBe(leaky);
  });

  it('a note never reaches another agent’s workspace stream — projection and audit still see it', async () => {
    // Every store event rides `ws~<id>`, and an attached MCP child relays any
    // task.* frame it has no line for as a channel message. Broadcasting
    // task.noted would therefore wake every other agent on the board once per
    // turn of this one — and two agents each holding a row wake each other
    // forever. The stream must stay silent for it; the ydoc projection and
    // the audit log are the readers.
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    const stream = await fetch(`${base}/events/workspace/${wsId}?agentId=agent-other`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(stream.status).toBe(200);
    await settle();
    const heard: string[] = [];
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const line of decoder.decode(value).split('\n')) {
            if (line.startsWith('event: ')) heard.push(line.slice(7).trim());
          }
        }
      } catch {}
    })();

    expect((await note(LEAD.name, 'Quiet on the wire')).status).toBe(202);
    // Positive control on the same stream: a row moving IS broadcast.
    await jj(
      await post(`/api/tasks/${taskId}/transition`, {
        to: 'done',
        author: LEAD,
        workspaceId: wsId,
      }),
    );
    await settle(400);
    void reader.cancel().catch(() => {});

    expect(heard).toContain('task.transitioned');
    expect(heard).not.toContain('task.noted');
    expect(projected(wsId, taskId).notes?.map((n) => n.text)).toEqual(['Quiet on the wire']);
    const log = await Bun.file(join(dataDir, 'workspaces', `${wsId}.events.jsonl`)).text();
    expect(log).toContain('"event":"task.noted"');
  });

  it('task notes survive a restart; the ring does not', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    await note(LEAD.name, 'Before the restart');
    await note('Nomad', 'Ephemeral');
    await handle.stop();

    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    expect(handle.tasks.getTask(taskId)?.notes?.map((n) => n.text)).toEqual(['Before the restart']);
    expect(projected(wsId, taskId).notes?.map((n) => n.text)).toEqual(['Before the restart']);
    expect((await ring('Nomad')).notes).toEqual([]);
  });
});
