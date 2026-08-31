import { describe, expect, it, vi } from 'vitest';
import {
  SPEECH_START_TIMEOUT_MS,
  SPEECH_TIMEOUT_MS,
  createAnnouncer,
} from '../src/meeting-announce.ts';

/**
 * The announcer exists for its FAILURES. Speaking works or it does not, and
 * the interesting half is every way "does not" arrives — no synthesis engine
 * at all, a browser that refuses without a gesture, an utterance the engine
 * accepts and then never mentions again. Each of those has to come back as
 * something other than `spoke` so the strip can put the sentence on screen for
 * a person, because a room that was never told is the one outcome this feature
 * cannot have.
 *
 * ONE of those failures is different from the others, and that difference is
 * what most of the new tests here are about. An utterance that is accepted and
 * then never BEGINS is the shape an iOS queue takes when no gesture has
 * unlocked it — and unlike the rest, a tap can still fix it. So it comes back
 * as `mute` rather than `failed`, and the strip offers the tap.
 */

/** A `SpeechSynthesisUtterance` as far as anything here is concerned. */
interface FakeUtterance {
  text: string;
  volume: number;
  onstart: (() => void) | null;
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
  /** The engine actually opening its mouth. */
  begin(at = this.spoken.length - 1): void {
    this.spoken[at]?.onstart?.();
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
  return { text, volume: 1, onstart: null, onend: null, onerror: null };
}

/** A timer that fires only when a test says so, and only the one it names. */
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
    /** Every live timer, or — given a delay — only the ones set for it. */
    fire: (ms?: number) => {
      for (const e of fns) if (e.live && (ms === undefined || e.ms === ms)) e.fn();
    },
    armed: (ms: number) => fns.some((e) => e.live && e.ms === ms),
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
    synth.begin();
    synth.finish();
    expect(await said).toBe('spoke');
  });

  it('does NOT cancel a quiet queue on the way in', async () => {
    // Safari drops an utterance handed to `speak()` immediately after a
    // `cancel()`, and on the board's auto-start there is nothing queued to
    // cancel in the first place — so the pre-emptive cancel bought nothing
    // and could cost the whole announcement.
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('hello');
    expect(synth.cancels).toBe(0);
    synth.begin();
    synth.finish();
    expect(await said).toBe('spoke');
  });

  it('clears an announcement still in progress, so a stale one cannot play over this one', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const first = announcer.speak('hello');
    const second = announcer.speak('the real one');
    expect(synth.cancels).toBe(1);
    synth.begin();
    synth.finish();
    expect(await second).toBe('spoke');
    // The one it replaced answers for nothing, even if the engine reports it
    // finished afterwards.
    synth.finish(0);
    expect(await first).toBe('failed');
  });

  it('reports itself supported', () => {
    expect(make(new FakeSynth()).announcer.supported()).toBe(true);
  });
});

describe('a browser that cannot', () => {
  it('fails with no engine at all, rather than throwing', async () => {
    const { announcer } = make(null);
    expect(announcer.supported()).toBe(false);
    expect(await announcer.speak('anything')).toBe('failed');
    // And priming is a no-op there rather than an error the strip has to
    // catch on a path that runs inside a click handler.
    expect(() => announcer.prime()).not.toThrow();
  });

  it('fails when speak() itself throws', async () => {
    const synth = new FakeSynth();
    synth.refuse = true;
    const { announcer } = make(synth);
    expect(await announcer.speak('anything')).toBe('failed');
  });

  it('fails on an error event', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('anything');
    synth.fail();
    expect(await said).toBe('failed');
  });

  it('fails when an utterance that BEGAN never comes back', async () => {
    // The real bug this guards: `speak()` accepts an utterance, starts it,
    // and fires neither `end` nor `error`. Without the timeout the strip
    // would sit claiming an announcement was in progress for the whole
    // meeting. The room did hear it, so a tap would add nothing — `failed`,
    // not `mute`.
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    synth.begin();
    expect(timer.armed(SPEECH_TIMEOUT_MS)).toBe(true);
    timer.fire(SPEECH_TIMEOUT_MS);
    expect(await said).toBe('failed');
  });

  it('takes the silent utterance OUT of the queue before falling back', async () => {
    // A timeout means the engine never reported what happened, not that it
    // did nothing. Left queued, the device can start speaking after the
    // strip has already asked a person to say the sentence — and then the
    // room hears it twice, over itself.
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    synth.begin();
    const before = synth.cancels;
    timer.fire(SPEECH_TIMEOUT_MS);
    expect(synth.cancels).toBeGreaterThan(before);
    expect(await said).toBe('failed');
  });

  it('does not let a late end event from a timed-out utterance answer spoke', async () => {
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    synth.begin();
    timer.fire(SPEECH_TIMEOUT_MS);
    synth.finish();
    expect(await said).toBe('failed');
  });
});

