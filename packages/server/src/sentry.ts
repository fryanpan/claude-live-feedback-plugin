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
    integrations: (defaults) => defaults.filter((i) => i.name !== 'BunServer'),
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
 * Every literal (non-id) path segment the route table dispatches on. A
 * request whose segment isn't in this set is assumed to be an id — a
 * workspace id, task id, doc id, share token, thread id, or (for docIds
 * specifically) a caller-chosen string that can embed a bound file's
 * relative path or a `task:<taskId>` alias. That last case is exactly why
 * this is default-DENY: an allowlist of known-safe words, not a denylist of
 * known-dangerous shapes. A segment this file doesn't yet know about reads
 * as `:id` and just loses a little span-name precision — it never leaks
 * content. Adding a new route with a new literal keyword segment means
 * adding that word here, or it silently buckets into `:id` too (safe, just
 * less useful for grepping traces by route).
 */
const STATIC_ROUTE_SEGMENTS = new Set([
  // top-level API / auth / asset families
  'api',
  'auth',
  'widget-token',
  'widget-session',
  'start',
  'verify',
  'session',
  'logout',
  'profile',
  'share',
  'enabled',
  'doc',
  'link',
  'workspace',
  'summaries',
  'backfill',
  'metrics',
  'docs',
  'workspaces',
  'diffs',
  'refs',
  'backlinks',
  'links',
  'titles',
  'dispatches',
  'agent-notes',
  'agents',
  'chat-audit',
  'plugin',
  'refresh',
  'push',
  'key',
  'subscriptions',
  'deploy',
  'reviews',
  'archived',
  'webhooks',
  'log',
  'ttl',
  // static shells / bundles
  'widget.js',
  'widget.iife.js',
  'widget.esm.js',
  'widget-auth',
  'signin',
  'widget',
  'review',
  'app',
  'mockup',
  'demos',
  'projects',
  'audio',
  'y',
  'events',
  // workspace sub-routes
  'review-items',
  'home',
  'read',
  'instructions',
  'next',
  'load-reports',
  'goal',
  'goals',
  'retired',
  'settings',
  'rename',
  'lead',
  'voice',
  'tasks',
  'batch',
  'import-tasks',
  'huddles',
  'add',
  'reorder',
  'attachments',
  // task sub-routes
  'transition',
  'evidence',
  'answer',
  'undo',
  'more-info',
  'after',
  'title',
  'body',
  'assignee',
  'due',
  'park',
  'archive',
  'restore',
  'notes',
  // doc sub-routes
  'threads',
  'content',
  'status',
  'reparse_from_disk',
  'diff',
  'activity',
  'agent_anchors',
  'find_and_replace',
  'suggestions',
  'resolve_all',
  'delete_block_at_anchor',
  'delete_blocks_in_range',
  'delete_section',
  'hooks',
  'fire',
  'by_find',
  'meetings',
  'unarchive',
  'promote',
  'comments',
  // agent sub-routes
  'watches',
  'merge',
]);

/**
 * Route pattern for a span/transaction name — NEVER `url.pathname` directly.
 * A raw path can carry a doc id that's a bound file's relative path, a task
 * title alias (`task:<taskId>`), or a share token; this collapses every
 * segment the route table doesn't dispatch on to `:id` so the name is safe
 * to send off-machine no matter what the id turns out to contain.
 */
export function routePatternForSpan(pathname: string): string {
  const segments = pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return '/';
  return `/${segments.map((seg) => (STATIC_ROUTE_SEGMENTS.has(seg) ? seg : ':id')).join('/')}`;
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
 */
const KNOWN_ID_FIELDS = ['docId', 'taskId', 'workspaceId'] as const;

export function sanitizeErrorForCapture(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  let message = err.message;
  for (const field of KNOWN_ID_FIELDS) {
    const value = (err as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0 && message.includes(value)) {
      message = message.split(value).join('[id]');
    }
  }
  if (message === err.message) return err; // nothing to change — don't rebuild the object
  const sanitized = new Error(message);
  sanitized.name = err.name;
  sanitized.stack = err.stack;
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
