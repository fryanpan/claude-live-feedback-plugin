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
 * A deliberately-deferred row is a TRIAGE row (parking moves it there and
 * comments why, 2026-08-27), and triage is not classified at all — so a
 * deferral never reads as stalled without a bucket to hold it.
 *
 * For ready-unpicked it also answers "busy or not spawned": whether agents
 * were producing board events at all during the last hours. Activity
 * elsewhere means capacity was busy; silence means work was not spawned.
 *
 * Classification/stall logic lives in scripts/keep-moving-lib.ts (pure,
 * unit-tested); this file is the CLI: fetch, format, print.
 *
 * Usage: bun scripts/keep-moving-report.ts [--base URL] [--ws ID] [--json]
 * The workspace is required: --ws, or FEEDBACK_WORKSPACE_ID in the env.
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
  // No hard-coded board. This repo is public, and a workspace id in a
  // checked-in default is somebody's live board named in the open.
  const ws = arg('ws') ?? process.env.FEEDBACK_WORKSPACE_ID;
  if (!ws) {
    console.error('pass --ws <workspaceId>, or set FEEDBACK_WORKSPACE_ID');
    process.exitCode = 2;
    return;
  }
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
  const activity = agentActivityByHour(events, now, 12, collectActivityTicks(tasks, items, events));

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
    'blocked-on-owner-unfiled',
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
  // Unfiled asks are the protocol violation the 08-27 "PASS" board hid: rows
  // waiting on the owner with nothing on his Home queue to answer. Includes
  // dependency chains whose terminal blocker is itself unfiled.
  const unfiled = rows.filter((r) => r.unfiledAsk);
  if (unfiled.length) {
    lines.push('');
    lines.push('## Unfiled asks (waiting on the owner, NO review item filed)');
    for (const r of unfiled) {
      const via =
        r.bucket === 'blocked-on-dependency' && r.terminal
          ? ` via after ${(r.blockers ?? []).join(', ')} → ${r.terminal.id} [${r.terminal.label}]`
          : '';
      lines.push(`- ${r.id} [${r.bucket}]${via} waiting ${fmt(r.ageMs)} — ${r.title.slice(0, 80)}`);
    }
  }
  // Old filed asks rot: one measured row sat "waiting on Bryan" behind two PRs
  // that had already merged. Visible, but not a verdict failure.
  const AGING_ASK_MS = 7 * 86_400_000;
  const aging = rows.filter((r) => (r.askAgeMs ?? 0) > AGING_ASK_MS);
  if (aging.length) {
    lines.push('');
    lines.push('## Aging asks (filed >7d ago — re-verify the blocker is still real)');
    for (const r of aging)
      lines.push(`- ${r.id} asked ${fmt(r.askAgeMs ?? 0)} ago — ${r.title.slice(0, 80)}`);
  }
  const deps = by('blocked-on-dependency');
  if (deps.length) {
    lines.push('');
    lines.push('## Blocked on dependencies (terminal blocker named)');
    for (const r of deps) {
      // A loop has no terminal — the malformed graph IS the finding.
      if (r.cycle && !r.terminal) {
        lines.push(
          `- ${r.id} dependency CYCLE: ${r.cycle.join(' → ')} — malformed graph, fix the edges — ${r.title.slice(0, 60)}`,
        );
        continue;
      }
      const chain = r.terminal
        ? `after ${(r.blockers ?? []).join(', ')} → ${r.terminal.id} [${r.terminal.label}]`
        : `after ${(r.blockers ?? []).join(', ')}`;
      const cycleNote = r.cycle ? ` [also a CYCLE: ${r.cycle.join(' → ')} — fix the edges]` : '';
      lines.push(`- ${r.id} ${chain}${cycleNote} — ${r.title.slice(0, 80)}`);
    }
  }
  const verdict =
    worst.length === 0 && unfiled.length === 0
      ? 'PASS: every open ticket is either moving or blocked for a named, FILED reason.'
      : `FAIL: ${worst.length} unblocked tickets quiet for >${fmt(stallMs)}` +
        `${unfiled.length ? `; ${unfiled.length} unfiled asks (owner-blocked, nothing on the Home queue)` : ''}.`;
  lines.push('');
  lines.push(`**Verdict: ${verdict}**`);
  console.log(lines.join('\n'));
}

if (import.meta.main) await main();
