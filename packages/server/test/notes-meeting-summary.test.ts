/**
 * What a meeting says about its own coverage, in one line at the stop.
 *
 * WHY IT EXISTS. A meeting was reported as "skipping chunks" and there was
 * nothing in the log to check the claim against: the notes pipeline spoke
 * only when a stage threw, so a meeting whose notes covered half of what was
 * said read exactly like a healthy one. Every signal that WOULD have
 * explained a silent drop — a compose refused for length, a failed compose
 * with no later tick — was absent from production logs, and absence proved
 * nothing, because nothing was ever written.
 *
 * So the session counts the turns the engine settled and the turns a
 * successful compose carried, and reports the difference when it ends. Zero
 * is the healthy state; anything else names how much of the meeting the
 * notes are missing.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { createNotesTickHarness } from './notes-tick-harness.ts';

describe('what the meeting says about its own coverage', () => {
  it('a healthy meeting reports every settled turn in the notes, and none lost', async () => {
    const h = createNotesTickHarness({
      compose: (input) =>
        `## Meeting notes\n\n${input.tick.turns.map((t) => `- ${t.text}`).join('\n')}\n`,
    });

    await h.speak('One.');
    await h.speak('Two.');
    h.sayPartial('and three is the one I never');
    await h.end();

    const summary = h.summary();
    expect(summary?.turnsSettled).toBe(2);
    expect(summary?.turnsLost).toBe(0);
    // The interrupted turn is composed without ever having settled, which is
    // why composed may run one ahead of settled.
    expect(summary?.turnsComposed).toBe(3);
    expect(summary?.composeFailures).toBe(0);
  });

  it('a meeting whose composes all fail says how many turns reached no note', async () => {
    const h = createNotesTickHarness({
      compose: () => {
        throw new Error('the composer is down');
      },
    });

    await h.speak('One.');
    await h.speak('Two.');
    await h.end();

    const summary = h.summary();
    expect(summary?.turnsSettled).toBe(2);
    expect(summary?.turnsComposed).toBe(0);
    // This is the number that was invisible in production: two sentences in
    // the transcript and in no note, with nothing in the log saying so.
    expect(summary?.turnsLost).toBe(2);
    expect(summary?.composeFailures).toBeGreaterThan(0);
  });

  it('words carried by a failed tick and composed by the next are not lost', async () => {
    let attempt = 0;
    const h = createNotesTickHarness({
      compose: (input) => {
        attempt++;
        if (attempt === 1) throw new Error('one bad tick');
        return `## Meeting notes\n\n${input.tick.turns.map((t) => `- ${t.text}`).join('\n')}\n`;
      },
    });

    await h.speak('The first thing.');
    await h.speak('The second thing.');
    await h.end();

    expect(h.summary()?.turnsLost).toBe(0);
    expect(h.notes()).toContain('The first thing.');
    expect(h.notes()).toContain('The second thing.');
  });
});
