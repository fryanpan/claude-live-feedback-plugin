/**
 * A goal edit reaches the workspace's LEAD AGENT — durably.
 *
 * Before this, `workspace.retriaged` fired and the request was DROPPED if no
 * agent happened to be attached at that instant: `delivered:false`, no
 * replay, and the next attach returned `untriaged:[]` / `queuedVoice:[]` —
 * two fields that look built for exactly this and come back empty, because
 * neither covers a goal edit. A north-star goal was edited, seven open tasks
 * were retriaged, and the agent learned nothing.
 *
 * Two things change here, and they are the same mechanism:
 *
 *  - the request is ADDRESSED to the lead agent, not to whoever is
 *    connected. A live non-lead attachment no longer counts as delivery.
 *  - an undelivered request PERSISTS and is handed over on the lead's next
 *    attach — the same "queued" contract voice utterances already have, and
 *    persisted synchronously for the same reason: a promise that lives only
 *    in memory dies with the process.
 *
 * Every absence below is paired with a presence. The harness is proven able
 * to observe a live delivery BEFORE anything asserts that a delivery did not
 * happen — an assertion of absence against a harness that cannot see is
 * vacuous, and this repo has shipped that bug more than once.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import {
  type PendingRetriage,
  TaskStore,
  type TaskStoreEvent,
  type TriageRequest,
  pendingRetriagePath,
} from '../src/tasks.ts';
import { openWorkspaceStream } from './agent-stream.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = 'agent-lead';
const OTHER = 'agent-bystander';

describe('durable goal-edit re-triage', () => {
  let dataDir: string;
  let store: TaskStore;
  let requests: TriageRequest[];
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'retriage-queue-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    requests = [];
    events = [];
    store.onEvent((e) => events.push(e));
    // The REAL bridge shape: a request counts as delivered only when the
    // workspace has a live LEAD attachment to act on it (server.ts installs
    // the same rule). Anything looser and every "queued" case below would be
    // testing the test.
    store.setTriageDelivery((req) => {
      if (req.kind === 'goal-retriage' && !store.hasLiveLeadAttachment(req.workspaceId)) {
        return false;
      }
      requests.push(req);
      return true;
    });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const hub = (name: string, lead?: string) =>
    store.createWorkspace(name, 'Old goal.', lead ? { leadAgentId: lead } : undefined);
  const openTask = (workspaceId: string, title: string): string => {
    const res = store.createTask(workspaceId, { title, goal: 'chores' });
    if (!res.ok) throw new Error('fixture');
    return res.task.id;
  };

  // ── The positive control everything else is measured against ─────────────

  it('POSITIVE CONTROL: with the lead live, the edit is delivered and nothing is queued', () => {
    const ws = hub('live-hub', LEAD);
    const t = openTask(ws.id, 'draft the outline');
    store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });

    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.requested).toBe(true);
    expect(res.retriage.queued).toBe(false);
    // The harness really sees deliveries.
    expect(requests.filter((r) => r.kind === 'goal-retriage')).toHaveLength(1);
    const req = requests.at(-1);
    if (req?.kind !== 'goal-retriage') throw new Error('expected goal-retriage');
    expect(req.taskIds).toEqual([t]);
    expect(req.leadAgentId).toBe(LEAD);
    // Nothing waiting: a delivered request must not also be replayed later.
    expect(store.getPendingRetriage(ws.id)).toBeUndefined();
    expect(existsSync(pendingRetriagePath(dataDir, ws.id))).toBe(false);
  });

  // ── The gap the feature exists to close ──────────────────────────────────

  it('with nobody attached the edit is queued, not dropped — and persisted synchronously', () => {
    const ws = hub('gap-hub', LEAD);
    const t = openTask(ws.id, 'draft the outline');

    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.requested).toBe(false);
    expect(res.retriage.queued).toBe(true);
    expect(requests.filter((r) => r.kind === 'goal-retriage')).toHaveLength(0);

    const pending = store.getPendingRetriage(ws.id);
    if (!pending) throw new Error('the goal edit was swallowed');
    expect(pending.batchId).toBe(res.retriage.batchId ?? '');
    expect(pending.oldGoal).toBe('Old goal.');
    expect(pending.newGoal).toBe('New goal.');
    expect(pending.taskIds).toEqual([t]);

    // On disk BEFORE any debounce runs — "waiting for you" is a promise, and
    // a promise a crash can drop is the summaries-incident lie.
    const onDisk = JSON.parse(readFileSync(pendingRetriagePath(dataDir, ws.id), 'utf8')) as {
      pending?: PendingRetriage;
    };
    expect(onDisk.pending?.batchId).toBe(pending.batchId);
  });

  // The ack above is only worth what the write is worth. `queued: true` says
  // "it is on disk waiting for the lead" — if the write threw and we said it
  // anyway, the person who edited the goal is told a restart-proof promise
  // that a restart erases. Reported false, deliberately conservative: the
  // in-memory copy is kept and can still be handed over this process
  // lifetime, so the flag under-promises rather than over-promises.
  it('does NOT claim the request is queued when the sidecar write fails', () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'retriage-broken-'));
    // `workspaces` as a FILE: existsSync passes, every write under it ENOTDIRs.
    writeFileSync(join(brokenDir, 'workspaces'), 'not a directory\n');
    const broken = new TaskStore({ dataDir: brokenDir, debounceMs: 5 });
    const brokenEvents: TaskStoreEvent[] = [];
    broken.onEvent((e) => brokenEvents.push(e));
    broken.setTriageDelivery(() => false);
    try {
      const ws = broken.createWorkspace('broken-hub', 'Old goal.', { leadAgentId: LEAD });
      const t = broken.createTask(ws.id, { title: 'draft the outline', goal: 'chores' });
      if (!t.ok) throw new Error('fixture');

      const res = broken.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
      if (!res.ok) throw new Error('unexpected');
      expect(res.retriage.requested).toBe(false);
      expect(res.retriage.queued).toBe(false);
      const row = brokenEvents.filter((e) => e.type === 'workspace.retriaged').at(-1);
      expect(row && 'queued' in row ? row.queued : undefined).toBe(false);
    } finally {
      broken.stop();
      rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it('the audit row records that it was queued, not merely undelivered', () => {
    const ws = hub('audit-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    const row = events.find((e) => e.type === 'workspace.retriaged');
    if (row?.type !== 'workspace.retriaged') throw new Error('no workspace.retriaged row');
    expect(row.delivered).toBe(false);
    expect(row.queued).toBe(true);
  });

  it('the lead picks it up on the next attach, and only once', () => {
    const ws = hub('handover-hub', LEAD);
    const t = openTask(ws.id, 'draft the outline');
    const edit = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!edit.ok) throw new Error('unexpected');

    const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    if (!attach.ok) throw new Error('fixture');
    expect(attach.pendingRetriage?.batchId).toBe(edit.retriage.batchId ?? '');
    expect(attach.pendingRetriage?.taskIds).toEqual([t]);
    expect(attach.pendingRetriage?.newGoal).toBe('New goal.');

    // Drained: a re-attach must not ask for the same work twice.
    const again = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    if (!again.ok) throw new Error('fixture');
    expect(again.pendingRetriage).toBeUndefined();
    expect(store.getPendingRetriage(ws.id)).toBeUndefined();
  });

  it('survives a restart — the request is still waiting for a store that never saw the edit', () => {
    const ws = hub('reboot-hub', LEAD);
    const t = openTask(ws.id, 'draft the outline');
    const edit = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!edit.ok) throw new Error('unexpected');
    store.flush();

    const reborn = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(reborn.getPendingRetriage(ws.id)?.batchId).toBe(edit.retriage.batchId ?? '');
      const attach = reborn.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
      if (!attach.ok) throw new Error('fixture');
      expect(attach.pendingRetriage?.taskIds).toEqual([t]);
    } finally {
      reborn.stop();
    }
  });

  // ── Addressing ───────────────────────────────────────────────────────────

  it('a live NON-lead attachment is not delivery: the edit still waits for the lead', () => {
    const ws = hub('bystander-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });

    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.requested).toBe(false);
    expect(res.retriage.queued).toBe(true);

    // …and the bystander re-attaching does not carry it off either.
    const bystander = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
    if (!bystander.ok) throw new Error('fixture');
    expect(bystander.pendingRetriage).toBeUndefined();
    // Positive control: the LEAD attaching does get it.
    const lead = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    if (!lead.ok) throw new Error('fixture');
    expect(lead.pendingRetriage?.batchId).toBe(res.retriage.batchId ?? '');
  });

  it('a reassignment redirects a waiting request to the new lead', () => {
    const ws = hub('redirect-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');

    store.setLeadAgent(ws.id, OTHER, { actor: PERSON });
    const nowLead = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
    if (!nowLead.ok) throw new Error('fixture');
    expect(nowLead.pendingRetriage?.batchId).toBe(res.retriage.batchId ?? '');
  });

  it('a handover to an agent who is ALREADY live delivers the waiting request now', () => {
    // The test above hands over and then attaches, so it only ever proves the
    // request survives to the new lead's NEXT attach. An agent that is already
    // attached has no next attach — without delivery here the request waits on
    // a reconnect that may never come, with its addressee sitting right there.
    const ws = hub('handover-live-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.queued).toBe(true); // positive control: it really is waiting

    // OTHER is live BEFORE it gets the seat — as a bystander, so not delivery.
    const bystander = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
    if (!bystander.ok) throw new Error('fixture');
    expect(bystander.lead).toBe(false); // the seat was taken, so this is a real bystander
    expect(bystander.pendingRetriage).toBeUndefined(); // and it got nothing, correctly
    expect(store.getPendingRetriage(ws.id)?.taskIds.length).toBe(1); // still waiting

    store.setLeadAgent(ws.id, OTHER, { actor: PERSON });
    // Now that the live bystander IS the lead, the request has been handed to
    // it and is no longer queued against a seat nobody is watching.
    expect(store.getPendingRetriage(ws.id)).toBeUndefined();
  });

  it('a handover to an AWAY agent leaves the request waiting for their attach', () => {
    // The other direction, so the fix above can only deliver to someone live.
    const ws = hub('handover-away-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');

    store.setLeadAgent(ws.id, OTHER, { actor: PERSON }); // OTHER never attached
    expect(store.getPendingRetriage(ws.id)?.taskIds.length).toBe(1);
    const attach = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
    if (!attach.ok) throw new Error('fixture');
    expect(attach.pendingRetriage?.batchId).toBe(res.retriage.batchId ?? '');
  });

  it('with NO lead at all the edit is still visible as pending work, and the first agent inherits it', () => {
    const ws = hub('leaderless-hub');
    expect(ws.leadAgentId).toBeUndefined(); // positive control on the fixture
    const t = openTask(ws.id, 'draft the outline');
    const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.queued).toBe(true);
    // Visible, not swallowed — this is what the hub renders.
    expect(store.getPendingRetriage(ws.id)?.taskIds).toEqual([t]);

    // The first agent to attach claims the empty seat, so it is the lead by
    // the time delivery is decided.
    const attach = store.attachAgent(ws.id, { agentId: OTHER, runtime: 'claude-code-local' });
    if (!attach.ok) throw new Error('fixture');
    expect(attach.lead).toBe(true);
    expect(attach.pendingRetriage?.taskIds).toEqual([t]);
  });

  // ── Coalescing + staleness ───────────────────────────────────────────────

  it('two edits in one gap collapse into ONE request: oldest baseline, newest goal and batch', () => {
    const ws = hub('coalesce-hub', LEAD);
    const t1 = openTask(ws.id, 'draft the outline');
    const first = store.setWorkspaceGoal(ws.id, 'Middle goal.', { actor: PERSON });
    const t2 = openTask(ws.id, 'collect screenshots');
    const second = store.setWorkspaceGoal(ws.id, 'Newest goal.', { actor: PERSON });
    if (!first.ok || !second.ok) throw new Error('unexpected');
    expect(first.retriage.batchId).not.toBe(second.retriage.batchId);

    const pending = store.getPendingRetriage(ws.id);
    if (!pending) throw new Error('nothing queued');
    // The baseline is what the placements were last judged against — the
    // FIRST undelivered edit's old goal, not the intermediate one.
    expect(pending.oldGoal).toBe('Old goal.');
    expect(pending.newGoal).toBe('Newest goal.');
    // The newest batch is the one the activity view has a row for, so the
    // moves must tie to it.
    expect(pending.batchId).toBe(second.retriage.batchId ?? '');
    expect(pending.taskIds.sort()).toEqual([t1, t2].sort());
  });

  it('work finished during the gap is dropped from the delivered list', () => {
    const ws = hub('stale-hub', LEAD);
    const stays = openTask(ws.id, 'draft the outline');
    const finished = openTask(ws.id, 'pick the topic');
    store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    store.transition(finished, 'done', { actor: PERSON });

    const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    if (!attach.ok) throw new Error('fixture');
    expect(attach.pendingRetriage?.taskIds).toEqual([stays]);
  });

  it('a request whose every task is finished retires instead of asking for nothing', () => {
    const ws = hub('empty-hub', LEAD);
    const only = openTask(ws.id, 'draft the outline');
    store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
    expect(store.getPendingRetriage(ws.id)).toBeDefined(); // positive control
    store.transition(only, 'done', { actor: PERSON });

    expect(store.getPendingRetriage(ws.id)).toBeUndefined();
    const attach = store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    if (!attach.ok) throw new Error('fixture');
    expect(attach.pendingRetriage).toBeUndefined();
    // The sidecar is retired too, not left as a file that answers nothing.
    expect(existsSync(pendingRetriagePath(dataDir, ws.id))).toBe(false);
  });

  it('an edit delivered live clears a request that was waiting from an earlier gap', () => {
    const ws = hub('supersede-hub', LEAD);
    openTask(ws.id, 'draft the outline');
    store.setWorkspaceGoal(ws.id, 'Queued goal.', { actor: PERSON });
    expect(store.getPendingRetriage(ws.id)).toBeDefined(); // positive control

    store.attachAgent(ws.id, { agentId: LEAD, runtime: 'claude-code-local' });
    // The attach above already drained it; a live edit afterwards must not
    // re-queue what it just delivered.
    const res = store.setWorkspaceGoal(ws.id, 'Live goal.', { actor: PERSON });
    if (!res.ok) throw new Error('unexpected');
    expect(res.retriage.requested).toBe(true);
    expect(store.getPendingRetriage(ws.id)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Through the real routes + the real delivery bridge
//
// Every handler in server.ts hand-copies fields into the store call, and the
// route is the layer nothing type-checks. These drive HTTP end to end — the
// store-level cases above cannot see a param the route drops.
// ─────────────────────────────────────────────────────────────────────────────

describe('re-triage routing, over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let baseUrl: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
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

  const makeHub = async (name: string, leadAgentId?: string): Promise<string> => {
    const r = await post('/api/workspaces', {
      name,
      goal: 'Old goal.',
      ...(leadAgentId !== undefined ? { leadAgentId } : {}),
    });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };
  const addTask = async (workspaceId: string, title: string): Promise<string> => {
    const r = await post(`/api/workspaces/${workspaceId}/tasks`, {
      author: PERSON,
      title,
      goal: 'chores',
    });
    return ((await r.json()) as { task: { id: string } }).task.id;
  };
  const editGoal = async (workspaceId: string, goal: string) => {
    const r = await put(`/api/workspaces/${workspaceId}/goal`, { goal, author: PERSON });
    return (await r.json()) as {
      retriage: { requested: boolean; queued: boolean; taskIds: string[]; batchId?: string };
    };
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'retriage-routes-'));
    handle = createServer({ port: 0, dataDir });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the goal edit goes to the LEAD, not to whoever is connected — and waits when they are away', async () => {
    const wsId = await makeHub('routed-hub', LEAD);
    const taskId = await addTask(wsId, 'draft the outline');

    // POSITIVE CONTROL FIRST: the lead attaches, joins the workspace channel
    // the way the MCP does, and the edit is delivered. Both halves matter —
    // the request IS a broadcast on that channel, so an agent that attached
    // without connecting is not a place a delivery can land.
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });
    const stream = await openWorkspaceStream(baseUrl, wsId);
    const live = await editGoal(wsId, 'Delivered goal.');
    expect(live.retriage.requested).toBe(true);
    expect(live.retriage.queued).toBe(false);

    // Now the lead is gone and only a bystander is connected. A connected
    // agent is not an addressee: the edit waits. The channel stays open on
    // purpose — reachability is a property of the CHANNEL, so this is the
    // case where somebody IS listening and it still waits for the right one.
    await local(`/api/workspaces/${wsId}/attachments/${LEAD}`, { method: 'DELETE' });
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: OTHER,
      runtime: 'claude-code-local',
    });
    const away = await editGoal(wsId, 'Waiting goal.');
    expect(away.retriage.requested).toBe(false);
    expect(away.retriage.queued).toBe(true);

    // Visible on the board's own read, not only in a sidecar.
    const info = await local(`/api/workspaces/${wsId}`);
    const body = (await info.json()) as {
      pendingRetriage?: { batchId: string; taskIds: string[]; newGoal: string };
    };
    expect(body.pendingRetriage?.batchId).toBe(away.retriage.batchId ?? '');
    expect(body.pendingRetriage?.taskIds).toEqual([taskId]);
    expect(body.pendingRetriage?.newGoal).toBe('Waiting goal.');

    // And handed over when the lead comes back, through the attach route.
    const back = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });
    const backBody = (await back.json()) as {
      pendingRetriage?: { batchId: string; taskIds: string[] };
    };
    expect(backBody.pendingRetriage?.batchId).toBe(away.retriage.batchId ?? '');
    expect(backBody.pendingRetriage?.taskIds).toEqual([taskId]);
    // Drained: the board no longer shows it waiting.
    const after = await local(`/api/workspaces/${wsId}`);
    expect(((await after.json()) as { pendingRetriage?: unknown }).pendingRetriage).toBeUndefined();
    await stream.close();
  });

  it('a goal edit with NO lead at all is pending work on the board, not a silent drop', async () => {
    const wsId = await makeHub('orphan-hub');
    const taskId = await addTask(wsId, 'draft the outline');
    const res = await editGoal(wsId, 'Nobody home.');
    expect(res.retriage.requested).toBe(false);
    expect(res.retriage.queued).toBe(true);

    const info = await local(`/api/workspaces/${wsId}`);
    const body = (await info.json()) as {
      workspace: { leadAgentId?: string };
      pendingRetriage?: { taskIds: string[] };
    };
    expect(body.workspace.leadAgentId).toBeUndefined();
    expect(body.pendingRetriage?.taskIds).toEqual([taskId]);

    // The board room says so too, which is what the hub renders off.
    const room = handle.rooms.get(workspaceRoomId(wsId));
    if (!room) throw new Error('ws room missing');
    const projected = room.ydoc.getMap('workspace').get('pendingRetriage') as
      | { taskIds: string[]; byName: string }
      | undefined;
    expect(projected?.taskIds).toEqual([taskId]);
    expect(projected?.byName).toBe('Jordan');
    // Display name only — the projection never carries actor ids.
    expect(JSON.stringify(projected)).not.toContain('known-jordan');
  });

  /**
   * The LIVE delivery must put the whole request on the wire.
   *
   * The MCP renders its channel line straight off this frame, so anything
   * missing here cannot be rendered no matter what the renderer does — and
   * the away lead, who gets `pendingRetriage` on attach, would keep getting
   * strictly more than the lead sitting at their desk. That asymmetry was
   * written down as "oldGoal is unrecoverable on the live path"; it was only
   * ever unrendered. This is the assertion that keeps it on the wire, because
   * `sse.broadcast(..., { event, ...req })` is a spread nothing type-checks
   * against what the reader needs.
   */
  it('the live triage.requested frame carries oldGoal and every taskId, not just a count', async () => {
    const wsId = await makeHub('wire-hub', LEAD);
    const first = await addTask(wsId, 'draft the outline');
    const second = await addTask(wsId, 'collect screenshots');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });

    const seen: Array<Record<string, unknown>> = [];
    const ctl = new AbortController();
    const stream = await local(`/events/workspace/${wsId}`, { signal: ctl.signal });
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const pump = (async () => {
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split('\n\n');
          buf = frames.pop() ?? '';
          for (const frame of frames) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                seen.push(JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
              } catch {}
            }
          }
        }
      } catch {}
    })();

    try {
      const edit = await editGoal(wsId, 'New goal: ship the board instead.');
      expect(edit.retriage.requested).toBe(true); // it really went out live
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !seen.some((e) => e.event === 'triage.requested')) {
        await new Promise((r) => setTimeout(r, 25));
      }

      // POSITIVE CONTROL: this reader can see frames at all. Without it,
      // every assertion below could pass vacuously on an empty stream.
      expect(seen.some((e) => e.event === 'workspace.goal_updated')).toBe(true);

      const req = seen.find((e) => e.event === 'triage.requested');
      if (!req) throw new Error('the live delivery never reached the channel');
      expect(req.kind).toBe('goal-retriage');
      expect(req.oldGoal).toBe('Old goal.');
      expect(req.newGoal).toBe('New goal: ship the board instead.');
      expect((req.taskIds as string[]).slice().sort()).toEqual([first, second].sort());
      expect(req.batchId).toBe(edit.retriage.batchId);
      expect(req.leadAgentId).toBe(LEAD);
    } finally {
      ctl.abort();
      await pump;
    }
  });

  it("the delivered request's batchId ties the resulting moves together as one goal edit", async () => {
    const wsId = await makeHub('batch-hub', LEAD);
    const G = await seedGoalsOverHttp(
      baseUrl,
      wsId,
      [{ key: 'ship', title: '1. Ship it' }],
      PERSON,
    );
    const first = await addTask(wsId, 'draft the outline');
    const second = await addTask(wsId, 'collect screenshots');
    await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: LEAD,
      runtime: 'claude-code-local',
    });
    const edit = await editGoal(wsId, 'New goal.');
    const batchId = edit.retriage.batchId;
    expect(typeof batchId).toBe('string');
    expect(edit.retriage.taskIds.sort()).toEqual([first, second].sort());

    const events: TaskStoreEvent[] = [];
    const off = handle.tasks.onEvent((e) => events.push(e));
    try {
      for (const taskId of [first, second]) {
        const moved = await post(`/api/tasks/${taskId}/goal`, {
          goal: G.ship,
          batchId,
          author: { id: LEAD, name: 'Lead', kind: 'agent' },
        });
        expect(moved.status).toBe(200);
      }
    } finally {
      off();
    }
    const regrouped = events.filter((e) => e.type === 'task.regrouped');
    expect(regrouped).toHaveLength(2);
    // N moves read as ONE goal edit because each carries the batch of the
    // `workspace.retriaged` row that asked for them — that is what the
    // activity view groups on.
    for (const ev of regrouped) {
      if (ev.type !== 'task.regrouped') throw new Error('narrowing');
      expect(ev.partOf).toBe(batchId ?? '');
    }
  });
});
