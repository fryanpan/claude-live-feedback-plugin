/**
 * One channel message per event, however many streams carried it.
 *
 * After the previous commit a member doc rides its own channel, its
 * `ws~<grouping>` channel AND every `ws~<board>` that holds it — so an agent
 * that both created a diff review and leads the board holding it now has two
 * live SSE loops delivering the same frame. Without a dedup the agent reads
 * the same comment twice and cannot tell a duplicate from a second reply.
 *
 * The key is `${event}#${docId}#${seq}` because that is the only tuple the
 * server actually guarantees: `rooms.ts` bumps a PER-ROOM monotonic `seq` on
 * every thread and suggestion event (rooms.ts fireEvent / fireSuggestionEvent),
 * so two events in one room can never share it and two rooms freely can —
 * which is exactly why docId has to be in the key and why seq alone is not a
 * key at all.
 *
 * The direction of the failure matters more than the dedup: a dropped frame
 * is silence, and silence is the whole bug class this ticket exists for. So
 * anything the key cannot positively identify — no numeric `seq`, no docId —
 * is forwarded. Every hub `task.*` / `decision.*` / `voice.*` event is in
 * that category: they carry no seq, they ride exactly one channel, and
 * swallowing one would be a real drop rather than a saved duplicate.
 */
import { describe, expect, it } from 'vitest';
import { createFrameDedup } from '../src/frame-dedup.ts';

/** A thread frame as `broadcastToRoom` stamps it. */
function threadFrame(docId: string, seq: number) {
  return { docId, threadId: 't-1', seq, thread: { comments: [{ text: 'hello' }] } };
}

describe('createFrameDedup', () => {
  it('forwards one copy when the same event arrives on two channels', () => {
    const shouldForward = createFrameDedup();
    const frame = threadFrame('doc-alpha', 7);
    expect(shouldForward('thread.created', frame)).toBe(true);
    // Same frame, second SSE loop (the board channel as well as the grouping).
    expect(shouldForward('thread.created', frame)).toBe(false);
  });

  // POSITIVE CONTROL 1 — the dedup keys on the event, not on the doc. Two
  // real comments on one doc are two different seqs and both must land, or
  // the "fix" is just a silencer.
  it('forwards both when the same doc fires two different seqs', () => {
    const shouldForward = createFrameDedup();
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
    const shouldForward = createFrameDedup();
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
    const shouldForward = createFrameDedup();
    expect(shouldForward('thread.created', threadFrame('doc-alpha', 1))).toBe(true);
    expect(shouldForward('thread.created', threadFrame('doc-beta', 1))).toBe(true);
  });

  // A frame with no docId cannot be identified either — forward it rather
  // than risk colliding two rooms under one empty key.
  it('forwards frames with a seq but no docId', () => {
    const shouldForward = createFrameDedup();
    expect(shouldForward('thread.created', { seq: 3 })).toBe(true);
    expect(shouldForward('thread.created', { seq: 3 })).toBe(true);
  });

  it('forwards non-object payloads rather than throwing', () => {
    const shouldForward = createFrameDedup();
    expect(shouldForward('thread.created', null)).toBe(true);
    expect(shouldForward('thread.created', 'not-json-shaped')).toBe(true);
  });

  describe('bound', () => {
    it('evicts oldest-first and forwards a key that fell out of the window', () => {
      const shouldForward = createFrameDedup(2);
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
      const shouldForward = createFrameDedup(limit);
      for (let i = 0; i < 500; i++) shouldForward('thread.created', threadFrame('doc-a', i));
      // Nothing to assert on size from outside, so assert on the consequence:
      // a key from 500 frames ago is long gone and forwards again.
      expect(shouldForward('thread.created', threadFrame('doc-a', 0))).toBe(true);
      // While the most recent `limit` keys are still suppressed.
      expect(shouldForward('thread.created', threadFrame('doc-a', 499))).toBe(false);
    });
  });
});
