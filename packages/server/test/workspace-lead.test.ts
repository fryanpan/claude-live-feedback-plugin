/**
 * Every workspace has a LEAD AGENT — the addressee for anything the board
 * needs a responsible party for (a goal edit's re-triage, first of all).
 *
 * A goal change with nobody responsible is a dead letter, so the lead is
 * modeled as workspace state rather than "whoever happens to be attached":
 *
 *  - it is set at CREATION (the creating agent, by default),
 *  - a workspace that somehow has none — created by a person, or hydrated
 *    from before this field existed — has the vacancy CLAIMED by the first
 *    agent that attaches, which is what makes "always" true for the boards
 *    that already exist rather than only for new ones,
 *  - and it is REASSIGNABLE, through the store, the route, and the MCP tool.
 *
 * The absence is deliberately representable: `leadAgentId === undefined` is
 * how a board says "nobody is responsible here", and the surfaces render
 * that rather than inventing a lead. Inferring one would be the
 * grounded-pending lie in a new place.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import {
  type HubWorkspace,
  TaskStore,
  type TaskStoreEvent,
  tasksSidecarPath,
} from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const AGENT = { id: 'agent-relay', name: 'Relay', kind: 'agent' };

describe('TaskStore lead agent', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-lead-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('createWorkspace records the lead agent it was handed', () => {
    const ws = store.createWorkspace('relay-hub', 'Ship the relay.', {
      leadAgentId: 'agent-relay',
    });
    expect(ws.leadAgentId).toBe('agent-relay');
    expect(ws.leadAgentSince).toBeGreaterThan(0);
    expect(store.getWorkspace(ws.id)?.leadAgentId).toBe('agent-relay');
  });

  it('a workspace created with no agent has NO lead — the gap is representable, not invented', () => {
    const ws = store.createWorkspace('leaderless-hub', 'Ship it.');
    expect(ws.leadAgentId).toBeUndefined();
    expect(ws.leadAgentSince).toBeUndefined();
  });

  it('the first agent to attach claims a vacant lead, and says so in the result', () => {
    const ws = store.createWorkspace('claim-hub', 'Ship it.');
    const res = store.attachAgent(ws.id, { agentId: 'agent-relay', runtime: 'claude-code-local' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lead).toBe(true);
    expect(store.getWorkspace(ws.id)?.leadAgentId).toBe('agent-relay');

    const e = events.find((ev) => ev.type === 'workspace.lead_changed');
    if (e?.type !== 'workspace.lead_changed') throw new Error('workspace.lead_changed not emitted');
    expect(e.workspaceId).toBe(ws.id);
    expect(e.oldLeadAgentId).toBeUndefined();
    expect(e.leadAgentId).toBe('agent-relay');
  });

  it('a second agent attaching does NOT take the lead (with the claim above as positive control)', () => {
    const ws = store.createWorkspace('two-agents-hub', 'Ship it.');
    const first = store.attachAgent(ws.id, {
      agentId: 'agent-relay',
      runtime: 'claude-code-local',
    });
    if (!first.ok) throw new Error('fixture');
    expect(first.lead).toBe(true); // positive control: a claim really happens

    const before = events.filter((e) => e.type === 'workspace.lead_changed').length;
    const second = store.attachAgent(ws.id, {
      agentId: 'agent-helper',
      runtime: 'claude-code-local',
    });
    if (!second.ok) throw new Error('fixture');
    expect(second.lead).toBe(false);
    expect(store.getWorkspace(ws.id)?.leadAgentId).toBe('agent-relay');
    expect(events.filter((e) => e.type === 'workspace.lead_changed').length).toBe(before);
  });

  it('setLeadAgent reassigns and emits workspace.lead_changed with both sides', () => {
    const ws = store.createWorkspace('reassign-hub', 'Ship it.', { leadAgentId: 'agent-relay' });
    const res = store.setLeadAgent(ws.id, 'agent-helper', { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.workspace.leadAgentId).toBe('agent-helper');

    const e = events.find((ev) => ev.type === 'workspace.lead_changed');
    if (e?.type !== 'workspace.lead_changed') throw new Error('workspace.lead_changed not emitted');
    expect(e.oldLeadAgentId).toBe('agent-relay');
    expect(e.leadAgentId).toBe('agent-helper');
    expect(e.actor.kind).toBe('person');
  });

  it('re-setting the same lead is a no-op: changed=false, no event', () => {
    const ws = store.createWorkspace('same-hub', 'Ship it.', { leadAgentId: 'agent-relay' });
    events.length = 0;
    const res = store.setLeadAgent(ws.id, 'agent-relay', { actor: AGENT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('refuses an unknown workspace', () => {
    const res = store.setLeadAgent('w-nope', 'agent-relay', { actor: PERSON });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('workspace-not-found');
  });

  it('the lead survives a restart — it is workspace state, not attachment state', () => {
    const ws = store.createWorkspace('durable-hub', 'Ship it.', { leadAgentId: 'agent-relay' });
    store.flush();
    expect(readFileSync(tasksSidecarPath(dataDir, ws.id), 'utf8')).toContain('agent-relay');
    const reborn = new TaskStore({ dataDir, debounceMs: 5 });
    expect(reborn.getWorkspace(ws.id)?.leadAgentId).toBe('agent-relay');
    reborn.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes + the ydoc projection
// ─────────────────────────────────────────────────────────────────────────────

describe('lead agent routes + projection', () => {
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
  const put = (path: string, body: unknown) =>
    local(path, { method: 'PUT', body: JSON.stringify(body) });
  const workspaceOf = async (id: string): Promise<HubWorkspace> => {
    const r = await local(`/api/workspaces/${id}`);
    return ((await r.json()) as { workspace: HubWorkspace }).workspace;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-lead-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST /api/workspaces forwards leadAgentId (the groups lesson: prove it through the real route)', async () => {
    const r = await post('/api/workspaces', {
      name: 'explicit-lead',
      goal: 'Ship it.',
      leadAgentId: 'agent-relay',
    });
    expect(r.status).toBe(200);
    const created = ((await r.json()) as { workspace: HubWorkspace }).workspace;
    expect(created.leadAgentId).toBe('agent-relay');
    // Read the stored effect back over HTTP, not from the create response.
    expect((await workspaceOf(created.id)).leadAgentId).toBe('agent-relay');
  });

  it('an agent author becomes the lead by default; a person author leaves the seat open', async () => {
    const byAgent = await post('/api/workspaces', {
      name: 'agent-created',
      goal: 'Ship it.',
      author: AGENT,
    });
    const agentWs = ((await byAgent.json()) as { workspace: HubWorkspace }).workspace;
    expect(agentWs.leadAgentId).toBe('agent-relay');

    const byPerson = await post('/api/workspaces', {
      name: 'person-created',
      goal: 'Ship it.',
      author: PERSON,
    });
    const personWs = ((await byPerson.json()) as { workspace: HubWorkspace }).workspace;
    // A person is not an agent lead. The seat stays open for the first agent.
    expect(personWs.leadAgentId).toBeUndefined();
  });

  it('PUT /api/workspaces/:id/lead reassigns; 400 without leadAgentId; 404 for an unknown workspace', async () => {
    const r = await post('/api/workspaces', { name: 'reassign-route', goal: 'Ship it.' });
    const wsId = ((await r.json()) as { workspace: HubWorkspace }).workspace.id;

    const ok = await put(`/api/workspaces/${wsId}/lead`, {
      leadAgentId: 'agent-helper',
      author: PERSON,
    });
    expect(ok.status).toBe(200);
    expect((await workspaceOf(wsId)).leadAgentId).toBe('agent-helper');

    expect((await put(`/api/workspaces/${wsId}/lead`, { author: PERSON })).status).toBe(400);
    expect(
      (await put('/api/workspaces/w-nope/lead', { leadAgentId: 'x', author: PERSON })).status,
    ).toBe(404);
  });

  it('attaching an agent to a leaderless workspace claims the seat, through the route', async () => {
    const r = await post('/api/workspaces', { name: 'claim-route', goal: 'Ship it.' });
    const wsId = ((await r.json()) as { workspace: HubWorkspace }).workspace.id;
    expect((await workspaceOf(wsId)).leadAgentId).toBeUndefined(); // positive control

    const attach = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-relay',
      runtime: 'claude-code-local',
    });
    expect(attach.status).toBe(200);
    expect(((await attach.json()) as { lead: boolean }).lead).toBe(true);
    expect((await workspaceOf(wsId)).leadAgentId).toBe('agent-relay');
  });

  it('the board room projects the lead — and drops the key when the seat is empty', async () => {
    const r = await post('/api/workspaces', {
      name: 'projected-lead',
      goal: 'Ship it.',
      leadAgentId: 'agent-relay',
    });
    const wsId = ((await r.json()) as { workspace: HubWorkspace }).workspace.id;
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room missing');
    const wsMap = room.ydoc.getMap('workspace');
    // Positive control: the room really projects this workspace…
    expect(wsMap.get('name')).toBe('projected-lead');
    expect(wsMap.get('leadAgentId')).toBe('agent-relay');

    const leaderless = await post('/api/workspaces', { name: 'projected-empty', goal: 'Ship it.' });
    const emptyId = ((await leaderless.json()) as { workspace: HubWorkspace }).workspace.id;
    const emptyRoom = handle.rooms.get(workspaceRoomId(emptyId));
    if (!emptyRoom) throw new Error('ws room missing');
    expect(emptyRoom.ydoc.getMap('workspace').get('name')).toBe('projected-empty');
    expect(emptyRoom.ydoc.getMap('workspace').has('leadAgentId')).toBe(false);
  });
});
