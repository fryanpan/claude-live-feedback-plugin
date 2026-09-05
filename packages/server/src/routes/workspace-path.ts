/**
 * How a canonical workspace path is read — one parser, so every route that
 * lives under `/workspaces/<workspaceId>/…` reads the id out of the same
 * place.
 *
 * The route inventory's shape is the Google API design guide's: a resource a
 * workspace owns is addressed under the workspace that owns it, so the
 * workspace id is a PATH SEGMENT rather than something the server looks up
 * from a doc, task or set id. That is what makes it possible for one guard to
 * answer the access question before a handler runs — the guard reads paths,
 * and a path that does not name its workspace has nothing for it to read.
 *
 * Two collections live at this shape today (the board's live event stream and
 * the agent roster), moved here because their old addresses collided with the
 * nouns the glossary reserves: `/events/workspace/<id>` sat beside the
 * activity feed's `events`, and the agent roster sat on `attachments`, which
 * the glossary spends on docs, mockups, previews and diffs. The rest of the
 * REST surface still addresses resources by their own id and resolves the
 * board behind the route; when it moves, it moves to this parser.
 *
 * `matchWorkspaceRoute` is deliberately dumb: it decodes the workspace
 * segment and hands back the remainder. It answers no question about whether
 * that workspace exists or whether the caller may reach it — the store
 * answers the first and `shareScopeAllows` the second, and folding either in
 * here would put two rules where the guard expects one.
 */

/** A canonical path's two halves: the board, and what under it was addressed. */
export interface WorkspaceRouteMatch {
  /** The decoded `<workspaceId>` segment. Never empty. */
  workspaceId: string;
  /** Everything after `/workspaces/<id>/`, undecoded, without a leading slash. */
  rest: string;
}

/**
 * Read `/workspaces/<workspaceId>/<rest>`, or `undefined` when the path is
 * not that shape.
 *
 * `sub`, when given, is the exact remainder this call is asking about — so a
 * caller writes the collection it serves rather than a regex, and a path that
 * names a different collection falls through to the next handler instead of
 * being half-claimed. Omit it to match any remainder.
 *
 * An empty workspace segment answers `undefined` rather than a match on the
 * empty string: `/workspaces//agents` names no board, and letting it through
 * would hand the store an id it can only fail on, one route further down.
 */
export function matchWorkspaceRoute(
  pathname: string,
  sub?: string,
): WorkspaceRouteMatch | undefined {
  const PREFIX = '/workspaces/';
  if (!pathname.startsWith(PREFIX)) return undefined;
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return undefined;
  const workspaceId = safeDecodeSegment(rest.slice(0, slash));
  if (workspaceId === '') return undefined;
  const tail = rest.slice(slash + 1);
  if (sub !== undefined && tail !== sub) return undefined;
  return { workspaceId, rest: tail };
}

/**
 * A path segment, decoded, answering itself rather than throwing on a stray
 * `%`. The same posture `middleware/host-guard.ts` takes on the same problem:
 * a malformed escape is a caller's typo, and a thrown `URIError` inside a
 * route match closes the connection with no response at all.
 */
function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
