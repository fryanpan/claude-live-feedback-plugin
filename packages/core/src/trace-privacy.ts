/**
 * Trace privacy: the pure, shared floor that keeps a Sentry payload down to
 * shapes, counts and timings — never doc content, titles, comment text, or
 * file paths.
 *
 * It lives in `@feedback/core` rather than beside the server's Sentry init
 * because BOTH sides send events now. The server has sent scrubbed traces
 * since PR #487; the browser started sending them once docs, mockups and the
 * landing page were instrumented too, and a browser event
 * carries the same hazards through different doors — `request.url` is the
 * page URL, an `http.client` span's description is the fetch URL, and a
 * navigation breadcrumb's `from`/`to` are raw paths. One copy of the rules,
 * imported by `packages/server/src/sentry.ts` (which re-exports it, so its
 * own callers and tests are unchanged) and by the browser's Sentry entry.
 *
 * Nothing in here touches the network, the filesystem, or a Sentry SDK — it
 * is string and object work only, which is what makes it safe to bundle into
 * a browser build.
 */

/**
 * Key-targeted, not content-targeted: this walks the whole event tree and
 * drops the VALUE of any key whose name looks like it carries a URL, query
 * string, cookie, or referrer — `url`, `request.url`, `url.full`,
 * `http.url`, `query_string`, `headers`, `referer`/`referrer`, `cookie(s)`.
 * It deliberately does NOT pattern-match string CONTENT (e.g. "starts with
 * /"), because that would also catch legitimate, harmless data this same
 * event carries — most importantly `exception.values[].stacktrace.frames[].
 * filename`, an absolute path into OUR OWN source tree that a debugging
 * agent needs to find where the error happened. Naming the key is the safer
 * floor: every URL-shaped attribute Sentry's conventions define is named
 * with one of these substrings, and nothing else in an event is.
 */
const SCRUB_KEY_SUBSTRINGS = ['url', 'href', 'referer', 'referrer', 'cookie', 'query_string'];

function shouldScrubKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === 'headers') return true;
  return SCRUB_KEY_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/**
 * Second floor, sitting under the key-targeted pass above: a VALUE-shaped
 * scan for this repo's own minted-id shape. The key-targeted pass only looks
 * at ATTRIBUTE NAMES — it does nothing for an id that leaks through an
 * ordinary string under an ordinary key: a transaction/span `name` (if
 * anything ever names one by raw path instead of routePatternForSpan), an
 * exception `message` ("doc t-... not found"), a breadcrumb message, or a
 * future `extra` string nobody thought to redact. A key list has to be right
 * about every key anyone will ever add; a value-shaped check does not.
 *
 * Every id this codebase MINTS (doc-ids.ts's newDocId, tasks.ts's cryptoId,
 * …) has the same shape: a short lowercase prefix, a dash, then 10+
 * base64url characters — the same shape scripts/scrub-check.py's own
 * denylist matches for the pre-push gate (`\bt-[A-Za-z0-9_-]{10,}\b`,
 * generalized here to any prefix, not just task ids). Redacting that SHAPE
 * wherever it appears in a string, independent of which key it's under,
 * closes the gap a key list can never fully enumerate.
 *
 * What this does NOT catch: a caller-chosen docId that's a bound file's
 * relative path or a `task:<id>` alias (see routePatternForSpan) embedded in
 * free text — those read as ordinary words ("roadmap", "internal"), and no
 * shape pattern can single them out of a message without also redacting
 * ordinary English. routePatternForSpan already keeps that shape out of
 * every span/transaction NAME; keeping a raw docId out of a hand-written
 * message string is a code-review concern (don't interpolate one into an
 * Error message), not something a generic scrubber can enforce.
 */
const MINTED_ID_SHAPE = /\b[a-z]{1,3}-[A-Za-z0-9_-]{10,}\b/g;

function redactMintedIdShapes(text: string): string {
  return text.replace(MINTED_ID_SHAPE, '[id]');
}

