/**
 * Attaching to a board whose lead seat is held by a session that is gone.
 *
 * `attachAgent` used to claim an EMPTY seat only, and the reason it gave was
 * sound: an occupied seat is a standing decision, and a second agent attaching
 * is not a reassignment. What that rule could not see is that "occupied" and
 * "occupied by somebody who is coming back" are different states. On
 * 2026-08-29/30 a session respawned under a new name, the seat kept pointing
 * at the id that had exited, and this branch — correctly, by its own rule —
 * refused to touch it for 4.5 hours.
 *
 * So the guard is narrowed by exactly one case. THE CONTROL IS THE POINT OF
 * THIS FILE: a live lead must still keep its seat against an attaching peer,
 * because that is the bug the original rule was written to prevent, and
 * trading one for the other would be no improvement at all.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.ts';

describe('a stale seat is takeable; a live one is not', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Windows in milliseconds, and a stale window short enough to cross. */
  function tightStore(): TaskStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'seat-takeover-'));
    dirs.push(dataDir);
    const store = new TaskStore({
      dataDir,
      debounceMs: 5,
      heartbeatFreshMs: 20,
      observedWorkFreshMs: 20,
      leadSeatStaleMs: 60,
    });
    stores.push(store);
    return store;
  }

  const attach = (store: TaskStore, wsId: string, agentId: string) => {
    const res = store.attachAgent(wsId, { agentId, runtime: 'claude-code-local' });
    if (!res.ok) throw new Error(`attach failed: ${res.error}`);
    return res;
  };

  it('claims an empty seat, as it always did', () => {
    const store = tightStore();
    const ws = store.createWorkspace('empty');
    const res = attach(store, ws.id, 'first');
    expect(res.lead).toBe(true);
    expect(res.seat.leadAgentId).toBe('first');
    expect(res.seat.stale).toBe(false);
    expect(res.seatTakenFrom).toBeUndefined();
  });

  it('CONTROL: a live lead keeps its seat against an attaching peer', () => {
    // The rule the narrowing must not break. If this ever goes red, a
    // bystander attaching can evict a working lead — the exact failure the
    // empty-only guard existed to prevent.
    const store = tightStore();
    const ws = store.createWorkspace('busy');
    attach(store, ws.id, 'incumbent');
    const peer = attach(store, ws.id, 'bystander');
    expect(peer.lead).toBe(false);
    expect(peer.seat.leadAgentId).toBe('incumbent');
    expect(peer.seat.live).toBe(true);
    expect(peer.seat.stale).toBe(false);
    expect(peer.seatTakenFrom).toBeUndefined();
    expect(store.getWorkspace(ws.id)?.leadAgentId).toBe('incumbent');
  });

  it('CONTROL: a lead that is quiet but holding a stream keeps its seat', async () => {
    // The same rule at the other end of the clock. A lead deep in a long
    // build makes no observable call for far longer than any window, and its
    // MCP child is holding the channel open the whole time.
    const store = tightStore();
    const ws = store.createWorkspace('quiet');
    attach(store, ws.id, 'incumbent');
    await new Promise((r) => setTimeout(r, 120));
    store.setAgentStreamProbe((wsId, agentId) => wsId === ws.id && agentId === 'incumbent');
    const peer = attach(store, ws.id, 'bystander');
    expect(peer.lead).toBe(false);
    expect(peer.seat.leadAgentId).toBe('incumbent');
    expect(peer.seatTakenFrom).toBeUndefined();
  });

  it('takes a seat whose holder is gone, and says whose it was', async () => {
    const store = tightStore();
    const ws = store.createWorkspace('renamed');
    attach(store, ws.id, 'agent-live-feedback');
    await new Promise((r) => setTimeout(r, 120));

    const reborn = attach(store, ws.id, 'agent-workspaces');
    expect(reborn.lead).toBe(true);
    expect(reborn.seatTakenFrom).toBe('agent-live-feedback');
    expect(reborn.seat.leadAgentId).toBe('agent-workspaces');
    expect(reborn.seat.live).toBe(true);
    expect(store.getWorkspace(ws.id)?.leadAgentId).toBe('agent-workspaces');
  });

  it('the handover is recorded, not silent', async () => {
    // The seat change goes through the ordinary hand-over path, so the board
    // repaints and the audit trail carries who took it from whom. A quiet
    // reassignment would be a second invisible seat change, which is the
    // family of bug this whole ticket is about.
    const store = tightStore();
    const ws = store.createWorkspace('recorded');
    const events: string[] = [];
    store.onEvent((ev) => {
      if (ev.type === 'workspace.lead_changed') events.push(ev.workspaceId);
    });
    attach(store, ws.id, 'gone');
    await new Promise((r) => setTimeout(r, 120));
    events.length = 0;
    attach(store, ws.id, 'reborn');
    expect(events).toContain(ws.id);
  });

  it('the same agent re-attaching refreshes rather than taking from itself', async () => {
    // A long-running session re-attaches defensively. It is its own stale
    // holder, and reporting that it seized the seat from itself would be a
    // false alarm on the one surface that must stay trustworthy.
    const store = tightStore();
    const ws = store.createWorkspace('refresh');
    attach(store, ws.id, 'steady');
    await new Promise((r) => setTimeout(r, 120));
    const again = attach(store, ws.id, 'steady');
    expect(again.lead).toBe(true);
    expect(again.seatTakenFrom).toBeUndefined();
    expect(again.seat.stale).toBe(false);
  });
});
