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

import { routePatternForSpan, scrubEventForPrivacy } from '@feedback/core/trace-privacy';

/**
 * The privacy floor is shared with the browser build, so it lives in
 * `@feedback/core/trace-privacy` — see that file's header. Re-exported here
 * because this module is still the one place server code (and
 * sentry-server.test.ts) asks for it.
 */
export { routePatternForSpan, scrubEventForPrivacy };

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

export async function flushServerSentry(timeoutMs = 2000): Promise<boolean> {
  if (!sentryModule) return true;
  return sentryModule.flush(timeoutMs);
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
