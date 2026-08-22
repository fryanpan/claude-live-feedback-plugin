/**
 * gzip for JSON API replies.
 *
 * Measured 2026-08-21: `GET /api/docs` answered 4,205,683 bytes with no
 * `content-encoding`, even to a client sending `Accept-Encoding: gzip`. The
 * review sidebar hits that route on every doc open, over a tailnet, to pick
 * six rows out of four thousand — so the transfer was both the largest thing
 * the app fetches and the one nothing had ever looked at.
 *
 * This sits in the per-request wrapper next to CORS rather than at one route,
 * because the win is not specific to `/api/docs` and a per-route header is a
 * thing the next route forgets. What keeps that safe is the narrowness of the
 * gate below, and each clause of it is load-bearing:
 *
 *   • JSON only. `text/event-stream` is a LIVE stream — buffering it to
 *     compress it would hold every event until the stream closed, which is to
 *     say it would break the event channel. Static assets are served by
 *     `Bun.file` further down and are deliberately out of scope here.
 *   • Never over an existing `content-encoding`: a second encoding the header
 *     does not name is a body no client can read.
 *   • Only when the client asked, and only when it did not refuse (`q=0`).
 *   • Only above a threshold — under ~1 KB the gzip framing can make the
 *     response bigger, and the CPU is spent either way.
 *
 * `Vary: accept-encoding` goes on every compressible reply, compressed or not.
 * Without it a shared cache can hand a stored gzip body to a client that never
 * asked for one (or the reverse), which is a corruption that only shows up
 * behind a proxy — and this server runs behind Cloudflare on the share host.
 */

/** Below this, gzip framing costs more than it saves. */
export const COMPRESS_MIN_BYTES = 1024;

/** Content types worth compressing. Deliberately a short allowlist rather than
 *  a `text/*` sweep, so a streaming body can never fall into it by default. */
const COMPRESSIBLE = /^application\/json\b/i;

/**
 * Whether the client both advertises gzip and has not refused it.
 *
 * Parsed rather than substring-matched: `gzip;q=0` means "not this one", and a
 * client that says so and gets gzip anyway cannot read the reply. `*` counts
 * as consent under the same q rule.
 */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [rawToken, ...params] = part.split(';');
    const token = rawToken?.trim().toLowerCase();
    if (token !== 'gzip' && token !== '*') continue;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith('q='))
      ?.slice(2);
    if (q !== undefined && Number.parseFloat(q) === 0) continue;
    return true;
  }
  return false;
}

/**
 * gzip `res` when the request and the response both allow it; otherwise return
 * `res` unchanged (or, for a compressible body the client did not want
 * encoded, the same bytes plus the `Vary` header a cache needs).
 */
export async function maybeCompress(req: Request, res: Response): Promise<Response> {
  if (res.body === null) return res;
  if (res.headers.get('content-encoding')) return res;
  if (!COMPRESSIBLE.test(res.headers.get('content-type') ?? '')) return res;

  const headers = new Headers(res.headers);
  headers.set('vary', 'accept-encoding');
  // The body is about to be re-framed either way, so any length the route set
  // by hand is stale; letting Response compute it is the only way it stays
  // true for both branches below.
  headers.delete('content-length');

  const bytes = new Uint8Array(await res.arrayBuffer());
  const rewrap = (body: Uint8Array, extra?: [string, string]) => {
    if (extra) headers.set(extra[0], extra[1]);
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  };
  if (!acceptsGzip(req.headers.get('accept-encoding'))) return rewrap(bytes);
  if (bytes.byteLength < COMPRESS_MIN_BYTES) return rewrap(bytes);
  return rewrap(Bun.gzipSync(bytes), ['content-encoding', 'gzip']);
}
