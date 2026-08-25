import { describe, expect, it } from 'bun:test';
import {
  CODE_TTL_MS,
  EmailCodes,
  MAX_ATTEMPTS,
  MAX_STARTS_PER_EMAIL,
  MAX_STARTS_PER_PEER,
  MAX_VERIFIES_PER_PEER,
  RATE_WINDOW_MS,
} from '../src/auth/email-code.ts';

/** A clock a test can move, and a fixed code so assertions are readable. */
function harness(code = '123456') {
  let clock = 1_000_000;
  const codes = new EmailCodes({ now: () => clock, generateCode: () => code });
  return {
    codes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('start', () => {
  it('mints a six-digit code for a valid address', () => {
    const { codes } = harness();
    const out = codes.start('alice@example.com', '10.0.0.1');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.code).toMatch(/^\d{6}$/);
    expect(out.email).toBe('alice@example.com');
  });

  it('refuses something that is not an address', () => {
    const { codes } = harness();
    const out = codes.start('alice', '10.0.0.1');
    expect(out).toEqual({ ok: false, error: 'invalid_email' });
  });

  it('normalizes the address, so one mailbox is one challenge', () => {
    const { codes } = harness();
    codes.start('  ALICE@Example.com ', '10.0.0.1');
    expect(codes.verify('alice@example.com', '123456', '10.0.0.1').ok).toBe(true);
  });

  it('invalidates the previous code when a new one is asked for', () => {
    let next = '111111';
    const codes = new EmailCodes({ now: () => 1_000_000, generateCode: () => next });
    codes.start('alice@example.com', '10.0.0.1');
    next = '222222';
    codes.start('alice@example.com', '10.0.0.1');
    expect(codes.verify('alice@example.com', '111111', '10.0.0.1').ok).toBe(false);
    expect(codes.verify('alice@example.com', '222222', '10.0.0.1').ok).toBe(true);
  });
});

describe('verify', () => {
  it('accepts the right code exactly once', () => {
    const { codes } = harness();
    codes.start('alice@example.com', '10.0.0.1');
    expect(codes.verify('alice@example.com', '123456', '10.0.0.1')).toEqual({
      ok: true,
      email: 'alice@example.com',
    });
    // Spent. A code read off a screen later is not a second login.
    expect(codes.verify('alice@example.com', '123456', '10.0.0.1')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });

  it('tolerates surrounding whitespace in what the person typed', () => {
    const { codes } = harness();
    codes.start('alice@example.com', '10.0.0.1');
    expect(codes.verify('alice@example.com', ' 123456 ', '10.0.0.1').ok).toBe(true);
  });

  it('expires', () => {
    const h = harness();
    h.codes.start('alice@example.com', '10.0.0.1');
    h.advance(CODE_TTL_MS + 1);
    expect(h.codes.verify('alice@example.com', '123456', '10.0.0.1')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });

  it('says the same thing about an unknown address as about an expired one', () => {
    const h = harness();
    expect(h.codes.verify('nobody@example.com', '123456', '10.0.0.1')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });

  it('locks out after the attempt ceiling, and the next guess is not a fresh five', () => {
    const { codes } = harness();
    codes.start('alice@example.com', '10.0.0.1');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const out = codes.verify('alice@example.com', '000000', '10.0.0.1');
      expect(out).toEqual({
        ok: false,
        error: 'invalid_code',
        attemptsLeft: MAX_ATTEMPTS - i,
      });
    }
    expect(codes.verify('alice@example.com', '000000', '10.0.0.1')).toEqual({
      ok: false,
      error: 'too_many_attempts',
    });
    // Positive control: the RIGHT code is refused too — the challenge is gone,
    // not merely the wrong guesses.
    expect(codes.verify('alice@example.com', '123456', '10.0.0.1')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });
});

describe('rate limits', () => {
  it('caps starts per email', () => {
    const { codes } = harness();
    for (let i = 0; i < MAX_STARTS_PER_EMAIL; i++) {
      expect(codes.start('alice@example.com', `10.0.0.${i}`).ok).toBe(true);
    }
    const out = codes.start('alice@example.com', '10.0.0.99');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('rate_limited');
    if (out.error !== 'rate_limited') return;
    expect(out.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('caps starts per peer address across different emails', () => {
    const { codes } = harness();
    for (let i = 0; i < MAX_STARTS_PER_PEER; i++) {
      expect(codes.start(`person${i}@example.com`, '10.0.0.1').ok).toBe(true);
    }
    // A fresh address, so only the peer limit can be what stops this.
    const out = codes.start('fresh@example.com', '10.0.0.1');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('rate_limited');
    // Positive control: another peer is unaffected.
    expect(codes.start('fresh@example.com', '10.0.0.2').ok).toBe(true);
  });

  it('caps verify attempts per peer, so a list of addresses is bounded too', () => {
    const { codes } = harness();
    for (let i = 0; i < MAX_VERIFIES_PER_PEER; i++) {
      codes.verify(`person${i}@example.com`, '000000', '10.0.0.1');
    }
    const out = codes.verify('alice@example.com', '000000', '10.0.0.1');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('rate_limited');
  });

  it('lets the window slide', () => {
    const h = harness();
    for (let i = 0; i < MAX_STARTS_PER_EMAIL; i++) {
      h.codes.start('alice@example.com', '10.0.0.1');
    }
    expect(h.codes.start('alice@example.com', '10.0.0.1').ok).toBe(false);
    h.advance(RATE_WINDOW_MS + 1);
    expect(h.codes.start('alice@example.com', '10.0.0.1').ok).toBe(true);
  });
});

describe('housekeeping', () => {
  it('does not accumulate a row per address anyone ever typed', () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.codes.start(`person${i}@example.com`, `10.0.0.${i}`);
    expect(h.codes.pendingCount()).toBeGreaterThan(0);
    h.advance(CODE_TTL_MS + 1);
    expect(h.codes.pendingCount()).toBe(0);
  });
});
