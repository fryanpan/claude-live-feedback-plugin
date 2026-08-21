/**
 * Deliver first, commit after — the ordering that keeps a failed frame
 * replayable.
 *
 * The inline version of this logic advanced `lastEventId` BEFORE awaiting
 * `handleFrame`, so a frame whose delivery threw (transient EPIPE writing the
 * MCP notification) was already committed as "seen": the reconnect presented
 * the advanced id, the server replayed everything AFTER it, and the one frame
 * that actually failed was never retried — a silent permanent loss inside the
 * very machinery built to end silent losses. These tests pin the ordering.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { type SseCursor, deliverThenCommit, frameMeta } from '../src/sse-cursor.ts';

const ok = async (): Promise<void> => {};
const boom = async (): Promise<void> => {
  throw new Error('EPIPE (synthetic)');
};

const FRAME = 'id: boot1:7\nevent: thread.created\ndata: {"event":"thread.created"}';
const GAP = 'event: replay.gap\ndata: {"event":"replay.gap","docId":"doc-a","action":"refetch"}';
const NO_ID = 'event: triage.requested\ndata: {"event":"triage.requested"}';

describe('deliverThenCommit', () => {
  it('advances the cursor to the frame id after a successful delivery', async () => {
    const cursor: SseCursor = { lastEventId: 'boot1:3' };
    await deliverThenCommit(FRAME, ok, cursor, () => {});
    expect(cursor.lastEventId).toBe('boot1:7');
  });

  it('leaves the cursor untouched when delivery throws — the frame must be re-presented, not skipped', async () => {
    const cursor: SseCursor = { lastEventId: 'boot1:3' };
    await expect(deliverThenCommit(FRAME, boom, cursor, () => {})).rejects.toThrow('EPIPE');
    // The old bug: this read 'boot1:7' — the failed frame's own id — so the
    // reconnect replayed everything after it and the frame itself was gone.
    expect(cursor.lastEventId).toBe('boot1:3');
  });

  it('a frame without an id leaves the cursor where it was', async () => {
    const cursor: SseCursor = { lastEventId: 'boot1:3' };
    await deliverThenCommit(NO_ID, ok, cursor, () => {});
    expect(cursor.lastEventId).toBe('boot1:3');
  });

  it('a delivered replay.gap clears the cursor and drops the dedup window', async () => {
    const cursor: SseCursor = { lastEventId: 'boot1:3' };
    let gaps = 0;
    await deliverThenCommit(GAP, ok, cursor, () => {
      gaps += 1;
    });
    expect(cursor.lastEventId).toBeUndefined();
    expect(gaps).toBe(1);
  });

  it('a gap whose delivery throws keeps the stale cursor, so the server re-answers it on reconnect', async () => {
    const cursor: SseCursor = { lastEventId: 'boot1:3' };
    let gaps = 0;
    await expect(
      deliverThenCommit(GAP, boom, cursor, () => {
        gaps += 1;
      }),
    ).rejects.toThrow('EPIPE');
    // Clearing early would make the next reconnect a FRESH subscription — no
    // replay attempt, no second gap notice, the "refetch" advice evaporated.
    // Keeping the stale id buys exactly one more gap notice, retried free.
    expect(cursor.lastEventId).toBe('boot1:3');
    expect(gaps).toBe(0);
  });
});

describe('frameMeta', () => {
  it('reads the id and event lines of a raw frame', () => {
    expect(frameMeta(FRAME)).toEqual({ id: 'boot1:7', event: 'thread.created' });
    expect(frameMeta(NO_ID)).toEqual({ event: 'triage.requested' });
    expect(frameMeta(':ka')).toEqual({});
  });
});
