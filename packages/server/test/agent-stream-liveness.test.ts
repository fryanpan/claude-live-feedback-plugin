/**
 * The socket the agent is holding open is better evidence than the clock.
 *
 * `voice-gate-liveness.test.ts` fixed the previous round of this: liveness
 * moved from "did the model remember to call `heartbeat`" to "did the server
 * OBSERVE this agent inside `OBSERVED_LIVE_MS`", where an observation is a
 * heartbeat or a write. That is strictly better and it still loses messages,
 * because it measures the wrong process.
 *
 * Measured here 2026-08-19, on this session: an utterance arrived at 16:41:18
 * with the agent's last observation at 16:22:09 — a 19.1-minute gap against a
 * 15-minute window, so it queued. Those nineteen minutes were `grep`, `sed`,
 * a read-only `curl` and a scratchpad file: an agent working continuously and
 * hard, making zero calls that this server could see. `attachment-keepalive.ts`
 * did not save it either, because that piggybacks on MCP tool calls and there
 * were none to ride.
 *
 * The whole time, the MCP child process was holding an SSE stream open on
 * `/events/workspace/<id>` — the very channel the delivery would have ridden.
 * The server had a live socket to the agent and declined to use it because a
 * language model had not spoken in nineteen minutes.
 *
 * So delivery asks the socket. Two properties this must have and a third it
 * must NOT acquire:
 *
 *  1. The stream names its agent, so "is that agent reachable" is answerable.
 *     A browser tab on the same board sends no agentId and therefore cannot
 *     make an absent agent look present — the previous round's `DeliveryProbe`
 *     could only ever count subscribers, which is why it was allowed to narrow
 *     the answer and never widen it. This one may widen it because it is
 *     specific.
 *  2. Anything that does queue comes back on the agent's next observation
 *     rather than its next `attach_agent`. A long-running session attaches
 *     once, at startup; parking a message until the next attach is parking it
 *     until the next restart.
 *  3. It must NOT move the DISPLAYED state. `attachmentState` renders
 *     "process up, agent unresponsive" from a fresh heartbeat against a stale
 *     tool call, and `attachment-keepalive.ts` deliberately refuses a timer to
 *     protect exactly that distinction. Reachability and working-ness are
 *     different questions; this file pins that they stay different.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { TaskStore, attachmentState } from '../src/tasks.ts';
import { type AgentStream, openWorkspaceStream } from './agent-stream.ts';

describe('an open agent stream is a delivery signal', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A store whose windows are milliseconds, so the clock can be waited out. */
  function tightStore(): TaskStore {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-stream-'));
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

  it('reaches an agent working off-server for longer than the observed window', async () => {
    const store = tightStore();
    const ws = store.createWorkspace('stream-hub');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });

    // Nineteen minutes of grep, in miniature: no heartbeat, no write, no tool
    // call this server can see.
    await new Promise((r) => setTimeout(r, 60));
    expect(store.hasLiveAttachment(ws.id)).toBe(false);

    // The agent's MCP child never went anywhere — its stream is open.
    store.setAgentStreamProbe(
      (workspaceId, agentId) => workspaceId === ws.id && agentId === 'worker',
    );
    expect(store.hasLiveAttachment(ws.id)).toBe(true);
  });

  it('POSITIVE CONTROL: a stream belonging to a DIFFERENT agent proves nothing', async () => {
    // Without this the assertion above passes against a probe that returns
    // true for anyone, which is the browser-tab bug the old subscriber count
    // had — an open tab impersonating a working agent, and the request handed
    // to it lost rather than late.
    const store = tightStore();
    const ws = store.createWorkspace('other-hub');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 60));

    store.setAgentStreamProbe((_workspaceId, agentId) => agentId === 'somebody-else');
    expect(store.hasLiveAttachment(ws.id)).toBe(false);
  });

  it('does not change what the board DISPLAYS about a wedged session', () => {
    // The keepalive's stated reason for refusing a timer. A session whose
    // process is up but which has done no work for longer than the stale
    // window reads unresponsive, and an open socket must not launder that
    // into "active" — the socket says the frame will arrive, not that anyone
    // will act on it.
    const now = Date.now();
    const wedged = { lastHeartbeat: now, lastToolCallAt: now - 60 * 60_000 };
    expect(attachmentState(wedged, now)).toBe('unresponsive');
  });

  it('hands a queued utterance back on the next heartbeat, not the next attach', () => {
    // A long-running session attaches once. Before this, `drainVoiceQueue`
    // ran only from `attachAgent`, so a queued message waited for a restart.
    const store = tightStore();
    const ws = store.createWorkspace('queue-hub');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });

    store.queueVoiceRequest(ws.id, {
      transcript: 'move the reachability ticket to the top',
      actor: { id: 'u-1', name: 'Reviewer' },
    });
    expect(store.listQueuedVoice(ws.id)).toHaveLength(1);

    const beat = store.heartbeat(ws.id, 'worker');
    expect(beat.ok).toBe(true);
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedVoice?.map((q) => q.transcript)).toEqual([
      'move the reachability ticket to the top',
    ]);
    // Drained, so the next beat does not redeliver it.
    expect(store.listQueuedVoice(ws.id)).toHaveLength(0);
  });

  it('POSITIVE CONTROL: a heartbeat from an agent with nothing queued drains nothing', () => {
    const store = tightStore();
    const ws = store.createWorkspace('empty-queue-hub');
    store.attachAgent(ws.id, { agentId: 'worker', runtime: 'claude-code-local' });
    const beat = store.heartbeat(ws.id, 'worker');
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedVoice ?? []).toEqual([]);
  });
});

