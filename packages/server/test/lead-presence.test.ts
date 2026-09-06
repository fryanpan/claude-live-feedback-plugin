/**
 * Lead presence: the doc page's "is anybody listening", and the change-only
 * push behind it. The monitor is driven with a fake source first (what it
 * pushes, when, and to whom), then the route and the stream are driven
 * against a real server with a real seat.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeadPresence } from '@feedback/core';
import { createLeadPresenceMonitor, readLeadPresence } from '../src/lead-presence.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { openWorkspaceStream } from './agent-stream.ts';
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('lead presence monitor', () => {
  const world = () => {
    const seats = new Map<string, { leadAgentId?: string; live: boolean }>();
    const boards = new Map<string, string>([
      ['doc-a', 'w-1'],
      ['doc-b', 'w-1'],
      ['doc-c', 'w-2'],
    ]);
    const listeners = new Set<(e: { type: string; workspaceId?: string }) => void>();
    const pushed: Array<[string, boolean]> = [];
    const open = new Set<string>(['doc-a', 'doc-b', 'doc-c']);
    const monitor = createLeadPresenceMonitor({
      source: {
        boardOf: (docId) => boards.get(docId),
        seat: (ws) => seats.get(ws) ?? { live: false },
      },
      broadcast: (docId, p) => pushed.push([docId, p.live]),
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      hasListeners: (docId) => open.has(docId),
      sweepMs: 0,
    });
    const emit = (type: string, workspaceId: string) => {
      for (const l of listeners) l({ type, workspaceId });
    };
    return { seats, monitor, pushed, emit, open };
  };

  it("answers the GET, then pushes only when the bit flips, only to that board's docs", () => {
    const w = world();
    expect(w.monitor.watch('doc-a')).toEqual({
      event: 'lead.presence',
      docId: 'doc-a',
      live: false,
      workspaceId: 'w-1',
    });
    w.monitor.watch('doc-c');
    // A heartbeat that changes nothing pushes nothing.
    w.emit('agent.heartbeat', 'w-1');
    expect(w.pushed).toEqual([]);
    // The seat comes alive: doc-a hears it, doc-c (another board) does not,
    // doc-b (same board, nobody asked) does not.
    w.seats.set('w-1', { leadAgentId: 'agent-lead', live: true });
    w.emit('agent.attached', 'w-1');
    expect(w.pushed).toEqual([['doc-a', true]]);
    // Same answer again: silence. An unrelated event: silence.
    w.emit('agent.heartbeat', 'w-1');
    w.emit('task.created', 'w-1');
    expect(w.pushed).toEqual([['doc-a', true]]);
    w.seats.set('w-1', { leadAgentId: 'agent-lead', live: false });
    w.emit('agent.detached', 'w-1');
    expect(w.pushed).toEqual([
      ['doc-a', true],
      ['doc-a', false],
    ]);
  });

  it('the sweep catches a window that closed silently, and drops docs nobody has open', () => {
    const w = world();
    w.seats.set('w-1', { leadAgentId: 'agent-lead', live: true });
    w.monitor.watch('doc-a');
    w.monitor.watch('doc-b');
    // Nothing fired; the clock ran out.
    w.seats.set('w-1', { leadAgentId: 'agent-lead', live: false });
    w.open.delete('doc-b');
    w.monitor.sweep();
    expect(w.pushed).toEqual([['doc-a', false]]);
    expect(w.monitor.watched()).toEqual(['doc-a']);
    w.monitor.stop();
    expect(w.monitor.watched()).toEqual([]);
  });

  it('notify re-reads one board — the stream-open case no event names', () => {
    const w = world();
    w.monitor.watch('doc-a');
    w.monitor.watch('doc-c');
    w.seats.set('w-1', { leadAgentId: 'agent-lead', live: true });
    w.seats.set('w-2', { leadAgentId: 'agent-other', live: true });
    w.monitor.notify('w-1');
    expect(w.pushed).toEqual([['doc-a', true]]);
  });

  it('a doc no board holds is never live', () => {
    expect(
      readLeadPresence({ boardOf: () => undefined, seat: () => ({ live: true }) }, 'doc-x'),
    ).toEqual({
      event: 'lead.presence',
      docId: 'doc-x',
      live: false,
    });
  });
});

describe(`GET /workspaces/${WS}/docs/:docId/lead-presence and the lead.presence stream`, () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let docId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const presenceOf = async (): Promise<LeadPresence> => {
    const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/lead-presence`);
    expect(res.status).toBe(200);
    return (await res.json()) as LeadPresence;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'lead-presence-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    workspaceId = (
      (await (await post('/workspaces', { name: 'presence-board' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    WS = workspaceId;
    docId = (
      (await (await post(`/workspaces/${workspaceId}/huddles`, { kind: 'discussion' })).json()) as {
        docId: string;
      }
    ).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reads the empty seat, then the live lead, and pushes the change to the doc's pages", async () => {
    // A huddle doc is HELD by its board (no setId) — the presence still
    // resolves to that board, which is the whole point of `boardOf`.
    const empty = await presenceOf();
    expect(empty).toEqual({ event: 'lead.presence', docId, workspaceId, live: false });

    // A page listening on the doc's stream.
    const controller = new AbortController();
    const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/events:stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    expect(res.ok).toBe(true);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no stream body');
    let seen = '';
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          seen += new TextDecoder().decode(value);
        }
      } catch {
        // aborted
      }
    })();
    const until = async (pred: () => boolean, what: string) => {
      const deadline = Date.now() + 2_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${seen}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // A lead attaches and is on the wire: live.
    const attached = handle.tasks.attachAgent(workspaceId, {
      agentId: 'agent-lead',
      runtime: 'claude-code-local',
    });
    expect(attached.ok).toBe(true);
    const stream = await openWorkspaceStream(base, workspaceId, {}, 'agent-lead');
    // The attach event reached the monitor; the page was told.
    await until(() => seen.includes('event: lead.presence'), 'the live push');
    expect(seen).toContain('"live":true');
    expect(seen).toContain('"leadAgentId":"agent-lead"');
    const live = await presenceOf();
    expect(live.live).toBe(true);
    expect(live.leadAgentId).toBe('agent-lead');

    // Gone: the seat's holder detaches, and the page hears it.
    await stream.close();
    expect(handle.tasks.detachAgent(workspaceId, 'agent-lead')).toBe(true);
    await until(() => seen.includes('"live":false'), 'the gone push');
    expect((await presenceOf()).live).toBe(false);

    controller.abort();
    await pump;
  });
});
