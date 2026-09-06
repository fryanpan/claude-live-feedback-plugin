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
 * and `/api/docs/<id>` named a member and left the server to find its board,
 * so "a doc on somebody else's board" was not a shape a request could even
 * have. Now that the board is in the path, `/workspaces/<A>/docs/<doc-on-B>`
 * IS a shape a request can have, and it has to be refused in one place rather
 * than in each handler that remembers to.
 *
 * HOW A ROUTE INHERITS THE ANSWER. The scope this returns travels on every
 * resource route's request, and those routes match against `scope.rest`
 * through `matchRest` rather than against the raw pathname. So a handler
 * reached without a resolved scope has no remainder to match and cannot
 * answer at all: "the workspace was checked" is not a step each route
 * remembers, it is the condition of the route existing. That is the half of
 * criterion 2 a deletion of the old per-handler checks does not by itself
 * buy — deleting them stops the second copy, and this stops the third from
 * being written.
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

/**
 * The board a request is on, and what under it was addressed.
 *
 * `board` carries the RECORD, not just the fact that one exists, and that is
 * what lets the per-route existence checks be deleted instead of left
 * dormant. Nine handlers opened with `taskStore.getWorkspace(id)` followed by
 * a 404 — a second copy of this file's first question — and most of them then
 * used the record they had just fetched. Answering with the record means the
 * handler has what it needed WITHOUT asking again, so there is nothing left
 * to leave behind: no lookup, no 404, no `if (!workspace)` that can never
 * fire.
 *
 * Generic in the board's type because this module knows nothing about the
 * store — `createServer` supplies the reader and the type travels with it.
 */
export interface WorkspaceScope<TBoard = unknown> {
  /** The decoded `<workspaceId>` segment. The board is known to exist. */
  workspaceId: string;
  /** Everything after `/workspaces/<id>/`, without a leading slash. Empty
   *  string when the path addressed the board itself. */
  rest: string;
  /** The board record the resolver read. Present by construction: a request
   *  whose board did not resolve was refused and never became a scope. */
  board: TBoard;
}

/**
 * What the middleware decided.
 *
 * A union rather than a nullable scope plus a nullable response, because
 * those two can both be set and there is no sensible reading of that. A
 * refusal carries the response and no scope, so nothing downstream can act on
 * a board this call has just refused.
 */
export type WorkspaceScopeResult<TBoard = unknown> =
  | { kind: 'pass' }
  | { kind: 'scope'; scope: WorkspaceScope<TBoard> }
  | { kind: 'refused'; response: Response };

/** What the resolver reads. Injected rather than imported so the rule is
 *  testable without a server. */
export interface WorkspaceScopeDeps<TBoard = unknown> {
  /**
   * The board record, or `undefined` when no board answers to this id.
   *
   * The RECORD rather than a boolean, so the handlers below inherit it. See
   * `WorkspaceScope.board`.
   */
  workspaceRecord: (workspaceId: string) => TBoard | undefined;
  /**
   * Which boards hold this member, addressed through this collection — empty
   * when none does.
   *
   * A SET, not one answer, and that is not defensive typing: an attachment is
   * LINKED to a board rather than filed in one, so a doc genuinely lives on
   * two boards at once (its review, and the board that review is filed on).
   * `shareScopeAllows` learned this the expensive way — an exact
   * `=== workspaceOf(id)` refused a board visitor every review row on their
   * own board — and this is the same question, so it gets the same shape.
   *
   * The COLLECTION is a parameter because the id space is not one space: a
   * goal band and a task body are `task:<id>`, a doc and a review are their
   * own ids, and a review item is addressed through the task that carries it.
   * Passing the collection means the server maps each to its store once,
   * here, instead of the middleware guessing from the shape of an id.
   */
  workspacesOfMember: (collection: string, memberId: string) => readonly string[];
  /** JSON response helper. */
  j: (status: number, body: unknown) => Response;
  /**
   * The refusal to send a BROWSER — a board's HTML pages go through this
   * resolver too, and answering one with a JSON body puts `{"error":…}` in a
   * tab. Optional: a caller with no page surface (the unit tests, and any
   * future embedder) falls back to `j`, which is the right answer when there
   * is no page to render.
   */
  notFoundPage?: () => Response;
}

