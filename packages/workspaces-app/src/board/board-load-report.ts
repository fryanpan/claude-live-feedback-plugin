/**
 * One line per page load: how long the board took to appear, and how long
 * its data took to arrive.
 *
 * One responsibility, and it is measurement rather than boot. "The board is
 * slow on the iPad" was a memory until the server grew `/load-reports`; this
 * is the client half, and the reason it is a module of its own is that its
 * two numbers mean nothing apart. `msToBoot` is the REST first paint;
 * `msToFirstProjection` is when the ydoc's task projection actually landed —
 * the payload that spent those ten seconds. Both are ms from navigation
 * start (`performance.now()`'s zero), so they compare across loads, and a
 * report carrying one without the other cannot say which phase was slow.
 *
 * `bootBoard` keeps the two stamps and the sent-once guard, because WHEN each
 * phase ends is a fact about the boot sequence. What is here is what a report
 * contains and where it goes.
 */
import { asBackgroundWrite } from '../signin/write-gate.ts';

/** The pageload trace to stamp alongside the POST, or null when the SDK
 *  never loaded — `pageSentry()`'s answer. */
export interface LoadTrace {
  setMeasurement(name: string, value: number, unit: string): void;
}

/** The one report, as `bootBoard` has it at send time. */
export interface LoadReportInput {
  workspaceId: string;
  /** ms from navigation start to the boot render. */
  msToBoot: number;
  /** ms to the ydoc's initial sync, or null when it never arrived — the
   *  fallback deadline reports boot-only rather than nothing, because that
   *  slow load is the one most worth recording. */
  msToFirstProjection: number | null;
  sentry: LoadTrace | null;
}

/**
 * POST the report, and stamp the same numbers on the pageload trace.
 *
 * Fire-and-forget by construction: a recorder must never break the page it
 * measures, so the fetch swallows its own failure and the trace write is
 * wrapped.
 */
export function postLoadReport(input: LoadReportInput): void {
  const { workspaceId, msToBoot, msToFirstProjection, sentry } = input;
  // What the network actually moved: "slow because big" and "slow because
  // far" need different fixes, and the report should tell them apart.
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  // Nobody asked for this POST — it is telemetry about the load that just
  // happened. Marked, so that a signed-out reader gets the standing bar
  // rather than a modal demanding they sign in to do something they never
  // did. Measured: unmarked, it raised the modal over the board within
  // four seconds of opening it.
  asBackgroundWrite(() => {
    void fetch(`/workspaces/${encodeURIComponent(workspaceId)}/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msToBoot,
        ...(msToFirstProjection !== null ? { msToFirstProjection } : {}),
        resourceCount: resources.length,
        transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
        decodedBytes: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
      }),
    }).catch(() => {});
  });
  // Same numbers onto the pageload trace, best-effort: if the SDK loaded
  // and the transaction is still open they land as measurements; if not,
  // the posted report above is still the durable record.
  try {
    sentry?.setMeasurement('ms_to_boot', msToBoot, 'millisecond');
    if (msToFirstProjection !== null) {
      sentry?.setMeasurement('ms_to_first_projection', msToFirstProjection, 'millisecond');
    }
  } catch {
    // The recorder never breaks the page it measures.
  }
}
