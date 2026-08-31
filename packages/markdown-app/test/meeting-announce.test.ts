import { describe, expect, it, vi } from 'vitest';
import { SPEECH_TIMEOUT_MS, createAnnouncer } from '../src/meeting-announce.ts';

/**
 * The announcer exists for its FAILURES. Speaking works or it does not, and
 * the interesting half is every way "does not" arrives — no synthesis engine
 * at all, a browser that refuses without a gesture, an utterance the engine
 * accepts and then never mentions again. Each of those has to come back as a
 * plain `false` so the strip can put the sentence on screen for a person,
 * because a room that was never told is the one outcome this feature cannot
 * have.
 */

/** A `SpeechSynthesisUtterance` as far as anything here is concerned. */
interface FakeUtterance {
  text: string;
  volume: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

class FakeSynth {
  spoken: FakeUtterance[] = [];
  cancels = 0;
  /** Set to throw from `speak`, the way a locked engine can. */
  refuse = false;
  speak(u: unknown): void {
    if (this.refuse) throw new Error('not allowed without a gesture');
    this.spoken.push(u as FakeUtterance);
  }
  cancel(): void {
    this.cancels += 1;
  }
  /** The engine finishing the last thing it was given. */
  finish(at = this.spoken.length - 1): void {
    this.spoken[at]?.onend?.();
  }
  fail(at = this.spoken.length - 1): void {
    this.spoken[at]?.onerror?.();
  }
}

function utterance(text: string): FakeUtterance {
  return { text, volume: 1, onend: null, onerror: null };
}

/** A timer that fires only when a test says so. */
function manualTimer() {
  const fns: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timer = (fn: () => void, ms: number) => {
    const entry = { fn, ms, live: true };
    fns.push(entry);
    return () => {
      entry.live = false;
    };
  };
  return {
    timer,
    fns,
    fire: () => {
      for (const e of fns) if (e.live) e.fn();
    },
  };
}

function make(synth: FakeSynth | null, timer = manualTimer()) {
  return {
    timer,
    announcer: createAnnouncer({
      synth,
      utterance: utterance as unknown as (text: string) => SpeechSynthesisUtterance,
      timer: timer.timer,
    }),
  };
}

describe('a browser that can speak', () => {
  it('says the sentence and resolves once the engine reports it finished', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('this conversation is being recorded');
    expect(synth.spoken.at(-1)?.text).toBe('this conversation is being recorded');
    synth.finish();
    expect(await said).toBe(true);
  });

  it('clears anything already queued, so a stale announcement cannot play over this one', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('hello');
    expect(synth.cancels).toBe(1);
    synth.finish();
    expect(await said).toBe(true);
  });

  it('reports itself supported', () => {
    expect(make(new FakeSynth()).announcer.supported()).toBe(true);
  });
});

describe('a browser that cannot', () => {
  it('resolves false with no engine at all, rather than throwing', async () => {
    const { announcer } = make(null);
    expect(announcer.supported()).toBe(false);
    expect(await announcer.speak('anything')).toBe(false);
    // And priming is a no-op there rather than an error the strip has to
    // catch on a path that runs inside a click handler.
    expect(() => announcer.prime()).not.toThrow();
  });

  it('resolves false when speak() itself throws', async () => {
    const synth = new FakeSynth();
    synth.refuse = true;
    const { announcer } = make(synth);
    expect(await announcer.speak('anything')).toBe(false);
  });

  it('resolves false on an error event', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('anything');
    synth.fail();
    expect(await said).toBe(false);
  });

  it('resolves false when the utterance never comes back at all', async () => {
    // The real bug this guards: `speak()` accepts an utterance and fires
    // neither `end` nor `error`. Without the timeout the strip would sit
    // claiming an announcement was in progress for the whole meeting.
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    expect(timer.fns[0]?.ms).toBe(SPEECH_TIMEOUT_MS);
    timer.fire();
    expect(await said).toBe(false);
  });

  it('does not let a late end event from a timed-out utterance answer true', async () => {
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    timer.fire();
    synth.finish();
    expect(await said).toBe(false);
  });
});

describe('priming, which is what the tap on the iPad is spent on', () => {
  it('queues a SILENT utterance — the unlock, not the announcement', () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    announcer.prime();
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]?.volume).toBe(0);
    // Not empty: at least one engine drops an empty utterance without
    // queueing it, and a dropped utterance unlocks nothing.
    expect(synth.spoken[0]?.text.length).toBeGreaterThan(0);
  });

  it('swallows a throw, because it runs inside a click handler', () => {
    const synth = new FakeSynth();
    synth.refuse = true;
    const { announcer } = make(synth);
    expect(() => announcer.prime()).not.toThrow();
  });
});

describe('a meeting that ends mid-sentence', () => {
  it('cancel() stops the engine and makes the pending promise answer false', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('this conversation is being recorded');
    announcer.cancel();
    // Even the engine reporting success afterwards must not resolve true:
    // that announcement belongs to a meeting that is over.
    synth.finish();
    expect(await said).toBe(false);
    expect(synth.cancels).toBeGreaterThanOrEqual(2);
  });

  it('never throws out of cancel', () => {
    const synth = new FakeSynth();
    synth.cancel = vi.fn(() => {
      throw new Error('gone');
    });
    const { announcer } = make(synth);
    expect(() => announcer.cancel()).not.toThrow();
  });
});
