#!/usr/bin/env bun
/**
 * Keep-moving metrics for a workspace board (asked for by Bryan, 2026-08-26:
 * "figure out how to measure whether keep moving is working or not from
 * ticket stats").
 *
 * The protocol's promise is: ready work gets picked up, in-progress work
 * keeps moving, and anything that stops has a NAMED reason (a dependency
 * edge or a filed ask to the owner). So the report classifies every open
 * ticket into exactly one bucket and measures how long it has sat there:
 *
 *   blocked-on-owner       an open review item targets it — waiting is correct
 *   blocked-on-dependency  an `after` edge names an unfinished task
 *   in-progress            picked up; STALLED if no transition/event recently
 *   ready-unpicked         todo, nothing blocking it — the protocol's debt
 *
 * For ready-unpicked it also answers "busy or not spawned": whether agents
 * were producing board events at all during the last hours. Activity
 * elsewhere means capacity was busy; silence means work was not spawned.
 *
 * Usage: bun scripts/keep-moving-report.ts [--base URL] [--ws ID] [--json]
 * Read-only: two GETs. Safe on prod.
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

function fmt(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

async function main(): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const base = arg('base') ?? 'http://localhost:8787';
  const ws = arg('ws') ?? 'w-DRa7BgNaZkqh';
  const stallMs = Number(arg('stall-hours') ?? '4') * 3_600_000;
  const now = Date.now();

  const [tasksRes, eventsRes, itemsRes] = await Promise.all([
    fetch(`${base}/api/workspaces/${ws}/tasks`),
    fetch(`${base}/api/workspaces/${ws}/events`),
    fetch(`${base}/api/workspaces/${ws}/review-items`),
  ]);
  const tasks = ((await tasksRes.json()) as { tasks: TaskRow[] }).tasks ?? [];
  const wsRes = await fetch(`${base}/api/workspaces/${ws}`);
  const wsBody = (await wsRes.json()) as {
    workspace?: { goals?: Array<{ id: string; name?: string; title?: string }> };
  };
  const goals = wsBody.workspace?.goals ?? [];
  // The decisions band is Bryan's queue by its own description — sitting
  // there is waiting on the owner, not on an agent.
  // Matching on "Bryan" is wrong — his name appears in ordinary goal titles
  // ("Bryan can review and steer…"). Only the decisions band is his queue.
  const ownerBand = new Set(
    goals.filter((g) => /decision/i.test(`${g.id} ${g.name ?? g.title ?? ''}`)).map((g) => g.id),
  );
  const dispatchable = new Set(goals.map((g) => g.id).filter((id) => !ownerBand.has(id)));
  const events = ((await eventsRes.json()) as { events: EventRow[] }).events ?? [];
  const items = ((await itemsRes.json()) as { items: ReviewItemRow[] }).items ?? [];

  const rows = classifyOpenTasks(tasks, events, items, now, stallMs, { dispatchable, ownerBand });
  const activity = agentActivityByHour(events, now, 12);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ now, rows, activity }, null, 2));
    return;
  }

  const by = (b: Bucket) => rows.filter((r) => r.bucket === b);
  const med = (xs: number[]) =>
    xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;
  const lines: string[] = [];
  lines.push(`# Keep-moving report — ${new Date(now).toISOString()}`);
  lines.push('');
  lines.push(`Open tickets: ${rows.length}`);
  for (const b of [
    'ready-unpicked',
    'in-progress',
    'blocked-on-owner',
    'blocked-on-dependency',
    'backlog-unranked',
  ] as Bucket[]) {
    const g = by(b);
    const stalledN = g.filter((r) => r.stalled).length;
    lines.push(
      `- **${b}**: ${g.length}` +
        (g.length
          ? ` (median ${fmt(med(g.map((r) => r.ageMs)) ?? 0)}, max ${fmt(Math.max(...g.map((r) => r.ageMs)))}${stalledN ? `, ${stalledN} stalled >${fmt(stallMs)}` : ''})`
          : ''),
    );
  }
  const activeHours = activity.filter((n) => n > 0).length;
  lines.push('');
  lines.push(
    `Agent activity, last 12h (events/hour, newest first): ${activity.join(' ')} — ` +
      `${activeHours}/12 hours had agent activity. ` +
      'Ready tickets aging while these are >0 means capacity was BUSY; while 0, work was NOT SPAWNED.',
  );
  const worst = rows.filter((r) => r.stalled).slice(0, 10);
  if (worst.length) {
    lines.push('');
    lines.push('## Stalled (oldest silence first)');
    for (const r of worst)
      lines.push(
        `- ${r.id} [${r.bucket}] quiet ${fmt(r.sinceActivityMs)} — ${r.title.slice(0, 90)}`,
      );
  }
  const verdict =
    worst.length === 0
      ? 'PASS: every open ticket is either moving or blocked for a named reason.'
      : `FAIL: ${worst.length} unblocked tickets quiet for >${fmt(stallMs)}.`;
  lines.push('');
  lines.push(`**Verdict: ${verdict}**`);
  console.log(lines.join('\n'));
}

if (import.meta.main) await main();
