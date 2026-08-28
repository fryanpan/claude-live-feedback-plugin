import { describe, expect, it } from 'bun:test';
import {
  CEILING_WINDOW_MS,
  CODE_TTL_MS,
  type EmailCodeOptions,
  EmailCodes,
  MAX_ATTEMPTS,
  MAX_STARTS_PER_EMAIL,
  MAX_STARTS_PER_PEER,
  MAX_VERIFIES_PER_PEER,
  RATE_WINDOW_MS,
} from '../src/auth/email-code.ts';

/** A clock a test can move, and a fixed code so assertions are readable. */
function harness(code = '123456', opts: EmailCodeOptions = {}) {
  let clock = 1_000_000;
  const codes = new EmailCodes({ now: () => clock, generateCode: () => code, ...opts });
  return {
    codes,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** A harness whose generator hands out codes from a script, in order. */
function scripted(script: string[], opts: EmailCodeOptions = {}) {
  let clock = 1_000_000;
  let i = 0;
  const codes = new EmailCodes({
    now: () => clock,
    generateCode: () => script[i++] ?? '999999',
    ...opts,
  });
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

describe('challenge coexistence', () => {
  it('a start from a different peer leaves the earlier code usable', () => {
    const { codes } = scripted(['111111', '222222']);
    codes.start('victim@example.com', '10.0.0.1');
    // The griefer asks for a code for the victim's address. Before the fix
    // this overwrote the victim's live challenge with one request.
    codes.start('victim@example.com', '203.0.113.9');
    expect(codes.verify('victim@example.com', '111111', '10.0.0.1').ok).toBe(true);
  });

  it('both live codes verify, and a success consumes every one of them', () => {
    const { codes } = scripted(['111111', '222222']);
    codes.start('alice@example.com', '10.0.0.1');
    codes.start('alice@example.com', '203.0.113.9');
    expect(codes.verify('alice@example.com', '222222', '10.0.0.1').ok).toBe(true);
    // One login spends the address's whole challenge set — the other mail's
    // code is not a second login.
    expect(codes.verify('alice@example.com', '111111', '10.0.0.1')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });

  it('a peer asking again invalidates its OWN earlier code, nobody else’s', () => {
    const { codes } = scripted(['111111', '222222', '333333']);
    codes.start('alice@example.com', '10.0.0.1'); // victim
    codes.start('alice@example.com', '203.0.113.9'); // other device
    codes.start('alice@example.com', '203.0.113.9'); // same device, again
    const stale = codes.verify('alice@example.com', '222222', '203.0.113.9');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error).toBe('invalid_code');
    // The victim's code survived both of the other peer's starts.
    expect(codes.verify('alice@example.com', '111111', '10.0.0.1').ok).toBe(true);
  });

  it('a third distinct peer evicts only the oldest live code', () => {
    const { codes } = scripted(['111111', '222222', '333333']);
    codes.start('alice@example.com', '10.0.0.1');
    codes.start('alice@example.com', '10.0.0.2');
    codes.start('alice@example.com', '10.0.0.3');
    const evicted = codes.verify('alice@example.com', '111111', '10.0.0.1');
    expect(evicted.ok).toBe(false);
    if (!evicted.ok) expect(evicted.error).toBe('invalid_code');
    expect(codes.verify('alice@example.com', '333333', '10.0.0.3').ok).toBe(true);
  });

  it('wrong guesses burn the whole set — two live codes are not ten attempts', () => {
    const { codes } = scripted(['111111', '222222']);
    codes.start('alice@example.com', '10.0.0.1');
    codes.start('alice@example.com', '203.0.113.9');
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const out = codes.verify('alice@example.com', '000000', '10.0.0.9');
      expect(out).toEqual({ ok: false, error: 'invalid_code', attemptsLeft: MAX_ATTEMPTS - i });
    }
    expect(codes.verify('alice@example.com', '000000', '10.0.0.9')).toEqual({
      ok: false,
      error: 'too_many_attempts',
    });
    // Positive control: BOTH real codes are dead, not merely the wrong guesses.
    for (const real of ['111111', '222222']) {
      expect(codes.verify('alice@example.com', real, '10.0.0.9')).toEqual({
        ok: false,
        error: 'no_challenge',
      });
    }
  });
});

describe('start ceilings', () => {
  it('the global ceiling refuses as a ceiling, carrying what a decoy needs', () => {
    const { codes } = harness('123456', { globalStartsPerHour: 3 });
    for (let i = 0; i < 3; i++) {
      expect(codes.start(`person${i}@example.com`, `10.0.0.${i}`).ok).toBe(true);
    }
    // A fresh email AND a fresh peer, so only the global ceiling can be what
    // stops this.
    const out = codes.start('  Fresh@Example.com ', '10.0.0.99');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('ceiling');
    if (out.error !== 'ceiling') return;
    expect(out.scope).toBe('global');
    // Normalized address and an expiry, so the route can answer exactly as a
    // success would have.
    expect(out.email).toBe('fresh@example.com');
    expect(out.expiresAt).toBeGreaterThan(0);
  });

  it('the global ceiling window slides', () => {
    const h = harness('123456', { globalStartsPerHour: 2 });
    h.codes.start('a@example.com', '10.0.0.1');
    h.codes.start('b@example.com', '10.0.0.2');
    expect(h.codes.start('c@example.com', '10.0.0.3').ok).toBe(false);
    h.advance(CEILING_WINDOW_MS + 1);
    expect(h.codes.start('c@example.com', '10.0.0.3').ok).toBe(true);
  });

  it('the per-peer ceiling binds even when the 15-minute buckets rotate', () => {
    const h = harness('123456', { peerStartsPerHour: 20, globalStartsPerHour: 1000 });
    let n = 0;
    const fresh = () => `person${n++}@example.com`;
    for (let i = 0; i < MAX_STARTS_PER_PEER; i++) {
      expect(h.codes.start(fresh(), '10.0.0.1').ok).toBe(true);
    }
    // The short window slides; before the hourly ceiling existed this peer
    // got a whole fresh budget here.
    h.advance(RATE_WINDOW_MS + 1);
    for (let i = MAX_STARTS_PER_PEER; i < 20; i++) {
      expect(h.codes.start(fresh(), '10.0.0.1').ok).toBe(true);
    }
    const out = h.codes.start(fresh(), '10.0.0.1');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('ceiling');
    if (out.error !== 'ceiling') return;
    expect(out.scope).toBe('peer');
    // Positive control: another peer is unaffected.
    expect(h.codes.start(fresh(), '10.0.0.2').ok).toBe(true);
  });

  it('a ceilinged start still marches toward the honest short-window refusal', () => {
    // Indistinguishability: a probing client must see the same 429-after-15
    // it would see on a healthy server, or the 200s themselves reveal the
    // ceiling. So refused-by-ceiling starts still count in the short buckets.
    const { codes } = harness('123456', { globalStartsPerHour: 1 });
    let n = 0;
    const fresh = () => `person${n++}@example.com`;
    expect(codes.start(fresh(), '10.0.0.1').ok).toBe(true);
    for (let i = 1; i < MAX_STARTS_PER_PEER; i++) {
      const out = codes.start(fresh(), '10.0.0.1');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('ceiling');
    }
    const out = codes.start(fresh(), '10.0.0.1');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe('rate_limited');
  });

  it('a ceilinged start mints no challenge', () => {
    const { codes } = harness('123456', { globalStartsPerHour: 1 });
    codes.start('first@example.com', '10.0.0.1');
    codes.start('second@example.com', '10.0.0.2');
    // The generator is fixed, so if a challenge HAD been minted this exact
    // code would verify.
    expect(codes.verify('second@example.com', '123456', '10.0.0.2')).toEqual({
      ok: false,
      error: 'no_challenge',
    });
  });

  it('a peer-ceilinged start does not eat the global budget', () => {
    const { codes } = harness('123456', { peerStartsPerHour: 1, globalStartsPerHour: 2 });
    expect(codes.start('a@example.com', '10.0.0.1').ok).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(codes.start(`spam${i}@example.com`, '10.0.0.1').ok).toBe(false);
    }
    // The refusals above must not have consumed the second global slot.
    expect(codes.start('b@example.com', '10.0.0.2').ok).toBe(true);
  });
});
