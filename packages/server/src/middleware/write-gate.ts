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

/**
 * The switch, read from `CW_REQUIRE_SIGNIN_TO_WRITE`.
 *
 * ON unless the variable says off (owner decision on the security row,
 * 2026-09-02: *"flip on and add widget sign in"*). Unset is on. The
 * off-spellings are the usual four; anything else — including a typo — is
 * on, because a gate that a misspelling could silently open is not a gate.
 * Exported as a function of the raw value so the default and the override
 * can be asserted without booting `bin.ts`, which reads its environment at
 * import.
 */
export function signInToWriteFromEnv(raw: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes((raw ?? '').trim().toLowerCase());
}

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
 *  browser client (`workspaces-app/src/signin/write-gate.ts`). */
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
 * "curl, the MCP child, or an agent". `Sec-Fetch-Site` and `Sec-Fetch-Dest`
 * are belt and braces: every browser since 2020 sends them on every request
 * including same-origin ones, so a browser that somehow omitted `Origin` is
 * still recognised.
 *
 * `Sec-Fetch-Mode` is deliberately NOT in the list. Node's fetch (undici)
 * sends `sec-fetch-mode: cors` on every request — and nothing else of the
 * family, and no `Origin` — measured on Node 24 on 2026-09-02. The plugin's
 * MCP child runs under node, so a predicate that counted it read every MCP
 * tool call as a browser: with the sign-in flag on that would have refused
 * every agent write, and the binding routes (which refuse browsers
 * unconditionally) refused the MCP bundle's own `create_review_doc` the day
 * they were closed. The list is "what browsers send that clients don't",
 * and this header failed the second half.
 */
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-dest'] as const;

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

/**
 * The file-binding routes are not for browsers at all.
 *
 * `POST /api/docs` (bind a file), `POST /api/workspaces` with a `folderPath`
 * (bind a folder) and `POST /api/workspaces/<id>/import-tasks` (read a
 * markdown file) each turn a host path into content this server will read
 * and serve. Every caller is an agent — an MCP tool, a hook, a curl — and
 * none of the browser apps call them. The cross-origin write gate refuses a
 * page the origin policy does not know; what it ADMITS is the gap: on the
 * local surface any page on a machine-local hostname passes, so a dev server
 * on another port could bind and read any file the server can.
 * (Urgent-fixes ticket, 2026-09-02.)
 *
 * So these routes refuse `isBrowserRequest` outright, whatever origin it
 * claims and whether or not it is signed in. Unlike the sign-in gate this
 * is not a flag: there is no browser flow to preserve. The sign-in gate's
 * boundary caveat applies here too — a non-browser client can decline to
 * look like one, and that client already sits inside the host gate — so this
 * closes the page-on-this-machine hole, not a determined agent.
 */
export const BROWSER_CANNOT_BIND_ERROR = 'browser_cannot_bind';

/** The JSON body a browser gets back from a binding route. */
export function browserCannotBindBody(): { error: string; message: string } {
  return {
    error: BROWSER_CANNOT_BIND_ERROR,
    message: 'Binding a file or folder is an agent action — pages cannot name host paths.',
  };
}

/**
 * The operator routes are not for browsers either.
 *
 * `POST /api/deploy` restarts this process out of its deploy source and
 * `POST /api/plugin/refresh` spawns a plugin update. Both are operator
 * actions with no browser flow: the board's own pages never call either, and
 * every real caller is an agent, a hook or a curl from the box.
 *
 * **Every `/api/share*` mutation is the same class**, and was open until the
 * pass-2 review. Minting a link (`POST /api/share/link`) or an Access share
 * (`POST /api/share/workspace`) publishes a whole board to the internet;
 * `POST /api/share/enabled` is the master switch and can RE-OPEN external
 * access after the operator closed it; the TTL and revoke routes move a live
 * credential's lifetime. No browser app in this repo calls any of them —
 * every caller is the MCP tool layer or `scripts/share.ts`.
 *
 * They are the same page-on-this-machine class the binding routes closed.
 * The loopback check on `/api/deploy` reads the PEER ADDRESS, which is
 * loopback for a page served from this machine; the cross-origin write gate
 * admits any machine-local hostname on any port; a session cookie is
 * same-site with a local dev origin and rides along; and no `cf-ray` is
 * present. None of those checks can tell a page from an agent — this one is
 * the one that does. `/api/share*`'s own "local-only" comments describe the
 * HOST class, which is a different question and does not answer this one.
 *
 * A SIBLING reason rather than `browser_cannot_bind`, because no host path
 * is being named here and a client matching on the string should not have to
 * read "bind" to mean "restart".
 */
export const BROWSER_CANNOT_OPERATE_ERROR = 'browser_cannot_operate';

/** The JSON body a browser gets back from an operator route. */
export function browserCannotOperateBody(): { error: string; message: string } {
  return {
    error: BROWSER_CANNOT_OPERATE_ERROR,
    message:
      'Deploying, refreshing the plugin and changing sharing are agent actions — pages cannot run them.',
  };
}
