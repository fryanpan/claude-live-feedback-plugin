/**
 * Pure classification/stall logic for the keep-moving report — extracted from
 * scripts/keep-moving-report.ts so it is unit-testable without a server.
 * The CLI (keep-moving-report.ts) owns fetching and formatting; this module
 * owns every decision about what counts as blocked, stalled, or active.
 */

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  goal?: string;
  after?: string[];
  createdAt: number;
  transitions?: Array<{ ts: number; to?: string; by?: { kind?: string; name?: string } }>;
}
export interface EventRow {
  taskId?: string;
  ts: number;
  actor?: { kind?: string; name?: string };
}
export interface ReviewItemRow {
  taskId?: string;
  docId?: string;
}

export type Bucket =
  | 'blocked-on-owner'
  | 'blocked-on-dependency'
  | 'in-progress'
  | 'ready-unpicked'
  | 'backlog-unranked';

export interface Classified {
  id: string;
  title: string;
  bucket: Bucket;
  /** ms in the current bucket (entered current status, or created). */
  ageMs: number;
  /** ms since ANY activity touched it (transition or board event). */
  sinceActivityMs: number;
  stalled: boolean;
  blockers?: string[];
}

/** A ticket's own clock: when it entered its current status. */
function enteredStatusAt(t: TaskRow): number {
  const last = t.transitions?.[t.transitions.length - 1];
  return last?.ts ?? t.createdAt;
}

export function classifyOpenTasks(
  tasks: TaskRow[],
  events: EventRow[],
  reviewItems: ReviewItemRow[],
  now: number,
  stallMs: number,
  bands: { dispatchable: Set<string>; ownerBand: Set<string> },
): Classified[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const askedTaskIds = new Set(
    reviewItems
      .map((r) => r.taskId ?? (r.docId?.startsWith('task:') ? r.docId.slice(5) : undefined))
      .filter((x): x is string => Boolean(x)),
  );
  const lastEventByTask = new Map<string, number>();
  for (const e of events) {
    if (e.taskId && e.ts > (lastEventByTask.get(e.taskId) ?? 0))
      lastEventByTask.set(e.taskId, e.ts);
  }
  const out: Classified[] = [];
  for (const t of tasks) {
    if (t.status !== 'todo' && t.status !== 'in-progress') continue;
    const unmet = (t.after ?? []).filter((dep) => {
      const d = byId.get(dep);
      return d !== undefined && d.status !== 'done';
    });
    const ageMs = now - enteredStatusAt(t);
    const sinceActivityMs = now - Math.max(enteredStatusAt(t), lastEventByTask.get(t.id) ?? 0);
    let bucket: Bucket;
    if (askedTaskIds.has(t.id) || bands.ownerBand.has(t.goal ?? '')) bucket = 'blocked-on-owner';
    else if (unmet.length > 0) bucket = 'blocked-on-dependency';
    else if (t.status === 'in-progress') bucket = 'in-progress';
    // Bryan's rule (2026-08-22): the backlog is NOT auto-dispatched — goal
    // bands run in priority order, everything else waits for a person to
    // rank it. A ticket in a band the goal list does not name is idle BY
    // RULE, so it must not read as a protocol failure — but the bucket is
    // reported, because 53 tickets sitting unranked is its own finding.
    else if (!bands.dispatchable.has(t.goal ?? '')) bucket = 'backlog-unranked';
    else bucket = 'ready-unpicked';
    out.push({
      id: t.id,
      title: t.title,
      bucket,
      ageMs,
      sinceActivityMs,
      // A blocked ticket is allowed to be old; only unblocked buckets stall.
      stalled:
        (bucket === 'in-progress' || bucket === 'ready-unpicked') && sinceActivityMs > stallMs,
      ...(unmet.length > 0 ? { blockers: unmet } : {}),
    });
  }
  return out.sort((a, b) => b.sinceActivityMs - a.sinceActivityMs);
}

/** Agent activity per recent hour — the "busy or not spawned" evidence. */
export function agentActivityByHour(events: EventRow[], now: number, hours: number): number[] {
  const buckets = new Array<number>(hours).fill(0);
  for (const e of events) {
    if (e.actor?.kind !== 'agent') continue;
    const h = Math.floor((now - e.ts) / 3_600_000);
    if (h >= 0 && h < hours) buckets[h] = (buckets[h] ?? 0) + 1;
  }
  return buckets; // index 0 = the most recent hour
}
