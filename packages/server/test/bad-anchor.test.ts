/**
 * A malformed anchor must fail at the call that made it — not on somebody
 * else's request minutes later.
 *
 * `POST /api/docs/:id/threads` used to take `anchor` verbatim and validate
 * nothing. A hand-written `text-range` with no decodable `startRel`/`endRel`
 * was accepted, stored, and then killed the re-anchor sweep with
 * `Y.decodeRelativePosition(undefined)`. The sweep runs inside a debounced
 * Yjs observer, so the throw arrived as an unhandled async TypeError charged
 * to whatever request happened to be in flight — which is how it once turned
 * up in `ws-meta-leak.test.ts`, a file the branch that triggered it never
 * touched.
 *
 * Two halves are tested here and they fail independently:
 *
 *   1. The write is refused with a 400 that NAMES the field, and stores
 *      nothing. Fixes new writes.
 *   2. Every reader survives an anchor that is ALREADY persisted, because
 *      docs written before the validation existed still carry them and a doc
 *      that cannot be swept is a doc that cannot be opened. Shipping only (1)
 *      leaves those docs broken forever.
 *
 * Everything goes through the real route table. The legacy-anchor fixtures
 * are planted the way the unvalidated route planted them — straight into the
 * ydoc — because that is the state on disk we have to survive. Valid fixture
 * anchors come from `/threads/by_find`, which builds the RelativePositions
 * from the doc; hand-writing one is how this bug got created.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Anchor, type Thread, type User, createThread } from '@feedback/core';
import type * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

const reviewer: User = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };

const BODY = '# Doc\n\nthe quick brown fox jumps\n';
/** Unique in BODY, so the snippet sweep can re-anchor against it. */
const SNIPPET = 'quick brown fox';

let handle: ServerHandle;
let dataDir: string;
let base: string;
let docSeq = 0;

/**
 * Async throws from inside a Yjs observer have no request to fail, so they
 * arrive as process-level uncaught errors. Collecting them is what lets a
 * test say WHICH request was standing nearby when the doc's own bug went
 * off — without a listener the run just dies somewhere else, which is
 * exactly the diagnosis cost this fix exists to remove.
 */
let uncaught: unknown[] = [];
const onUncaught = (err: unknown): void => {
  uncaught.push(err);
};

async function mkdoc(prefix: string): Promise<string> {
  const docId = `${prefix}-${docSeq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, BODY);
  const res = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(res.status).toBe(200);
  return docId;
}

async function postThread(
  docId: string,
  anchor: unknown,
): Promise<{ status: number; body: { error?: string; thread?: Thread } }> {
  const res = await fetch(`${base}/api/docs/${docId}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: reviewer, text: 'a comment', anchor }),
  });
  return { status: res.status, body: (await res.json()) as { error?: string; thread?: Thread } };
}

async function listThreads(docId: string): Promise<Thread[]> {
  const res = await fetch(`${base}/api/docs/${docId}/threads`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { threads: Thread[] }).threads;
}

/** Read the anchor as the CRDT holds it — the shape every reader sees. */
function storedAnchor(docId: string, threadId: string): Record<string, unknown> | undefined {
  const room = handle.rooms.get(docId);
  const threads = room?.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>> | undefined;
  return threads?.get(threadId)?.get('anchor') as Record<string, unknown> | undefined;
}

/**
 * Plant an anchor the way the unvalidated route did: straight into the ydoc,
 * no validation anywhere. This is the already-on-disk state, not a shortcut.
 */
function plantLegacyAnchor(docId: string, anchor: unknown): string {
  const room = handle.rooms.get(docId);
  if (!room) throw new Error(`no room for ${docId}`);
  const threadId = `legacy-${docSeq++}`;
  createThread(room.ydoc, {
    threadId,
    anchor: anchor as Anchor,
    createdBy: reviewer,
    firstComment: { id: `c-${threadId}`, text: 'planted before anchors were validated' },
  });
  return threadId;
}

/** Touch the doc so the debounced re-anchor sweep fires (250ms), then wait
 *  past it. Returns the edit's own status — the edit SUCCEEDS either way;
 *  the crash is deferred, which is the whole problem. */
