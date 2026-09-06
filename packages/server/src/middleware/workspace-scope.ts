/**
 * The one place a canonical `/workspaces/<id>/…` request learns which board
 * it is on, and whether that board will have it.
 *
 * WHY THIS EXISTS. The route inventory's shape is the Google API design
 * guide's: a resource a workspace owns is addressed under the workspace that
 * owns it. The point of putting the id in the PATH is not tidiness — it is
 * that the access question can then be answered ONCE, before any handler
 * runs, by something that reads paths. Every route that resolved its own
 * board (`taskStore.getWorkspace(...)` at the top of a handler, or a store
 * lookup that asked which board holds this row) was a second copy of that
 * rule, and a second copy is a rule that drifts.
 *
 * WHAT IT ANSWERS, and what it deliberately does not. It answers two
 * questions:
 *
 *   1. Does the board named in the path exist?
 *   2. Does the resource named under it actually belong to that board?
 *
 * It does NOT answer whether this caller may reach the board. That question
 * already has one owner — `shareScopeAllows` in `middleware/host-guard.ts`,
 * which runs above every route in the chain and judges the path by the share
 * the visitor holds. Answering it a second time here would be the exact
 * duplication this file exists to remove, and the copy that drifts open is a
 * breach. So membership is enforced upstream by host-guard; what this adds is
 * the half host-guard cannot see, which is whether the ids in the path agree
 * with each other.
 *
 * Question 2 is the one that used to have no owner at all. `/api/goals/<id>`
 * named a row and left the server to find its board, so "a goal on somebody
 * else's board" was not a shape a request could even have. Now that the board
 * is in the path, `/workspaces/<A>/goals/<goal-on-B>` IS a shape a request can
 * have, and it has to be refused in one place rather than in each handler that
 * remembers to.
 *
 * WHAT IT REFUSES WITH. 404, not 403, and the same body for a board that does
 * not exist and a row filed elsewhere. A 403 on a foreign id confirms the id
 * is real to someone who guessed it; the two answers are deliberately
 * indistinguishable.
 *
 * HTML PAGES ARE NOT ITS BUSINESS. `/workspaces/<id>` and its tabs, and
 * `docs|mockups|reviews/<id>`, are browser addresses served at the tail of the
 * chain by `routes/shell-static.ts`, which renders its own HTML not-found for
 * an unknown board. Claiming those here would answer a browser with a JSON
 * body. `isBoardPageRequest` is the single list both sides read — see
 * `workspace-path.ts` for why it is one list and not two.
 *
 * NEITHER IS THE BOARD ITSELF. `/workspaces/<id>` with nothing under it — the
 * board record and the board delete — is left to its own routes, because that
 * one path fronts TWO stores: the id is a board's, or an attachment set's,
 * dispatched by which store knows it. An existence check here would have to
 * ask both, and asking the doc store means scanning every doc on every
 * request. The routes that already dispatch by id keep doing it.
 *
 * ONE COLLECTION BYPASSES THIS ENTIRELY, and it is the exception rather than
 * an oversight: `/workspaces/<id>/events:stream` is served ABOVE this
 * middleware, in `routes/upgrade-stream.ts`, because an SSE open is taken
 * over rather than answered and every gate a long-lived connection has must
 * be decided at its handshake. So it keeps an existence check of its own —
 * and that check asks a WIDER question than this file's: a stream exists for
 * a board OR for any attachment set with a member doc, because task events
 * and a review's thread events broadcast on the same `ws~<id>` channel. This
 * one does not, which is correct for both and is why neither can be deleted
 * in favour of the other.
 *
 * The cost of an exception is that it is the one route this file's own test
 * would never exercise, so the collections table in
 * `test/workspace-scope.test.ts` lists `events:stream` on purpose — the route
 * that bypasses the middleware is the route most worth probing, and a table
 * that skipped it would be silent about exactly the path nothing else covers.
 */
import { isBoardPageRequest, matchWorkspaceRoute } from '../workspace-path.ts';

