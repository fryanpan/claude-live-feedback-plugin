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

// biome-ignore lint/suspicious/noExplicitAny: the whole point of the dynamic
// import is that this module never eagerly resolves `@sentry/bun`'s types
// at the top level either — a `import type` of a package this file might
// never load is fine (types are erased), but naming its shape without one
// would need a second copy of options types we don't want to maintain.
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
  });
  sentryModule = Sentry;
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
 * Capture an error with whatever non-content context helps name the phase it
 * broke in (a route pattern, a socket kind — never a doc id, title, comment
 * body, or file path). No-op when Sentry isn't configured.
 */
export function captureServerError(err: unknown, extra?: Record<string, string>): void {
  const Sentry = sentryModule;
  if (!Sentry) return;
  Sentry.captureException(err, extra ? { extra } : undefined);
}
