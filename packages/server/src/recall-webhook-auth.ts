/**
 * Verifying that a webhook really came from Recall.
 *
 * Recall signs webhooks in the Svix format and publishes NO static IPs or
 * domains to allowlist (docs.recall.ai/docs/real-time-endpoints), so a
 * signature is the only thing standing between this route and anyone who has
 * seen a bot id. The scheme, from
 * docs.recall.ai/docs/authenticating-requests-from-recallai (read 2026-08-30):
 *
 *   signed = HMAC-SHA256(key, `${id}.${timestamp}.${body}`)
 *   header `webhook-signature` (or `svix-signature`) is a space-separated
 *   list of `v1,<base64>` entries — a LIST because a secret being rotated
 *   produces two valid signatures for a while.
 *   the secret is `whsec_<base64>`; the bytes signed with are the DECODED
 *   part after the prefix, not the string.
 *
 * Written here rather than pulled from the `svix` package: this is a dozen
 * lines of Web Crypto, and the alternative is a dependency on the deploy path
 * — which on this server means a `bun install` that has taken prod down
 * before.
 */

/** Reject a signature older than this. Bounds replay of a captured request. */
const TOLERANCE_SEC = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/** Read the headers under either the `webhook-` or the `svix-` spelling. */
export function svixHeadersFrom(headers: Headers): SvixHeaders {
  const pick = (name: string): string | null =>
    headers.get(`webhook-${name}`) ?? headers.get(`svix-${name}`);
  return { id: pick('id'), timestamp: pick('timestamp'), signature: pick('signature') };
}

/**
 * True when `body` was signed by `secret` for these headers.
 *
 * Every failure is one `false`: a caller that could tell "bad timestamp" from
 * "bad signature" apart would be handing an attacker a decision tree, and the
 * operator's own debugging goes through the server log, not the response.
 */
export async function verifySvixSignature(args: {
  secret: string;
  body: string;
  headers: SvixHeaders;
  nowSec?: number;
}): Promise<boolean> {
  const { id, timestamp, signature } = args.headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = args.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SEC) return false;

  const raw = args.secret.startsWith('whsec_') ? args.secret.slice('whsec_'.length) : args.secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${args.body}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  const expected = btoa(String.fromCharCode(...mac));

  // Every candidate is compared, and the result is OR-ed at the end rather
  // than returned early, so the time this takes does not depend on which
  // entry matched.
  let ok = false;
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    if (timingSafeEqual(value, expected)) ok = true;
  }
  return ok;
}

/** Constant-time for equal-length strings; length itself is not a secret. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Remembers which `webhook-id`s have been accepted, so a captured request
 * cannot be played back inside the signature's tolerance window.
 *
 * The signature covers `${id}.${timestamp}.${body}` and `TOLERANCE_SEC`
 * bounds how old a timestamp may be — which bounded a replay to ten minutes
 * and did nothing inside them: every replay re-ran the handler (Urgent-fixes
 * ticket, 2026-09-02). Svix ids are unique per delivery, so a second arrival
 * of one inside the window is by definition not a delivery.
 *
 * Checked only AFTER the signature verifies: an unsigned caller must not be
 * able to learn which ids the server has seen, and an attacker who can sign
 * can mint fresh ids anyway — this guard is about captured traffic, not
 * forged traffic.
 *
 * Bounded two ways. By time: an entry is forgotten after `ttlSec`, which
 * defaults to twice the tolerance so it outlives every timestamp the
 * verifier would still accept. By count: past `maxEntries` the OLDEST entry
 * goes, and an evicted id is admitted again — the bound is a bound, not a
 * promise. At the vendor's real delivery rate (a handful per meeting) the
 * count bound never engages; it exists so a flood of signed traffic cannot
 * grow this without limit.
 */
export class WebhookReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlSec: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlSec?: number; maxEntries?: number } = {}) {
    this.ttlSec = opts.ttlSec ?? TOLERANCE_SEC * 2;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /** How many ids are remembered right now (after expiry sweep). Tests. */
  get size(): number {
    return this.seen.size;
  }

  /**
   * `true` the first time `id` is presented inside the window; `false` for
   * every repeat until the window passes. Records the id as a side effect
   * of a `true` answer, so "admit then handle" is the only call pattern.
   */
  admit(id: string, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
    this.sweep(nowSec);
    const at = this.seen.get(id);
    if (at !== undefined && nowSec - at <= this.ttlSec) return false;
    // Delete-then-set keeps Map insertion order as recency, so eviction
    // below always takes the entry least recently accepted.
    this.seen.delete(id);
    this.seen.set(id, nowSec);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Drop expired entries. Insertion order is time order, so stop at the
   *  first live one. */
  private sweep(nowSec: number): void {
    for (const [id, at] of this.seen) {
      if (nowSec - at <= this.ttlSec) break;
      this.seen.delete(id);
    }
  }
}