export function scrubEventForPrivacy(value: unknown, depth = 0): unknown {
  // Fail closed, not open: a subtree this deep is never a real Sentry event
  // shape (envelope objects run a handful of levels deep at most), so
  // returning it unscrubbed on the assumption that "it's probably fine"
  // would be exactly the kind of unproven assumption this whole file exists
  // to replace with a check. Redact instead — the guard is still what stops
  // a pathological/cyclical shape from recursing forever, it just no longer
  // buys an attacker's data a pass on the way out.
  if (depth > 20) return '[scrubbed: too deep]';
  if (typeof value === 'string') {
    return redactMintedIdShapes(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubEventForPrivacy(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldScrubKey(key) ? '[scrubbed]' : scrubEventForPrivacy(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Every REAL route this server dispatches on, as a whole-path template —
 * literal segments verbatim, `:id` marking a caller-controlled slot. Built
 * directly from server.ts's own route matchers (the `pathname.match(/^...$/)`
 * regexes, the `/api/docs/:id` catch-all's `rest` dispatch, and its nested
 * `threads`/`agent_anchors` sub-dispatches) — not retyped from memory.
 *
 * This used to be a flat allowlist of literal WORDS, checked per segment
 * independently of where in the path it sat. That was wrong: whether a
 * segment is static depends on its POSITION in a matched route, not its
 * VALUE — a caller-chosen id can legally equal any English word, including
 * one that happens to be a route keyword somewhere else in the API (a doc
 * literally titled "content", landing at `/api/docs/content/content`, kept
 * BOTH occurrences of "content" as static under the old check, leaking the
 * id). Matching whole templates instead means a segment is only ever static
 * when it sits at the position a REAL route puts a literal, never merely
 * because its value happens to collide with one.
 *
 * A path that matches no template here still degrades to every segment
 * becoming `:id` (see routePatternForSpan below) — safe by construction,
 * same as an unknown segment always was. Missing a real route from this
 * list costs span-name precision, never privacy: routePatternForSpan has no
 * path where "no template matched" produces anything other than all-`:id`.
 */
const ROUTE_TEMPLATES: readonly (readonly string[])[] = [
  // top-level static (no dynamic segment at all)
  ['api', 'agent-notes'],
  ['api', 'auth', 'logout'],
  ['api', 'auth', 'profile'],
  ['api', 'auth', 'session'],
  ['api', 'auth', 'start'],
  ['api', 'auth', 'verify'],
  ['api', 'auth', 'widget-session'],
  ['api', 'auth', 'widget-token'],
  ['api', 'chat-audit'],
  ['api', 'deploy'],
  ['api', 'diffs'],
  ['api', 'dispatches'],
  ['api', 'docs'],
  ['api', 'links', 'titles'],
  ['api', 'metrics'],
  ['api', 'plugin', 'refresh'],
  ['api', 'push', 'key'],
  ['api', 'push', 'subscriptions'],
  ['api', 'refs', 'backlinks'],
  ['api', 'reviews', 'archived'],
  ['api', 'share'],
  ['api', 'share', 'doc'],
  ['api', 'share', 'enabled'],
  ['api', 'share', 'link'],
  ['api', 'share', 'workspace'],
  ['api', 'summaries', 'backfill'],
  ['api', 'webhooks', 'log'],
  ['api', 'workspaces'],
  ['signin'],
  ['widget-auth'],
  ['widget.esm.js'],
  ['widget.iife.js'],
  ['widget.js'],
  // one id, top level
  ['api', 'reviews', ':id'],
  ['api', 'reviews', ':id', 'archive'],
  ['api', 'reviews', ':id', 'unarchive'],
  // reviewApi(sub): `/api/(?:reviews|workspaces)/:id/<sub>` — a review or a
  // hub workspace can be addressed under either prefix (compat for
  // long-running sessions and open tabs; see the reviewApi comment in
  // server.ts), so every one of these 8 subroutes needs BOTH prefixes.
  ['api', 'reviews', ':id', 'refresh'],
  ['api', 'workspaces', ':id', 'refresh'],
  ['api', 'reviews', ':id', 'groups'],
  ['api', 'workspaces', ':id', 'groups'],
  ['api', 'reviews', ':id', 'grouped'],
  ['api', 'workspaces', ':id', 'grouped'],
  ['api', 'reviews', ':id', 'threads'],
  ['api', 'workspaces', ':id', 'threads'],
  ['api', 'reviews', ':id', 'files'],
  ['api', 'workspaces', ':id', 'files'],
  ['api', 'reviews', ':id', 'tree'],
  ['api', 'workspaces', ':id', 'tree'],
  ['api', 'reviews', ':id', 'context-file'],
  ['api', 'workspaces', ':id', 'context-file'],
  ['api', 'reviews', ':id', 'editable-file'],
  ['api', 'workspaces', ':id', 'editable-file'],
  ['share', ':id'],
  ['s', ':id'],
  ['api', 'share', ':id'],
  ['api', 'share', ':id', 'ttl'],
  ['events', 'workspace', ':id'],
  ['api', 'dispatches', ':id'],
  ['api', 'chat-audit', ':id'],
  ['review', ':id'],
  ['mockup', ':id'],
  ['audio', ':id'],
  ['y', ':id'],
  // /api/workspaces/:id/...
  ['api', 'workspaces', ':id'],
  ['api', 'workspaces', ':id', 'review-items'],
  ['api', 'workspaces', ':id', 'home'],
  ['api', 'workspaces', ':id', 'home', 'read'],
  ['api', 'workspaces', ':id', 'home', 'instructions'],
  ['api', 'workspaces', ':id', 'next'],
  ['api', 'workspaces', ':id', 'load-reports'],
  ['api', 'workspaces', ':id', 'events'],
  ['api', 'workspaces', ':id', 'goal'],
  ['api', 'workspaces', ':id', 'goals'],
  ['api', 'workspaces', ':id', 'goals', 'rename'],
  ['api', 'workspaces', ':id', 'goals', 'add'],
  ['api', 'workspaces', ':id', 'goals', 'reorder'],
  ['api', 'workspaces', ':id', 'retired'],
  ['api', 'workspaces', ':id', 'settings'],
  ['api', 'workspaces', ':id', 'rename'],
  ['api', 'workspaces', ':id', 'lead'],
  ['api', 'workspaces', ':id', 'voice'],
  ['api', 'workspaces', ':id', 'docs'],
  ['api', 'workspaces', ':id', 'import-tasks'],
  ['api', 'workspaces', ':id', 'huddles'],
  ['api', 'workspaces', ':id', 'tasks'],
  ['api', 'workspaces', ':id', 'tasks', 'batch'],
  ['api', 'workspaces', ':id', 'attachments'],
  ['api', 'workspaces', ':id', 'attachments', ':id'],
  ['api', 'workspaces', ':id', 'attachments', ':id', 'heartbeat'],
  ['api', 'workspaces', ':id', 'comment-queue', ':id', 'ack'],
  ['api', 'workspaces', ':id', 'voice-queue', ':id', 'ack'],
  // /api/tasks/:id/...
  ['api', 'tasks', ':id', 'transition'],
  ['api', 'tasks', ':id', 'evidence'],
  ['api', 'tasks', ':id', 'links'],
  ['api', 'tasks', ':id', 'goal'],
  ['api', 'tasks', ':id', 'answer'],
  ['api', 'tasks', ':id', 'answer', 'undo'],
  ['api', 'tasks', ':id', 'more-info'],
  ['api', 'tasks', ':id', 'review-items'],
  ['api', 'tasks', ':id', 'review-items', ':id', 'answer'],
  ['api', 'tasks', ':id', 'review-items', ':id', 'more-info'],
  ['api', 'tasks', ':id', 'review-items', ':id', 'release'],
  ['api', 'tasks', ':id', 'review-items', ':id', 'revise'],
  ['api', 'tasks', ':id', 'after'],
  ['api', 'tasks', ':id', 'title'],
  ['api', 'tasks', ':id', 'body'],
  ['api', 'tasks', ':id', 'assignee'],
  ['api', 'tasks', ':id', 'due'],
  ['api', 'tasks', ':id', 'park'],
  ['api', 'tasks', ':id', 'archive'],
  ['api', 'tasks', ':id', 'restore'],
  ['api', 'tasks', ':id', 'notes'],
  // /api/agents/:id/...
  ['api', 'agents', ':id', 'watches'],
  ['api', 'agents', ':id', 'merge'],
  ['api', 'agents', ':id', 'notes'],
  // /api/docs/:id and its ~30 subroutes (canonicalized once in server.ts, then dispatched on the literal 'rest' of the path)
  ['api', 'docs', ':id'],
  ['api', 'docs', ':id', 'archive'],
  ['api', 'docs', ':id', 'unarchive'],
  ['api', 'docs', ':id', 'meetings'],
  ['api', 'docs', ':id', 'meetings', ':id'],
  ['api', 'docs', ':id', 'threads'],
  ['api', 'docs', ':id', 'tasks'],
  ['api', 'docs', ':id', 'content'],
  ['api', 'docs', ':id', 'status'],
  ['api', 'docs', ':id', 'reparse_from_disk'],
  ['api', 'docs', ':id', 'diff'],
  ['api', 'docs', ':id', 'activity'],
  ['api', 'docs', ':id', 'find_and_replace'],
  ['api', 'docs', ':id', 'agent_anchors'],
  ['api', 'docs', ':id', 'suggestions'],
  ['api', 'docs', ':id', 'suggestions', 'resolve_all'],
  ['api', 'docs', ':id', 'suggestions', ':id', 'accept'],
  ['api', 'docs', ':id', 'suggestions', ':id', 'reject'],
  ['api', 'docs', ':id', 'delete_block_at_anchor'],
  ['api', 'docs', ':id', 'delete_blocks_in_range'],
  ['api', 'docs', ':id', 'delete_section'],
  ['api', 'docs', ':id', 'hooks', 'fire'],
  // /api/docs/:id/threads/:id/... (nested inside the rest dispatch above)
  ['api', 'docs', ':id', 'threads', ':id', 'promote'],
  ['api', 'docs', ':id', 'threads', ':id'],
  ['api', 'docs', ':id', 'threads', ':id', 'comments'],
  ['api', 'docs', ':id', 'threads', ':id', 'answer'],
  ['api', 'docs', ':id', 'threads', ':id', 'revise'],
  ['api', 'docs', ':id', 'threads', ':id', 'withdraw'],
  ['api', 'docs', ':id', 'threads', ':id', 'withdraw', 'undo'],
  ['api', 'docs', ':id', 'threads', ':id', 'answer', 'undo'],
  ['api', 'docs', ':id', 'threads', ':id', 'summary'],
  ['api', 'docs', ':id', 'threads', ':id', 'resolve'],
  ['api', 'docs', ':id', 'threads', ':id', 'reopen'],
  ['api', 'docs', ':id', 'threads', ':id', 'reanchor'],
  ['api', 'docs', ':id', 'threads', ':id', 'rewrite_region'],
  ['api', 'docs', ':id', 'threads', ':id', 'insert_after'],
  ['api', 'docs', ':id', 'threads', ':id', 'insert_blocks_after'],
  ['api', 'docs', ':id', 'threads', 'by_find'],
  // /api/docs/:id/agent_anchors/:id/... (nested inside the rest dispatch above)
  ['api', 'docs', ':id', 'agent_anchors', ':id'],
  ['api', 'docs', ':id', 'agent_anchors', ':id', 'edit'],
  ['api', 'docs', ':id', 'agent_anchors', ':id', 'insert_blocks'],
  // the frontend shell — /workspaces/:id and /workspaces/:id/(docs|mockups|reviews)/:id
  ['workspaces', ':id'],
  ['workspaces', ':id', 'home'],
  ['workspaces', ':id', 'tasks'],
  ['workspaces', ':id', 'mine'],
  ['workspaces', ':id', 'activity'],
  ['workspaces', ':id', 'docs', ':id'],
  ['workspaces', ':id', 'mockups', ':id'],
  ['workspaces', ':id', 'reviews', ':id'],
];

function matchesRouteTemplate(segments: readonly string[], template: readonly string[]): boolean {
  if (segments.length !== template.length) return false;
  return segments.every((seg, i) => template[i] === ':id' || template[i] === seg);
}

/**
 * Static-asset roots server.ts serves with a `pathname.startsWith('/<root>/')`
 * prefix match (widgetDist, markdown-app's dist, the demos dir, the
 * project-card assets) — arbitrary depth beneath the root (an asset can sit
 * in a subdirectory), so no fixed-length ROUTE_TEMPLATES entry can name it:
 * a template matches on exact segment COUNT, and these routes have none.
 * codex review (this branch): the whole-template rewrite above silently
 * dropped these from `/app/:id` etc. to the generic `/:id/:id` fallback,
 * an observability regression with no privacy fix behind it — the OLD flat
 * per-segment allowlist happened to keep segment 0 static for exactly these
 * four words. Collapsing everything past the root to one `:id` restores
 * that, and stays position-keyed rather than value-keyed for the same
 * reason ROUTE_TEMPLATES is: nothing in ROUTE_TEMPLATES ever puts a
 * caller-chosen id at segment 0 under these literal strings, so a request
 * only lands here by actually hitting one of these four static routes.
 */
const STATIC_ASSET_ROUTE_ROOTS = new Set(['widget', 'app', 'demos', 'projects']);

/**
 * Route pattern for a span/transaction name — NEVER `url.pathname` directly.
 * A raw path can carry a doc id that's a bound file's relative path, a task
 * title alias (`task:<taskId>`), or a share token; this collapses every
 * segment that isn't at a literal position in a known route to `:id`, so the
 * name is safe to send off-machine no matter what the id turns out to
 * contain — see ROUTE_TEMPLATES above for why this matches whole shapes
 * rather than classifying segments independently.
 */
export function routePatternForSpan(pathname: string): string {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return '/';
  const template = ROUTE_TEMPLATES.find((t) => matchesRouteTemplate(segments, t));
  if (template) return `/${template.join('/')}`;
  if (segments.length >= 2 && STATIC_ASSET_ROUTE_ROOTS.has(segments[0]!)) {
    return `/${segments[0]}/:id`;
  }
  return `/${segments.map(() => ':id').join('/')}`;
}

/**
 * A span/transaction name, reduced to a route pattern.
 *
 * The two floors above are blind to exactly one shape, and it is the shape a
 * BROWSER event is full of: a string that IS a path (or `GET <path>`), under
 * an ordinary key like `transaction` or a span's `description`. The
 * key-targeted pass only looks at attribute NAMES, and `description` is not
 * URL-named; the shape pass only catches this codebase's MINTED ids, and a
 * `docId` can be a bound file's relative path (`docs/product/vision.md`) or a
 * `task:<id>` alias — ordinary words, no shape to match.
 *
 * The server never needed this because `withRouteSpan` names every span it
 * creates through `routePatternForSpan` before the SDK ever sees it. In the
 * browser the names are minted by the SDK's own tracing integration, from
 * `location.pathname` and from every fetch URL, so the only place to fix them
 * is on the way out.
 *
 * A name that is not path-shaped is returned untouched — this is a rewrite of
 * known-safe shapes, not a guess at unknown ones.
 */
export function scrubSpanName(name: string): string {
  const withMethod = /^([A-Z]{3,7}) (\S+)$/.exec(name);
  if (withMethod) {
    const path = pathOf(withMethod[2] ?? '');
    return path === null ? name : `${withMethod[1]} ${routePatternForSpan(path)}`;
  }
  const path = pathOf(name);
  return path === null ? name : routePatternForSpan(path);
}

/**
 * The pathname of a string that is a path or an absolute URL, or null when it
 * is neither. Query and fragment are dropped outright rather than patterned
 * over: a query string is the one part of a URL most likely to carry a title,
 * a search term, or a token, and no span name needs it.
 */
function pathOf(raw: string): string | null {
  if (raw.startsWith('/')) return raw.split(/[?#]/)[0] ?? '/';
  const m = /^https?:\/\/[^/]*(\/[^\s?#]*)?/.exec(raw);
  if (!m) return null;
  return m[1] ?? '/';
}

/** Breadcrumb `data` keys whose value is a raw path. Navigation breadcrumbs
 *  record where the SPA went, which is a doc address. */
const PATH_VALUED_BREADCRUMB_KEYS = ['from', 'to'] as const;

/**
 * The browser's `beforeSend` / `beforeSendTransaction`: the name pass above,
 * then the same two floors the server runs.
 *
 * Order matters. `routePatternForSpan` has to see the real path to match a
 * route template against it, so the names are rewritten FIRST; the key and
 * shape floors then run over the whole event, catching everything the name
 * pass did not visit (`request.url`, `http.url`, a minted id in a message).
 * Running them the other way round would hand the name pass `/[id]/[id]`
 * and reduce every route to the all-`:id` fallback.
 */
export function scrubBrowserEvent(event: unknown): unknown {
  if (event && typeof event === 'object') {
    const e = event as Record<string, unknown>;
    if (typeof e.transaction === 'string') e.transaction = scrubSpanName(e.transaction);
    for (const span of Array.isArray(e.spans) ? e.spans : []) {
      if (!span || typeof span !== 'object') continue;
      const s = span as Record<string, unknown>;
      for (const key of ['description', 'name'] as const) {
        if (typeof s[key] === 'string') s[key] = scrubSpanName(s[key] as string);
      }
    }
    for (const crumb of Array.isArray(e.breadcrumbs) ? e.breadcrumbs : []) {
      if (!crumb || typeof crumb !== 'object') continue;
      const data = (crumb as Record<string, unknown>).data;
      if (!data || typeof data !== 'object') continue;
      const d = data as Record<string, unknown>;
      for (const key of PATH_VALUED_BREADCRUMB_KEYS) {
        if (typeof d[key] === 'string') d[key] = scrubSpanName(d[key] as string);
      }
    }
  }
  return scrubEventForPrivacy(event);
}
