/**
 * Which CLIENT is this request from — for rate-limiting purposes?
 *
 * `server.requestIP(req)` reports the address the kernel saw, which a client
 * cannot choose, and that is exactly why the rest of this codebase trusts it
 * (see `isLoopbackAddress` in host-guard.ts). It is nevertheless the wrong
 * answer here, because **every remote reviewer reaches this server through a
 * reverse proxy running on this same machine**, so the kernel sees loopback
 * for all of them. Measured 2026-08-25 against the live deployment:
 *
 * | how the request arrived         | socket peer     | x-forwarded-for at the origin |
 * | ------------------------------- | --------------- | ----------------------------- |
 * | direct, loopback                | `127.0.0.1`     | absent                        |
 * | `tailscale serve` (tailnet)     | `127.0.0.1`     | the tailnet address           |
 * | cloudflared / Cloudflare edge   | `127.0.0.1`     | `<client value>,<real>`       |
 * | direct to the port, LAN/tailnet | the real client | whatever the client sent      |
 *
 * (Addresses in the examples below are rewritten into the RFC 5737 / RFC 3849
 * documentation ranges. This is a public repository, and the real ones locate
 * a particular house.)
 *
 * The first three rows collapse onto one key, which is the defect this file
 * exists to fix: the per-peer login limits (`MAX_STARTS_PER_PEER` = 15,
 * `MAX_VERIFIES_PER_PEER` = 30 per 15 minutes) counted every remote reviewer
 * into a single shared bucket, so one person retrying locked out everyone
 * else. It fails closed, so it is a self-inflicted denial of service rather
 * than a way in — but it would be a first-day outage the moment
 * `CW_REQUIRE_EMAIL_AUTH` is switched on.
 *
 * ## What we trust, and why that is the whole of the problem
 *
 * A forwarding header is only worth reading when the request really arrived
 * from a proxy we run. Trusting `x-forwarded-for` unconditionally would be
 * strictly worse than the bug: row four of the table is a client talking to
 * the port directly, and it can put anything it likes in that header — so an
 * attacker would mint a fresh identity per request and the limit would stop
 * counting anyone. `policyFor` in server.ts already makes this distinction
 * for the forwarded *scheme*; this is the same shape for the forwarded
 * *address*.
 *
 * **The trust condition is a loopback socket.** Both of our proxies terminate
 * on this machine and dial the server over loopback, and no remote attacker
 * can make their own connection appear to come from one — that is precisely
 * the unforgeability `isLoopbackAddress` is documented for. A request from
 * any other peer address did not pass through a proxy, so its forwarding
 * headers are self-reported and are ignored outright.
 *
 * **The value we take is the RIGHTMOST `x-forwarded-for` entry**, because
 * that is the one our own proxy appended. Measured, both directions:
 *
 *   - `tailscale serve` REPLACES the header. A client sending
 *     `x-forwarded-for: 9.9.9.9` arrived at the origin as
 *     `x-forwarded-for: 100.64.0.5` — its value was discarded.
 *   - Cloudflare APPENDS. The same forged `9.9.9.9` arrived as
 *     `x-forwarded-for: 9.9.9.9,198.51.100.7`. The client controls the
 *     LEFTMOST entry and cannot touch the last one.
 *
 * Taking the first entry — the usual reading of this header — would therefore
 * hand a Cloudflare visitor their own choice of bucket. Taking the last one
 * is proxy-supplied on both paths.
 *
 * ## Why NOT `cf-connecting-ip`, which looks like the stronger signal
 *
 * On the Cloudflare path it genuinely is: the edge refuses the request
 * outright rather than forwarding a client-supplied one (measured — sending
 * `cf-connecting-ip` yourself gets an edge **403**, the request never reaches
 * the origin). But it is only stronger *if you already know the request came
 * from Cloudflare*, and here you cannot know that: `tailscale serve` forwards
 * arbitrary client headers untouched, so a tailnet client sending
 * `cf-connecting-ip: <anything>` — with a forged `cf-ray`, `cdn-loop`, or any
 * other "this came from the edge" marker alongside it — delivers all of them
 * to the origin verbatim (measured). Both proxies land on the same loopback
 * socket, so no header can separate the two paths, and preferring
 * `cf-connecting-ip` would reintroduce exactly the forgeable identity this
 * function exists to deny. Nothing is lost by leaving it alone: on a real
 * Cloudflare request the rightmost `x-forwarded-for` entry IS
 * `cf-connecting-ip` (both `198.51.100.7` in the measurement above).
 *
 * ## What an attacker can still do
 *
 * Share a bucket with honest people, by being behind the same address — which
 * is the documented, deliberate cost of the per-peer limit being looser than
 * the per-email one (see the module header of auth/email-code.ts). And run
 * code on this machine, which reaches loopback and can claim any address; that
 * is inside the trust boundary already, since such a process can read the
 * server's memory.
 *
 * A pure function over two strings, so it is unit-testable without a server —
 * same convention as host-guard.ts, and for the same reason.
 */
import { isLoopbackAddress } from './host-guard.ts';