async function editAndLetSweepRun(docId: string): Promise<number> {
  const res = await fetch(`${base}/api/docs/${docId}/find_and_replace`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ find: 'jumps', replace: 'leaps' }),
  });
  await new Promise((r) => setTimeout(r, 500));
  return res.status;
}

describe('a malformed text-range anchor', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-bad-anchor-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
  });

  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    uncaught = [];
  });

  afterEach(() => {
    // No test in this file is entitled to leave a process-level error behind
    // for the NEXT one to be blamed for. That mis-attribution is the bug.
    expect(uncaught).toEqual([]);
  });

  describe('is refused at the call that made it', () => {
    it('names the missing startRel', async () => {
      const docId = await mkdoc('missing-start');
      const res = await postThread(docId, {
        kind: 'text-range',
        endRel: [1, 2, 3],
        snippet: { text: SNIPPET },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('startRel');
    });

    it('names the missing endRel', async () => {
      const docId = await mkdoc('missing-end');
      // A REAL startRel, so the message has to be about the half that is
      // actually missing — a fixture with two broken fields can't tell a
      // field-naming error apart from a fixed string.
      const { thread } = await createValidThread(docId);
      const good = storedAnchor(docId, thread.id) as { startRel: number[] };
      const res = await postThread(docId, {
        kind: 'text-range',
        startRel: good.startRel,
        snippet: { text: SNIPPET },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('endRel');
      expect(res.body.error).not.toContain('startRel');
    });

    it('names the missing snippet — the sweep reads it one property deeper', async () => {
      const docId = await mkdoc('missing-snippet');
      const { thread } = await createValidThread(docId);
      const good = storedAnchor(docId, thread.id) as { startRel: number[]; endRel: number[] };
      const res = await postThread(docId, {
        kind: 'text-range',
        startRel: good.startRel,
        endRel: good.endRel,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('snippet');
    });

    it('rejects bytes that are present but do not decode', async () => {
      const docId = await mkdoc('undecodable');
      const res = await postThread(docId, {
        // Well-formed as a byte array, meaningless as a RelativePosition:
        // a presence check alone would wave this through.
        kind: 'text-range',
        startRel: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
        endRel: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
        snippet: { text: SNIPPET },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/startRel|endRel/);
    });

    it('rejects the stringified-Uint8Array shape a careless JSON round-trip produces', async () => {
      const docId = await mkdoc('stringified');
      const res = await postThread(docId, {
        kind: 'text-range',
        startRel: { '0': 2, '1': 251 },
        endRel: { '0': 2, '1': 252 },
        snippet: { text: SNIPPET },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('startRel');
    });

    it('stores nothing when it refuses', async () => {
      const docId = await mkdoc('stores-nothing');
      // Positive control for this assertion: the doc CAN hold a thread, and
      // this listing CAN see one. Otherwise "no threads" proves nothing.
      await createValidThread(docId);
      expect(await listThreads(docId)).toHaveLength(1);

      const res = await postThread(docId, { kind: 'text-range', snippet: { text: SNIPPET } });
      expect(res.status).toBe(400);
      expect(await listThreads(docId)).toHaveLength(1);
    });

    it('still accepts a real anchor built by /threads/by_find', async () => {
      const docId = await mkdoc('valid-passes');
      const { thread } = await createValidThread(docId);
      expect(thread.anchor.kind).toBe('text-range');
      // And the same anchor round-trips back through the raw route the
      // browser posts to, which is the shape validation must not break.
      const echoed = await postThread(docId, storedAnchor(docId, thread.id));
      expect(echoed.status).toBe(200);
    });

    it('guards the reanchor route too — it rewrites an EXISTING thread anchor', async () => {
      const docId = await mkdoc('reanchor-guard');
      const { thread } = await createValidThread(docId);
      const before = storedAnchor(docId, thread.id);

      const res = await fetch(`${base}/api/docs/${docId}/threads/${thread.id}/reanchor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor: { kind: 'text-range', snippet: { text: SNIPPET } } }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('startRel');
      expect(storedAnchor(docId, thread.id)).toEqual(before);
    });
  });

  describe('already persisted, breaks nothing', () => {
    it('the sweep visits it and REPAIRS it from its snippet', async () => {
      const docId = await mkdoc('legacy-repair');
      const threadId = plantLegacyAnchor(docId, {
        kind: 'text-range',
        snippet: { text: SNIPPET },
      });
      // Positive control: before the sweep runs the anchor really is the
      // broken one. Without this the "repaired" assertion below could be
      // satisfied by a fixture that was never broken.
      expect(storedAnchor(docId, threadId)?.startRel).toBeUndefined();

      expect(await editAndLetSweepRun(docId)).toBe(200);

      const after = storedAnchor(docId, threadId) as { startRel?: number[] } | undefined;
      expect(after?.startRel).toBeDefined();
      expect((after?.startRel as number[]).length).toBeGreaterThan(0);
    });

    it('a snippet-less one is skipped rather than thrown on', async () => {
      const docId = await mkdoc('legacy-no-snippet');
      const threadId = plantLegacyAnchor(docId, { kind: 'text-range' });
      expect(await editAndLetSweepRun(docId)).toBe(200);
      // Nothing to re-anchor against, so it stays broken — but quietly, and
      // the thread is still readable.
      expect(storedAnchor(docId, threadId)?.startRel).toBeUndefined();
      expect(await listThreads(docId)).toHaveLength(1);
    });

    it('THE TELL: a request to a doc it never touched still succeeds', async () => {
      const victim = await mkdoc('victim');
      const bystander = await mkdoc('bystander');
      // A snippet that matches nothing, so the sweep cannot quietly repair
      // its way out of reading the undecodable bytes.
      plantLegacyAnchor(victim, {
        kind: 'text-range',
        snippet: { text: 'text that appears nowhere in this document' },
      });

      // Positive control: the bystander is reachable BEFORE the sweep fires,
      // so a failure afterwards is the sweep's doing and not a dead server.
      expect((await fetch(`${base}/api/docs/${bystander}`)).status).toBe(200);

      // The edit that arms the sweep succeeds — the damage is deferred.
      expect(await editAndLetSweepRun(victim)).toBe(200);

      // ...and lands here, on a doc that has no threads, no bad anchor, and
      // no connection to the victim at all. This is the request that used to
      // eat the TypeError.
      expect((await fetch(`${base}/api/docs/${bystander}`)).status).toBe(200);
      expect(uncaught).toEqual([]);
    });

    it('a RESTARTED server can still open it — the on-load sweep is synchronous', async () => {
      const docId = await mkdoc('legacy-onload');
      const threadId = plantLegacyAnchor(docId, {
        kind: 'text-range',
        snippet: { text: 'nothing in the document matches this' },
      });
      // Let the debounced .ydoc write land, then load the same data dir from
      // a cold process. Room load sweeps synchronously, so a throw there is
      // a 500 on the first request that opens the doc — not a deferred
      // orphan. This is the "cannot be opened" half.
      await new Promise((r) => setTimeout(r, 500));
      const restarted = createServer({ port: 0, dataDir });
      try {
        const restartedBase = `http://localhost:${restarted.port}`;
        const res = await fetch(`${restartedBase}/api/docs/${docId}`);
        expect(res.status).toBe(200);
        const listed = await fetch(`${restartedBase}/api/docs/${docId}/threads`);
        expect(listed.status).toBe(200);
        const { threads } = (await listed.json()) as { threads: Thread[] };
        // Positive control: the reload really did carry the planted thread
        // over, so "it opened" is about this anchor and not an empty doc.
        expect(threads.map((t) => t.id)).toContain(threadId);
      } finally {
        await restarted.stop();
      }
    });
  });
});

/** A real anchor, built from the doc by the server. Never hand-written. */
async function createValidThread(docId: string): Promise<{ thread: Thread }> {
  const res = await fetch(`${base}/api/docs/${docId}/threads/by_find`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ author: reviewer, text: 'anchored properly', find: SNIPPET }),
  });
  expect(res.status, `by_find failed: ${await res.clone().text()}`).toBe(200);
  const body = (await res.json()) as { thread: Thread };
  return { thread: body.thread };
}
