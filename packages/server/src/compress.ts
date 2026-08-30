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
 *   • Finite bodies only. `text/event-stream` is a LIVE stream — buffering it
 *     to compress it would hold every event until the stream closed, which is
 *     to say it would break the event channel. The list below therefore names
 *     types rather than sweeping `text/*`, and adding one to it is a claim
 *     that bodies of that type END.
 *
 *     This read "JSON only" until 2026-08-25, on the reasoning that static
 *     assets were out of scope. They were the largest thing the server sent:
 *     the board shell is ~1 KB of HTML that then pulls its stylesheet, its
 *     app bundle and the widget — together over half a megabyte, going out
 *     raw. That is invisible next to the server and dominates the load over
 *     a slow link, which is where the board is actually read. css/js/svg/html
 *     are all finite, and the only streaming body this server has is SSE.
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
const COMPRESSIBLE =
  /^(?:application\/json|application\/javascript|application\/manifest\+json|text\/css|text\/html|text\/javascript|image\/svg\+xml)\b/i;

/** Exported for the test that pins `text/event-stream` OUT of the list. The
 *  gate's value is entirely in what it excludes, and nothing else can observe
 *  that without sending a live stream through the whole server. */
export const COMPRESSIBLE_FOR_TEST = COMPRESSIBLE;

/**
 * Marks the gzipped representation of a body so it cannot collide with the
 * identity one.
 *
 * An `ETag` names a REPRESENTATION, not a file, so the compressed and plain
 * forms of one asset must not share a tag: a cache holding one of them would
 * otherwise satisfy a request for the other. `Vary: accept-encoding` already
 * keeps a well-behaved shared cache honest, but the tag is what an end client
 * echoes back on revalidation, and it costs one suffix to make it unambiguous.
 */
const GZIP_ETAG_SUFFIX = '-gz';

/** Add the gzip marker to an etag, preserving its quoting. */
export function gzipEtag(etag: string): string {
  return etag.endsWith('"') ? `${etag.slice(0, -1)}${GZIP_ETAG_SUFFIX}"` : etag + GZIP_ETAG_SUFFIX;
}

/** Strip the gzip marker, so a revalidation can be compared against the one
 *  tag the route computed regardless of which representation the client holds. */
export function baseEtag(etag: string): string {
  const inner = etag.endsWith('"') ? etag.slice(0, -1) : etag;
  if (!inner.endsWith(GZIP_ETAG_SUFFIX)) return etag;
  const stripped = inner.slice(0, -GZIP_ETAG_SUFFIX.length);
  return etag.endsWith('"') ? `${stripped}"` : stripped;
}

/**
 * Turn a fresh 200 into a 304 when the client already holds this exact body.
 *
 * Sits in the per-request wrapper rather than in the static route, because it
 * needs the REQUEST and every route that sets an `etag` should get this for
 * free — a conditional-request check that lives in one route is one the next
 * route forgets. A response with no `etag` is passed through untouched, so
 * this is inert for everything that has not opted in by setting one.
 *
 * Runs BEFORE compression: gzipping a body that is about to be dropped is the
 * one case where the CPU buys nothing at all.
 */
export function maybeNotModified(req: Request, res: Response): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res;
  if (res.status !== 200) return res;
  const etag = res.headers.get('etag');
  if (!etag) return res;

  const header = req.headers.get('if-none-match');
  if (!header) return res;
  // `If-None-Match` is a list, and `*` matches any existing representation.
  const matched = header
    .split(',')
    .map((t) => t.trim())
    .some((t) => t === '*' || baseEtag(t) === baseEtag(etag));
  if (!matched) return res;

  // A 304 carries the validators and nothing else; a body here would be a
  // protocol error, and `maybeCompress` leaves it alone because it has none.
  const headers = new Headers();
  for (const k of ['etag', 'cache-control', 'vary', 'content-type']) {
    const v = res.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new Response(null, { status: 304, headers });
}

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
  // by hand is stale. `rewrap` restates it from the bytes it actually sends —
  // true for both branches by construction — so the `[timing]` line in the
  // request wrapper can name the body size without consuming the body.
  headers.delete('content-length');

  const bytes = new Uint8Array(await res.arrayBuffer());
  const rewrap = (body: Uint8Array<ArrayBuffer>, extra?: [string, string]) => {
    if (extra) headers.set(extra[0], extra[1]);
    headers.set('content-length', String(body.byteLength));
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  };
  if (!acceptsGzip(req.headers.get('accept-encoding'))) return rewrap(bytes);
  if (bytes.byteLength < COMPRESS_MIN_BYTES) return rewrap(bytes);
  // The gzipped body is a different representation of the same resource, so
  // it must not answer to the identity tag (see GZIP_ETAG_SUFFIX).
  const tag = headers.get('etag');
  if (tag) headers.set('etag', gzipEtag(tag));
  // Re-viewed rather than passed straight through: `gzipSync` types its result
  // over `ArrayBufferLike`, which a Response body cannot be (it could be
  // shared). The copy is of the COMPRESSED bytes, so it is the small one.
  return rewrap(new Uint8Array(Bun.gzipSync(bytes)), ['content-encoding', 'gzip']);
}
