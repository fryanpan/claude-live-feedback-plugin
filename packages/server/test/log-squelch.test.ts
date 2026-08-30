/**
 * The log cannot grow without bound.
 *
 * Prod's err.log reached 357 MB on 2026-08-29 because one warning fired in a
 * loop and nothing capped it. The cause is fixed; this is the ceiling that
 * makes the NEXT one cost kilobytes. The decision is a pure function over an
 * injected clock, so the window can roll here without any waiting.
 */
import { describe, expect, it } from 'bun:test';
import {
  SQUELCH_MAX_KEYS,
  flushSquelch,
  formatArgs,
  installLogSquelch,
  newSquelchState,
  squelchLine,
} from '../src/log-squelch.ts';

const OPTS = { windowMs: 1000, maxKeys: 4 };

describe('squelchLine', () => {
  it('prints a line once per window and counts the rest', () => {
    const state = newSquelchState(0);
    const first = squelchLine(state, 'boom', 0, OPTS);
    expect(first).toEqual({ flushed: [], emit: true });
    for (let i = 1; i < 5000; i++) {
      expect(squelchLine(state, 'boom', i % 999, OPTS).emit).toBe(false);
    }
    expect(state.counts.get('boom')).toBe(4999);
  });

  it('reports the suppressed count when the window rolls, then prints again', () => {
    const state = newSquelchState(0);
    squelchLine(state, 'boom', 0, OPTS);
    for (let i = 0; i < 9; i++) squelchLine(state, 'boom', 10, OPTS);
    const rolled = squelchLine(state, 'boom', 1000, OPTS);
    expect(rolled.flushed).toEqual(['[log-squelch] …repeated 9 more times in 1s: boom']);
    expect(rolled.emit).toBe(true);
    // The count restarted with the window — the next roll reports only what
    // the NEW window suppressed.
    squelchLine(state, 'boom', 1000, OPTS);
    expect(squelchLine(state, 'boom', 2000, OPTS).flushed).toEqual([
      '[log-squelch] …repeated 1 more time in 1s: boom',
    ]);
  });

  it('says nothing about a line that never repeated', () => {
    const state = newSquelchState(0);
    squelchLine(state, 'once', 0, OPTS);
    expect(squelchLine(state, 'other', 1000, OPTS).flushed).toEqual([]);
  });

  it('tracks interleaved lines independently — a loop between two strings still collapses', () => {
    const state = newSquelchState(0);
    for (let i = 0; i < 1000; i++) {
      squelchLine(state, i % 2 === 0 ? 'a' : 'b', 0, OPTS);
    }
    expect(state.counts.get('a')).toBe(499);
    expect(state.counts.get('b')).toBe(499);
    expect(flushSquelch(state, 1000, OPTS)).toEqual([
      '[log-squelch] …repeated 499 more times in 1s: a',
      '[log-squelch] …repeated 499 more times in 1s: b',
    ]);
  });

  it('passes chatter through once the key cap is reached rather than growing', () => {
    const state = newSquelchState(0);
    for (let i = 0; i < 50; i++) {
      expect(squelchLine(state, `line ${i}`, 0, OPTS).emit).toBe(true);
    }
    expect(state.counts.size).toBe(OPTS.maxKeys);
    // An untracked line keeps printing — the cap drops the squelch, never
    // the line.
    expect(squelchLine(state, 'line 49', 0, OPTS).emit).toBe(true);
    expect(SQUELCH_MAX_KEYS).toBeGreaterThan(OPTS.maxKeys);
  });

  it('truncates a long line in its summary', () => {
    const state = newSquelchState(0);
    const long = 'x'.repeat(500);
    squelchLine(state, long, 0, OPTS);
    squelchLine(state, long, 0, OPTS);
    const [summary] = flushSquelch(state, 1000, OPTS);
    expect(summary).toBe(`[log-squelch] …repeated 1 more time in 1s: ${'x'.repeat(200)}…`);
  });
});

describe('formatArgs', () => {
  it('keys an error by name and message, so the same failure collapses', () => {
    expect(formatArgs(['[ws] send failed', new TypeError('closed')])).toBe(
      '[ws] send failed TypeError: closed',
    );
    expect(formatArgs(['a', { b: 1 }, 2])).toBe('a {"b":1} 2');
  });

  it('survives an argument that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatArgs(['x', cyclic])).not.toThrow();
  });
});

describe('installLogSquelch', () => {
  it('collapses a hot console.error loop to one line plus a summary', () => {
    const written: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...a: unknown[]) => written.push(a.map(String).join(' '));
    let clock = 0;
    const handle = installLogSquelch({ ...OPTS, now: () => clock });
    try {
      for (let i = 0; i < 50_000; i++) console.error('Invalid access: Add Yjs type');
      clock = 5000;
      console.error('Invalid access: Add Yjs type');
      handle.flush();
    } finally {
      handle.restore();
      console.error = realError;
      console.warn = realWarn;
    }
    // 50,001 calls; three lines out.
    expect(written).toEqual([
      'Invalid access: Add Yjs type',
      '[log-squelch] …repeated 49999 more times in 1s: Invalid access: Add Yjs type',
      'Invalid access: Add Yjs type',
    ]);
  });

  it('writes the first occurrence with its original arguments', () => {
    const calls: unknown[][] = [];
    const realError = console.error;
    const realWarn = console.warn;
    console.error = (...a: unknown[]) => calls.push(a);
    const err = new Error('closed');
    const handle = installLogSquelch({ ...OPTS, now: () => 0 });
    try {
      console.error('[ws] doc send failed', err);
      console.error('[ws] doc send failed', err);
    } finally {
      handle.restore();
      console.error = realError;
      console.warn = realWarn;
    }
    expect(calls).toEqual([['[ws] doc send failed', err]]);
    expect(calls[0]?.[1]).toBe(err);
  });

  it('squelches console.warn too, and restore puts both back', () => {
    const written: string[] = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...a: unknown[]) => written.push(a.map(String).join(' '));
    const handle = installLogSquelch({ ...OPTS, now: () => 0 });
    const wrapped = console.warn;
    try {
      console.warn('same');
      console.warn('same');
      console.warn('same');
    } finally {
      handle.restore();
    }
    expect(written).toEqual(['same']);
    expect(console.warn).not.toBe(wrapped);
    console.warn = realWarn;
    console.error = realError;
  });
});
