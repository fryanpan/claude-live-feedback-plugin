/**
 * Sign in before you write.
 *
 * `CW_REQUIRE_EMAIL_AUTH` governs what a session MEANS — with it on, the
 * server's verdict about who you are outranks the name your request claimed.
 * It has never governed whether you need one. Every refusal the auth work
 * shipped sits on the sign-in routes themselves, so an ordinary write — a
 * comment, a task edit, a doc edit — has always been accepted from a browser
 * that presented nothing at all, attributed to whatever name it typed.
 *
 * This module is the missing half: the predicate that says a particular
 * request is an ordinary write from a browser that has proven nothing, and
 * must be refused with instructions rather than accepted with a guess.
 *
 * Three deliberate boundaries.
 *
 * 1. **Reads are never gated.** GET and HEAD pass whatever the flag says.
 *    Everyone who can reach this server can read it; that is the product.
 *    A handful of routes are POSTs only because a batch of inputs does not
 *    fit in a query string; `READ_SHAPED_POSTS` names them, and they pass
 *    too.
 *
 * 2. **Agents are not browsers.** An MCP tool, a curl, a webhook and the
 *    plugin's own hooks write over loopback or the tailnet with no session
 *    and no way to get one — a gate that caught them would take every agent
 *    offline the moment it was switched on. The line between them and a
 *    browser is `isBrowserRequest`: browsers attach `Origin` and the
 *    `Sec-Fetch-*` family to every non-GET themselves, from privileged code
 *    a page cannot reach, and no HTTP client in this repo sends either. This
 *    is an ATTRIBUTION boundary, not an authorization one — a determined
 *    non-browser caller can decline to look like a browser, and already
 *    could write before this existed. What keeps THAT caller out is the host
 *    gate and Cloudflare Access, both of which run above this.
 *
 * 3. **The sign-in flow cannot be gated by the thing it exists to satisfy.**
 *    `/api/auth/*` is how a browser stops being unsigned; gating it would
 *    make the switch a deadlock — no session, so no writes, so no way to
 *    post the email that mints one.
 */

/** The error code a refused write answers with. The browser client keys its
 *  sign-in prompt off this exact string, so it is exported rather than
 *  spelled twice. */
export const SIGN_IN_REQUIRED_ERROR = 'sign_in_required';

/** Where a refused writer is sent. The client appends its own `?next=`. */
export const SIGN_IN_PATH = '/signin';

/**
 * What the refusal SAYS. A bare 401 is indistinguishable from a bug, and the
 * done-condition for this gate is that the person learns what to do — so the
 * message names the action, and the body carries the URL that performs it.
 */
export const SIGN_IN_REQUIRED_MESSAGE =
  'Sign in to comment or edit here — your name goes on what you write. Reading needs no account.';

/** The JSON body of a refusal. Shape is part of the contract with the
 *  browser client (`markdown-app/src/signin/write-gate.ts`). */
export function signInRequiredBody(): {
  error: string;
  message: string;
  signInUrl: string;
} {
  return {
    error: SIGN_IN_REQUIRED_ERROR,
    message: SIGN_IN_REQUIRED_MESSAGE,
    signInUrl: SIGN_IN_PATH,
  };
}

/**
 * Headers a browser sets on its own and a page cannot forge or suppress.
 *
 * `Origin` is the one this server already trusts to tell a browser from an
 * agent — the cross-origin write gate and the websocket origin check are
 * both built on it, and `isAllowedBrowserOrigin` documents a null Origin as
 * "curl, the MCP child, or an agent". The `Sec-Fetch-*` family is belt and
 * braces: every browser since 2020 sends it on every request including
 * same-origin ones, so a browser that somehow omitted `Origin` is still
 * recognised, and nothing that is not a browser gains a header by accident.
 */
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'] as const;

/**
 * `true` when this request came from a browser.
 *
 * Presence, never value: `Origin: null` (a `file://` page, a sandboxed
 * iframe) is emphatically a browser, and it is the ORIGIN CHECK's job to
 * refuse it — this predicate only decides which gate applies.
 */
