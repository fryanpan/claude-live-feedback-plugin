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
 *
 * EXPORTED because a route that reads its own segments has the same problem
 * and no way to inherit the answer. `matchWorkspaceRoute` protects only the
 * workspace segment; a handler that then pulls an agent id or a queue entry
 * id out of the remainder with a bare `decodeURIComponent` is one `%` away
 * from a closed socket — neither an allow nor a deny, chosen by the caller.
 * `routes/workspace-attachments.ts` is where that was true.
 */
export function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The board's five HTML pages, by the remainder that addresses them:
 * `/workspaces/<id>` itself and its four named tabs.
 *
 * A named list rather than a depth rule, for the reason the share guard
 * spells out at the same shape: a rule like "one segment is a page" would
 * make every collection added later a page too, so adding one would be an
 * accident rather than a decision.
 */
const BOARD_PAGE_TABS: readonly string[] = ['', 'home', 'tasks', 'mine', 'activity'];

/**
 * `/workspaces/<id>` and its four named tabs, as the matcher that SERVES
 * them — built from the list above rather than written out beside it.
 *
 * The empty entry is the bare board path, which is why the suffix group is
 * optional; every other entry becomes one arm of the alternation. Building
 * it means the page list is one list in fact and not merely in intent: a tab
 * added to the array is served and is passed over by the scope middleware in
 * the same edit, and there is no second spelling to forget. The two used to
 * be a literal regex here and a literal array there, and the cost of them
 * disagreeing is invisible from the client — a suffix the shell does not
 * match 404s a link the product itself handed out, and a suffix the
 * middleware does not recognise answers a browser with a JSON body.
 */
export const BOARD_PAGE_PATH = new RegExp(
  `^/workspaces/([^/]+?)(?:/(?:${BOARD_PAGE_TABS.filter((t) => t !== '').join('|')}))?$`,
);

/**
 * The three resources a board addresses a PAGE for: `docs/<id>`,
 * `mockups/<id>` and `reviews/<id>`.
 */
const BOARD_PAGE_RESOURCES: readonly string[] = ['docs', 'mockups', 'reviews'];

/**
 * `/workspaces/<id>/<kind>/<resourceId>`, as the matcher that serves it.
 * Same reason as `BOARD_PAGE_PATH`: one list, two readers.
 */
export const BOARD_PAGE_RESOURCE_PATH = new RegExp(
  `^/workspaces/([^/]+)/(${BOARD_PAGE_RESOURCES.join('|')})/([^/]+)$`,
);

/**
 * Is this request asking for one of the board's HTML pages?
 *
 * ONE list, read by both the thing that serves those pages
 * (`routes/shell-static.ts`, through the two exported matchers above) and
 * the thing that must not claim them (`middleware/workspace-scope.ts`,
 * through this predicate). Two lists would agree on the day they were
 * written and drift after, and the drift is silent either way round: a page
 * claimed by the API surface answers JSON to a browser, and a collection
 * mistaken for a page falls through to an HTML shell.
 *
 * `?format=json` is what makes the three merged addresses — the board
 * record, its Home brief and its task list — answer data instead of a page.
 * That is the whole of the "no `/api` prefix" decision: one path, HTML by
 * default, JSON on request. It is read here rather than at each route so the
 * two surfaces cannot disagree about which one a query string asked for.
 */
export function isBoardPageRequest(method: string, rest: string, url: URL): boolean {
  if (method !== 'GET') return false;
  if (wantsJson(url)) return false;
  if (BOARD_PAGE_TABS.includes(rest)) return true;
  const cut = rest.indexOf('/');
  if (cut === -1) return false;
  const kind = rest.slice(0, cut);
  const id = rest.slice(cut + 1);
  return !id.includes('/') && id !== '' && BOARD_PAGE_RESOURCES.includes(kind);
}

/**
 * Did this caller ask for the JSON twin of a path that also serves a page?
 *
 * Exact `json` rather than "any value present": a caller that sends
 * `?format=` or `?format=html` is asking for the page, and reading a
 * truthy-ish presence as data would answer a browser with a JSON body it
 * cannot render.
 */
export function wantsJson(url: URL): boolean {
  return url.searchParams.get('format') === 'json';
}
