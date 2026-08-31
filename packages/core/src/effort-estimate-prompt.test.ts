import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT_ESTIMATE_PROMPT,
  EFFORT_ESTIMATE_MAX_SECONDS,
  EFFORT_ESTIMATE_PROMPT_VERSION,
  buildEffortEstimatePrompt,
  parseEffortEstimateResponse,
} from './effort-estimate-prompt.ts';

const DAY = 24 * 60 * 60;

/** All fixtures are synthetic. */

describe('buildEffortEstimatePrompt', () => {
  it('puts the prompt verbatim in the system turn and the ticket as labelled fields', () => {
    const { system, user } = buildEffortEstimatePrompt('Weigh review overhead heavily.', {
      title: 'Fix the flaky retry test',
      body: 'It fails about 1 in 20 runs; the timeout is probably too tight.',
      goal: 'Stabilize CI',
    });
    expect(system).toContain('Weigh review overhead heavily.');
    expect(system).toContain('handsOnSeconds');
    expect(system).toContain('wallClockSeconds');
    expect(user).toContain('Title: Fix the flaky retry test');
    expect(user).toContain('Goal: Stabilize CI');
    expect(user).toContain('Description: It fails about 1 in 20 runs');
  });

  it('says when there is no goal or description rather than leaving the field out', () => {
    const { user } = buildEffortEstimatePrompt(DEFAULT_EFFORT_ESTIMATE_PROMPT, {
      title: 'Bare ticket',
    });
    expect(user).toContain('Goal: (none)');
    expect(user).toContain('Description: (none)');
  });

  it('the default prompt names both kinds of time it asks for', () => {
    expect(DEFAULT_EFFORT_ESTIMATE_PROMPT.toLowerCase()).toContain('hands-on');
    expect(DEFAULT_EFFORT_ESTIMATE_PROMPT.toLowerCase()).toContain('wall-clock');
  });

  // The whole point of version 2. A scorer with no baseline supplies the one
  // from its training data — a person doing the work — and the board printed
  // 15.5 days of the owner's own attention on a goal an agent was days from
  // finishing. The baseline has to be IN the prompt, not in a reviewer's head.
  it('the default prompt says agents do the work, and what that costs the owner', () => {
    const p = DEFAULT_EFFORT_ESTIMATE_PROMPT.toLowerCase();
    expect(p).toContain('agents do the work');
    expect(p).toContain('minutes to a few hours');
    expect(p).toContain('hours to a few days');
    // And says out loud that the human-effort reading is the wrong one,
    // rather than only implying it by giving ranges.
    expect(p).toContain('do not estimate how long a human engineer would take');
  });

  it('tells the scorer the ceiling it will be judged against', () => {
    // A ceiling the model is never shown turns every overshoot into a failed
    // run — an estimate the board does not get — where naming it can turn
    // some of them into an estimate in range.
    const { system } = buildEffortEstimatePrompt(DEFAULT_EFFORT_ESTIMATE_PROMPT, { title: 'x' });
    expect(system).toContain(String(EFFORT_ESTIMATE_MAX_SECONDS));
    expect(system).toContain('14 days');
  });

  it('the version is past 1, so every version-1 estimate reads as stale', () => {
    // The boot re-score pass and the calibrator both key on this. Left at 1,
    // the new prompt would reach only tickets somebody happens to edit.
    expect(EFFORT_ESTIMATE_PROMPT_VERSION).toBeGreaterThan(1);
  });
});

describe('parseEffortEstimateResponse', () => {
  it('reads a bare JSON estimate', () => {
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 900, "wallClockSeconds": 86400}'),
    ).toEqual({ handsOnSeconds: 900, wallClockSeconds: 86400 });
  });

  it('reads an estimate wrapped in prose or a code fence', () => {
    const text = 'Sure.\n```json\n{"handsOnSeconds": 300, "wallClockSeconds": 3600}\n```';
    expect(parseEffortEstimateResponse(text)).toEqual({
      handsOnSeconds: 300,
      wallClockSeconds: 3600,
    });
  });

  it('rounds fractional seconds', () => {
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 120.6, "wallClockSeconds": 7199.4}'),
    ).toEqual({ handsOnSeconds: 121, wallClockSeconds: 7199 });
  });

  // The positive control: a prompt bad enough that the reply carries no
  // usable estimate must yield NOTHING, never a guess and never a zero.
  it('is null — no estimate, never a guess — when the reply is not a usable estimate', () => {
    expect(parseEffortEstimateResponse('I cannot estimate this.')).toBeNull();
    expect(parseEffortEstimateResponse('{"wallClockSeconds": 3600}')).toBeNull();
    expect(parseEffortEstimateResponse('{"handsOnSeconds": 300}')).toBeNull();
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": "300", "wallClockSeconds": 3600}'),
    ).toBeNull();
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 0, "wallClockSeconds": 3600}'),
    ).toBeNull();
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": -100, "wallClockSeconds": 3600}'),
    ).toBeNull();
    expect(
      parseEffortEstimateResponse(
        `{"handsOnSeconds": 300, "wallClockSeconds": ${EFFORT_ESTIMATE_MAX_SECONDS + 1}}`,
      ),
    ).toBeNull();
    expect(parseEffortEstimateResponse('not even json')).toBeNull();
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": NaN, "wallClockSeconds": 3600}'),
    ).toBeNull();
    // A fractional value that rounds down to zero must be rejected AFTER
    // rounding, not accepted on its still-positive raw value.
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 0.4, "wallClockSeconds": 3600}'),
    ).toBeNull();
    // Hands-on is documented as a slice of wall-clock time — never more of
    // it — so a reply that inverts the two is not a usable estimate.
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 7200, "wallClockSeconds": 3600}'),
    ).toBeNull();
  });

  // The reply that prompted this whole change: 30 days hands-on over 60 days
  // of calendar time on a real ticket, which the 90-day ceiling accepted and
  // summed into a goal, where it was 98% of the remainder. Under the 14-day
  // ceiling it is a REFUSAL — no numbers, and the caller records a failed run
  // the row shows — which is the honest answer to a reply that sized the
  // ticket for a person.
  it('refuses the 30-day reply that the old ceiling let through', () => {
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 2592000, "wallClockSeconds": 5184000}'),
    ).toBeNull();
    // Either number alone is enough to refuse it — a plausible hands-on
    // figure does not rescue a 60-day calendar estimate.
    expect(
      parseEffortEstimateResponse('{"handsOnSeconds": 3600, "wallClockSeconds": 5184000}'),
    ).toBeNull();
    expect(
      parseEffortEstimateResponse(`{"handsOnSeconds": 300, "wallClockSeconds": ${15 * DAY}}`),
    ).toBeNull();
    // Positive control: the ceiling is not refusing everything. A large but
    // agent-plausible ticket — a day of the owner's attention over ten days
    // of calendar time — still parses.
    expect(
      parseEffortEstimateResponse(`{"handsOnSeconds": ${DAY}, "wallClockSeconds": ${10 * DAY}}`),
    ).toEqual({ handsOnSeconds: DAY, wallClockSeconds: 10 * DAY });
  });

  it('accepts a number right at the ceiling', () => {
    expect(
      parseEffortEstimateResponse(
        `{"handsOnSeconds": 300, "wallClockSeconds": ${EFFORT_ESTIMATE_MAX_SECONDS}}`,
      ),
    ).toEqual({ handsOnSeconds: 300, wallClockSeconds: EFFORT_ESTIMATE_MAX_SECONDS });
  });
});
