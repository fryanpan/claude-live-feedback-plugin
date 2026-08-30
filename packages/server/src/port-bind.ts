/**
 * Bind policy: what a failed listen() MEANS, and what to do about it.
 *
 * Written after the 2026-08-29 outage, whose whole shape came from one
 * conflation. `scripts/serve.ts` probed a port with a throwaway
 * `net.createServer().listen()` and resolved `false` on ANY `error` event, so
 * "someone else owns this port" and "this host cannot open a socket right
 * now" were the same answer. When the machine ran out of network buffers,
 * every one of the 50 probed ports "failed", the supervisor threw `no free
 * port near 8787`, and launchd relaunched it every 10s — 393 times, each
 * relaunch re-running two client builds and re-hydrating 5,622 documents.
 *
 * The three exported pieces are the policy, kept pure so they can be tested
 * without sockets, clocks, or a spare port:
 *
 *   classifyBindError  — in-use vs. host-unavailable vs. a real bug
 *   bindRetryDelayMs   — the backoff schedule
 *   shouldWalkPorts    — whether moving to the next port is even legal
 *
 * `acquirePort` composes them against injected probe/sleep functions.
 */
/**
 * - `in-use`: another process holds the port. Waiting can fix it; so can
 *   walking to the next port, WHERE WALKING IS ALLOWED.
 * - `unavailable`: the host cannot give us a socket at all (out of buffers,
 *   out of descriptors, the address is gone). The port is not the problem, so
 *   walking to a different one is guaranteed not to help and actively hurts —
 *   it is how a supervisor ends up believing 50 ports are occupied. Wait.
 * - `fatal`: anything we do not recognise. Do not paper over it with a retry
 *   loop; let it throw so it gets read.
 */
export type BindErrorKind = 'in-use' | 'unavailable' | 'fatal';

const IN_USE_CODES = new Set(['EADDRINUSE']);

/**
 * Host-resource and address failures. None of these are a statement about
 * which port was asked for. ENOBUFS is the one that took prod down; the rest
 * are its neighbours in the same failure class and are listed so the next one
 * does not have to be diagnosed from scratch.
 */
const UNAVAILABLE_CODES = new Set([
  'ENOBUFS', // no buffer space — the 2026-08-29 outage
  'ENOMEM',
  'EADDRNOTAVAIL', // the interface went away (VPN/tailnet flap)
  'EMFILE', // per-process descriptor limit
  'ENFILE', // system-wide descriptor limit
  'EAGAIN',
  'ENETDOWN',
  'ENETUNREACH',
]);

/**
 * Bun.serve throws an ordinary `Error` whose `code` is usually set, but not
 * always — and a code we cannot read must not silently become `fatal` when
 * the message plainly names it. So: `code` first, then a whole-token scan of
 * the message. Substring matching would classify `EADDRINUSExx`, hence the
 * word boundaries.
 */
function errorCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  const message = (err as Error | null | undefined)?.message;
  if (typeof message !== 'string') return null;
  for (const known of [...IN_USE_CODES, ...UNAVAILABLE_CODES]) {
    if (new RegExp(`\\b${known}\\b`).test(message)) return known;
  }
  return null;
}

export function classifyBindError(err: unknown): BindErrorKind {
  const code = errorCode(err);
  if (code === null) return 'fatal';
  if (IN_USE_CODES.has(code)) return 'in-use';
  if (UNAVAILABLE_CODES.has(code)) return 'unavailable';
  return 'fatal';
}

/** Exported so logs and tests quote the same numbers the code uses. */
export const BIND_RETRY_BASE_MS = 1_000;
export const BIND_RETRY_CAP_MS = 60_000;

/**
 * Delay BEFORE retry number `attempt` (1-based): 1s, 2s, 4s, 8s, 16s, 32s,
 * then 60s forever. The cap matters more than the growth — an unattended
 * supervisor that retries once a minute costs nothing and stays ready to
 * recover the moment the port frees, where launchd's 10s relaunch cost two
 * client builds and a 5,622-document hydration every time.
 */
