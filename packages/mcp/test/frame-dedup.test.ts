/**
 * One channel message per event, however many streams carried it.
 *
 * After the previous commit a member doc rides its own channel, its
 * `ws~<grouping>` channel AND every `ws~<board>` that holds it — so an agent
 * that both created a diff review and leads the board holding it now has two
 * live SSE loops delivering the same frame. Without a dedup the agent reads
 * the same comment twice and cannot tell a duplicate from a second reply.
 *
 * What identifies an event, in order: the server's `eid` (one per broadcast,
 * unique across restarts by construction), then `${event}#${docId}#${seq}`
 * for a server older than that stamp. `rooms.ts` bumps a PER-ROOM monotonic
 * `seq` on every thread and suggestion event, so two events in one room can
 * never share it and two rooms freely can — which is why docId has to be in
 * the fallback key and why seq alone is not a key at all. And because that
 * counter restarts with the SERVER, the fallback is bounded by a reconnect
 * and by a clock; see the "across a server restart" block below, which is the
 * regression this file did not catch the first time.
 *
 * The direction of the failure matters more than the dedup: a dropped frame
 * is silence, and silence is the whole bug class this ticket exists for. So
 * anything the key cannot positively identify — no numeric `seq`, no docId —
 * is forwarded. Every hub `task.*` / `decision.*` / `voice.*` event is in
 * that category: they carry no seq, they ride exactly one channel, and
 * swallowing one would be a real drop rather than a saved duplicate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFrameDedup } from '../src/frame-dedup.ts';

/** A thread frame as `broadcastToRoom` stamps it. */
function threadFrame(docId: string, seq: number) {
  return { docId, threadId: 't-1', seq, thread: { comments: [{ text: 'hello' }] } };
}

