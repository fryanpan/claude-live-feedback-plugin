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
  /**
   * The server's AUTHORITATIVE resolution of who owns the row —
   * `'agent' | 'person' | 'unknown'` from `taskProjection.ownerKindReader`
   * (it resolves assignee + assigneeKind against the attached-agent roster).
   * Prefer this over reading `assignee` / `assigneeKind` here: on the live
   * board `assigneeKind` is often null while `ownerKind` is always present.
   */
  ownerKind?: string;
  assignee?: string;
  /** Row-edit timestamps — activity the /events feed has measurably missed. */
  updatedAt?: number;
  bodyWrittenAt?: number;
  titleWrittenAt?: number;
  /**
   * Epoch ms until which the row is deliberately deferred. The API also
   * carries a possibly-null `parked` convenience field — compare
   * `parkedUntil > now` yourself rather than trusting it.
   */
  parkedUntil?: number | null;
}
export interface EventRow {
  taskId?: string;
  ts: number;
  actor?: { kind?: string; name?: string };
}
export interface ReviewItemRow {
  taskId?: string;
  docId?: string;
  /** When the ask was filed — a review filing is board activity. */
  askedAt?: number;
}

export type Bucket =
  | 'blocked-on-owner'
  | 'blocked-on-dependency'
  | 'in-progress'
  | 'ready-unpicked'
  | 'backlog-unranked'
  | 'parked';

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
  /** Present on parked rows: when the deferral expires. */
  parkedUntil?: number;
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
  /**
   * Latest `thread.lastActivity` per taskId, from the row's discussion doc
   * (`GET /api/docs/task:<id>/threads`). A comment IS activity: a row whose
   * whole decision conversation is live on its thread is not quiet. The CLI
   * fetches these only for rows a first pass reported stalled, which caps the
   * per-row calls at the handful being reported. (The `/api/docs` listing's
   * `lastActivityAt` is NOT usable here — it is a `.ydoc` mtime, refreshed by
   * server-side snapshot rewrites; see packages/server/src/landing.ts rule 1.)
   */
  threadActivity?: Map<string, number>,
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
    const sinceActivityMs =
      now -
      Math.max(enteredStatusAt(t), lastEventByTask.get(t.id) ?? 0, threadActivity?.get(t.id) ?? 0);
    // A row parked into the future is deliberately deferred — it must never
    // read as stalled (measured false-FAIL: t-FbXgQ6m9e-et, parked to
    // 2026-08-28, reported "ready-unpicked stalled" at 07:59Z).
    const parked = t.parkedUntil != null && t.parkedUntil > now;
    // A person-owned row is waiting on its owner, not on agent capacity —
    // `ownerKind === 'person'` is the server's authoritative call (gap 1:
    // t-Q6DTQn05IMPo, assignee "human", read as a dark in-progress row).
    let bucket: Bucket;
    if (parked) bucket = 'parked';
    else if (
      t.ownerKind === 'person' ||
      askedTaskIds.has(t.id) ||
      bands.ownerBand.has(t.goal ?? '')
    )
      bucket = 'blocked-on-owner';
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
      ...(parked && t.parkedUntil != null ? { parkedUntil: t.parkedUntil } : {}),
    });
  }
  return out.sort((a, b) => b.sinceActivityMs - a.sinceActivityMs);
}

/**
 * Agent activity per recent hour — the "busy or not spawned" evidence.
 *
 * What is counted, exactly:
 *  - every `/events` row whose `actor.kind === 'agent'` — on the live server
 *    that is the task.* family (transitioned, created, regrouped, body_edited,
 *    parked, assigned, retitled, archived, evidence_amended, restored),
 *    decision.answered, and workspace.* edits. Rows with no actor
 *    (agent.heartbeat, agent.attached, server.started) are excluded: they are
 *    liveness, not work.
 *  - `extraTicks`: timestamps from `collectActivityTicks` below — row edits
 *    and review-item filings the events feed does not reliably carry.
 */
export function agentActivityByHour(
  events: EventRow[],
  now: number,
  hours: number,
  extraTicks: number[] = [],
): number[] {
  const buckets = new Array<number>(hours).fill(0);
  const add = (ts: number) => {
    const h = Math.floor((now - ts) / 3_600_000);
    if (h >= 0 && h < hours) buckets[h] = (buckets[h] ?? 0) + 1;
  };
  for (const e of events) {
    if (e.actor?.kind !== 'agent') continue;
    add(e.ts);
  }
  for (const ts of extraTicks) add(ts);
  return buckets; // index 0 = the most recent hour
}

/**
 * Activity timestamps the `/events` feed misses (measured: a Team Lead board
 * row update at 07:19Z never appeared in `/events`, so the histogram read
 * "0/12 hours" across a worked window). Sources, exactly:
 *  - task rows: `updatedAt`, `bodyWrittenAt`, `titleWrittenAt` — deduped per
 *    row (a transition also moves `updatedAt`; double-counting an hour that
 *    events already cover is harmless, a false 0 is not). These fields carry
 *    no actor, so a rare person edit counts too — the histogram's question is
 *    "was the board being worked", and an unattributed tick beats a false 0.
 *  - review items: `askedAt` — filing an ask is agent work.
 */
export function collectActivityTicks(tasks: TaskRow[], reviewItems: ReviewItemRow[]): number[] {
  const ticks: number[] = [];
  for (const t of tasks) {
    const seen = new Set<number>();
    for (const ts of [t.updatedAt, t.bodyWrittenAt, t.titleWrittenAt]) {
      if (typeof ts === 'number' && ts > 0 && !seen.has(ts)) {
        seen.add(ts);
        ticks.push(ts);
      }
    }
  }
  for (const r of reviewItems) {
    if (typeof r.askedAt === 'number' && r.askedAt > 0) ticks.push(r.askedAt);
  }
  return ticks;
}
