/**
 * A seat held by a session that is gone.
 *
 * 2026-08-29/30: the lead session respawned under a new agent name, so its
 * identity moved. The board's lead pointer still named the old id, whose last
 * heartbeat was 4.5 hours earlier and which would never wake again. For that
 * whole window no board comment, review answer or stall nudge reached any live
 * session, and nothing anywhere said so — an occupied-but-dead seat rendered
 * exactly like a healthy one, and `attach_agent` reported `lead: false` as an
 * ordinary field.
 *
 * The empty seat was never the problem: that state is loud on every surface.
 * This is the third state nobody had a name for.
 *
 * WHAT STALENESS IS KEYED ON, which is the part worth reviewing: the socket
 * first, the clock only after the socket is gone. Elapsed silence on its own
 * is a bad signal here and measured at 40% false positives against sessions
 * that were provably working — see `agent-stream-liveness.test.ts` for the
 * 19.1-minute grep that started that. So the control below matters more than
 * the assertions: a lead holding a stream must never read stale, however long
 * it has been quiet.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEAD_SEAT_STALE_MS, TaskStore } from '../src/tasks.ts';

describe('leadSeatHealth', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Windows in milliseconds, so "off the wire" arrives without waiting. */
  function tightStore(): TaskStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'lead-seat-'));
    dirs.push(dataDir);
    const store = new TaskStore({
      dataDir,
      debounceMs: 5,
      heartbeatFreshMs: 40,
      observedWorkFreshMs: 40,
    });
    stores.push(store);
    return store;
  }

  /** Far enough past the stale window that the clock has made up its mind. */
  const wellPast = () => Date.now() + LEAD_SEAT_STALE_MS + 60_000;

  it('an empty seat is empty, not stale', () => {
    // Named separately because the fix must not bury the state people have
    // been reading correctly all along under the one they could not see.
    const store = tightStore();
    const ws = store.createWorkspace('empty-seat');
    expect(store.leadSeatHealth(ws.id, wellPast())).toEqual({ live: false, stale: false });
  });

  it('a lead that just attached is live', () => {
    const store = tightStore();
    const ws = store.createWorkspace('fresh');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    const health = store.leadSeatHealth(ws.id);
    expect(health.leadAgentId).toBe('worker');
    expect(health.live).toBe(true);
    expect(health.stale).toBe(false);
  });

  it('POSITIVE CONTROL: a lead holding a stream is never stale, however quiet', async () => {
    // The whole design in one assertion. This session has made no observable
    // call for well past every window — the 19.1-minute grep — and it is
    // plainly alive, because its MCP child is holding the very channel a
    // delivery would ride. If this ever goes red, the read has drifted onto
    // elapsed silence and will start evicting working leads.
    const store = tightStore();
    const ws = store.createWorkspace('busy-lead');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    store.setAgentStreamProbe((wsId, agentId) => wsId === ws.id && agentId === 'worker');
    const health = store.leadSeatHealth(ws.id, wellPast());
    expect(health.live).toBe(true);
    expect(health.stale).toBe(false);
  });

  it('NEGATIVE CONTROL: somebody else’s stream does not keep the seat alive', async () => {
    // Without this the control above passes against a probe that answers true
    // for anyone — a browser tab on the same board impersonating a lead that
    // exited hours ago.
    const store = tightStore();
    const ws = store.createWorkspace('other-stream');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    store.setAgentStreamProbe((_wsId, agentId) => agentId === 'somebody-else');
    expect(store.leadSeatHealth(ws.id, wellPast()).stale).toBe(true);
  });

  it('a lead off the wire for a moment is not yet stale', async () => {
    // The reconnect blip. Calling this stale is how a working lead loses its
    // seat to the next session that attaches.
    const store = tightStore();
    const ws = store.createWorkspace('blip');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    const health = store.leadSeatHealth(ws.id);
    expect(health.live).toBe(false);
    expect(health.stale).toBe(false);
    expect(health.leadAgentId).toBe('worker');
  });

  it('a lead off the wire and past the window is stale, and says so in words', async () => {
    const store = tightStore();
    const ws = store.createWorkspace('gone');
    store.attachAgent(ws.id, { agentId: 'agent-live-feedback', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));
    const health = store.leadSeatHealth(ws.id, wellPast());
    expect(health.stale).toBe(true);
    expect(health.live).toBe(false);
    expect(health.leadAgentId).toBe('agent-live-feedback');
    expect(health.lastObservedAt).toBeGreaterThan(0);
    expect(health.staleForMs ?? 0).toBeGreaterThanOrEqual(LEAD_SEAT_STALE_MS);
    // The notice names the holder: "the seat is stale" without saying whose
    // is not actionable by the person reading the board.
    expect(health.notice ?? '').toContain('agent-live-feedback');
  });

  it('a seat whose holder detached is stale with nothing observed', () => {
    // Reachable, and it is the incident's own shape: the attachment record
    // goes and the seat pointer stays. There is no moment to report, and no
    // reason to believe anybody is listening.
    //
    // Note what is NOT tested here, because the server already refuses it:
    // `setLeadAgent` will not hand the seat to an id nothing attached under,
    // so a hand-set phantom lead cannot be created that way. The assertion
    // below pins that refusal, so this case stays honest about which door the
    // state actually comes through.
    const store = tightStore();
    const ws = store.createWorkspace('detached');
    store.attachAgent(ws.id, { agentId: 'agent-live-feedback', runtime: 'claude-code-local' });
    const refused = store.setLeadAgent(ws.id, 'never-here', {
      actor: { id: 'agent-live-feedback', name: 'Worker', kind: 'agent' },
    });
    expect(refused.ok).toBe(false);

    expect(store.detachAgent(ws.id, 'agent-live-feedback')).toBe(true);
    const health = store.leadSeatHealth(ws.id, wellPast());
    expect(health.leadAgentId).toBe('agent-live-feedback');
    expect(health.stale).toBe(true);
    expect(health.lastObservedAt).toBeUndefined();
    expect(health.notice ?? '').toContain('never been observed');
  });
});
