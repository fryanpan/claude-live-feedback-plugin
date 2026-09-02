import { describe, expect, it } from 'bun:test';
import { STAMP_PATTERN, stamped } from '../src/log-stamp.ts';

describe('stamped', () => {
  it('puts an ISO instant in front of the line and leaves the line alone', () => {
    const at = Date.parse('2026-09-02T15:04:05.678Z');
    expect(stamped('[auth] login code issued for alice@example.com', at)).toBe(
      '2026-09-02T15:04:05.678Z [auth] login code issued for alice@example.com',
    );
  });

  it('keeps milliseconds, because a code burst is measured in seconds', () => {
    // Second resolution would put a whole burst on one reading, which is the
    // exact question the stamp exists to answer.
    const a = stamped('x', Date.parse('2026-09-02T15:04:05.100Z'));
    const b = stamped('x', Date.parse('2026-09-02T15:04:05.900Z'));
    expect(a).not.toBe(b);
  });

  it('defaults to now, so a caller that does not hold a clock still gets one', () => {
    const before = Date.now();
    const line = stamped('x');
    const parsed = Date.parse(line.slice(0, line.indexOf(' ')));
    // No wall-clock DURATION assertion — only that the stamp names an instant
    // inside the window this call spanned.
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  it('writes the shape STAMP_PATTERN matches, and that pattern rejects a bare line', () => {
    // The pattern is what a log reader and the other suites match against, so
    // it is asserted in both directions: a stamped line passes, and an
    // unstamped one must fail or the pattern would prove nothing anywhere.
    expect(STAMP_PATTERN.test(stamped('[auth] hello'))).toBe(true);
    expect(STAMP_PATTERN.test('[auth] hello')).toBe(false);
    // A near-miss too: a date with no time is not the shape.
    expect(STAMP_PATTERN.test('2026-09-02 [auth] hello')).toBe(false);
  });
});
