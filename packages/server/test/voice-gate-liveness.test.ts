/**
 * Delivery liveness: does a request reach the agent that is actually working?
 *
 * The bug this file pins. `hasLiveAttachment` asked "did this agent recently
 * SAY it was alive" — `lastHeartbeat`, moved only by the `heartbeat` MCP tool,
 * which nothing calls automatically: no timer, no hook, one line of prose in
 * one skill. So the gate measured whether a language model remembered to
 * announce itself, not whether it was working.
 *
 * Measured on the live board before this change (2026-08-19):
 *
 *  - 13 liveness events (attach + heartbeat) in 5.43 days, against 215
 *    `task.transitioned` events in the same window.
 *  - Union of the 5-minute freshness windows those 13 events bought: 60
 *    minutes. **The gate could read live for 0.77% of the time an agent was
 *    attached and demonstrably working.**
 *  - Consequence, via `voice.ts`: 6 of 10 recorded utterances routed to
 *    `agent-queued`, one of them Bryan saying "voice is not working".
 *
 * Queued is not lost — `drainVoiceQueue` hands the backlog to the next
 * attaching session — but attach gaps on that board ran to 3.3 days, so the
 * honest description is "deferred, possibly for days, and mislabelled as
 * away".
 *
 * The fix is to derive liveness from work the server ALREADY OBSERVES, never
 * from self-report. Two conditions, both server-side observations:
 *
 *  1. a sign of life inside `OBSERVED_LIVE_MS` — a heartbeat OR an observed
 *     write, whichever is newer;
 *  2. somebody actually subscribed to the workspace channel the request is
 *     about to be broadcast on.
 *
 * (2) is why this is an AND rather than a wider window: a delivery to a dead
 * session is broadcast to nobody and lost for good, where a queued one is
 * merely late. The window alone cannot see a session that died thirty seconds
 * ago; the open channel can.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OBSERVED_LIVE_MS, TaskStore } from '../src/tasks.ts';

describe('liveness for delivery is observed, not self-reported', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A store whose windows are milliseconds, so the clock can be waited out. */
  function tightStore(observedWorkFreshMs = 40): TaskStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'voice-gate-'));
    dirs.push(dataDir);
    const store = new TaskStore({
      dataDir,
      debounceMs: 5,
      heartbeatFreshMs: 40,
      observedWorkFreshMs,
    });
    stores.push(store);
    return store;
  }

  it('an agent that is WORKING but never heartbeats still counts as live', async () => {
    // THE bug. The agent attaches, gets on with the job, and never calls the
    // one tool whose only purpose is to say it exists. Today that reads away
    // within five minutes and its user is told the board is not listening.
    const store = tightStore();
    const ws = store.createWorkspace('delivery-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });

    // Let every heartbeat-shaped signal go stale.
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveAttachment(ws.id)).toBe(false);

    // …and now the agent does a piece of observable work. That is the whole
    // signal: the server saw it write, so the server knows it is there.
    expect(store.noteAgentToolCall(ws.id, 'worker')).toBe(true);
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it('POSITIVE CONTROL: a silent attachment still goes away', async () => {
    // Without this, the assertion above passes just as happily against a gate
    // that returns true unconditionally — which would be a worse bug than the
    // one being fixed, because a delivery to nobody is lost rather than late.
    const store = tightStore();
    const ws = store.createWorkspace('silent-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'ghost', runtime: 'claude-code-local' });
    expect(store.hasLiveAttachment(ws.id)).toBe(true); // fresh at attach
    await new Promise((r) => setTimeout(r, 60));
    // The record is still there. Existence was never the question.
    expect(store.listAttachments(ws.id)).toHaveLength(1);
    expect(store.hasLiveAttachment(ws.id)).toBe(false);
  });

  it('the LEAD predicate reads the same observed clock', async () => {
    // Goal re-triage is lead-addressed, so it has its own predicate — and it
    // had the same starvation. Fixing one and not the other would leave the
    // board-wide request queueing while ordinary ones flowed.
    const store = tightStore();
    const ws = store.createWorkspace('lead-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveLeadAttachment(ws.id)).toBe(false);
    store.noteAgentToolCall(ws.id, 'lead');
    expect(store.hasLiveLeadAttachment(ws.id)).toBe(true);
  });

  it('a fresh heartbeat is still a sign of life — the new clock ADDS to the old one', async () => {
    // The change must not trade one starved signal for another: an agent that
    // does heartbeat honestly is live on that alone, with no writes at all.
    const store = tightStore();
    const ws = store.createWorkspace('polite-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'polite', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveAttachment(ws.id)).toBe(false);
    store.heartbeat(ws.id, 'polite');
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it('nobody subscribed to the channel means nobody receives it, whatever the clock says', () => {
    // The half a time window cannot cover: a session that died since its last
    // write is inside the window and gone. The request is about to be
    // broadcast on `ws~<id>` — so ask whether anyone is on that channel.
    const store = tightStore();
    const ws = store.createWorkspace('probe-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    // Freshly attached and freshly working: the clock says live.
    expect(store.hasLiveAttachment(ws.id)).toBe(true);

    store.setDeliveryProbe(() => false);
    expect(store.hasLiveAttachment(ws.id)).toBe(false);
    expect(store.hasLiveLeadAttachment(ws.id)).toBe(false);

    // POSITIVE CONTROL for the probe itself: it can also say yes, so the
    // assertion above is about the probe's answer and not about it being
    // wired at all.
    store.setDeliveryProbe(() => true);
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it('WIRING: doing real board work moves the clock, with nobody remembering to call anything', async () => {
    // The bug underneath the bug. `noteAgentToolCall` already existed and was
    // already correct — and had ZERO production callers, so the clock it
    // moves never moved. Every assertion above would pass just as well
    // against that dead method. This one fails unless the observation is
    // wired to something an agent actually does.
    const store = tightStore();
    const ws = store.createWorkspace('wiring-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveAttachment(ws.id)).toBe(false);

    // No liveness call anywhere in this line — just an agent doing its job.
    const created = store.createTask(ws.id, {
      title: 'Something worth doing',
      actor: { id: 'worker', name: 'worker', kind: 'agent' },
    });
    expect(created.ok).toBe(true);
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it('WIRING: the roster is matched on every spelling, not the one the event happens to use', async () => {
    // Measured on the live board: the same session appears as `live-feedback`
    // in the event actor and `agent-live-feedback` in the attachment roster.
    // Matching a single spelling would leave this fix a no-op in production
    // while every test above still passed.
    const store = tightStore();
    const ws = store.createWorkspace('spelling-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'agent-field-worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveAttachment(ws.id)).toBe(false);

    store.createTask(ws.id, {
      title: 'Work under the other spelling',
      actor: { id: 'Field Worker', name: 'Field Worker', kind: 'agent' },
    });
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it("WIRING: a person's edit does not make an absent agent look live", async () => {
    // POSITIVE CONTROL for the matching above. If the actor were ignored and
    // any event bumped every attachment, the two tests above would pass and
    // the gate would promise delivery to sessions that had gone home.
    const store = tightStore();
    const ws = store.createWorkspace('person-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));

    store.createTask(ws.id, {
      title: 'Filed by a human',
      actor: { id: 'reviewer', name: 'Reviewer', kind: 'person' },
    });
    expect(store.hasLiveAttachment(ws.id)).toBe(false);
  });

  it('WIRING: a heartbeat event must never move the WORK clock', async () => {
    // The two clocks exist so `unresponsive` — alive but not working — is
    // expressible. Observing `agent.heartbeat` as work would collapse them
    // back into one and delete that state, which is the same mistake the MCP
    // side made by defaulting `toolCallAt` to now.
    const store = tightStore(10_000); // work window wide open
    const ws = store.createWorkspace('clocks-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    const before = store.listAttachments(ws.id)[0]?.lastToolCallAt;
    await new Promise((r) => setTimeout(r, 20));
    store.heartbeat(ws.id, 'worker');
    expect(store.listAttachments(ws.id)[0]?.lastToolCallAt).toBe(before);
  });

  it("WIRING: observing an event stamps the EVENT's time, not the moment of observing it", () => {
    // Found as a 1-in-3 flake, not by reading the code. Attaching into an
    // empty lead seat emits `workspace.lead_changed` — a non-agent event, so
    // the observer fires during the attach itself — and a fresh `Date.now()`
    // there lands a millisecond after the attach, breaking the contract that
    // a new attachment's two clocks are equal ("active from birth, never
    // unresponsive-from-birth").
    const store = tightStore(10_000);
    const ws = store.createWorkspace('stamp-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    const att = store.listAttachments(ws.id)[0];
    expect(att?.lastToolCallAt).toBe(att?.lastHeartbeat);
  });

  it('WIRING: attaching reads the clock ONCE — a tick mid-attach cannot split the two', () => {
    // The test above SAMPLES that contract; this one asserts it. Passing the
    // event's `ts` into the observer fixed only half of the flake, because
    // `assignLead` still took a `Date.now()` of its OWN for the
    // `workspace.lead_changed` it stamps — so the attach was still two clock
    // reads, and still went red whenever the millisecond happened to tick
    // between them. Measured at 8 failures in 300 runs on 676f53b, which is
    // exactly the kind of rate that reddens somebody else's branch.
    //
    // Ticking the clock on EVERY read makes that tick certain rather than
    // lucky: under this stub the old code fails every single run, so the red
    // is a statement about the code and not about the machine's timing.
    const store = tightStore(10_000);
    const ws = store.createWorkspace('one-read-hub', 'Ship it.');
    const realNow = Date.now;
    let ticks = realNow.call(Date);
    Date.now = () => ++ticks;
    try {
      store.attachAgent(ws.id, { agentId: 'lead', runtime: 'claude-code-local' });
    } finally {
      Date.now = realNow;
    }
    const att = store.listAttachments(ws.id)[0];
    expect(att?.lastToolCallAt).toBe(att?.lastHeartbeat);
  });

  it('WIRING: observing OLDER work than we already knew is not news', () => {
    // The clock only moves forward, the same guard `heartbeat` applies to a
    // claimed toolCallAt — otherwise a replayed or out-of-order event could
    // walk a live agent's liveness backwards toward away.
    const store = tightStore(10_000);
    const ws = store.createWorkspace('monotonic-hub', 'Ship it.');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    const before = store.listAttachments(ws.id)[0]?.lastToolCallAt ?? 0;
    expect(store.noteAgentToolCall(ws.id, 'worker', before - 60_000)).toBe(true);
    expect(store.listAttachments(ws.id)[0]?.lastToolCallAt).toBe(before);
  });

  it('the shipped window is minutes, and wide enough for how agents actually work', () => {
    // Measured on the live board: the median gap between consecutive
    // observable agent writes is 0.3 min and p90 is 11.2 min, so a window at
    // the old 5-minute heartbeat figure would still read away across ~18% of
    // ordinary working gaps. 15 minutes sits just above p90 — wide enough for
    // a normal pause, narrow enough that a dead session stops being promised
    // work quickly. It is deliberately NOT hours: the cost of a false live is
    // a lost utterance.
    expect(OBSERVED_LIVE_MS).toBe(15 * 60_000);
  });
});
