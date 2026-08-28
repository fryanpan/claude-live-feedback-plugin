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
 * Above the sliding windows sit two hourly ABUSE CEILINGS — per peer and
 * global — that bound how much mail this server can be made to send at all;
 * see `CEILING_WINDOW_MS`. They refuse differently: not a 429 but an answer
 * the route makes indistinguishable from success, plus a loud log line.
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

/**
 * The abuse ceilings, measured over an hour — deliberately LONGER than
 * `RATE_WINDOW_MS`, because the per-peer limit alone re-arms every fifteen
 * minutes: a patient client gets 60 sends an hour from one address forever,
 * and every one of those is a mail this server asked a provider to deliver
 * to an address the requester does not have to own. The per-hour pair is the
 * bound on that: per peer so one address cannot sustain the drip, and global
 * so a peer-rotating botnet meets a ceiling that does not rotate with it.
 *
 * Defaults are generous for a small team — sixty mails an hour is one a
 * minute, sustained — and env-tunable (`CW_AUTH_GLOBAL_STARTS_PER_HOUR`,
 * `CW_AUTH_PEER_STARTS_PER_HOUR` via bin.ts) for a deployment whose team is
 * not small.
 */
export const CEILING_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_GLOBAL_STARTS_PER_HOUR = 60;
export const DEFAULT_PEER_STARTS_PER_HOUR = 30;

/**
 * Live challenges an address can hold at once — the "last two" rule.
 *
 * One was the griefing hole: any stranger could ask for a code for YOUR
 * address and the overwrite killed the code already in your inbox, while the
 * per-email start cap kept you from asking for another. Two slots, where a
 * peer's own re-request replaces only its own slot, means evicting somebody
 * else's live code costs two distinct peer buckets instead of one request.
 *
 * Guess-budget math for holding two codes live (see `verify`): a wrong guess
 * burns an attempt on EVERY live challenge, so an address still absorbs at
 * most `MAX_ATTEMPTS` wrong guesses per challenge set — each guess now
 * checked against ≤2 codes, so a set is worth ≤10 of a million codes instead
 * of ≤5. Regeneration is bounded by `MAX_STARTS_PER_EMAIL` exactly as
 * before, and `MAX_VERIFIES_PER_PEER` still prices the guessing itself.
 */
export const MAX_LIVE_CHALLENGES = 2;

export interface EmailCodeOptions {
  now?: () => number;
  /** Test seam. Production draws from `crypto.randomInt`. */
  generateCode?: () => string;
  /** Hourly send ceiling across ALL addresses and peers. */
  globalStartsPerHour?: number;
  /** Hourly send ceiling for one peer, outlasting its 15-minute buckets. */
  peerStartsPerHour?: number;
}

export type StartOutcome =
  | { ok: true; code: string; email: string; expiresAt: number }
  | { ok: false; error: 'invalid_email' }
  | { ok: false; error: 'rate_limited'; retryAfterSeconds: number }
  /**
   * An abuse ceiling tripped. NOT surfaced as a refusal: the route answers
   * it exactly like a success (hence the normalized email and an expiry to
   * echo) and logs it loudly instead. A 429 here would hand a mail-bomber a
   * progress meter and tell any client the server-wide traffic state.
   */
  | { ok: false; error: 'ceiling'; scope: 'global' | 'peer'; email: string; expiresAt: number };

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
  /** Which peer asked for this code — a re-request replaces only its own. */
  peer: string;
}

export class EmailCodes {
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly globalStartsPerHour: number;
  private readonly peerStartsPerHour: number;
  /** Up to `MAX_LIVE_CHALLENGES` per address, oldest first. */
  private readonly challenges = new Map<string, Challenge[]>();
  private readonly startsByEmail = new Map<string, number[]>();
  private readonly startsByPeer = new Map<string, number[]>();
  private readonly verifiesByPeer = new Map<string, number[]>();
  private readonly hourlyStartsByPeer = new Map<string, number[]>();
  private hourlyStarts: number[] = [];