/**
 * Every collection whose next path segment names a MEMBER this board must
 * own, and — per collection — the words that sit where a member id goes and
 * are verbs instead.
 *
 * Listing them is the point: a collection absent from this map has its ids
 * checked by NOTHING, so adding one is a decision rather than something that
 * happens by forgetting. The table is what makes criterion 3 provable — the
 * foreign-workspace test walks this map, so a collection added here without a
 * membership answer fails the test, and a collection added to the router
 * without being added here is what the test's own completeness check catches.
 *
 * WHY THE VERB LIST, rather than the old "three segments means a row" rule.
 * That rule read the segment after the collection as an id only when
 * something followed it, which was right for `goals` — `goals/add`,
 * `goals/rename` and `goals/reorder` are verbs sitting exactly where a band
 * id goes, and looking `rename` up as a band would refuse every one of them.
 * It is WRONG for every collection that addresses a member with two segments
 * and no verb after it: `docs/<docId>?format=json` is a doc read, and under
 * that rule it was checked by nothing at all, so a foreign doc id spelled
 * behind your own board's prefix answered with the doc. Naming the verbs
 * instead inverts the default — an unknown word at the id slot is an ID, and
 * therefore checked.
 */
export const SCOPED_COLLECTIONS: Readonly<Record<string, readonly string[]>> = {
  /** `add`, `rename` and `reorder` are band verbs, not band ids. */
  goals: ['add', 'rename', 'reorder'],
  /** `batch` files many rows at once; every other word is a task id. */
  tasks: ['batch'],
  /** A doc, a mockup and a review are addressed by their own id throughout —
   *  no verb has ever sat at that slot, and one added later must be named
   *  here before it can work. */
  docs: [],
  mockups: [],
  reviews: [],
  /** One filed ask, read by its own id. */
  'review-items': [],
  /** One builder dispatch, closed by its own id. */
  dispatches: [],
};

/**
 * Resolve the board a `/workspaces/<id>/…` request is on, or refuse it.
 *
 * `pass` means this path is not the middleware's business — either it is not
 * under `/workspaces/` at all, or it is one of the board's HTML pages.
 */
export function resolveWorkspaceScope<TBoard>(
  deps: WorkspaceScopeDeps<TBoard>,
  rq: { pathname: string; method: string; url: URL },
): WorkspaceScopeResult<TBoard> {
  const { pathname, method, url } = rq;
  const match = matchWorkspaceRoute(pathname);
  if (!match) return { kind: 'pass' };
  const { workspaceId, rest } = match;
  /**
   * A page is CHECKED and then passed, not passed unchecked.
   *
   * It reads as a detail and is the difference between one access rule and
   * two. `/workspaces/<ws>/docs/<id>` is one address with two renderings —
   * the editor shell, and the same thing with `?format=json` — and while the
   * page skipped this resolver entirely, spelling any board id in front of
   * anybody's doc id served the shell with a 200. Nothing leaked (the shell
   * carries no content, and the data fetch behind it was refused), but the
   * product then showed a reviewer a page that could not load, and the rule
   * "one middleware decides" was false for the surface people actually open.
   *
   * So the checks below run for a page too, and only the SHAPE of the answer
   * differs: `pass` hands the request to the shell with the board and the
   * member both confirmed, and a refusal renders as a page rather than JSON.
   */
  const page = isBoardPageRequest(method, rest, url);
  const refuse = (status: number, body: unknown): WorkspaceScopeResult<TBoard> => ({
    kind: 'refused',
    response: page && deps.notFoundPage ? deps.notFoundPage() : deps.j(status, body),
  });

  const board = deps.workspaceRecord(workspaceId);
  if (board === undefined) {
    return refuse(404, { error: 'workspace not found' });
  }

  // The member half. `<collection>/<memberId>[/<verb>…]` must name something
  // this board holds — see the header for why a foreign member answers the
  // same 404 an unknown board does.
  //
  // ONE lookup for every collection in the table, which is the whole of what
  // the cutover bought: `workspaceOfDoc(...)` at the top of a handler, and
  // the store lookup that asked which board holds this row, were each a
  // second copy of this rule.
  const member = memberAddressed(rest);
  if (member) {
    const owners = deps.workspacesOfMember(member.collection, member.memberId);
    // `Array.isArray` for the reason `shareScopeAllows` gives at its own use
    // of the same shape: a resolver still handing back a bare string also
    // answers `.includes`, and would then grant on any SUBSTRING match.
    // Refusing a non-array can only close, never open.
    if (!Array.isArray(owners) || !owners.includes(workspaceId)) {
      return refuse(404, { error: 'not-found' });
    }
  }

  // Checked, then handed on: the page surface serves it, and no route below
  // will claim it because `pass` leaves no scope for `matchRest` to match.
  if (page) return { kind: 'pass' };

  return { kind: 'scope', scope: { workspaceId, rest, board } };
}