/**
 * The bucket key used when we cannot identify the client at all.
 *
 * `requestIP` returns null for a socket that has already gone away. Sharing
 * one bucket is the conservative answer: it can only make the limit stricter,
 * never hand anyone a private one.
 */
export const UNKNOWN_CLIENT = 'unknown';

export interface ClientAddressInput {
  /** `server.requestIP(req)?.address` — what the kernel saw. */
  socketAddress: string | null | undefined;
  /** The raw `x-forwarded-for` header, if any. */
  forwardedFor: string | null | undefined;
}

/**
 * The rate-limit bucket key for a request.
 *
 * Never throws and always returns something usable as a Map key, because the
 * caller is a login route: a malformed header must degrade to a stricter
 * bucket, never to an exception on the sign-in path.
 */
export function clientAddressKey(input: ClientAddressInput): string {
  const socketKey = bucketFor(input.socketAddress) ?? UNKNOWN_CLIENT;
  // Not behind one of our proxies: the header is self-reported. Ignore it.
  if (!isLoopbackAddress(input.socketAddress)) return socketKey;
  const forwarded = bucketFor(lastForwardedEntry(input.forwardedFor));
  // A missing or unparseable header falls back to the socket — which on this
  // branch is loopback, i.e. the shared bucket we had before. Strictly the
  // old behaviour, reached only when there is nothing better to key on.
  return forwarded ?? socketKey;
}

/**
 * The last entry of an `x-forwarded-for` list — the one OUR proxy appended.
 *
 * Only the final entry is ever read, so a client stuffing thousands of
 * entries in front of it wastes its own bandwidth: it cannot move the value
 * we take, and it cannot grow the key we store (`bucketFor` accepts only
 * something that parses as an IP address, so the key space stays bounded by
 * the address space rather than by what a client can type).
 */
function lastForwardedEntry(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.split(',');
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i]?.trim();
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Normalise one address into a bucket key, or null when it is not an address.
 *
 * IPv6 is bucketed by its /64 PREFIX rather than by the full address, and
 * that is load-bearing rather than tidy: a single IPv6 client is routinely
 * handed a whole /64, so keying on the full address would let one machine
 * rotate through 2^64 private buckets and the per-peer limit would count
 * nobody. Honest people sharing a /64 share a bucket, which is the same trade
 * already accepted for everyone behind one IPv4 NAT.
 */
function bucketFor(addr: string | null | undefined): string | null {
  if (!addr) return null;
  let a = addr.trim().toLowerCase();
  if (a === '') return null;
  // `[2001:db8::1]:443` — some proxies bracket-and-port IPv6 entries.
  if (a.startsWith('[')) {
    const close = a.indexOf(']');
    if (close < 0) return null;
    a = a.slice(1, close);
  } else if (isIPv4WithPort(a)) {
    a = a.slice(0, a.lastIndexOf(':'));
  }
  // Bun reports an IPv4 loopback peer as `::ffff:127.0.0.1`; unwrap so the
  // same client is one bucket however it reached us.
  const unwrapped = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  if (isIPv4(unwrapped)) return unwrapped;
  if (isIPv6(a)) return ipv6Prefix64(a);
  return null;
}

/** `1.2.3.4:5678`, but never a bare IPv6 address (which is full of colons). */
function isIPv4WithPort(a: string): boolean {
  const colon = a.lastIndexOf(':');
  if (colon <= 0 || a.indexOf(':') !== colon) return false;
  return isIPv4(a.slice(0, colon)) && /^\d{1,5}$/.test(a.slice(colon + 1));
}

/** Anchored and fully numeric: `127.0.0.1.evil.example` must not match. */
function isIPv4(a: string): boolean {
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Deliberately a shape check, not a full RFC 4291 parser. Its only job is to
 * refuse anything that is not an address, so that the key space stays bounded
 * — the address itself is proxy-supplied on every path that reaches here.
 */
function isIPv6(a: string): boolean {
  if (!a.includes(':')) return false;
  if (!/^[0-9a-f:.]+$/.test(a)) return false;
  // At most one `::`, and never a stray triple colon.
  if (a.includes(':::')) return false;
  const doubles = a.split('::').length - 1;
  if (doubles > 1) return false;
  const groups = a.split(':').filter((g) => g !== '');
  if (groups.length === 0 || groups.length > 8) return false;
  return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g) || isIPv4(g));
}

/**
 * The first four hextets, `::`-expanded and zero-padded, so that every
 * spelling of one /64 produces one key: `2001:db8::1` and
 * `2001:0db8:0000:0000:0:0:0:2` are the same network and must not be two
 * buckets.
 */
function ipv6Prefix64(a: string): string {
  const split = (s: string): string[] => (s === '' ? [] : s.split(':'));
  let groups: string[];
  if (a.includes('::')) {
    const [head = '', tail = ''] = a.split('::', 2);
    const headGroups = split(head);
    const tailGroups = split(tail);
    const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
    groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  } else {
    groups = split(a);
  }
  // Pad to four so a short-but-valid spelling still yields a fixed-width key.
  while (groups.length < 4) groups.push('0');
  return groups
    .slice(0, 4)
    .map((g) => (g === '' ? '0' : g).padStart(4, '0'))
    .join(':');
}
