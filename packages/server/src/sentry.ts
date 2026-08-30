/**
 * Server-side Sentry: traces + error capture for the process itself. This is
 * deliberately separate from `ServerOptions.sentryDsn` in server.ts, which
 * only ever hands the DSN to the BROWSER as a meta tag — that option gets
 * passed by dozens of tests that spin up multiple `createServer()` instances
 * per process (see sentry-config.test.ts), and none of them should trigger a
 * real (process-global) Sentry client. This module is instead wired up
 * exactly once, by bin.ts, for the actual running process.
 *
 * What 2026-08-29 cost without this: the server took the machine's
 * networking down, and the only server telemetry was a 357 MB error log,
 * 99.92% of it one repeated line. Every cause was found by grepping by hand.
 *
 * Dynamic import, gated on the DSN being present — same pattern as the
 * browser's Sentry init in hub-app.ts. An unconfigured process (every test,
 * every stranger's clone, prod with the env var unset) never imports
 * `@sentry/bun`, never calls `Sentry.init`, and never opens a socket to
 * anywhere. See sentry-server.test.ts, which proves that by pointing a real
 * DSN at a local capture server and observing zero requests arrive when no
 * DSN is configured — not by reading this file.
 */

// `typeof import(...)` of a package this file might never load at runtime is
// fine — types are erased, so naming the shape this way costs nothing when
// the dynamic `import()` below never fires (no DSN configured).
type SentryBunModule = typeof import('@sentry/bun');

let sentryModule: SentryBunModule | null = null;

/** Test-only: forget the module-global client so a test file can exercise
 *  both the configured and unconfigured paths without leaking state between
 *  `it()` blocks. Never called from production code. */
export function resetServerSentryForTest(): void {
  sentryModule = null;
}

export function isServerSentryActive(): boolean {
  return sentryModule !== null;
}

/**
 * Initialise server-side Sentry. Only ever call this when a DSN is present —
 * the caller (bin.ts) is what decides that, this function has no opinion.
 * Full sample rate: low-traffic internal tool, and the one slow request that
 * matters must not get dropped by sampling.
 */
export async function initServerSentry(opts: {
  dsn: string;
  release: string | null;
}): Promise<void> {
  const Sentry = await import('@sentry/bun');
  Sentry.init({
    dsn: opts.dsn,
    release: opts.release ?? undefined,
    tracesSampleRate: 1.0,
    // Default (false): no IPs, no cookies, no headers beyond what tracing
    // itself needs. Traces carry shapes and counts, never content — see
    // routePatternForSpan below for the same rule applied to span names.
    sendDefaultPii: false,
    // The SDK's own `BunServer` integration monkey-patches `Bun.serve`
    // globally and creates ITS OWN transaction per request, named
    // `${method} ${url.pathname}` — the raw path, plus a `url.full`
    // attribute carrying the full URL including the query string. That is
    // exactly what routePatternForSpan exists to prevent, and it runs
    // whether or not withRouteSpan below ever gets called — every
    // `Bun.serve()` in the process, including test fixtures. There's no
    // "redact this" knob on it, so it's disabled outright; withRouteSpan
    // already wraps every real request with a route-pattern-named span.
    //
    // Also drops `OnUncaughtException` and `OnUnhandledRejection`: the SDK
    // registers its own `process.on('uncaughtException' | 'unhandledRejection',
    // ...)` listeners for those, which is bin.ts's job too (see the handlers
    // installed right after this call). Leaving both pairs active means Bun
    // fires every listener on a fatal error, so the SDK's own listener
    // calls `captureException` a second time — a duplicate event for a
    // process that just crashed once. `OnUnhandledRejection` does this
    // unconditionally; `OnUncaughtException` only skips its own exit call
    // once it notices bin.ts's listener is registered too, so the capture
    // still doubles even though the two don't race on `process.exit`
    // itself. bin.ts's handlers already do capture + flush + exit with
    // explicit control, so they're the single source of truth here — same
    // reasoning as disabling `BunServer` below and leaving withRouteSpan as
    // the one thing that names a span.
    integrations: (defaults) =>
      defaults.filter(
        (i) => !['BunServer', 'OnUncaughtException', 'OnUnhandledRejection'].includes(i.name),
      ),
    // Floor, not a substitute for the above: disabling BunServer closes the
    // one leak source this file found by reading the SDK's source. It does
    // not prove there isn't another — a different default integration, or
    // the SDK's own request handling, can attach a URL/header/referrer to an
    // event without going through withRouteSpan at all. beforeSend and
    // beforeSendTransaction run on every outbound payload regardless of
    // which code path produced it, so the guarantee doesn't depend on having
    // enumerated every source correctly. See scrubEventForPrivacy.
    beforeSend(event) {
      return scrubEventForPrivacy(event) as typeof event;
    },
    beforeSendTransaction(event) {
      return scrubEventForPrivacy(event) as typeof event;
    },
  });
  sentryModule = Sentry;
}

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

