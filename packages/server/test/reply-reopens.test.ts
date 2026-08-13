/**
 * A person's reply to a RESOLVED thread reopens it.
 *
 * The drawer's default tab is "Open", and `filtered()` drops resolved
 * threads from it entirely. So a reply that leaves the thread resolved is a
 * reply nobody sees: a reviewer replied three minutes after an agent resolved
 * the thread, and reported it as *comments going missing*. Nothing was lost —
 * `list_threads` had every word — but the review surface had no way to show
 * it to them.
 *
 * The asymmetry is deliberate. A person replying is continuing the
 * conversation; an AGENT replying is often posting a closing note, and
 * resurrecting a thread the human just closed would be its own bug. The
 * actor split reuses `classifyActor`, the same one the activity log uses.
 *
 * Everything here goes through the HTTP route the browser actually posts to
 * — `postComment` is reachable three ways and the route is the layer no unit
 * test covers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, Thread, User } from '@feedback/core';
import type * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

const reviewer: User = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const visitor: User = { id: 'anon-7f3', name: 'Sam', kind: 'anon', color: '#7a5' };
/** What `resolveAgentAuthor` builds from FEEDBACK_AGENT_NAME="Quick Build". */
const agent: User = { id: 'agent-quick-build', name: 'Quick Build', kind: 'known', color: '#888' };

const anchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'P',
    stableAttrs: {},
    classes: [],
    text: 'some text',
    path: 'P[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'some text' },
};

let handle: ServerHandle;
let dataDir: string;
let base: string;
let docSeq = 0;

async function j<T>(res: Response): Promise<T> {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
}

/** A fresh doc + one thread per test, so no test can inherit another's status. */
async function seedThread(): Promise<{ docId: string; threadId: string }> {
  const docId = `reopen-${docSeq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Doc\n\nsome text\n');
  await j(
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    }),
  );
  const { thread } = await j<{ thread: Thread }>(
    await fetch(`${base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: reviewer, text: 'drop this line from the PR body', anchor }),
    }),
  );
  return { docId, threadId: thread.id };
}

async function resolve(docId: string, threadId: string): Promise<void> {
  await j(
    await fetch(`${base}/api/docs/${docId}/threads/${threadId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: agent }),
    }),
  );
}

async function reply(docId: string, threadId: string, author: User, text: string): Promise<Thread> {
  const { thread } = await j<{ thread: Thread }>(
    await fetch(`${base}/api/docs/${docId}/threads/${threadId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author, text }),
    }),
  );
  return thread;
}

/** Status as the BROWSER sees it — the ydoc map it syncs, not the REST body.
 *  A reopen the REST response reports but the CRDT doesn't carry would leave
 *  the thread hidden in the drawer, which is the whole bug. */
function syncedStatus(docId: string, threadId: string): unknown {
  const room = handle.rooms.get(docId);
  const threads = room?.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>> | undefined;
  return threads?.get(threadId)?.get('status');
}

describe('a reply to a resolved thread', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-reply-reopen-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('leaves an OPEN thread open — replying is not a status change by itself', async () => {
    const { docId, threadId } = await seedThread();
    const t = await reply(docId, threadId, reviewer, 'still thinking about this');
    expect(t.status).toBe('open');
    expect(t.comments.length).toBe(2);
    expect(syncedStatus(docId, threadId)).toBe('open');
  });

  it('reopens when a person replies', async () => {
    const { docId, threadId } = await seedThread();
    await resolve(docId, threadId);
    // Positive control: the resolve really did take, so 'open' below is the
    // reply's doing and not a resolve that never happened.
    expect(syncedStatus(docId, threadId)).toBe('resolved');

    const t = await reply(docId, threadId, reviewer, 'actually, drop that line');
    expect(t.status).toBe('open');
    expect(t.comments.at(-1)?.text).toBe('actually, drop that line');
    // The browser reads status from the CRDT, not from this response.
    expect(syncedStatus(docId, threadId)).toBe('open');
  });

  it('reopens for a share visitor too — anon is still a person', async () => {
    const { docId, threadId } = await seedThread();
    await resolve(docId, threadId);
    expect(syncedStatus(docId, threadId)).toBe('resolved');
    const t = await reply(docId, threadId, visitor, 'one more thing');
    expect(t.status).toBe('open');
  });

  it('does NOT reopen when an agent replies', async () => {
    const { docId, threadId } = await seedThread();
    await resolve(docId, threadId);
    const t = await reply(docId, threadId, agent, 'Done — removed it in 943d603.');
    // Positive control: the reply itself landed. Without this, "still
    // resolved" would also pass if the POST had failed outright.
    expect(t.comments.length).toBe(2);
    expect(t.comments.at(-1)?.author.id).toBe('agent-quick-build');
    expect(t.status).toBe('resolved');
    expect(syncedStatus(docId, threadId)).toBe('resolved');
  });

  it('announces the reopen on the event stream a watching agent reads', async () => {
    const { docId, threadId } = await seedThread();
    await resolve(docId, threadId);

    const res = await fetch(`${base}/events/${docId}`);
    expect(res.ok).toBe(true);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no sse body');

    await reply(docId, threadId, reviewer, 'actually, drop that line');

    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    while (!buf.includes('thread.reopened') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    // The reply event proves the stream was live and delivering; the reopen
    // is the claim under test.
    expect(buf).toContain('thread.replied');
    expect(buf).toContain('thread.reopened');
  });
});
