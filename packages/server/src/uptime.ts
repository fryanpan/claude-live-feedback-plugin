/**
 * Deploy readiness (plan §3.12 commit 11): uptime measured from the
 * per-workspace events.jsonl audit log, against the 99% availability target
 * (goal 4.4 — "the hub is up when you pull out your phone").
 *
 * The log is the substrate: every event line is proof the server was alive
 * at that instant, so downtime is a GAP analysis — any silence wider than
 * the tick grace means the process was down (or unable to write, which for
 * a hub you can't reach amounts to the same thing). Real store events alone
 * can't carry this — an idle workspace emits nothing for hours — so the
 * UptimeMonitor appends a periodic `server.tick` marker as a liveness
 * floor, plus one `server.started` at boot so a restart bounds the outage
 * it just ended.
 *
 * Markers deliberately do NOT go through TaskStore.emit: §3.6's event table
 * is the exhaustive subscriber contract and has no server.* rows — ticks
 * are measurement substrate, not workspace activity, so nothing should be
 * broadcast to SSE watchers or MCP channels for them. They are appended
 * straight to the same events.jsonl the audit trail lives in, and the
 * events route strips `server.tick` back out of the activity list while
 * feeding every line's timestamp into the analysis. `server.started` stays
 * visible — a restart is honest activity worth a row.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type TaskStore, eventsLogPath } from './tasks.ts';

/** Goal 4.4 (decided 2026-08-13): 99% uptime. */
export const UPTIME_TARGET = 0.99;
/** Liveness floor: one marker per 5 minutes ≈ 12KB/day per workspace, and a
 *  granularity well inside the ~100 minutes of downtime a 99% target allows
 *  over the 7-day window. */
export const UPTIME_TICK_MS = 5 * 60_000;
/** The measurement window the activity view reports over. */
export const UPTIME_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const SERVER_STARTED_EVENT = 'server.started';
export const SERVER_TICK_EVENT = 'server.tick';

export interface UptimeGap {
  from: number;
  to: number;
  downMs: number;
}

export interface UptimeReport {
  target: number;
  windowMs: number;
  /** The span actually measured: `now - max(window start, first event)`.
   *  Shorter than windowMs while the log is younger than the window — no
   *  phantom downtime is charged for time before measurement began. */
  measuredMs: number;
  downMs: number;
  uptimeRatio: number;
  meetsTarget: boolean;
  /** Counted outages, chronological, already clipped to the window. */
  gaps: UptimeGap[];
  tickMs: number;
}

export interface UptimeOptions {
  now: number;
  tickMs?: number;
  windowMs?: number;
  target?: number;
}

/**
 * Pure gap analysis over event timestamps (any event counts as proof of
 * life). A gap wider than 2× the tick interval is an outage; within that
 * grace it's timer jitter or a single lost beat, not downtime. The outage
 * is charged from when the next tick SHOULD have landed (`last + tickMs`)
 * to the event that ended the silence — the fairest estimate the log
 * supports. The silence from the newest event to `now` is analyzed the
 * same way, so a server that just came back from a long nap can't report
 * itself clean. Returns null when there is nothing to measure.
 */
export function analyzeUptime(timestamps: number[], opts: UptimeOptions): UptimeReport | null {
  const { now } = opts;
  const tickMs = opts.tickMs ?? UPTIME_TICK_MS;
  const windowMs = opts.windowMs ?? UPTIME_WINDOW_MS;
  const target = opts.target ?? UPTIME_TARGET;

  const ts = timestamps.filter((t) => Number.isFinite(t) && t <= now).sort((a, b) => a - b);
  if (ts.length === 0) return null;

  const start = Math.max(now - windowMs, ts[0] as number);
  const graceMs = 2 * tickMs;
  const gaps: UptimeGap[] = [];
  let downMs = 0;

  // Every consecutive pair, plus the (newest event → now) tail. Pairs that
  // predate the window still run — their outage interval gets clipped, so a
  // gap straddling the window start contributes exactly its in-window part.
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i] as number;
    const b = i + 1 < ts.length ? (ts[i + 1] as number) : now;
    if (b - a <= graceMs) continue;
    const from = Math.max(a + tickMs, start);
    const to = Math.min(b, now);
    if (to <= from) continue;
    gaps.push({ from, to, downMs: to - from });
    downMs += to - from;
  }

  const measuredMs = now - start;
  const uptimeRatio = measuredMs > 0 ? (measuredMs - downMs) / measuredMs : 1;
  return {
    target,
    windowMs,
    measuredMs,
    downMs,
    uptimeRatio,
    meetsTarget: uptimeRatio >= target,
    gaps,
    tickMs,
  };
}

/** Append one liveness marker line, shaped like every other audit row. */
function appendMarker(dataDir: string, workspaceId: string, event: string, ts: number): void {
  try {
    const path = eventsLogPath(dataDir, workspaceId);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${JSON.stringify({ event, workspaceId, ts })}\n`);
  } catch (err) {
    // Delivery beats bookkeeping, same stance as TaskStore.appendAudit — a
    // full disk must not take the server down over a metric.
    console.error('[uptime] failed to append liveness marker:', err);
  }
}

/**
 * The liveness floor. `start()` stamps `server.started` into every existing
 * workspace's log (bounding whatever outage the restart ended) and then
 * beats `server.tick` on the interval; workspaces created mid-run join the
 * loop on the next beat because the workspace list is re-read each tick.
 */
export class UptimeMonitor {
  private dataDir: string;
  private tasks: TaskStore;
  private tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: { dataDir: string; tasks: TaskStore; tickMs?: number }) {
    this.dataDir = opts.dataDir;
    this.tasks = opts.tasks;
    this.tickMs = opts.tickMs ?? UPTIME_TICK_MS;
  }

  start(): void {
    if (this.timer) return;
    const now = Date.now();
    for (const ws of this.tasks.listWorkspaces()) {
      appendMarker(this.dataDir, ws.id, SERVER_STARTED_EVENT, now);
    }
    this.timer = setInterval(() => {
      const ts = Date.now();
      for (const ws of this.tasks.listWorkspaces()) {
        appendMarker(this.dataDir, ws.id, SERVER_TICK_EVENT, ts);
      }
    }, this.tickMs);
    // Never hold the process (or a test runner) open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
