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
  /** Why the row was parked — shown in the report so a park reads as a
   *  decision with a date, not as a stuck row. */
  parkedReason?: string;
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
  | 'blocked-on-owner-unfiled'
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
  /** Present on rows parked into the future: when the deferral expires. */
  parkedUntil?: number;
  /** Present with parkedUntil: why the row was parked. */
  parkedReason?: string;
  /** blocked-on-owner only: ms since the NEWEST pending review item was
   *  filed. Old asks go on the "re-verify the blocker is still real" list —
   *  measured: t-BX3kTEZ6M7vY waited on two PRs that had already merged. */
  askAgeMs?: number;
  /** blocked-on-dependency only: the far end of the `after` chain — the row
   *  the whole chain is actually waiting on, and what state it is in. */
  terminal?: { id: string; label: string };
  /** TRUE means this row is waiting on the owner with NO pending review item
   *  anywhere on its chain's terminal — an ask that exists only in someone's
   *  head. Bryan cannot see it on his Home queue, so it counts toward FAIL
   *  (7 of 10 "blocked-on-owner" rows on the 08-27 "PASS" board were this). */
  unfiledAsk: boolean;
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
  // Presence in askedTaskIds is what "an ask is FILED" means; newestAskAt
  // additionally carries the newest pending item's askedAt where one exists,
  // so old asks can go on the re-verify list.
  const askedTaskIds = new Set<string>();
  const newestAskAt = new Map<string, number>();
  for (const r of reviewItems) {
    const id = r.taskId ?? (r.docId?.startsWith('task:') ? r.docId.slice(5) : undefined);
    if (!id) continue;
    askedTaskIds.add(id);
    if (
      typeof r.askedAt === 'number' &&
      r.askedAt > (newestAskAt.get(id) ?? Number.NEGATIVE_INFINITY)
    )
      newestAskAt.set(id, r.askedAt);
  }
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
    // Precedence: pending-item owner-block > parked > unfiled owner-block.
    //
    // A PENDING review item outranks a park (the P2-1 invariant: an ACTIVE
    // ask never hides — it surfaces as blocked-on-owner rather than sitting
    // behind 'parked'). Neither bucket ever stalls, so the parked guarantee
    // is preserved either way.
    //
    // Owner-blocked is only LEGITIMATE waiting when a pending review item
    // exists — that is what puts the ask on Bryan's Home queue. A
    // person-owned row (`ownerKind === 'person'`, the server's authoritative
    // call) or an owner-band row with NO pending item is an ask that exists
    // nowhere he reads: blocked-on-owner-unfiled, a protocol violation that
    // counts toward FAIL (Bryan's 08-27 review: 7 of 10 "blocked-on-owner"
    // rows were invisible on his queue).
    //
    // But a park OUTRANKS the unfiled bucket: a person-owned row somebody
    // deliberately parked with a date and reason is a documented deferral,
    // not a hidden ask (t-6KSlEc3s64Bb: naming explicitly deferred 08-18,
    // parked for exactly that reason, was being nagged as an unfiled ask
    // forever). Nothing hides permanently — parks require a reason, and an
    // expired park resurfaces the row as unfiled.
    const hasPendingAsk = askedTaskIds.has(t.id);
    let bucket: Bucket;
    if (hasPendingAsk) bucket = 'blocked-on-owner';
    else if (parked) bucket = 'parked';
    else if (t.ownerKind === 'person' || bands.ownerBand.has(t.goal ?? ''))
      bucket = 'blocked-on-owner-unfiled';
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
      ...(parked && t.parkedReason ? { parkedReason: t.parkedReason } : {}),
      ...(bucket === 'blocked-on-owner' && newestAskAt.has(t.id)
        ? { askAgeMs: now - (newestAskAt.get(t.id) ?? now) }
        : {}),
      unfiledAsk: bucket === 'blocked-on-owner-unfiled',
    });
  }
  // Second pass: attribute each dependency chain to its TERMINAL blocker —
  // the row the whole chain is actually waiting on. "after t-X" is only half
  // an answer when t-X is itself waiting on Bryan; and a chain that bottoms
  // out in an UNFILED ask is an unfiled ask for every row behind it too.
  //
  // Two Codex findings on #396 shape the walk:
  //  - EVERY unmet branch is traversed (P1): a row with several `after` edges
  //    is unfiled when ANY branch ends unfiled — inspecting only the first
  //    branch produced a false PASS.
  //  - Only a dependency-blocked intermediate is transparent (P2): a dep that
  //    is itself owner-blocked / unfiled / parked / in-progress IS the
  //    effective blocker, so the walk stops there instead of naming a deeper
  //    task and suppressing the intermediate's own state.
  const rowById = new Map(out.map((r) => [r.id, r]));
  for (const r of out) {
    if (r.bucket !== 'blocked-on-dependency') continue;
    const visited = new Set<string>([r.id]);
    const terminals: TaskRow[] = [];
    let cycleNode: TaskRow | undefined;
    const walk = (task: TaskRow): void => {
      for (const dep of task.after ?? []) {
        const d = byId.get(dep);
        if (d === undefined || d.status === 'done') continue;
        if (visited.has(d.id)) {
          cycleNode ??= d; // cycle: remember where it loops rather than hanging
          continue;
        }
        visited.add(d.id);
        if (rowById.get(d.id)?.bucket === 'blocked-on-dependency') walk(d);
        else terminals.push(d);
      }
    };
    const rootTask = byId.get(r.id);
    if (rootTask) walk(rootTask);
    const bucketOf = (task: TaskRow): Bucket | undefined => rowById.get(task.id)?.bucket;
    const anyUnfiled = terminals.some((d) => bucketOf(d) === 'blocked-on-owner-unfiled');
    // One terminal is displayed; the worst branch wins the slot: an unfiled
    // ask, else a filed owner-block, else whatever came first.
    const pick =
      terminals.find((d) => bucketOf(d) === 'blocked-on-owner-unfiled') ??
      terminals.find((d) => bucketOf(d) === 'blocked-on-owner') ??
      terminals[0] ??
      cycleNode;
    if (!pick) continue;
    r.terminal = { id: pick.id, label: bucketOf(pick) ?? pick.status };
    if (anyUnfiled) r.unfiledAsk = true;
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
 * A row timestamp within this of an event for the same task is the SAME
 * action seen through two lenses, not two actions. Measured skew between an
 * event's `ts` and the row fields the same handler writes is tens of
 * milliseconds; 5s covers any debounced flush without swallowing a genuinely
 * separate edit.
 */
const EVENT_TICK_EPSILON_MS = 5_000;

/**
 * Activity timestamps the `/events` feed misses (measured: a Team Lead board
 * row update at 07:19Z never appeared in `/events`, so the histogram read
 * "0/12 hours" across a worked window). Sources, exactly:
 *  - task rows: `updatedAt`, `bodyWrittenAt`, `titleWrittenAt` — deduped per
 *    row, and emitted ONLY as a fallback: a normal transition moves
 *    `updatedAt` AND appears in `/events`, so a timestamp within
 *    EVENT_TICK_EPSILON_MS of any event for the same task is skipped rather
 *    than counted twice (an unconditional tick inflated the histogram exactly
 *    when the events feed worked). The dedup compares against ALL events for
 *    the task, whatever the actor — a person's transition should not re-enter
 *    as an unattributed tick either. These fields carry no actor, so a rare
 *    uncovered person edit still counts — the histogram's question is "was
 *    the board being worked", and an unattributed tick beats a false 0.
 *  - review items: `askedAt` — filing an ask is agent work; deduped the same
 *    way against the item's task, should a filing ever start emitting events.
 */
export function collectActivityTicks(
  tasks: TaskRow[],
  reviewItems: ReviewItemRow[],
  events: EventRow[] = [],
): number[] {
  const eventTsByTask = new Map<string, number[]>();
  for (const e of events) {
    if (!e.taskId) continue;
    const list = eventTsByTask.get(e.taskId);
    if (list) list.push(e.ts);
    else eventTsByTask.set(e.taskId, [e.ts]);
  }
  const coveredByEvent = (taskId: string | undefined, ts: number): boolean => {
    if (!taskId) return false;
    const list = eventTsByTask.get(taskId);
    return list?.some((et) => Math.abs(et - ts) <= EVENT_TICK_EPSILON_MS) ?? false;
  };
  const ticks: number[] = [];
  for (const t of tasks) {
    const seen = new Set<number>();
    for (const ts of [t.updatedAt, t.bodyWrittenAt, t.titleWrittenAt]) {
      if (typeof ts === 'number' && ts > 0 && !seen.has(ts) && !coveredByEvent(t.id, ts)) {
        seen.add(ts);
        ticks.push(ts);
      }
    }
  }
  for (const r of reviewItems) {
    if (typeof r.askedAt === 'number' && r.askedAt > 0 && !coveredByEvent(r.taskId, r.askedAt))
      ticks.push(r.askedAt);
  }
  return ticks;
}
