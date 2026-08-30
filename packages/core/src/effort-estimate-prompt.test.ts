import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT_ESTIMATE_PROMPT,
  EFFORT_ESTIMATE_MAX_SECONDS,
  buildEffortEstimatePrompt,
  parseEffortEstimateResponse,
} from './effort-estimate-prompt.ts';

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
  });

  it('accepts a number right at the ceiling', () => {
    expect(
      parseEffortEstimateResponse(
        `{"handsOnSeconds": 300, "wallClockSeconds": ${EFFORT_ESTIMATE_MAX_SECONDS}}`,
      ),
    ).toEqual({ handsOnSeconds: 300, wallClockSeconds: EFFORT_ESTIMATE_MAX_SECONDS });
  });
});
