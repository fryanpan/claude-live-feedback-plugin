/**
 * A delivery to a LIVE agent has to be durable too.
 *
 * `voice-gate-liveness.test.ts` and `agent-stream-liveness.test.ts` both fixed
 * the same half of this: making the server's answer to "is this agent
 * reachable" correct. Neither touched what happens once the answer is yes.
 *
 * On the yes branch the route emitted one SSE frame and kept no record:
 *
 *     if (hasLiveAttachment(ws)) result = { route: 'agent', ack: 'Sent…' }
 *     else { queueVoiceRequest(…);  result = { route: 'agent-queued', … } }
 *
 * So being live made a message strictly LESS likely to arrive than being away,
 * which is the reverse of what liveness should buy. Measured 2026-08-19: of ten
 * utterances that day, nine took `agent-queued` or `fast-path` and survived;
 * the one that took `agent` is the one that was lost, and `attach_agent` four
 * minutes later returned `queuedVoice: []` because it had never been written
 * anywhere.
 *
 * The fix inverts the relationship the ticket names: the queue is the record
 * and live delivery is an optimisation on top of it. Every utterance routed to
 * an agent is written down; the frame is sent as well when someone is there;
 * and the entry leaves the queue when the receiving process ACKNOWLEDGES it,
 * not when the server finishes writing to a socket.
 *
 * The grace window is what stops that durability turning into duplicate work.
 * A frame in flight has been emitted and not yet acked, which is
 * indistinguishable from one that was lost — so a redelivery has to wait long
 * enough for a working agent to have acked, and an attaching agent (a NEW
 * process, for which nothing can be in flight) skips the wait entirely.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';

describe('an utterance routed to an agent is written down either way', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function store(ackGraceMs = 40): TaskStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'voice-durable-'));
    dirs.push(dataDir);
    const s = new TaskStore({ dataDir, debounceMs: 5, voiceAckGraceMs: ackGraceMs });
    stores.push(s);
    return s;
  }

  function ws(s: TaskStore): string {
    const w = s.createWorkspace('durable-hub');
    s.attachAgent(w.id, { agentId: 'worker', runtime: 'claude-code-local' });
    return w.id;
  }

  const utterance = {
    transcript: 'move the reachability ticket to the top',
    actor: { id: 'u-1', name: 'Reviewer' },
  };

  it('gives every queued entry an id, so a receipt can name one', () => {
    const s = store();
    const w = ws(s);
    const id = s.queueVoiceRequest(w, utterance);
    expect(typeof id).toBe('string');
    expect(s.listQueuedVoice(w).map((q) => q.id)).toEqual([id as string]);
  });

  it('an entry the agent acknowledged does not come back', () => {
    const s = store();
    const w = ws(s);
    const id = s.queueVoiceRequest(w, utterance) as string;
    expect(s.ackVoiceRequest(w, id)).toBe(true);
    expect(s.listQueuedVoice(w)).toHaveLength(0);
  });

  it('POSITIVE CONTROL: acking an unknown id leaves the queue alone', () => {
    // Without this the assertion above is satisfied by an ack that simply
    // empties the file, which would discard real work on a stale receipt.
    const s = store();
    const w = ws(s);
    s.queueVoiceRequest(w, utterance);
    expect(s.ackVoiceRequest(w, 'no-such-entry')).toBe(false);
    expect(s.listQueuedVoice(w)).toHaveLength(1);
  });

  it('an in-flight frame is not re-handed to the same session while it could still be acked', () => {
    const s = store(10_000); // a grace window nothing in this test can outlive
    const w = ws(s);
    const id = s.queueVoiceRequest(w, utterance) as string;
    s.markVoiceEmitted(w, id);

    // The keepalive's heartbeat, moments later. The frame is in flight, so
    // handing it over again would ask the agent to do the work twice.
    const beat = s.heartbeat(w, 'worker');
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedVoice ?? []).toEqual([]);
    // Still on the books — not delivered, just not re-sent yet.
    expect(s.listQueuedVoice(w)).toHaveLength(1);
  });

  it('an emitted frame nobody acknowledged comes back once the grace lapses', async () => {
    const s = store(30);
    const w = ws(s);
    const id = s.queueVoiceRequest(w, utterance) as string;
    s.markVoiceEmitted(w, id);
    await new Promise((r) => setTimeout(r, 50));

    const beat = s.heartbeat(w, 'worker');
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedVoice?.map((q) => q.transcript)).toEqual([utterance.transcript]);
  });

  it('a NON-LEAD attach leaves the queue intact for the lead', () => {
    // The queue is addressed to the seat, not to whoever shows up first — the
    // same contract as pendingBucketReview / taskReviews.
    // Before this test, any attach drained it, so a bystander attaching to a
    // board swallowed the notes into a payload it has no contract to act on.
    const s = store();
    const w = s.createWorkspace('guarded-hub', { leadAgentId: 'agent-lead' }).id;
    s.queueVoiceRequest(w, utterance);

    const bystander = s.attachAgent(w, {
      agentId: 'agent-bystander',
      runtime: 'claude-code-local',
    });
    if (!bystander.ok) throw new Error('attach refused');
    expect(bystander.lead).toBe(false);
    expect(bystander.queuedVoice).toBeUndefined();
    // Still on the books — not delivered, just not handed to the wrong seat.
    expect(s.listQueuedVoice(w)).toHaveLength(1);

    // And the lead's next attach still receives it.
    const lead = s.attachAgent(w, { agentId: 'agent-lead', runtime: 'claude-code-local' });
    if (!lead.ok) throw new Error('attach refused');
    expect(lead.lead).toBe(true);
    expect(lead.queuedVoice?.map((q) => q.transcript)).toEqual([utterance.transcript]);
    expect(s.listQueuedVoice(w)).toHaveLength(0);
  });

  it("POSITIVE CONTROL: the lead's attach drains the queue exactly as before", () => {
    const s = store();
    const w = s.createWorkspace('guarded-hub', { leadAgentId: 'agent-lead' }).id;
    s.queueVoiceRequest(w, utterance);

    const lead = s.attachAgent(w, { agentId: 'agent-lead', runtime: 'claude-code-local' });
    if (!lead.ok) throw new Error('attach refused');
    expect(lead.lead).toBe(true);
    expect(lead.queuedVoice?.map((q) => q.transcript)).toEqual([utterance.transcript]);
    // Drained means drained: a second attach by the lead is offered nothing.
    const again = s.attachAgent(w, { agentId: 'agent-lead', runtime: 'claude-code-local' });
    if (!again.ok) throw new Error('attach refused');
    expect(again.queuedVoice ?? []).toEqual([]);
    expect(s.listQueuedVoice(w)).toHaveLength(0);
  });

  it('an ATTACHING agent gets an in-flight frame immediately — a new process holds nothing', () => {
    // The grace window exists to protect a session that might still ack. A
    // session that just attached is a different process; whatever was in
    // flight went to the one that is gone, so waiting would strand it for the
    // length of the grace for no one's benefit.
    const s = store(10_000);
    const w = ws(s);
    const id = s.queueVoiceRequest(w, utterance) as string;
    s.markVoiceEmitted(w, id);

    const attached = s.attachAgent(w, { agentId: 'worker', runtime: 'claude-code-local' });
    if (!attached.ok) throw new Error('attach refused');
    expect(attached.queuedVoice?.map((q: { transcript: string }) => q.transcript)).toEqual([
      utterance.transcript,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The headline, through the real route: the LIVE branch writes the row too.
// This is the exact case that lost Bryan's 15:59 utterance on 2026-08-19 —
// acked as "Sent to the workspace agent" and recorded nowhere.
// ─────────────────────────────────────────────────────────────────────────────

describe('the live branch is durable too', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const streams: AgentStream[] = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-live-durable-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.close();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('records an utterance sent to a live agent, and the ack clears exactly it', async () => {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'live-durable', goal: 'Ship it.' }),
    });
    const { workspace } = (await r.json()) as { workspace: { id: string } };
    await fetch(`${base}/api/workspaces/${workspace.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'worker', runtime: 'claude-code-local' }),
    });
    // Reachable, so the route takes the live branch — the one that used to
    // keep nothing.
    streams.push(await openWorkspaceStream(base, workspace.id, {}, 'worker'));

    const said = await fetch(`${base}/api/workspaces/${workspace.id}/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transcript: 'change goal one and re-place the tasks under it',
        author: { id: 'known-jordan', name: 'Jordan', kind: 'known' },
      }),
    });
    const routed = (await said.json()) as { route: string };
    expect(routed.route).toBe('agent');

    // The point: it is on the queue despite having been delivered live.
    const queued = handle.tasks.listQueuedVoice(workspace.id);
    expect(queued).toHaveLength(1);
    const entryId = queued[0]?.id as string;
    expect(entryId).toBeTypeOf('string');

    // And the receipt — the thing the agent's MCP sends once the frame is in
    // its hands — is what takes it off.
    const acked = await fetch(`${base}/api/workspaces/${workspace.id}/voice-queue/${entryId}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect((await acked.json()) as { cleared: boolean }).toMatchObject({ cleared: true });
    expect(handle.tasks.listQueuedVoice(workspace.id)).toHaveLength(0);
  });
});
