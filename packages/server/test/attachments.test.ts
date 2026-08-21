/**
 * Agent attachment registry + heartbeat + agent.* events (plan §4).
 *
 * The workspace↔agent link is modeled as DATA from day one: an
 * `AgentAttachment` record keyed (workspaceId, agentId), no uniqueness on
 * agentId — one agent can attach to N workspaces. Three contracts under test:
 *
 *  - agent.attached / agent.heartbeat / agent.detached ride the same emit
 *    choke point as every other store event (SSE + events.jsonl), and the
 *    record they carry NEVER includes `endpoint` — host-machine fields are
 *    REST-only with visitor redaction (the private-meta lesson).
 *  - AgentAttachment records never enter any ydoc. The ws:<id> board room
 *    is proven clean with a positive control beside the absence.
 *  - Attachment state distinguishes "process up, agent unresponsive" (fresh
 *    lastHeartbeat, stale lastToolCallAt — the usage-limit outage shape)
 *    from active and away. We never guess from absence of activity.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import {
  type AgentAttachment,
  TaskStore,
  type TaskStoreEvent,
  attachmentState,
  attachmentStateLabel,
  attachmentsSidecarPath,
  eventsLogPath,
  publicAttachment,
} from '../src/tasks.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

/** A synthetic host-machine-describing endpoint. Must never leave REST. */
const ENDPOINT = 'http://127.0.0.1:9099/hooks/agent-relay';