describe('SseHub knows which agent is on a stream', () => {
  it('reports an agent-tagged stream and ignores an anonymous one', () => {
    const hub = new SseHub();
    const sink = { write: () => {}, close: () => {} };
    const tab = { write: () => {}, close: () => {} };

    hub.add('ws~w-1', tab); // a browser tab: no agent identity
    expect(hub.agentsOn('ws~w-1').size).toBe(0);

    const drop = hub.add('ws~w-1', sink, undefined, 'worker');
    expect(hub.agentsOn('ws~w-1').has('worker')).toBe(true);

    drop();
    expect(hub.agentsOn('ws~w-1').has('worker')).toBe(false);
    // The tab is still there — removing the agent must not close the channel.
    expect(hub.count('ws~w-1')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wiring seam. Everything above tests the store and the hub apart; this
// runs the real route, because the two halves being right proves nothing if
// `?agentId=` never reaches `agentsOn`.
// ─────────────────────────────────────────────────────────────────────────────

describe('a real stream on the real route keeps a working agent reachable', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const streams: AgentStream[] = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-stream-routes-'));
    // Millisecond windows so the observed clock can be waited out — the same
    // staleness a nineteen-minute grep produces in production.
    handle = createServer({ port: 0, dataDir, heartbeatFreshMs: 40, observedWorkFreshMs: 40 });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    for (const s of streams.splice(0)) await s.close();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function makeAttachedWorkspace(name: string): Promise<string> {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, goal: 'Ship it.' }),
    });
    const { workspace } = (await r.json()) as { workspace: { id: string } };
    await fetch(`${base}/api/workspaces/${workspace.id}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'worker', runtime: 'claude-code-local' }),
    });
    return workspace.id;
  }

  it('an agentId-named stream survives the observed window; an anonymous one does not', async () => {
    const anon = await makeAttachedWorkspace('anon-board');
    const named = await makeAttachedWorkspace('named-board');

    // A browser tab: subscribed, but claiming nothing about any agent.
    streams.push(await openWorkspaceStream(base, anon));
    // The agent's own MCP child.
    streams.push(await openWorkspaceStream(base, named, {}, 'worker'));

    await new Promise((r) => setTimeout(r, 60));

    // The control comes FIRST so the assertion below cannot be satisfied by a
    // route that ignores the query string and reports everyone reachable.
    expect(handle.tasks.hasLiveAttachment(anon)).toBe(false);
    expect(handle.tasks.hasLiveAttachment(named)).toBe(true);
  });
});
