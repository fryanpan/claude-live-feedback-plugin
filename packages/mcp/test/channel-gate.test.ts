/**
 * A bot meeting's live transcript must never wake the agent.
 *
 * `meeting.transcript` frames are transient (no `eid`), so the dedup has no
 * key and forwards every one — which is exactly what happened: 11 vendor
 * frames, 11 channel notifications, before this gate existed. The test
 * composes the two decisions `handleFrame` makes, in its order, with a real
 * dedup instance, so the assertion is on the forward path's own verdict and
 * not on a lookalike predicate.
 *
 * Source- and bundle-reading like the other mcp tests: mcp.ts is a bundle
 * entry point and exports nothing, and `.mcp.json` loads the committed
 * `packages/plugin/mcp/index.js`, so a source-only gate reaches nobody.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isChannelEvent } from '../src/channel-gate.ts';
import { createFrameDedup } from '../src/frame-dedup.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

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

  it('the committed bundle carries the gate (a source-only change reaches nobody)', () => {
    expect(BUNDLE).toContain('startsWith("meeting.")');
    // Negative control for the probe itself: a literal that is NOT in the
    // bundle must not be found, or the assertion above proves nothing.
    expect(BUNDLE).not.toContain('startsWith("meeting-not-a-prefix.")');
  });
});
