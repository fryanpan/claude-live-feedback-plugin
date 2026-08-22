/**
 * The rule the restore notice needed: an emit produced inside a tool call must
 * not be WRITTEN inside it. See deferred-emit.ts for the measurement that
 * produced this module, and restore-notice-delivery.test.ts for the wire-level
 * reproduction it fixes.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { createDeferredEmitter } from '../src/deferred-emit.ts';

/** A manual clock, so "later macrotask" is something a test can step. */
function manualSchedule() {
  const pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
    },
    /** Run everything scheduled so far, plus anything they schedule. */
    async tick(rounds = 5): Promise<void> {
      for (let i = 0; i < rounds; i++) {
        const batch = pending.splice(0, pending.length);
        for (const fn of batch) fn();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    count: () => pending.length,
  };
}

describe('createDeferredEmitter', () => {
  it('does not run an emit synchronously, even with no tool call in flight', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });
    expect(ran).toEqual([]);

    await clock.tick();
    expect(ran).toEqual(['notice']);
  });

  it('holds an emit queued during a tool call until the call ends', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    const end = emitter.beginToolCall();
    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });

    // This is the whole bug: draining here would write the frame into the
    // window between the tool-call request and its response.
    await clock.tick();
    expect(ran).toEqual([]);
    expect(emitter.pending()).toBe(1);

    end();
    await clock.tick();
    expect(ran).toEqual(['notice']);
  });

  it('waits for the LAST overlapping tool call, not the first', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    const endA = emitter.beginToolCall();
    const endB = emitter.beginToolCall();
    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });

    endA();
    await clock.tick();
    expect(ran).toEqual([]);

    endB();
    await clock.tick();
    expect(ran).toEqual(['notice']);
  });

  it('preserves queue order across the wait', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    const end = emitter.beginToolCall();
    emitter.emitOutsideToolCall(async () => {
      ran.push('backlog');
    });
    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });
    end();
    await clock.tick();

    // The restore queues backlog delivery before its summary line; a reordered
    // drain would announce the state before the frames it describes.
    expect(ran).toEqual(['backlog', 'notice']);
  });

  it('a throwing emit does not strand the ones behind it', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    emitter.emitOutsideToolCall(async () => {
      throw new Error('EPIPE (synthetic)');
    });
    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });
    await clock.tick();

    expect(ran).toEqual(['notice']);
    expect(emitter.pending()).toBe(0);
  });

  it('releasing the same tool call twice does not unbalance the count', async () => {
    const clock = manualSchedule();
    const emitter = createDeferredEmitter(clock.schedule);
    const ran: string[] = [];

    const endA = emitter.beginToolCall();
    const endB = emitter.beginToolCall();
    endA();
    endA();
    emitter.emitOutsideToolCall(async () => {
      ran.push('notice');
    });

    // A double release used to drop the count to zero with B still running.
    await clock.tick();
    expect(ran).toEqual([]);

    endB();
    await clock.tick();
    expect(ran).toEqual(['notice']);
  });
});