function readAudit(dataDir: string, workspaceId: string): Array<Record<string, unknown>> {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure state derivation
// ─────────────────────────────────────────────────────────────────────────────

describe('attachmentState', () => {
  const base: AgentAttachment = {
    workspaceId: 'w-x',
    agentId: 'relay-agent',
    runtime: 'claude-code-local',
    lastHeartbeat: 0,
    lastToolCallAt: 0,
    capabilities: [],
  };
  const MIN = 60_000;

  it('fresh heartbeat + fresh tool call → active', () => {
    const att = { ...base, lastHeartbeat: 100 * MIN, lastToolCallAt: 99 * MIN };
    expect(attachmentState(att, 101 * MIN)).toBe('active');
  });

  it('fresh heartbeat + 30+ min since the last tool call → unresponsive (the usage-limit outage shape)', () => {
    // A session that hit its usage limit heartbeats normally for hours —
    // the outage signature is the two fields DISAGREEING.
    const att = { ...base, lastHeartbeat: 100 * MIN, lastToolCallAt: 70 * MIN };
    expect(attachmentState(att, 101 * MIN)).toBe('unresponsive');
    expect(attachmentStateLabel('unresponsive')).toBe('process up, agent unresponsive');
  });

  it('stale heartbeat → away, regardless of lastToolCallAt', () => {
    const att = { ...base, lastHeartbeat: 10 * MIN, lastToolCallAt: 10 * MIN };
    expect(attachmentState(att, 101 * MIN)).toBe('away');
    expect(attachmentStateLabel('away')).toBe('away — requests queue');
  });

  it('thresholds are overridable (tests must not burn real minutes)', () => {
    const att = { ...base, lastHeartbeat: 1000, lastToolCallAt: 900 };
    expect(attachmentState(att, 1050, { heartbeatFreshMs: 10 })).toBe('away');
    expect(attachmentState(att, 1050, { heartbeatFreshMs: 1000, toolCallStaleMs: 100 })).toBe(
      'unresponsive',
    );
  });
});

describe('publicAttachment (the shape events and visitors get)', () => {
  it('strips endpoint and adds state — and the full record is the positive control', () => {
    const att: AgentAttachment = {
      workspaceId: 'w-x',
      agentId: 'relay-agent',
      runtime: 'webhook',
      endpoint: ENDPOINT,
      lastHeartbeat: 5000,
      lastToolCallAt: 4000,
      capabilities: ['tasks.write'],
    };
    // Positive control: the source record really carries the endpoint…
    expect(att.endpoint).toBe(ENDPOINT);
    const pub = publicAttachment(att, 6000) as Record<string, unknown>;
    // …and the public shape really carries everything else.
    expect(pub.agentId).toBe('relay-agent');
    expect(pub.runtime).toBe('webhook');
    expect(pub.capabilities).toEqual(['tasks.write']);
    expect(pub.state).toBe('active');
    expect(pub.stateLabel).toBe('active');
    // The absence under test:
    expect('endpoint' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain('9099');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store-level registry
// ─────────────────────────────────────────────────────────────────────────────

describe('TaskStore attachment registry', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'attach-store-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('attachAgent records the §3.2 fields and emits agent.attached (SSE + audit, endpoint in neither)', () => {
    const ws = store.createWorkspace('relay-hub', 'Ship the relay.');
    const res = store.attachAgent(ws.id, {
      agentId: 'relay-agent',
      runtime: 'claude-code-local',
      capabilities: ['tasks.write', 'docs.edit'],
      endpoint: ENDPOINT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.attachment.workspaceId).toBe(ws.id);
    expect(res.attachment.agentId).toBe('relay-agent');
    expect(res.attachment.runtime).toBe('claude-code-local');
    expect(res.attachment.endpoint).toBe(ENDPOINT);
    expect(res.attachment.lastHeartbeat).toBeGreaterThan(0);
    // Attach IS a tool call — a freshly attached agent must read as active,
    // never as unresponsive-from-birth.
    expect(res.attachment.lastToolCallAt).toBe(res.attachment.lastHeartbeat);

    const e = events.find((ev) => ev.type === 'agent.attached');
    if (e?.type !== 'agent.attached') throw new Error('agent.attached not emitted');
    expect(e.workspaceId).toBe(ws.id);
    expect(e.agentId).toBe('relay-agent');
    // Positive control: the event really carries the record…
    expect(e.attachment.capabilities).toEqual(['tasks.write', 'docs.edit']);
    // …and the absence under test: no endpoint, anywhere in the event.
    //
    // Matched on the WHOLE endpoint, not on its port. `9099` alone is four
    // digits, and this record carries three `Date.now()` millisecond stamps —
    // so the search space includes ~30 digit positions that no test controls.
    // It duly fired: CI went red on `lastHeartbeat: 1786980999099`, where the
    // endpoint was correctly absent and the CLOCK spelled the needle. The
    // sibling `publicAttachment` case above never tripped only because its
    // timestamps are hand-written constants. Structural check first, since it
    // is the assertion actually being made.
    expect('endpoint' in (e.attachment as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(e)).not.toContain(ENDPOINT);

    // Same for the audit log line (the emit choke point).
    const audit = readAudit(dataDir, ws.id);
    const line = audit.find((l) => l.event === 'agent.attached');
    if (!line) throw new Error('agent.attached missing from events.jsonl');
    expect((line.attachment as Record<string, unknown>).agentId).toBe('relay-agent');
    expect('endpoint' in (line.attachment as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(line)).not.toContain(ENDPOINT);
  });

  it('is keyed (workspaceId, agentId): one agent attaches to N workspaces; re-attach upserts', () => {
    const a = store.createWorkspace('hub-a', 'A');
    const b = store.createWorkspace('hub-b', 'B');
    expect(store.attachAgent(a.id, { agentId: 'lead', runtime: 'claude-code-local' }).ok).toBe(
      true,
    );
    expect(store.attachAgent(b.id, { agentId: 'lead', runtime: 'claude-code-local' }).ok).toBe(
      true,
    );
    expect(store.listAttachments(a.id)).toHaveLength(1);
    expect(store.listAttachments(b.id)).toHaveLength(1);

    // Re-attach with new capabilities replaces, never duplicates.
    const again = store.attachAgent(a.id, {
      agentId: 'lead',
      runtime: 'claude-code-local',
      capabilities: ['voice.mutations'],
    });
    expect(again.ok).toBe(true);
    const list = store.listAttachments(a.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.capabilities).toEqual(['voice.mutations']);
  });

  it('refuses an unknown workspace and emits nothing (with the attach above as positive control)', () => {
    const res = store.attachAgent('w-nope', { agentId: 'x', runtime: 'webhook' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('workspace-not-found');
    expect(events).toHaveLength(0);
  });

  it('attach returns the open-gating-decisions summary (§3.3: a fresh context learns the gates exist)', () => {
    const ws = store.createWorkspace('gates-hub', 'Ship it.');
    const dec = store.createTask(ws.id, {
      title: 'your go',
      assignee: 'human',
      needs: 'decision',
      body: 'Which of these two? Both land this week; the second costs a migration. Blocked until answered: the PR.',
      goal: 'chores',
    });
    if (!dec.ok) throw new Error('fixture');
    const t1 = store.createTask(ws.id, {
      title: 'Open the PR',
      goal: 'chores',
      after: [dec.task.id],
    });
    const t2 = store.createTask(ws.id, {
      title: 'Announce it',
      goal: 'chores',
      after: [dec.task.id],
    });
    if (!t1.ok || !t2.ok) throw new Error('fixture');

    const res = store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.gating.openDecisions).toBe(1);
    expect(res.gating.gatedTasks).toBe(2);
    expect(res.gating.summary).toBe('1 open decision gating 2 tasks');

    // Answered-and-done decisions stop gating: the summary goes quiet.
    store.transition(dec.task.id, 'done', { actor: PERSON });
    const after = store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.gating.openDecisions).toBe(0);
    expect(after.gating.summary).toBe('no open gating decisions');
  });

  it('attach returns the untriaged Backlog tasks so the agent can sweep them (§3.4)', () => {
    const ws = store.createWorkspace('sweep-hub', 'Ship it.');
    // No attachment yet → this create emits no triage request and no marker;
    // it just sits in Backlog, untriaged.
    const t = store.createTask(ws.id, { title: 'Landed while nobody was attached' });
    if (!t.ok) throw new Error('fixture');
    expect(t.task.triagePendingTs).toBeUndefined();
    const res = store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.untriaged).toEqual([t.task.id]);
  });

  it('heartbeat bumps lastHeartbeat, moves lastToolCallAt only forward, and emits agent.heartbeat', async () => {
    const ws = store.createWorkspace('hb-hub', 'Ship it.');
    const res = store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    if (!res.ok) throw new Error('fixture');
    const t0 = res.attachment.lastToolCallAt;

    await new Promise((r) => setTimeout(r, 5));
    const hb = store.heartbeat(ws.id, 'lead');
    expect(hb.ok).toBe(true);
    if (!hb.ok) return;
    expect(hb.attachment.lastHeartbeat).toBeGreaterThan(t0);
    // A plain heartbeat proves the process, not the work: no tool-call bump.
    expect(hb.attachment.lastToolCallAt).toBe(t0);

    // The MCP child can report its session's real last tool call…
    const forward = store.heartbeat(ws.id, 'lead', { toolCallAt: t0 + 2 });
    if (!forward.ok) throw new Error('heartbeat failed');
    expect(forward.attachment.lastToolCallAt).toBe(t0 + 2);
    // …but never backdate it (monotonic) —
    const back = store.heartbeat(ws.id, 'lead', { toolCallAt: t0 - 1000 });
    if (!back.ok) throw new Error('heartbeat failed');
    expect(back.attachment.lastToolCallAt).toBe(t0 + 2);
    // — and never forward-date it past now (a claim of future work is fake).
    const future = store.heartbeat(ws.id, 'lead', { toolCallAt: Date.now() + 60_000 });
    if (!future.ok) throw new Error('heartbeat failed');
    expect(future.attachment.lastToolCallAt).toBeLessThanOrEqual(Date.now());

    expect(events.filter((e) => e.type === 'agent.heartbeat')).toHaveLength(4);
    expect(store.heartbeat(ws.id, 'ghost').ok).toBe(false);
  });

  it('noteAgentToolCall bumps lastToolCallAt without an event (tool calls are not §3.6 rows)', () => {
    const ws = store.createWorkspace('tc-hub', 'Ship it.');
    const res = store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    if (!res.ok) throw new Error('fixture');
    const before = events.length;
    expect(store.noteAgentToolCall(ws.id, 'lead')).toBe(true);
    expect(store.noteAgentToolCall(ws.id, 'ghost')).toBe(false);
    expect(events.length).toBe(before);
  });

  it('detachAgent removes the record and emits agent.detached exactly once', () => {
    const ws = store.createWorkspace('bye-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    expect(store.detachAgent(ws.id, 'lead')).toBe(true);
    expect(store.listAttachments(ws.id)).toHaveLength(0);
    expect(events.filter((e) => e.type === 'agent.detached')).toHaveLength(1);
    // Second detach: nothing left to announce.
    expect(store.detachAgent(ws.id, 'lead')).toBe(false);
    expect(events.filter((e) => e.type === 'agent.detached')).toHaveLength(1);
  });

  it('hasLiveAttachment is OBSERVED freshness, not mere existence', async () => {
    // The window this reads used to be `heartbeatFreshMs` — i.e. how recently
    // the agent SAID it was alive. It is now how recently the server OBSERVED
    // it, by heartbeat or by write, so both knobs are set here: leaving
    // `observedWorkFreshMs` at its 15-minute default would keep the fresh
    // attach inside the window and this test would never see it go stale.
    // See OBSERVED_LIVE_MS and voice-gate-liveness.test.ts for why it changed.
    const tight = new TaskStore({
      dataDir,
      debounceMs: 5,
      heartbeatFreshMs: 30,
      observedWorkFreshMs: 30,
    });
    const ws = tight.createWorkspace('live-hub', 'Ship it.');
    expect(tight.hasLiveAttachment(ws.id)).toBe(false);
    tight.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    // Positive control: fresh → live.
    expect(tight.hasLiveAttachment(ws.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // The record still exists, but nothing has been observed since. Existence
    // was never the question.
    expect(tight.listAttachments(ws.id)).toHaveLength(1);
    expect(tight.hasLiveAttachment(ws.id)).toBe(false);
    tight.stop();
  });

  it('persists to its own sidecar and survives a restart (stale, honestly — away, not active)', () => {
    const ws = store.createWorkspace('persist-hub', 'Ship it.');
    store.attachAgent(ws.id, {
      agentId: 'relay-agent',
      runtime: 'webhook',
      endpoint: ENDPOINT,
      capabilities: ['tasks.write'],
    });
    store.flush();
    const sidecar = attachmentsSidecarPath(dataDir, ws.id);
    expect(existsSync(sidecar)).toBe(true);
    // The endpoint lives in the sidecar (server-side file), like private-meta.
    expect(readFileSync(sidecar, 'utf8')).toContain('9099');
    // And NOT in the tasks sidecar — separate state, separate file.
    const tasksSidecar = join(dataDir, 'workspaces', `${ws.id}.tasks.json`);
    expect(readFileSync(tasksSidecar, 'utf8')).not.toContain('9099');

    const reborn = new TaskStore({ dataDir, debounceMs: 5 });
    const list = reborn.listAttachments(ws.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.endpoint).toBe(ENDPOINT);
    expect(list[0]?.capabilities).toEqual(['tasks.write']);
    reborn.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes + the triage-delivery bridge + the ydoc absence
// ─────────────────────────────────────────────────────────────────────────────

/** Read an SSE stream until stop(), collecting event names + data lines. */
function listen(res: Response): {
  events: string[];
  data: string[];
  stop: () => void;
} {
  const events: string[] = [];
  const data: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || stopped) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
          if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
        }
      }
    } catch {
      // torn down — fine
    }
  })();
  return {
    events,
    data,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe('attachment routes + triage bridge', () => {
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

  const makeWorkspace = async (name: string, leadAgentId?: string): Promise<string> => {
    const r = await post('/api/workspaces', {
      name,
      goal: 'Ship it.',
      ...(leadAgentId !== undefined ? { leadAgentId } : {}),
    });
    const body = (await r.json()) as { workspace: { id: string } };
    return body.workspace.id;
  };

  /** Streams `declareSelf` opened, hung up after each test. */
  const declaredStreams: AgentStream[] = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'attach-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of declaredStreams.splice(0)) await s.close();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST attach → GET list round-trips every param, including endpoint + capabilities', async () => {
    const wsId = await makeWorkspace('routes-hub');
    const r = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'relay-agent',
      runtime: 'webhook',
      endpoint: ENDPOINT,
      capabilities: ['tasks.write'],
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      attachment: AgentAttachment;
      gating: { summary: string };
      untriaged: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.attachment.endpoint).toBe(ENDPOINT);
    expect(body.gating.summary).toBe('no open gating decisions');
    expect(body.untriaged).toEqual([]);

    const list = await local(`/api/workspaces/${wsId}/attachments`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      attachments: Array<AgentAttachment & { state: string; stateLabel: string }>;
    };
    expect(listBody.attachments).toHaveLength(1);
    const att = listBody.attachments[0];
    if (!att) throw new Error('attachment missing');
    // The owner surface serves the full record + derived state.
    expect(att.endpoint).toBe(ENDPOINT);
    expect(att.capabilities).toEqual(['tasks.write']);
    expect(att.state).toBe('active');
  });

  it('validates: 400 on missing agentId / bad runtime, 404 on unknown workspace', async () => {
    const wsId = await makeWorkspace('bad-hub');
    expect((await post(`/api/workspaces/${wsId}/attachments`, { runtime: 'webhook' })).status).toBe(
      400,
    );
    expect(
      (
        await post(`/api/workspaces/${wsId}/attachments`, {
          agentId: 'x',
          runtime: 'carrier-pigeon',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post('/api/workspaces/w-nope/attachments', { agentId: 'x', runtime: 'webhook' }))
        .status,
    ).toBe(404);
  });

  it('heartbeat route forwards toolCallAt (the groups lesson: prove it through the real route)', async () => {
    const wsId = await makeWorkspace('hb-routes-hub');
    const attach = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'lead',
      runtime: 'claude-code-local',
    });
    const attached = (await attach.json()) as { attachment: AgentAttachment };
    const t0 = attached.attachment.lastToolCallAt;

    // Let the clock pass t0+5, or the claim is (correctly) clamped as a
    // forward-dated one.
    await settle(20);
    const hb = await post(`/api/workspaces/${wsId}/attachments/lead/heartbeat`, {
      toolCallAt: t0 + 5,
    });
    expect(hb.status).toBe(200);
    const hbBody = (await hb.json()) as { attachment: AgentAttachment };
    expect(hbBody.attachment.lastToolCallAt).toBe(t0 + 5);
    expect(hbBody.attachment.lastHeartbeat).toBeGreaterThanOrEqual(t0);

    expect((await post(`/api/workspaces/${wsId}/attachments/ghost/heartbeat`, {})).status).toBe(
      404,
    );
  });

  it('DELETE detaches; agent.* events reach the workspace SSE channel', async () => {
    const wsId = await makeWorkspace('sse-hub');
    const sseRes = await local(`/events/workspace/${wsId}`);
    expect(sseRes.status).toBe(200);
    const sse = listen(sseRes);
    try {
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId: 'lead',
        runtime: 'claude-code-local',
        endpoint: ENDPOINT,
      });
      await post(`/api/workspaces/${wsId}/attachments/lead/heartbeat`, {});
      const del = await local(`/api/workspaces/${wsId}/attachments/lead`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      await settle();
      expect(sse.events).toContain('agent.attached');
      expect(sse.events).toContain('agent.heartbeat');
      expect(sse.events).toContain('agent.detached');
      // The wire never carries the endpoint — the SSE feed is a share-visitor
      // surface once commit 8 opens it.
      expect(sse.data.join('\n')).not.toContain('9099');
      // Positive control: the same data lines DO carry the agent identity.
      expect(sse.data.join('\n')).toContain('"agentId":"lead"');

      const del2 = await local(`/api/workspaces/${wsId}/attachments/lead`, { method: 'DELETE' });
      expect(del2.status).toBe(404);
    } finally {
      sse.stop();
    }
  });

  it('the triage bridge grounds pending markers: live attachment → request delivered + marker; none → neither', async () => {
    // NO attachment: the task lands plainly in Backlog, no marker, and the
    // SSE stream sees no triage.requested (absence proven against the
    // presence below on the same stream shape).
    const coldWs = await makeWorkspace('cold-hub');
    const coldSse = listen(await local(`/events/workspace/${coldWs}`));
    const cold = await post(`/api/workspaces/${coldWs}/tasks`, {
      author: PERSON,
      title: 'Nobody home',
    });
    const coldTask = ((await cold.json()) as { task: { id: string; triagePendingTs?: number } })
      .task;
    await settle();
    coldSse.stop();
    expect(coldTask.triagePendingTs).toBeUndefined();
    expect(coldSse.events).not.toContain('triage.requested');
    // Positive control on that stream: it did see the create.
    expect(coldSse.events).toContain('task.created');

    // LIVE attachment: same create → the request rides the workspace channel
    // and the marker is stamped (grounded-pending, §3.4).
    const hotWs = await makeWorkspace('hot-hub');
    await post(`/api/workspaces/${hotWs}/attachments`, {
      agentId: 'lead',
      runtime: 'claude-code-local',
    });
    const hotSse = listen(await local(`/events/workspace/${hotWs}`));
    const hot = await post(`/api/workspaces/${hotWs}/tasks`, {
      author: PERSON,
      title: 'Somebody home',
    });
    const hotTask = ((await hot.json()) as { task: { id: string; triagePendingTs?: number } }).task;
    await settle();
    hotSse.stop();
    expect(hotTask.triagePendingTs).toBeGreaterThan(0);
    expect(hotSse.events).toContain('triage.requested');
    const reqLine = hotSse.data.find(
      (d) => d.includes('"triage.requested"') || d.includes('triage.requested'),
    );
    if (!reqLine) throw new Error('triage.requested data line missing');
    expect(reqLine).toContain(hotTask.id);
    // Deliberately NOT in the audit log: §3.6's table is the exhaustive
    // subscriber contract and has no triage.requested row.
    expect(readAudit(dataDir, hotWs).filter((l) => l.event === 'triage.requested')).toHaveLength(0);
    // Positive control: the same log has the create.
    expect(readAudit(dataDir, hotWs).filter((l) => l.event === 'task.created')).toHaveLength(1);
  });

  it('AgentAttachment records never enter any ydoc (§3.3 rule 1)', async () => {
    // The board is given a lead up front so the agent we attach below is NOT
    // the lead. That separation is what keeps this assertion strong now that
    // the workspace projects `leadAgentId`: an agent id in the ws room is
    // board state (who is responsible), never evidence that an ATTACHMENT
    // reached the ydoc, and this test still refuses the latter.
    const wsId = await makeWorkspace('clean-room-hub', 'agent-board-lead');
    await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, title: 'A visible task' });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'relay-agent',
      runtime: 'webhook',
      endpoint: ENDPOINT,
    });
    await post(`/api/workspaces/${wsId}/attachments/relay-agent/heartbeat`, {});
    await settle();

    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room missing');
    const dump = JSON.stringify({
      tasks: room.ydoc.getMap('tasks').toJSON(),
      workspace: room.ydoc.getMap('workspace').toJSON(),
    });
    // Positive control: the room really projects this workspace's state —
    // including the one agent-shaped field it is SUPPOSED to carry.
    expect(dump).toContain('A visible task');
    expect(dump).toContain('clean-room-hub');
    expect(dump).toContain('agent-board-lead');
    // The absences under test: no attachment record, no endpoint, and not
    // even the agent id of the agent that attached.
    expect(dump).not.toContain('9099');
    expect(dump).not.toContain('relay-agent');
    expect(dump).not.toContain('lastHeartbeat');
    expect(dump).not.toContain('capabilities');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Declaring yourself lead: attach, then seat.
  //
  // The measured incident: a peer held six doc watches and believed it was
  // listening. It had never attached. A voice note and a re-triage request
  // queued SILENTLY — no error, no dropped-event warning — because every
  // delivery gate here asks whether the lead is ATTACHED, and a doc watch is
  // not an attachment. These tests pin the two halves of that gate to the
  // sequence the MCP now performs in one call, and PC3 pins the half that
  // must NOT change: naming an agent who is not there keeps queuing, because
  // a queue is honest and a forged delivery is not.
  // ───────────────────────────────────────────────────────────────────────

  /**
   * The declaration, as the MCP issues it: attach, open the workspace stream,
   * then take the seat.
   *
   * The stream is not decoration. `attach_agent` subscribes right after it
   * attaches, and a delivery is a BROADCAST — so an agent that only attached
   * is registered and unreachable, and the gates below correctly refuse to
   * call anything delivered to it. Modelling only the attach half described
   * an agent that never connected.
   */
  const declareSelf = async (wsId: string, agentId: string) => {
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId,
      runtime: 'claude-code-local',
    });
    declaredStreams.push(await openWorkspaceStream(base, wsId));
    return put(`/api/workspaces/${wsId}/lead`, { leadAgentId: agentId, author: PERSON });
  };

  it('a self-declaration leaves the board holding a LIVE lead attachment', async () => {
    // The seat starts with somebody else, so taking it is a real handover
    // rather than the empty-seat claim attaching already does on its own.
    const wsId = await makeWorkspace('declare-hub', 'agent-away');
    const seat = await declareSelf(wsId, 'agent-self');
    expect(seat.status).toBe(200);
    const seatBody = (await seat.json()) as {
      changed: boolean;
      workspace: { leadAgentId: string };
    };
    expect(seatBody.changed).toBe(true);
    expect(seatBody.workspace.leadAgentId).toBe('agent-self');

    const list = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as {
      attachments: Array<AgentAttachment & { state: string }>;
    };
    const lead = list.attachments.find((a) => a.agentId === seatBody.workspace.leadAgentId);
    // "Live lead attachment" is the conjunction the delivery gates read: an
    // attachment record AND a fresh heartbeat AND it being the seat-holder.
    expect(lead).toBeDefined();
    expect(lead?.state).toBe('active');
    // Positive control on the absent agent: holding the seat before this
    // never created a record, and nothing here invented one for it.
    expect(list.attachments.map((a) => a.agentId)).not.toContain('agent-away');
  });

  it('after declaring, a voice change-request routes to the agent instead of queuing', async () => {
    const wsId = await makeWorkspace('voice-declare-hub', 'agent-away');
    await declareSelf(wsId, 'agent-self');

    const r = await post(`/api/workspaces/${wsId}/voice`, {
      transcript: 'make cutting token usage the top goal',
      author: PERSON,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { route: string; ack: string };
    expect(body.route).toBe('agent');
    expect(body.ack).not.toContain('queued');
  });

  it('after declaring, a goal edit asks for re-triage instead of parking it', async () => {
    const wsId = await makeWorkspace('goal-declare-hub', 'agent-away');
    await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, title: 'An open row' });
    await declareSelf(wsId, 'agent-self');

    const sse = listen(await local(`/events/workspace/${wsId}?agentId=agent-self`));
    const r = await put(`/api/workspaces/${wsId}/goal`, {
      goal: 'Cut token usage per session in half.',
      author: PERSON,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      retriage: { requested: boolean; queued: boolean; taskIds: string[] };
    };
    await settle();
    sse.stop();
    expect(body.retriage.requested).toBe(true);
    expect(body.retriage.queued).toBe(false);
    expect(body.retriage.taskIds).toHaveLength(1);
    // The ask actually rode the channel a declared lead is now subscribed to
    // — "requested" is only true because somebody could hear it.
    expect(sse.events).toContain('triage.requested');
  });

  it('POSITIVE CONTROL — naming an UNREACHABLE agent as lead still queues voice and re-triage', async () => {
    // The asymmetry that keeps delivery honest. Handing the seat to an agent
    // who is not on the wire must NOT forge its liveness: otherwise the
    // board would report a live lead, voice would route to 'agent', and the
    // note would reach nobody at all — strictly worse than a queue, because
    // nothing anywhere would say it had been missed.
    //
    // The handover target has to be an id the board has a RECORD of (a
    // never-seen id is now refused outright — the unknown-lead-agent guard),
    // so this agent attached once but holds no stream: registered, named
    // lead, and unreachable, which is exactly the case queuing exists for.
    // The seat starts with a seeded lead so the attach cannot claim it.
    const wsId = await makeWorkspace('third-party-hub', 'agent-original');
    await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, title: 'An open row' });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-elsewhere',
      runtime: 'claude-code-local',
    });
    const seat = await put(`/api/workspaces/${wsId}/lead`, {
      leadAgentId: 'agent-elsewhere',
      author: PERSON,
    });
    expect(seat.status).toBe(200);

    const list = (await (await local(`/api/workspaces/${wsId}/attachments`)).json()) as {
      attachments: AgentAttachment[];
    };
    // Only the agent's OWN attach is on record — neither the seeded seat nor
    // the handover invented one.
    expect(list.attachments.map((a) => a.agentId)).toEqual(['agent-elsewhere']);

    const voice = (await (
      await post(`/api/workspaces/${wsId}/voice`, {
        transcript: 'make cutting token usage the top goal',
        author: PERSON,
      })
    ).json()) as { route: string; ack: string };
    expect(voice.route).toBe('agent-queued');
    expect(voice.ack).toContain('queued');

    const goal = (await (
      await put(`/api/workspaces/${wsId}/goal`, {
        goal: 'Cut token usage per session in half.',
        author: PERSON,
      })
    ).json()) as { retriage: { requested: boolean; queued: boolean } };
    expect(goal.retriage.requested).toBe(false);
    expect(goal.retriage.queued).toBe(true);

    // And the queued note is still there for whoever does show up — the
    // whole point of refusing to fake the delivery.
    const drain = (await (
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId: 'agent-elsewhere',
        runtime: 'claude-code-local',
      })
    ).json()) as {
      queuedVoice: Array<{ transcript: string }>;
      pendingRetriage?: { taskIds: string[] };
    };
    expect(drain.queuedVoice.map((v) => v.transcript)).toEqual([
      'make cutting token usage the top goal',
    ]);
    expect(drain.pendingRetriage?.taskIds).toHaveLength(1);
  });
});
