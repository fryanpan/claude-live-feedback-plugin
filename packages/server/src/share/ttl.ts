/**
 * The TTL a share request asks for, resolved into the seconds it gets.
 *
 * Two spellings reach the routes: `ttlSeconds` (a number — what the MCP
 * schema has always advertised and what `set_share_ttl` takes) and `ttl`
 * (a duration string, `'15m'`). Both feed one resolver so a request that
 * is wrong in either spelling is refused the same way, and so the
 * configured ceiling applies to a fresh mint and to an extension alike —
 * a max that only the mint route honoured would be one `set_share_ttl`
 * away from meaningless.
 *
 * The grammar is deliberately small: an integer and one unit letter. No
 * decimals, no spaces, no compound `1h30m`, no upper case. A caller who
 * wants something the grammar cannot say has `ttlSeconds`.
 */

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

/** The one-line grammar reminder every `bad_ttl` reply carries. */
export const TTL_FORMAT_HINT =
  "ttl is an integer plus a unit: '15m', '2h', '3d', '1w' (or pass ttlSeconds as a number)";

/** `'15m'` → 900. `null` for anything outside the grammar. */
export function parseTtl(input: string): number | null {
  const m = /^(\d+)([smhdw])$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * (UNIT_SECONDS[m[2] as string] as number);
}

export interface TtlClamp {
  requestedSeconds: number;
  appliedSeconds: number;
  maxSeconds: number;
}

export type TtlResolution =
  | { ok: true; seconds: number; clamped?: TtlClamp }
  | { ok: false; error: 'bad_ttl'; hint: string };

export interface ResolveTtlArgs {
  /** Raw body field — unknown type on purpose; this is where it is checked. */
  ttl?: unknown;
  /** Raw body field, same. */
  ttlSeconds?: unknown;
  /** Applied when neither spelling is present. */
  defaultSeconds: number;
  /** Ceiling from ShareConfig. Absent = no ceiling. */
  maxSeconds?: number;
}

/**
 * Refuses rather than defaults: a `ttl` the grammar cannot read, a
 * `ttlSeconds` that is not a finite number, both spellings at once, or a
 * value of zero or less all come back `bad_ttl`. The old route treated a
 * non-number `ttlSeconds` as absent and minted the default — a two-week
 * share answering a request for fifteen minutes.
 */
export function resolveTtl(args: ResolveTtlArgs): TtlResolution {
  const hasTtl = args.ttl !== undefined;
  const hasSeconds = args.ttlSeconds !== undefined;
  if (hasTtl && hasSeconds) {
    return {
      ok: false,
      error: 'bad_ttl',
      hint: `pass ttl or ttlSeconds, not both — ${TTL_FORMAT_HINT}`,
    };
  }
  let requested: number;
  if (hasTtl) {
    const parsed = typeof args.ttl === 'string' ? parseTtl(args.ttl) : null;
    if (parsed === null) {
      return {
        ok: false,
        error: 'bad_ttl',
        hint: `could not read ttl ${JSON.stringify(args.ttl)} — ${TTL_FORMAT_HINT}`,
      };
    }
    requested = parsed;
  } else if (hasSeconds) {
    if (typeof args.ttlSeconds !== 'number' || !Number.isFinite(args.ttlSeconds)) {
      return {
        ok: false,
        error: 'bad_ttl',
        hint: `ttlSeconds must be a finite number, got ${JSON.stringify(args.ttlSeconds)} — ${TTL_FORMAT_HINT}`,
      };
    }
    requested = args.ttlSeconds;
  } else {
    requested = args.defaultSeconds;
  }
  if (requested <= 0) {
    return {
      ok: false,
      error: 'bad_ttl',
      hint: `a share needs a positive ttl, got ${requested}s — ${TTL_FORMAT_HINT}`,
    };
  }
  if (args.maxSeconds !== undefined && requested > args.maxSeconds) {
    return {
      ok: true,
      seconds: args.maxSeconds,
      clamped: {
        requestedSeconds: requested,
        appliedSeconds: args.maxSeconds,
        maxSeconds: args.maxSeconds,
      },
    };
  }
  return { ok: true, seconds: requested };
}
