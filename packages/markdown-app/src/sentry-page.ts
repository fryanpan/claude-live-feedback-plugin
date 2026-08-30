/**
 * The page's Sentry client, if `/app/sentry.js` loaded one.
 *
 * A bundle must NOT import `@sentry/browser` to add a measurement — `app.ts`
 * and the widget build without splitting, so any import of the SDK lands in
 * the entry every page load fetches whether or not a DSN is configured.
 * `sentry-boot.ts` parks the module on `window` for exactly this; everything
 * here is best-effort and returns null on an unconfigured page.
 */
export interface PageSentry {
  setMeasurement(name: string, value: number, unit: string): void;
}

export function pageSentry(): PageSentry | null {
  const held = (window as unknown as { __cwSentry?: unknown }).__cwSentry;
  if (!held || typeof held !== 'object') return null;
  const candidate = held as { setMeasurement?: unknown };
  return typeof candidate.setMeasurement === 'function' ? (held as PageSentry) : null;
}