export function bindRetryDelayMs(
  attempt: number,
  base: number = BIND_RETRY_BASE_MS,
  cap: number = BIND_RETRY_CAP_MS,
): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return Math.min(base, cap);
  // 2**(attempt-1) overflows to Infinity long before it matters; Math.min
  // still yields `cap`, so no guard is needed on the exponent itself.
  return Math.min(cap, base * 2 ** (attempt - 1));
}

/**
 * Walking to the next port is a DEV convenience — it keeps two agents on one
 * machine from fighting over 8787. Under launchd the port is part of the
 * contract: peers, the discovery file, the Cloudflare tunnel and the
 * supervisor's own bind-health watchdog all name it. A prod server that
 * quietly moved to 8788 is invisible to every one of them, and on 2026-08-29
 * that invisibility is what let the watchdog restart a perfectly healthy
 * server nine times in a row while its predecessors stayed alive.
 */
export function shouldWalkPorts(argv: readonly string[]): boolean {
  return !(argv.includes('--no-watch') || argv.includes('--no-port-walk'));
}

/**
 * Is this port free? Probed by doing exactly what the server does —
 * `Bun.serve` on the same port — because nothing weaker is trustworthy.
 *
 * The probe this replaces bound a `node:net` server to `127.0.0.1` and then
 * `::1`, and MEASURABLY CANNOT SEE a running `Bun.serve` on the same port:
 *
 *     holder bound via Bun.serve on 19811
 *     node bind 127.0.0.1 : BOUND (probe says free)
 *     node bind ::1       : BOUND (probe says free)
 *     node bind wildcard  : ERR EADDRINUSE
 *     Bun.serve probe     : ERR EADDRINUSE
 *
 * BSD `SO_REUSEADDR` semantics let a bind to a *more specific* address
 * succeed while a wildcard listener holds the port, so the old probe returned
 * "free" for a port that was very much taken. That is the second half of the
 * 2026-08-29 outage: the supervisor pre-flighted 8787, was told it was free,
 * handed 8787 to the child, and the child's real bind then hit EADDRINUSE and
 * walked to 8788 — where the supervisor's watchdog, still polling 8787, could
 * not find it. A probe that does not bind the way the server binds is not a
 * probe; it is a second opinion about a different question.
 */
export async function probeLocalPort(port: number): Promise<BindErrorKind | null> {
  try {
    const probe = Bun.serve({ port, fetch: () => new Response(null, { status: 404 }) });
    probe.stop(true);
    return null;
  } catch (err) {
    return classifyBindError(err);
  }
}

export interface AcquirePortOptions {
  port: number;
  /** Resolves `null` when the port took a listener, else why it did not. */
  probe: (port: number) => Promise<BindErrorKind | null>;
  sleep: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  /** Bound the loop in tests; production callers wait indefinitely. */
  maxAttempts?: number;
  base?: number;
  cap?: number;
}

export interface AcquirePortResult {
  /** 1 when the first probe succeeded — i.e. no waiting happened. */
  attempts: number;
  waitedMs: number;
}

/**
 * Wait for `port` to become bindable, in this process, without ever changing
 * the port. Throws on a `fatal` probe result, and on running out of
 * `maxAttempts`.
 */
export async function acquirePort(opts: AcquirePortOptions): Promise<AcquirePortResult> {
  const { port, probe, sleep, log = () => {}, maxAttempts = Number.POSITIVE_INFINITY } = opts;
  let waitedMs = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const kind = await probe(port);
    if (kind === null) return { attempts: attempt, waitedMs };
    if (kind === 'fatal') throw new Error(`cannot bind :${port}: unrecognised bind failure`);
    if (attempt >= maxAttempts) break;
    const delay = bindRetryDelayMs(attempt, opts.base, opts.cap);
    log(
      kind === 'in-use'
        ? `[supervisor] :${port} is held by another process — waiting ${Math.round(delay / 1000)}s ` +
            `for it (attempt ${attempt}); not walking to another port`
        : `[supervisor] cannot open a socket on :${port} (host resources, not the port) — ` +
            `retrying in ${Math.round(delay / 1000)}s (attempt ${attempt})`,
    );
    await sleep(delay);
    waitedMs += delay;
  }
  throw new Error(`gave up waiting for :${port} after ${maxAttempts} attempt(s)`);
}
