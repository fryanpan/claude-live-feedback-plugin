/**
 * A bot meeting's live transcript must never wake the agent.
 *
 * `meeting.transcript` frames are transient (no `eid`), so the dedup has no
 * key and forwards every one — which is exactly what happened: 11 vendor
 * frames, 11 channel notifications, before this gate existed. The first two
 * describes compose the two decisions `handleFrame` makes, in its order, with
 * a real dedup instance, so the assertion is on the forward path's own
 * verdict and not on a lookalike predicate.
 *
 * The last describe is the delivery half, and it used to be
 * `BUNDLE.toContain('startsWith("meeting.")')`. That literal survives a gate
 * whose caller was deleted, survives a gate that runs AFTER the dedup, and
 * dies on a rename that keeps the feature working — so it could not tell a
 * shipped gate from a shipped string. It now runs the committed bundle over
 * stdio, pushes real frames down its event stream, and counts the channel
 * lines a session would have read.
 */
import { describe, expect, it } from 'vitest';
import { isChannelEvent } from '../src/channel-gate.ts';
import { createFrameDedup } from '../src/frame-dedup.ts';
import { type BundleHarness, restoredWatches, startBundle } from './harness/mcp-bundle.ts';

/** The forward decision as `handleFrame` makes it: kind gate, then dedup. */
function forwards(shouldForward: (ev: string, p: unknown) => boolean, ev: string, p: unknown) {
  return isChannelEvent(ev) && shouldForward(ev, p);
}

/** A transient transcript frame as the server sends it: no eid, no seq. */
const transcript = (turn: number, text: string, final: boolean) => ({
  event: 'meeting.transcript',
  docId: 'doc-1',
  meetingId: 'm-1',
  turn,
  text,
  final,
  speaker: 'p7',
  speakerName: 'Rowan Pike',
});

describe('the channel gate on meeting frames', () => {
  it('forwards none of a stream of transcript frames — partials, finals, repeats', () => {
    const { shouldForward } = createFrameDedup();
    let delivered = 0;
    for (let i = 0; i < 11; i++) {
      if (
        forwards(shouldForward, 'meeting.transcript', transcript(i >> 1, `word ${i}`, i % 2 === 1))
      )
        delivered += 1;
    }
    expect(delivered).toBe(0);
  });

  it('is the gate and not the dedup that drops them — the dedup alone would forward every one', () => {
    // The reason the bug existed: a frame with no eid and no seq has no
    // identity, and the dedup fails open on exactly that.
    const { shouldForward } = createFrameDedup();
    expect(shouldForward('meeting.transcript', transcript(0, 'so the', false))).toBe(true);
    expect(shouldForward('meeting.transcript', transcript(0, 'so the sync', false))).toBe(true);
    expect(isChannelEvent('meeting.transcript')).toBe(false);
  });

  it("drops the meeting's lifecycle facts too — they are the strip's, not the agent's", () => {
    for (const ev of ['meeting.started', 'meeting.stopped', 'meeting.bot']) {
      expect(isChannelEvent(ev), ev).toBe(false);
    }
  });

  it('POSITIVE CONTROL: a thread frame still forwards through the same path', () => {
    const { shouldForward } = createFrameDedup();
    const thread = {
      docId: 'doc-1',
      threadId: 't-1',
      seq: 3,
      thread: { comments: [{ text: 'hi' }] },
    };
    expect(forwards(shouldForward, 'thread.created', thread)).toBe(true);
    // And the dedup still does its own job behind the gate.
    expect(forwards(shouldForward, 'thread.created', thread)).toBe(false);
    for (const ev of ['suggestion.created', 'task.updated', 'decision.asked', 'voice.note']) {
      expect(isChannelEvent(ev), ev).toBe(true);
    }
  });

  // That `handleFrame` puts this gate BEFORE the dedup is asserted where the
  // handler now lives: frame-handler.test.ts feeds it a `meeting.words` frame
  // and reads a dedup predicate that records what it was asked about. The
  // regex that used to stand here could not tell a working gate from a
  // surviving string.
});

/**
 * The gate as the artifact peers load actually applies it.
 *
 * `.mcp.json` runs `packages/plugin/mcp/index.js`, so a source-only change
 * reaches nobody — that is why this half exists at all. What it now measures
 * is the SESSION's view: frames go down the bundle's own event stream, and
 * the channel notifications it writes to stdout are counted.
 *
 * The thread frame is the load-bearing control and is pushed LAST. The mux
 * loop delivers frames in order and awaits each one, so a thread line on
 * stdout proves every meeting frame ahead of it was already handled — which
 * is what makes "no meeting line" an absence rather than a race.
 */
describe('the committed bundle applies the gate', () => {
  it('writes a line for a thread frame and none for a meeting stream', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle((req) =>
        req.method === 'GET' && /\/watches$/.test(req.path) ? restoredWatches('doc-1') : {},
      );
      await h.streamOpen();

      for (let i = 0; i < 11; i++) {
        h.pushFrame({
          id: `m:${i}`,
          event: 'meeting.transcript',
          data: transcript(i >> 1, `word ${i}`, i % 2 === 1),
        });
      }
      for (const event of ['meeting.started', 'meeting.stopped', 'meeting.bot']) {
        h.pushFrame({ id: `l:${event}`, event, data: { event, docId: 'doc-1', meetingId: 'm-1' } });
      }
      h.pushFrame({
        id: 'thr:1',
        event: 'thread.created',
        data: {
          event: 'thread.created',
          docId: 'doc-1',
          threadId: 't-1',
          seq: 3,
          thread: { comments: [{ text: 'does the gate hold' }] },
        },
      });

      // The control: the probe can see a channel line at all. Everything
      // below is vacuous without it.
      const control = await h.waitForChannel((c) => c.event === 'thread.created');
      expect(control.content).toContain('does the gate hold');

      // The measurement. Fourteen meeting frames went down the same stream,
      // ahead of the one that arrived.
      expect(h.channel.filter((c) => (c.event ?? '').startsWith('meeting.'))).toEqual([]);
      expect(h.channel.filter((c) => c.event === 'thread.created').length).toBe(1);
      expect(h.channel.some((c) => c.content.includes('word 10'))).toBe(false);
    } finally {
      await h?.stop();
    }
  }, 60_000);
});