/** What a canonical remainder addressed, when it addressed one member of a
 *  scoped collection — `undefined` for a collection root, a collection verb,
 *  or a collection nothing checks. */
function memberAddressed(rest: string): { collection: string; memberId: string } | undefined {
  const cut = rest.indexOf('/');
  if (cut <= 0) return undefined;
  const collection = rest.slice(0, cut);
  const verbs = Object.hasOwn(SCOPED_COLLECTIONS, collection)
    ? SCOPED_COLLECTIONS[collection]
    : undefined;
  if (!verbs) return undefined;
  const tail = rest.slice(cut + 1);
  const idEnd = tail.indexOf('/');
  const raw = idEnd === -1 ? tail : tail.slice(0, idEnd);
  if (raw === '') return undefined;
  // A collection verb standing where an id goes. Compared BEFORE decoding, so
  // `%61dd` is an id and not a second spelling of `add` — a verb is a literal
  // this server writes, and every caller that means it types it.
  if (verbs.includes(raw)) return undefined;
  return { collection, memberId: decodeSegment(raw) };
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

/**
 * Match a route pattern against the remainder of a canonical path — the ONE
 * way a resource route says which address it serves.
 *
 * Every route under `/workspaces/<id>/…` matches through this rather than
 * against the raw pathname, and that is a structural claim, not a style: a
 * handler reached with no scope has no `rest` to match, so it cannot answer.
 * The workspace check is therefore not something each route remembers to do —
 * it is the thing that makes the route reachable at all. A route that went
 * back to reading `pathname` would be answering before the middleware ran,
 * and that is the failure this whole shape exists to make impossible.
 *
 * Patterns are anchored against the remainder WITHOUT a leading slash:
 * `/^tasks\/([^/]+)\/after$/`. Capture indices are the resource's own, in the
 * order the path spells them — the workspace is not a capture group here
 * because it is not this pattern's business; it arrived resolved.
 *
 * Answers `null` rather than `undefined` for a miss, matching
 * `String.prototype.match`, so a call site reads the same as the
 * `pathname.match(...)` it replaced.
 */
export function matchRest(
  scope: WorkspaceScope<unknown> | undefined,
  pattern: RegExp,
): RegExpMatchArray | null {
  return scope ? scope.rest.match(pattern) : null;
}

/**
 * Does this canonical path address exactly this collection or verb?
 *
 * The equality twin of `matchRest`, for the routes that were
 * `pathname === '/api/docs'` — same rule, same reason: no scope, no match.
 */
export function restIs(
  scope: WorkspaceScope<unknown> | undefined,
  sub: string,
): scope is WorkspaceScope<unknown> {
  return scope !== undefined && scope.rest === sub;
}