describe('createFrameDedup', () => {
  it('forwards one copy when the same event arrives on two channels', () => {
    const { shouldForward } = createFrameDedup();
    const frame = threadFrame('doc-alpha', 7);
    expect(shouldForward('thread.created', frame)).toBe(true);
    // Same frame, second SSE loop (the board channel as well as the grouping).
    expect(shouldForward('thread.created', frame)).toBe(false);
  });

  // POSITIVE CONTROL 1 — the dedup keys on the event, not on the doc. Two
  // real comments on one doc are two different seqs and both must land, or
  // the "fix" is just a silencer.
  it('forwards both when the same doc fires two different seqs', () => {
    const { shouldForward } = createFrameDedup();
    expect(shouldForward('thread.created', threadFrame('doc-alpha', 7))).toBe(true);
    expect(shouldForward('thread.replied', threadFrame('doc-alpha', 8))).toBe(true);
    // …and the same seq under a different event name is a different event.
    expect(shouldForward('thread.resolved', threadFrame('doc-alpha', 9))).toBe(true);
  });

  // POSITIVE CONTROL 2 — hub events carry no seq. Two of them can be byte
  // identical (two voice notes with the same text, two `triage.requested`
  // for the same batch) and BOTH are real. They ride one channel, so there
  // is no duplicate to suppress and a collision here would be a true drop.
  it('forwards every seq-less hub frame, even byte-identical ones', () => {
    const { shouldForward } = createFrameDedup();
    const voice = { workspaceId: 'ws-1', text: 'make token usage the top goal' };
    expect(shouldForward('voice.note', voice)).toBe(true);
    expect(shouldForward('voice.note', voice)).toBe(true);
    const task = { workspaceId: 'ws-1', taskId: 'task-9' };
    expect(shouldForward('task.created', task)).toBe(true);
    expect(shouldForward('task.created', task)).toBe(true);
  });

  // POSITIVE CONTROL 3 — seq is per-room, so two docs share seq numbers as a
  // matter of course. Keying on seq alone would silently eat the second doc's
  // first-ever comment.
  it('forwards both when two different docs share a seq', () => {
    const { shouldForward } = createFrameDedup();
    expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
    expect(shouldForward('thread.created', threadFrame('doc-beta', 1))).toBe(true);
  });

  // A frame with no docId cannot be identified either — forward it rather
  // than risk colliding two rooms under one empty key.
  it('forwards frames with a seq but no docId', () => {
    const { shouldForward } = createFrameDedup();
    expect(shouldForward('thread.created', { seq: 3 })).toBe(true);
    expect(shouldForward('thread.created', { seq: 3 })).toBe(true);
  });

  it('forwards non-object payloads rather than throwing', () => {
    const { shouldForward } = createFrameDedup();
    expect(shouldForward('thread.created', null)).toBe(true);
    expect(shouldForward('thread.created', 'not-json-shaped')).toBe(true);
  });

  describe('bound', () => {
    it('evicts oldest-first and forwards a key that fell out of the window', () => {
      const { shouldForward } = createFrameDedup({ limit: 2 });
      expect(shouldForward('thread.created', threadFrame('doc-a', 1))).toBe(true);
      expect(shouldForward('thread.created', threadFrame('doc-b', 1))).toBe(true);
      // Third key evicts doc-a's.
      expect(shouldForward('thread.created', threadFrame('doc-c', 1))).toBe(true);
      // doc-a is out of the window: forwarded again rather than remembered
      // forever. Over-delivering after an eviction is the safe direction.
      expect(shouldForward('thread.created', threadFrame('doc-a', 1))).toBe(true);
      // doc-c is still inside it.
      expect(shouldForward('thread.created', threadFrame('doc-c', 1))).toBe(false);
    });

    it('never grows past the bound', () => {
      const limit = 8;
      const { shouldForward } = createFrameDedup({ limit });
      for (let i = 0; i < 500; i++) shouldForward('thread.created', threadFrame('doc-a', i));
      // Nothing to assert on size from outside, so assert on the consequence:
      // a key from 500 frames ago is long gone and forwards again.
      expect(shouldForward('thread.created', threadFrame('doc-a', 0))).toBe(true);
      // While the most recent `limit` keys are still suppressed.
      expect(shouldForward('thread.created', threadFrame('doc-a', 499))).toBe(false);
    });
  });

  /**
   * THE REGRESSION THIS SUITE MISSED. `room.seq` is a plain field on the room
   * object, initialised to 0 in `rooms.ts` `getOrCreate` and never persisted
   * into the `.ydoc` — so every server start (a deploy, a `bun --watch`
   * reload, a `delete_workspace` + re-create of the same id) rebuilds every
   * room counting from 1 again, while this process and its `seen` set live
   * for days. A key of `event#docId#seq` alone is therefore NOT unique across
   * a server epoch: Bryan's next comment reproduces a key already held, the
   * frame is suppressed, and the agent hears nothing — the exact
   * silence-you-cannot-distinguish failure this whole branch exists to close,
   * reintroduced one layer down by its own fix.
   *
   * Three independent defences, each tested here: the server now stamps a
   * process-unique `eid`; the fallback key expires on a wall clock; and any
   * SSE RECONNECT — which is what a server restart looks like from in here —
   * drops the whole window.
   */
  describe('across a server restart', () => {
    it('forwards a repeated seq after a reconnect, because the room counter restarted', () => {
      const { shouldForward, reset } = createFrameDedup();
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
      // Prod is redeployed. Every SSE loop's fetch ends and retries; the
      // rooms come back counting from 1.
      reset();
      // A DIFFERENT, real comment that happens to reproduce the old key.
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
    });

    it('forwards a repeated seq once the suppression window has aged out', () => {
      let now = 1_000;
      const { shouldForward } = createFrameDedup({ ttlMs: 30_000, now: () => now });
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
      now += 30_001;
      // No reconnect was observed (a room can also be destroyed and rebuilt
      // at seq 0 under a live server), so the clock is the backstop.
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
    });

    it('forwards both when the server stamps a different eid on the same seq', () => {
      const { shouldForward } = createFrameDedup();
      expect(
        shouldForward('thread.created', { ...threadFrame('doc-alpha', 1), eid: 'boot-a:1' }),
      ).toBe(true);
      // Same doc, same seq, new server epoch — a different event, and the
      // server says so without the client having to infer it.
      expect(
        shouldForward('thread.created', { ...threadFrame('doc-alpha', 1), eid: 'boot-b:1' }),
      ).toBe(true);
    });

    // POSITIVE CONTROL 4 — the two copies of ONE event still collapse. Every
    // relaxation above is a licence to forward more, so each needs the
    // duplicate case re-proved beside it or the dedup has quietly become a
    // pass-through.
    it('still collapses a real duplicate: same eid on two channels', () => {
      const { shouldForward } = createFrameDedup();
      const frame = { ...threadFrame('doc-alpha', 1), eid: 'boot-a:9' };
      expect(shouldForward('thread.created', frame)).toBe(true);
      expect(shouldForward('thread.created', frame)).toBe(false);
    });

    // POSITIVE CONTROL 5 — the same, on the seq fallback: inside the window
    // and with no reconnect between them, the second copy is still dropped.
    it('still collapses a real duplicate arriving milliseconds apart', () => {
      let now = 1_000;
      const { shouldForward } = createFrameDedup({ ttlMs: 30_000, now: () => now });
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
      now += 4; // the skew between two channels of one broadcast
      expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(false);
    });

    // POSITIVE CONTROL 6 — an eid-stamped frame and its own second copy are
    // matched by eid even though the reconnect reset happened between two
    // UNRELATED events, i.e. reset() is not a licence to forget everything
    // that arrives after it.
    it('keeps deduping after a reset', () => {
      const { shouldForward, reset } = createFrameDedup();
      reset();
      const frame = threadFrame('doc-beta', 3);
      expect(shouldForward('thread.replied', frame)).toBe(true);
      expect(shouldForward('thread.replied', frame)).toBe(false);
    });

    /**
     * A `reset()` nobody calls is a fix that ships disabled, and mcp.ts
     * cannot be imported (it ends in a top-level `await server.connect`), so
     * the wiring is asserted on its source. Anchored to the reconnect
     * backoff, because resetting anywhere else would not be the fix.
     */
    it('is wired into the SSE reconnect in mcp.ts', () => {
      const src = readFileSync(join(import.meta.dirname, '../src/mcp.ts'), 'utf8');
      const backoff = src.indexOf('setTimeout(r, 1500)');
      expect(backoff).toBeGreaterThan(-1);
      const afterBackoff = src.slice(backoff, backoff + 900);
      expect(afterBackoff).toContain('shouldForwardFrame.reset()');
    });
  });
});