/** The board a request is on, and what under it was addressed. */
export interface WorkspaceScope {
  /** The decoded `<workspaceId>` segment. The board is known to exist. */
  workspaceId: string;
  /** Everything after `/workspaces/<id>/`, without a leading slash. Empty
   *  string when the path addressed the board itself. */
  rest: string;
}

/**
 * What the middleware decided.
 *
 * A union rather than a nullable scope plus a nullable response, because
 * those two can both be set and there is no sensible reading of that. A
 * refusal carries the response and no scope, so nothing downstream can act on
 * a board this call has just refused.
 */
export type WorkspaceScopeResult =
  | { kind: 'pass' }
  | { kind: 'scope'; scope: WorkspaceScope }
  | { kind: 'refused'; response: Response };

/** What the resolver reads. Injected rather than imported so the rule is
 *  testable without a server. */
export interface WorkspaceScopeDeps {
  /** Does this board exist? */
  workspaceExists: (workspaceId: string) => boolean;
  /**
   * Which board holds this ROW — a goal or a task — or undefined when none
   * does.
   *
   * A row lives in the same `task:<id>` id space whether it is a goal band or
   * a task, which is why one lookup covers both collections.
   */
  workspaceOfRow: (rowId: string) => string | undefined;
  /** JSON response helper. */
  j: (status: number, body: unknown) => Response;
}

/**
 * The collections whose second path segment names a ROW this board must own.
 *
 * `goals/<goalId>/<verb>` is the one that moved onto this shape here; `tasks`
 * joins it when the task collection moves. Listing them is the point: a
 * collection absent from this map has its ids checked by nothing, so adding
 * one is a decision rather than something that happens by forgetting.
 */
const ROW_COLLECTIONS: readonly string[] = ['goals'];

/**
 * Resolve the board a `/workspaces/<id>/…` request is on, or refuse it.
 *
 * `pass` means this path is not the middleware's business — either it is not
 * under `/workspaces/` at all, or it is one of the board's HTML pages.
 */
export function resolveWorkspaceScope(
  deps: WorkspaceScopeDeps,
  rq: { pathname: string; method: string; url: URL },
): WorkspaceScopeResult {
  const { pathname, method, url } = rq;
  const match = matchWorkspaceRoute(pathname);
  if (!match) return { kind: 'pass' };
  const { workspaceId, rest } = match;
  if (isBoardPageRequest(method, rest, url)) return { kind: 'pass' };

  if (!deps.workspaceExists(workspaceId)) {
    return { kind: 'refused', response: deps.j(404, { error: 'workspace not found' }) };
  }

  // The row half. `goals/<goalId>/<verb>` must name a band this board holds —
  // see the header for why a foreign row answers the same 404 an unknown
  // board does.
  //
  // THREE SEGMENTS, not two, and that is what tells a row apart from a verb.
  // The goal collection carries custom verbs sitting exactly where an id goes
  // — `goals/add`, `goals/rename`, `goals/reorder` — so a rule keyed on "the
  // segment after the collection" would look `rename` up as a band and refuse
  // every one of them. A row is addressed only when something follows its id.
  const cut = rest.indexOf('/');
  if (cut !== -1 && ROW_COLLECTIONS.includes(rest.slice(0, cut))) {
    const tail = rest.slice(cut + 1);
    const idEnd = tail.indexOf('/');
    if (idEnd > 0) {
      const rowId = decodeSegment(tail.slice(0, idEnd));
      // Unknown and foreign answer the same way, and this is the lookup the
      // move exists to delete from the handlers: the board a row belongs to
      // is asked once, here, rather than at the top of each verb.
      if (deps.workspaceOfRow(rowId) !== workspaceId) {
        return { kind: 'refused', response: deps.j(404, { error: 'not-found' }) };
      }
    }
  }

  return { kind: 'scope', scope: { workspaceId, rest } };
}

/** A path segment, decoded, answering itself rather than throwing on a stray
 *  `%` — the same posture `workspace-path.ts` takes on the same
 *  problem, and for the same reason: a malformed escape is a caller's typo,
 *  and a `URIError` thrown inside a route match closes the connection with no
 *  response at all. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
