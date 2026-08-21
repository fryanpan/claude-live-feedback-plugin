/**
 * A comment addressed to an agent survives its stream being down.
 *
 * The measured gap this pins: a comment was ONE `sse.broadcast` on the board
 * channel — no queue, no ack, no replay. `attach_agent` drained queuedVoice /
 * pendingRetriage / pendingBucketReview / taskReviews; there was NO comment
 * queue to drain. And nothing reported the loss: an agent's 'active' label
 * derives from heartbeat + last-tool-call clocks, never from whether its
 * stream is open, so the label stayed green through a session hearing nothing.
 *
 * The shape mirrors the voice queue (`voice-durability.test.ts`): the queue is
 * the record, live delivery is an optimisation on top of it, and a row leaves
 * the queue when the receiving process ACKNOWLEDGES it — never on the send.
 *
 * One deliberate divergence from voice, pinned here because voice got it
 * wrong: `queuedVoice` drains for WHOEVER attaches first (it lacks the
 * `lead ?` guard the other three attach drains have). A comment row is
 * ADDRESSED — it names its agent at queue time, and it drains only for that
 * agent. A bystander attaching leaves it waiting.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { MAX_QUEUED_COMMENTS, TaskStore, commentQueuePath } from '../src/tasks.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };

describe('a comment for an agent is written down, addressed, and cleared only on receipt', () => {
  const dirs: string[] = [];
  const stores: TaskStore[] = [];

  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function store(ackGraceMs = 40): { s: TaskStore; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'comment-durable-'));
    dirs.push(dataDir);
    const s = new TaskStore({ dataDir, debounceMs: 5, commentAckGraceMs: ackGraceMs });
    stores.push(s);
    return { s, dataDir };
  }

  function ws(s: TaskStore, agentId = 'worker-a'): string {
    const w = s.createWorkspace('durable-comments', 'Ship it.');
    s.attachAgent(w.id, { agentId, runtime: 'claude-code-local' });
    return w.id;
  }

  const row = (agentId: string) => ({
    agentId,
    docId: 'plan-doc',
    threadId: 'th-1',
    event: 'thread.created',
    author: { id: 'known-reviewer', name: 'Reviewer' },
    text: 'Tighten this paragraph.',
    payload: { event: 'thread.created', docId: 'plan-doc', threadId: 'th-1' },
  });

  it('gives every queued row an id and persists it at the contract path', () => {
    const { s, dataDir } = store();
    const w = ws(s);
    const id = s.queueComment(w, row('worker-a'));
    expect(typeof id).toBe('string');
    expect(s.listQueuedComments(w).map((q) => q.id)).toEqual([id as string]);
    expect(existsSync(commentQueuePath(dataDir, w))).toBe(true);
  });

  it('a row the agent acknowledged does not come back', () => {
    const { s } = store();
    const w = ws(s);
    const id = s.queueComment(w, row('worker-a')) as string;
    expect(s.ackComment(w, id)).toBe(true);
    expect(s.listQueuedComments(w)).toHaveLength(0);
  });

  it('POSITIVE CONTROL: acking an unknown id leaves the queue alone', () => {
    // Without this the assertion above is satisfied by an ack that simply
    // empties the file, which would discard real comments on a stale receipt.
    const { s } = store();
    const w = ws(s);
    s.queueComment(w, row('worker-a'));
    expect(s.ackComment(w, 'no-such-row')).toBe(false);
    expect(s.listQueuedComments(w)).toHaveLength(1);
  });

  it('a row is drained only for its addressee — a bystander attaching leaves it waiting', () => {
    // The lead-guard lesson, pinned: queuedVoice drains for whoever attaches
    // first; a comment row must not copy that mistake.
    const { s } = store();
    const w = ws(s, 'worker-a');
    s.queueComment(w, row('worker-a'));

    const bystander = s.attachAgent(w, { agentId: 'worker-b', runtime: 'claude-code-local' });
    if (!bystander.ok) throw new Error('unreachable');
    expect(bystander.queuedComments).toEqual([]);
    expect(s.listQueuedComments(w)).toHaveLength(1);

    const owner = s.attachAgent(w, { agentId: 'worker-a', runtime: 'claude-code-local' });
    if (!owner.ok) throw new Error('unreachable');
    expect(owner.queuedComments.map((q) => q.text)).toEqual(['Tighten this paragraph.']);
  });

  it('attach hands a row over but KEEPS it until the receipt', () => {
    // "Cleared on a receipt from the receiving process rather than on the
    // send" — the attach response is a send too.
    const { s } = store(10_000);
    const w = ws(s, 'worker-a');
    s.queueComment(w, row('worker-a'));
    const attached = s.attachAgent(w, { agentId: 'worker-a', runtime: 'claude-code-local' });
    if (!attached.ok) throw new Error('unreachable');
    expect(attached.queuedComments).toHaveLength(1);
    expect(s.listQueuedComments(w)).toHaveLength(1);
  });

  it('an in-flight row is not re-handed while it could still be acked', () => {
    const { s } = store(10_000); // a grace window nothing in this test can outlive
    const w = ws(s, 'worker-a');
    s.queueComment(w, row('worker-a'));
    s.attachAgent(w, { agentId: 'worker-a', runtime: 'claude-code-local' }); // hands over, marks emitted

    const beat = s.heartbeat(w, 'worker-a');
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedComments ?? []).toEqual([]);
    // Still on the books — not delivered, just not re-sent yet.
    expect(s.listQueuedComments(w)).toHaveLength(1);
  });

  it('an emitted row nobody acknowledged comes back once the grace lapses', async () => {
    const { s } = store(30);
    const w = ws(s, 'worker-a');
    s.queueComment(w, row('worker-a'));
    s.attachAgent(w, { agentId: 'worker-a', runtime: 'claude-code-local' });
    await new Promise((r) => setTimeout(r, 50));

    const beat = s.heartbeat(w, 'worker-a');
    if (!beat.ok) throw new Error('unreachable');
    expect(beat.queuedComments?.map((q) => q.text)).toEqual(['Tighten this paragraph.']);
  });

  it('an ATTACHING agent gets an in-flight row immediately — a new process holds nothing', () => {
    const { s } = store(10_000);
    const w = ws(s, 'worker-a');
    const id = s.queueComment(w, row('worker-a')) as string;
    s.markCommentEmitted(w, id);

    const attached = s.attachAgent(w, { agentId: 'worker-a', runtime: 'claude-code-local' });
    if (!attached.ok) throw new Error('unreachable');
    expect(attached.queuedComments.map((q) => q.text)).toEqual(['Tighten this paragraph.']);
  });

  it('the queue is delivery state, not the record — it stays bounded', () => {
    // The comment itself lives in the thread; this file is an index of what
    // is still owed. An addressee that never acks (an old bundle) must not
    // grow it without limit.
    const { s } = store();
    const w = ws(s);
    for (let i = 0; i < MAX_QUEUED_COMMENTS + 5; i++) {
      s.queueComment(w, { ...row('worker-a'), text: `comment ${i}` });
    }
    const queue = s.listQueuedComments(w);
    expect(queue).toHaveLength(MAX_QUEUED_COMMENTS);
    // Oldest dropped, newest kept.
    expect(queue[queue.length - 1]?.text).toBe(`comment ${MAX_QUEUED_COMMENTS + 4}`);
    expect(queue[0]?.text).toBe('comment 5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The headline, through the real routes: a comment posted while the subscriber
// is DISCONNECTED is queued, delivered on the next heartbeat after reconnect,
// and cleared by the receipt. Plus the live branch: a comment delivered to an
// open stream is written down too, and its frame carries the row id to ack.
// ─────────────────────────────────────────────────────────────────────────────

/** Read an SSE stream, collecting parsed {event, data} frames until stop(). */
function listenFrames(res: Response): {
  frames: Array<{ event: string; data: Record<string, unknown> }>;
  stop: () => void;
} {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          let ev = 'message';
          const dataParts: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) dataParts.push(line.slice(5).trimStart());
          }
          if (dataParts.length > 0) {
            try {
              frames.push({ event: ev, data: JSON.parse(dataParts.join('\n')) });
            } catch {}
          }
          sep = buf.indexOf('\n\n');
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('a comment posted while the subscriber is disconnected is delivered after reconnect', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;
  const stops: Array<() => void> = [];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'comment-durable-live-'));
    srcDir = mkdtempSync(join(tmpdir(), 'comment-durable-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  async function board(name: string, agentId: string): Promise<string> {
    const w = await post('/api/workspaces', { name, goal: 'Ship it.' });
    const { workspace } = (await w.json()) as { workspace: { id: string } };
    const att = await post(`/api/workspaces/${workspace.id}/attachments`, {
      agentId,
      runtime: 'claude-code-local',
    });
    expect(att.status).toBe(200);
    expect(((await att.json()) as { lead?: boolean }).lead).toBe(true);
    return workspace.id;
  }

  async function makeDoc(docId: string, hubWorkspaceId: string): Promise<void> {
    const path = join(srcDir, `${docId}.md`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, `# ${docId}\n\nFirst paragraph.\n`);
    const res = await post('/api/docs', { docId, sourceUrl: path, title: docId, hubWorkspaceId });
    expect(res.status).toBe(200);
  }

  const comment = (docId: string, text: string, author: Record<string, unknown> = PERSON) =>
    post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author,
      text,
      anchor: { kind: 'subject' },
    });

  it('queues while the stream is down, delivers on the heartbeat after reconnect, clears on the receipt', async () => {
    const workspaceId = await board('reconnect-board', 'agent-owner');
    await makeDoc('reconnect-doc', workspaceId);

    // The stream is DOWN — the agent attached, then its process lost the
    // connection. The comment must not be a broadcast to nobody.
    expect((await comment('reconnect-doc', 'This contradicts the goal.')).status).toBe(200);
    await settle();

    const queued = handle.tasks.listQueuedComments(workspaceId);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.agentId).toBe('agent-owner');
    expect(queued[0]?.text).toBe('This contradicts the goal.');
    const rowId = queued[0]?.id as string;

    // Reconnect: the agent's MCP child re-opens the workspace stream…
    const stream = await get(
      `/events/workspace/${encodeURIComponent(workspaceId)}?agentId=agent-owner`,
    );
    expect(stream.status).toBe(200);
    const heard = listenFrames(stream);
    stops.push(heard.stop);
    await settle(150);

    // …and the next heartbeat hands the parked comment over as an addressed
    // frame carrying the row id to acknowledge.
    const beat = await post(`/api/workspaces/${workspaceId}/attachments/agent-owner/heartbeat`, {});
    expect(beat.status).toBe(200);
    await settle();

    const delivered = heard.frames.find((f) => f.data.commentQueueId === rowId);
    expect(delivered).toBeDefined();
    expect(delivered?.event).toBe('thread.created');
    // The frame is the ORIGINAL broadcast payload replayed — and a
    // thread.created carries its opening comment inside the thread, not on
    // the payload's `comment` field (rooms.ts fireEvent call sites).
    const threadComments = (delivered?.data.thread as { comments?: Array<{ text?: string }> })
      ?.comments;
    expect(threadComments?.[threadComments.length - 1]?.text).toBe('This contradicts the goal.');
    expect(delivered?.data.workspaceId).toBe(workspaceId);

    // The receipt — sent by the receiving process once the frame is in its
    // hands — is what takes the row off.
    const acked = await post(`/api/workspaces/${workspaceId}/comment-queue/${rowId}/ack`, {});
    expect((await acked.json()) as { cleared: boolean }).toMatchObject({ cleared: true });
    expect(handle.tasks.listQueuedComments(workspaceId)).toHaveLength(0);
  });

  it('the live branch is durable too, and the live frame carries the row id for ITS agent only', async () => {
    const workspaceId = await board('live-board', 'agent-live');
    await makeDoc('live-doc', workspaceId);

    const stream = await get(
      `/events/workspace/${encodeURIComponent(workspaceId)}?agentId=agent-live`,
    );
    const heard = listenFrames(stream);
    stops.push(heard.stop);
    // A browser tab on the same channel — it must never see delivery
    // bookkeeping addressed to an agent.
    const tab = await get(`/events/workspace/${encodeURIComponent(workspaceId)}`);
    const tabHeard = listenFrames(tab);
    stops.push(tabHeard.stop);
    await settle(150);

    expect((await comment('live-doc', 'Rename this heading.')).status).toBe(200);
    await settle();

    // On the queue despite having been delivered live.
    const queued = handle.tasks.listQueuedComments(workspaceId);
    expect(queued).toHaveLength(1);
    const rowId = queued[0]?.id as string;
    // …and marked emitted, because the addressee's stream was open.
    expect(typeof queued[0]?.emittedAt).toBe('number');

    const live = heard.frames.find((f) => f.event === 'thread.created');
    expect(live?.data.commentQueueId).toBe(rowId);
    const tabFrame = tabHeard.frames.find((f) => f.event === 'thread.created');
    expect(tabFrame).toBeDefined();
    expect(tabFrame?.data.commentQueueId).toBeUndefined();

    expect(handle.tasks.ackComment(workspaceId, rowId)).toBe(true);
  });

  it("an agent's own comment is not queued back to it", async () => {
    const workspaceId = await board('self-board', 'agent-self');
    await makeDoc('self-doc', workspaceId);

    const mine = await comment('self-doc', 'Noting my own progress.', {
      id: 'agent-self',
      name: 'agent-self',
      kind: 'agent',
    });
    expect(mine.status).toBe(200);
    await settle();
    expect(handle.tasks.listQueuedComments(workspaceId)).toHaveLength(0);

    // POSITIVE CONTROL on the same board: a person's comment does queue.
    expect((await comment('self-doc', 'Please tighten the intro.')).status).toBe(200);
    await settle();
    expect(handle.tasks.listQueuedComments(workspaceId).map((q) => q.text)).toEqual([
      'Please tighten the intro.',
    ]);
  });
});
