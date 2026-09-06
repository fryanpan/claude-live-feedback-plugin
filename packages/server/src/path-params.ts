/**
 * ── Path parameters: one decoder, applied at the front door ──
 *
 * `decodeURIComponent` throws a `URIError` on a stray `%`, and the throw
 * happens wherever a route pulls its id out of the path — deep inside a
 * matcher, long after the request was accepted. Bun answers that with a 500,
 * which tells the caller nothing about the typo they actually made.
 *
 * Two shapes were measured answering 500 on `a%zzb` before this existed:
 * the board page (`routes/shell-static.ts`) and one prompt
 * (`routes/prompts.ts`). Neither is special — they are simply the two that
 * decode a segment directly rather than through a guarded matcher.
 *
 * The guard therefore sits at the front door rather than in each route. A
 * per-route check is only as good as the routes somebody remembered to
 * change, and this server has 95 direct `decodeURIComponent` calls; a single
 * check ahead of all of them cannot be forgotten by the next route added.
 */

/**
 * The first path segment that cannot be percent-decoded, or `undefined` when
 * every segment decodes.
 *
 * Returns the offending segment rather than a boolean so the caller can say
 * which part of the address was wrong without re-scanning it. The `%` test is
 * a fast path: a segment with no `%` in it cannot carry a bad escape, and
 * almost no real request has one.
 */
export function malformedPathSegment(pathname: string): string | undefined {
  for (const segment of pathname.split('/')) {
    if (!segment.includes('%')) continue;
    try {
      decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }
  return undefined;
}

/**
 * One path parameter, decoded, or `undefined` when the escape is malformed.
 *
 * Routes reached through the front-door guard cannot receive a malformed
 * segment, so this is for callers that decode a value the guard never saw —
 * a query parameter, or a segment read back out of stored content.
 */
export function decodePathParam(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