  constructor(opts: EmailCodeOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.generateCode = opts.generateCode ?? sixDigits;
    this.globalStartsPerHour = opts.globalStartsPerHour ?? DEFAULT_GLOBAL_STARTS_PER_HOUR;
    this.peerStartsPerHour = opts.peerStartsPerHour ?? DEFAULT_PEER_STARTS_PER_HOUR;
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

    // Recorded BEFORE the ceilings are consulted, on purpose: the route
    // answers a tripped ceiling as a success, and a probing client must keep
    // meeting the same 429-after-N it would meet on a healthy server — a
    // stream of 200s past the short-window limits would itself announce that
    // the ceiling is up.
    record(this.startsByEmail, key, now);
    record(this.startsByPeer, peer, now);

    const expiresAt = now + CODE_TTL_MS;
    if (withinWindow(this.hourlyStarts, now).length >= this.globalStartsPerHour) {
      return { ok: false, error: 'ceiling', scope: 'global', email: key, expiresAt };
    }
    const peerHour = withinWindow(this.hourlyStartsByPeer.get(peer) ?? [], now);
    if (peerHour.length >= this.peerStartsPerHour) {
      return { ok: false, error: 'ceiling', scope: 'peer', email: key, expiresAt };
    }
    // Only a start that will actually mail consumes hourly budget — a
    // peer-ceilinged flood must not spend the global allowance of everyone
    // else while sending nothing.
    this.hourlyStarts = withinWindow(this.hourlyStarts, now);
    this.hourlyStarts.push(now);
    this.hourlyStartsByPeer.set(peer, [...peerHour, now]);

    const code = this.generateCode();
    const salt = randomBytes(16).toString('hex');
    // Up to two challenges live per address, so a stranger's request cannot
    // kill the code already in the owner's inbox. A peer re-requesting
    // replaces its OWN slot — its earlier mail cannot be replayed — and only
    // a third distinct peer evicts, oldest first. Budget math at
    // `MAX_LIVE_CHALLENGES`.
    const live = this.liveChallenges(key, now);
    const challenge: Challenge = { salt, hash: hashCode(salt, code), expiresAt, attempts: 0, peer };
    const own = live.findIndex((c) => c.peer === peer);
    if (own >= 0) live[own] = challenge;
    else {
      live.push(challenge);
      while (live.length > MAX_LIVE_CHALLENGES) live.shift();
    }
    this.challenges.set(key, live);
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

    // An expired challenge is indistinguishable from one that never existed:
    // both mean "ask for a code", and telling them apart would say whether an
    // address has been used here.
    const live = this.liveChallenges(key, now);
    if (live.length === 0) {
      this.challenges.delete(key);
      return { ok: false, error: 'no_challenge' };
    }

    const supplied = typeof code === 'string' ? code.trim() : '';
    const matched = live.some((c) => equalsHash(c.hash, hashCode(c.salt, supplied)));
    if (!matched) {
      // A miss burns an attempt on EVERY live challenge — the guess was
      // against all of them — so holding two codes never grows the number of
      // wrong guesses an address absorbs, only what each guess is compared
      // to. See the budget math at `MAX_LIVE_CHALLENGES`.
      const survivors = live.filter((c) => {
        c.attempts += 1;
        return c.attempts < MAX_ATTEMPTS;
      });
      if (survivors.length === 0) {
        this.challenges.delete(key);
        return { ok: false, error: 'too_many_attempts' };
      }
      this.challenges.set(key, survivors);
      const attemptsLeft = Math.max(...survivors.map((c) => MAX_ATTEMPTS - c.attempts));
      return { ok: false, error: 'invalid_code', attemptsLeft };
    }
    // One login spends the address's whole challenge set: the other mail's
    // code must not stay a second live credential.
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

  /** The address's unexpired challenges, oldest first. */
  private liveChallenges(key: string, now: number): Challenge[] {
    return (this.challenges.get(key) ?? []).filter((c) => c.expiresAt > now);
  }

  /** Drop what has aged out, so a long-running process does not accumulate
   *  a row per address anyone ever typed. */
  private prune(now: number): void {
    for (const [key, list] of this.challenges) {
      const live = list.filter((c) => c.expiresAt > now);
      if (live.length === 0) this.challenges.delete(key);
      else this.challenges.set(key, live);
    }
    for (const log of [this.startsByEmail, this.startsByPeer, this.verifiesByPeer]) {
      for (const [key, hits] of log) {
        const live = hits.filter((t) => now - t < RATE_WINDOW_MS);
        if (live.length === 0) log.delete(key);
        else log.set(key, live);
      }
    }
    this.hourlyStarts = withinWindow(this.hourlyStarts, now);
    for (const [key, hits] of this.hourlyStartsByPeer) {
      const live = withinWindow(hits, now);
      if (live.length === 0) this.hourlyStartsByPeer.delete(key);
      else this.hourlyStartsByPeer.set(key, live);
    }
  }
}

/** The timestamps still inside the hourly ceiling window. */
function withinWindow(hits: number[], now: number): number[] {
  return hits.filter((t) => now - t < CEILING_WINDOW_MS);
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
