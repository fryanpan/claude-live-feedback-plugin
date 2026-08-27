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
 *   parked                 parkedUntil > now — deliberately deferred, never stalled
 *
 * For ready-unpicked it also answers "busy or not spawned": whether agents
 * were producing board events at all during the last hours. Activity
 * elsewhere means capacity was busy; silence means work was not spawned.
 *
 * Classification/stall logic lives in scripts/keep-moving-lib.ts (pure,
 * unit-tested); this file is the CLI: fetch, format, print.
 *
 * Usage: bun scripts/keep-moving-report.ts [--base URL] [--ws ID] [--json]
 * Read-only GETs only. Safe on prod.
 */

import {
  type Bucket,
  type EventRow,
  type ReviewItemRow,
  type TaskRow,
  agentActivityByHour,
  classifyOpenTasks,
  collectActivityTicks,
} from './keep-moving-lib.ts';

export * from './keep-moving-lib.ts';

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

  const bands = { dispatchable, ownerBand };
  let rows = classifyOpenTasks(tasks, events, items, now, stallMs, bands);
  // Second pass for rows the first pass called stalled: their task:<id>
  // discussion threads may hold the activity the board events missed (the
  // per-doc threads route is the only trustworthy source — the /api/docs
  // listing's lastActivityAt is a .ydoc mtime, poisoned by snapshot rewrites).
  // Fetching only for already-stalled rows caps the extra calls at the
  // handful being reported.
  const stalledIds = rows.filter((r) => r.stalled).map((r) => r.id);
  if (stalledIds.length > 0) {
    const threadActivity = new Map<string, number>();
    await Promise.all(
      stalledIds.map(async (id) => {
        try {
          const res = await fetch(`${base}/api/docs/${encodeURIComponent(`task:${id}`)}/threads`);
          if (!res.ok) return; // no discussion doc — nothing to reset
          const body = (await res.json()) as { threads?: Array<{ lastActivity?: number }> };
          const last = Math.max(0, ...(body.threads ?? []).map((t) => t.lastActivity ?? 0));
          if (last > 0) threadActivity.set(id, last);
        } catch {
          // unreachable doc: leave the first-pass verdict standing
        }
      }),
    );
    if (threadActivity.size > 0)
      rows = classifyOpenTasks(tasks, events, items, now, stallMs, bands, threadActivity);
  }
  const activity = agentActivityByHour(events, now, 12, collectActivityTicks(tasks, items));

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
    'parked',
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
