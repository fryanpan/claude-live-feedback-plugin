/**
 * The six-digit login code.
 *
 * A code and not a magic link, and that is not a style preference: the app is
 * an installable PWA (`display: standalone`), and on iOS a home-screen PWA
 * keeps its own cookie jar. A link tapped in Mail authenticates Safari and
 * leaves the PWA logged out — the reviewer would watch the login succeed in
 * the wrong window. A code is typed into whichever window asked for it.
 *
 * Six digits is a million guesses, which is only enough because three limits
 * hold at once, and each one closes a hole the others leave open:
 *
 * - **Attempts per challenge (5).** Bounds grinding one code. Exhausting
 *   them consumes the challenge, so the sixth guess cannot be the first of a
 *   fresh five.
 * - **Starts per email (5 / 15 min).** Bounds the OTHER grind — requesting a
 *   thousand codes and guessing one each — and doubles as the mail-bomb
 *   limit, since every start sends a message to an address the requester does
 *   not have to own.
 * - **Starts and attempts per peer address.** An attacker with a list of
 *   addresses is under no per-email limit at all; this is the only one that
 *   sees them. Held deliberately looser than the per-email ceiling, because
 *   several honest people can share one address behind a tunnel or a NAT.
 *
 * The code is stored HASHED with a per-challenge salt and compared
 * timing-safely, for the same reason a password would be: this file's map is
 * read by anything that can read the process, and a memory dump or a stray
 * log line should not be a set of live credentials.
 *
 * In-memory on purpose. A challenge outlives neither a restart nor ten
 * minutes, and persisting it would put a live credential on disk to buy back
 * a case — "the server restarted while I was reading my mail" — whose whole
 * cost is asking for another code.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { isEmailLike, normalizeEmail } from '@feedback/core';

/** How long a code stays usable. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the challenge is spent. */
export const MAX_ATTEMPTS = 5;
/** The window both start limits are measured over. */
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_STARTS_PER_EMAIL = 5;
export const MAX_STARTS_PER_PEER = 15;
export const MAX_VERIFIES_PER_PEER = 30;

export interface EmailCodeOptions {
  now?: () => number;
  /** Test seam. Production draws from `crypto.randomInt`. */
  generateCode?: () => string;
}

export type StartOutcome =
  | { ok: true; code: string; email: string; expiresAt: number }
  | { ok: false; error: 'invalid_email' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };

export type VerifyOutcome =
  | { ok: true; email: string }
  | { ok: false; error: 'invalid_email' }
  | { ok: false; error: 'no_challenge' }
  | { ok: false; error: 'invalid_code'; attemptsLeft: number }
  | { ok: false; error: 'too_many_attempts' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number };

interface Challenge {
  salt: string;
  hash: string;
  expiresAt: number;
  attempts: number;
}

export class EmailCodes {
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly challenges = new Map<string, Challenge>();
  private readonly startsByEmail = new Map<string, number[]>();
  private readonly startsByPeer = new Map<string, number[]>();
  private readonly verifiesByPeer = new Map<string, number[]>();

  constructor(opts: EmailCodeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.generateCode = opts.generateCode ?? sixDigits;
  }

  /**
   * Mint a code for an address. The CALLER sends it — this class never
   * touches the network, so the route can turn a delivery failure into a 502
   * and the code that was never delivered stays usable until it expires.
   */
  start(email: string, peer: string): StartOutcome {
    if (!isEmailLike(email)) return { ok: false, error: 'invalid_email' };
    const key = normalizeEmail(email);
    const now = this.now();

    const perEmail = this.checkLimit(this.startsByEmail, key, MAX_STARTS_PER_EMAIL, now);
    if (perEmail) return perEmail;
    const perPeer = this.checkLimit(this.startsByPeer, peer, MAX_STARTS_PER_PEER, now);
    if (perPeer) return perPeer;

    record(this.startsByEmail, key, now);
    record(this.startsByPeer, peer, now);

    const code = this.generateCode();
    const salt = randomBytes(16).toString('hex');
    const expiresAt = now + CODE_TTL_MS;
    // One live challenge per address: asking for a new code invalidates the
    // old one, so a code read out of an old mail cannot be replayed.
    this.challenges.set(key, { salt, hash: hashCode(salt, code), expiresAt, attempts: 0 });
    this.prune(now);
    return { ok: true, code, email: key, expiresAt };
  }

  /** Spend a code. A success consumes the challenge; so does the fifth miss. */
  verify(email: string, code: string, peer: string): VerifyOutcome {
    if (!isEmailLike(email)) return { ok: false, error: 'invalid_email' };
    const key = normalizeEmail(email);
    const now = this.now();

    const perPeer = this.checkLimit(this.verifiesByPeer, peer, MAX_VERIFIES_PER_PEER, now);
    if (perPeer) return perPeer;
    record(this.verifiesByPeer, peer, now);

    const challenge = this.challenges.get(key);
    // An expired challenge is indistinguishable from one that never existed:
    // both mean "ask for a code", and telling them apart would say whether an
    // address has been used here.
    if (!challenge || challenge.expiresAt <= now) {
      this.challenges.delete(key);
      return { ok: false, error: 'no_challenge' };
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      this.challenges.delete(key);
      return { ok: false, error: 'too_many_attempts' };
    }

    const supplied = typeof code === 'string' ? code.trim() : '';
    if (!equalsHash(challenge.hash, hashCode(challenge.salt, supplied))) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_ATTEMPTS) {
        this.challenges.delete(key);
        return { ok: false, error: 'too_many_attempts' };
      }
      return { ok: false, error: 'invalid_code', attemptsLeft: MAX_ATTEMPTS - challenge.attempts };
    }
    this.challenges.delete(key);
    return { ok: true, email: key };
  }

  /** Live challenge count — for tests and for a health read, never a route. */
  pendingCount(): number {
    this.prune(this.now());
    return this.challenges.size;
  }

  private checkLimit(
    log: Map<string, number[]>,
    key: string,
    max: number,
    now: number,
  ): { ok: false; error: 'rate_limited'; retryAfterSeconds: number } | null {
    const hits = (log.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    log.set(key, hits);
    if (hits.length < max) return null;
    const oldest = hits[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000));
    return { ok: false, error: 'rate_limited', retryAfterSeconds };
  }

  /** Drop what has aged out, so a long-running process does not accumulate
   *  a row per address anyone ever typed. */
  private prune(now: number): void {
    for (const [key, c] of this.challenges) {
      if (c.expiresAt <= now) this.challenges.delete(key);
    }
    for (const log of [this.startsByEmail, this.startsByPeer, this.verifiesByPeer]) {
      for (const [key, hits] of log) {
        const live = hits.filter((t) => now - t < RATE_WINDOW_MS);
        if (live.length === 0) log.delete(key);
        else log.set(key, live);
      }
    }
  }
}

/**
 * Six digits, uniformly. `randomInt` and not `Math.random()`: the anon id in
 * core is ~31 bits of `Math.random`, which is a known wart there and would be
 * a live credential here.
 */
function sixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(salt: string, code: string): string {
  return createHmac('sha256', salt).update(code).digest('hex');
}

function equalsHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

function record(log: Map<string, number[]>, key: string, now: number): void {
  log.set(key, [...(log.get(key) ?? []), now]);
}