export async function flushServerSentry(timeoutMs = 2000): Promise<boolean> {
  if (!sentryModule) return true;
  return sentryModule.flush(timeoutMs);
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
 * Wrap one request in a span named by route pattern + method, continuing the
 * browser's trace when it sent `sentry-trace`/`baggage` headers (the default
 * browser tracing integration adds those to same-origin relative-URL
 * fetches, which is how this app talks to itself) so one page load reads as
 * one trace end to end. A no-op passthrough when Sentry isn't configured.
 */
export function withRouteSpan<T>(req: Request, pathname: string, fn: () => Promise<T>): Promise<T> {
  const Sentry = sentryModule;
  if (!Sentry) return fn();
  const name = `${req.method} ${routePatternForSpan(pathname)}`;
  return Sentry.continueTrace(
    {
      sentryTrace: req.headers.get('sentry-trace') ?? undefined,
      baggage: req.headers.get('baggage') ?? undefined,
    },
    () => Sentry.startSpan({ name, op: 'http.server' }, () => fn()),
  );
}

/**
 * Some of our own error classes carry a caller-chosen id as a STRUCTURED
 * field precisely because it can't be redacted by shape: codex review found
 * `ReservedDocIdError` (doc-ids.ts) formats an arbitrary `docId` — which can
 * be a bound file's relative path or a `task:<id>` alias, exactly the
 * caller-chosen shapes that don't match MINTED_ID_SHAPE — directly into its
 * own `.message`, and it's thrown from a live code path (rooms.ts) with
 * nothing catching it by name before it could reach captureServerError. This
 * doesn't need to guess at a shape: when an Error exposes one of these
 * fields, the exact value is known, so every occurrence of it in the
 * message can be replaced outright before Sentry ever sees the object.
 * Extend this list if a future error class follows the same pattern.
 *
 * codex review: the first version of this fix redacted `.message` but
 * copied `.stack` across unchanged — and a stack's own first line is
 * `${name}: ${message}` (V8's own format), so the raw id came right back
 * through that copy, proven by a probe that built a real ReservedDocIdError
 * and found the id still in `sanitized.stack`. The stack gets the exact
 * same value-for-value replacement as the message, for the same reason: the
 * value is known exactly, so there is nothing to guess at.
 */
const KNOWN_ID_FIELDS = ['docId', 'taskId', 'workspaceId'] as const;

export function sanitizeErrorForCapture(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  let message = err.message;
  let stack = err.stack;
  for (const field of KNOWN_ID_FIELDS) {
    const value = (err as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0 && message.includes(value)) {
      message = message.split(value).join('[id]');
      if (stack) stack = stack.split(value).join('[id]');
    }
  }
  if (message === err.message) return err; // nothing to change — don't rebuild the object
  const sanitized = new Error(message);
  sanitized.name = err.name;
  sanitized.stack = stack;
  return sanitized;
}

/**
 * Capture an error with whatever non-content context helps name the phase it
 * broke in (a route pattern, a socket kind — never a doc id, title, comment
 * body, or file path). No-op when Sentry isn't configured.
 */
export function captureServerError(err: unknown, extra?: Record<string, string>): void {
  const Sentry = sentryModule;
  if (!Sentry) return;
  Sentry.captureException(sanitizeErrorForCapture(err), extra ? { extra } : undefined);
}