describe('an utterance that never begins — the locked iOS queue', () => {
  it('comes back as mute, which is the one failure a tap can still fix', async () => {
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    expect(timer.armed(SPEECH_START_TIMEOUT_MS)).toBe(true);
    timer.fire(SPEECH_START_TIMEOUT_MS);
    expect(await said).toBe('mute');
  });

  it('answers in seconds rather than waiting out the whole end timeout', () => {
    // The measured cost of the old behaviour: a room stood in silence for
    // twelve seconds before the sentence appeared on screen.
    expect(SPEECH_START_TIMEOUT_MS).toBeLessThan(SPEECH_TIMEOUT_MS / 2);
  });

  it('takes it out of the queue too — nothing may speak after the fallback', async () => {
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    const before = synth.cancels;
    timer.fire(SPEECH_START_TIMEOUT_MS);
    expect(synth.cancels).toBeGreaterThan(before);
    expect(await said).toBe('mute');
  });

  it('a slow engine that DOES begin is never called mute', async () => {
    // A voice that takes a moment to load is not a locked queue, and asking
    // a room to tap while the device is already talking is worse than
    // waiting.
    const synth = new FakeSynth();
    const { announcer, timer } = make(synth);
    const said = announcer.speak('anything');
    synth.begin();
    expect(timer.armed(SPEECH_START_TIMEOUT_MS)).toBe(false);
    timer.fire(SPEECH_START_TIMEOUT_MS);
    synth.finish();
    expect(await said).toBe('spoke');
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

  it('reports whether a gesture has been spent on the unlock yet', () => {
    // What the strip asks before offering "tap to say it": a queue nothing
    // has ever primed is one a tap can still unlock. One that was primed and
    // stayed mute is a dead end, and offering the tap there is a lie.
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    expect(announcer.primed()).toBe(false);
    announcer.prime();
    expect(announcer.primed()).toBe(true);
  });

  it('a prime that never reached the engine claims no unlock', () => {
    const synth = new FakeSynth();
    synth.refuse = true;
    const { announcer } = make(synth);
    announcer.prime();
    expect(announcer.primed()).toBe(false);
  });

  it('does not cancel the warm utterance out from under the sentence', async () => {
    // The unlock IS the queued silent utterance on WebKit; cancelling it on
    // the way into the real sentence is the other half of the same Safari
    // trap.
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    announcer.prime();
    const said = announcer.speak('this conversation is being recorded');
    expect(synth.cancels).toBe(0);
    synth.begin();
    synth.finish();
    expect(await said).toBe('spoke');
  });
});

describe('a meeting that ends mid-sentence', () => {
  it('cancel() stops the engine and makes the pending promise answer failed', async () => {
    const synth = new FakeSynth();
    const { announcer } = make(synth);
    const said = announcer.speak('this conversation is being recorded');
    synth.begin();
    announcer.cancel();
    // Even the engine reporting success afterwards must not resolve `spoke`:
    // that announcement belongs to a meeting that is over.
    synth.finish();
    expect(await said).toBe('failed');
    expect(synth.cancels).toBeGreaterThanOrEqual(1);
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