export function isBrowserRequest(headers: Headers): boolean {
  return BROWSER_HEADERS.some((h) => headers.get(h) !== null);
}

/**
 * `true` for a request whose refusal would break the very flow that lifts
 * the refusal. Prefix-matched: every route under `/api/auth/` is either part
 * of minting a session (`start`, `verify`), part of ending one (`logout`),
 * or part of carrying one to another surface (`widget-token`) — and each of
 * them already refuses on its own terms when it has to.
 */
export function isSignInFlowPath(pathname: string): boolean {
  return pathname === '/api/auth' || pathname.startsWith('/api/auth/');
}

/**
 * Routes that are POSTs for their request SHAPE and reads in their effect.
 *
 * `POST /api/links/titles` batches a render burst's URLs into one lookup and
 * changes nothing; gated, an unsigned reader's link chips silently never
 * resolve, and the refusal tells them "Reading needs no account" while
 * refusing a read.
 *
 * This is an enumeration, which `isGatedWrite` refuses to be — and the
 * difference is which way a forgotten entry fails. A list of writes TO gate
 * omits a route and lets a write through unchecked. A list of reads to EXEMPT
 * omits a route and gates something harmlessly, which shows up as a visible
 * refusal on a read rather than as a silent hole. Only add a path here after
 * confirming its handler mutates nothing.
 */
const READ_SHAPED_POSTS: ReadonlySet<string> = new Set(['/api/links/titles']);

/**
 * Opening a doc the caller may already READ.
 *
 * `POST /api/reviews/<id>/editable-file` and `.../context-file` (and their
 * `/api/workspaces/` aliases) answer one question: what is the docId for this
 * file in this review? They are POSTs because a relPath does not belong in a
 * query string. Each one materialises the doc if it is not already there, at
 * a DETERMINISTIC id, under the review's own root, bounded by the same
 * traversal, symlink and exclude guards a share visitor already passes — and
 * creates no content of anybody's. Call it twice and the second call is a
 * lookup.
 *
 * They are exempt because gating them refuses a READ. The redline surface
 * opens the companion doc at mount; refused, it silently fell back to the
 * derived read-only redline over the MEMBER doc — and the chrome then reads
 * threads off the member instead of the companion, so a signed-out reader saw
 * a different set of comments from everyone else. The `.md` File view fell
 * back to raw source for the same reason. Neither said anything; boundary 1
 * of this file says reads are never gated, and this was two of them.
 *
 * A separate predicate from `READ_SHAPED_POSTS` rather than an entry in it,
 * because that set's contract is "confirmed to mutate nothing" and these
 * materialise a derived view. Different promise, so a different list — and
 * both stay lists of reads to EXEMPT, where a forgotten entry shows up as a
 * refused read rather than as a silent hole.
 */
const OPEN_FOR_READING_POST =
  /^\/api\/(?:reviews|workspaces)\/[^/]+\/(?:editable-file|context-file)$/;

/** `true` for a non-GET route that only reads. Matched on the whole path —
 *  exactly for the fixed ones, and on a full-string pattern for the two that
 *  carry an id. Never a prefix: that would hand the exemption to every future
 *  route beginning with the same characters. */
export function isReadShapedPost(pathname: string): boolean {
  return READ_SHAPED_POSTS.has(pathname) || OPEN_FOR_READING_POST.test(pathname);
}

/**
 * `true` when this method+path is an ordinary write — the class of request
 * the gate governs.
 *
 * Keyed on METHOD, not on a list of routes. An enumeration is a list that
 * silently stops being complete the day someone adds a route, and "how do
 * you know you covered every write" then has no answer. Every mutating route
 * on this server is a non-GET, so every one of them is covered by
 * construction, including the ones not written yet.
 */
export function isGatedWrite(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  if (isReadShapedPost(pathname)) return false;
  return !isSignInFlowPath(pathname);
}
