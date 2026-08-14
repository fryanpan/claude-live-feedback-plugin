/**
 * Deploy readiness (plan §3.12 commit 11): uptime measured from the
 * per-workspace events.jsonl — "the hub is up when you pull out your phone"
 * (goal 4.4, 99% target) becomes a number computed from the same audit log
 * every subscriber already sees.
 *
 * Three layers, each proven at its own grain:
 *  - analyzeUptime: pure gap math over event timestamps (any event is proof
 *    of life; a gap wider than the tick grace is an outage).
 *  - UptimeMonitor: the liveness floor — periodic server.tick markers so an
 *    idle workspace's log still has density to analyze.
 *  - The route: GET /api/workspaces/:id/events carries the report and strips
 *    tick rows from the activity list (measurement substrate, not activity).
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore, eventsLogPath } from '../src/tasks.ts';
import {
  SERVER_STARTED_EVENT,
  SERVER_TICK_EVENT,
  UPTIME_TARGET,
  UPTIME_TICK_MS,
  UPTIME_WINDOW_MS,
  UptimeMonitor,
  analyzeUptime,
} from '../src/uptime.ts';

const MIN = 60_000;

describe('analyzeUptime (pure gap math)', () => {
  it('steady ticks with no gap → 100% uptime, meets the target (positive control)', () => {
    const ts: number[] = [];
    for (let t = 0; t <= 60 * MIN; t += MIN) ts.push(t);
    const report = analyzeUptime(ts, { now: 60 * MIN, tickMs: MIN });
    expect(report).not.toBeNull();
    expect(report?.downMs).toBe(0);
    expect(report?.uptimeRatio).toBe(1);
    expect(report?.meetsTarget).toBe(true);
    expect(report?.gaps).toEqual([]);
    expect(report?.measuredMs).toBe(60 * MIN);
    expect(report?.target).toBe(UPTIME_TARGET);
  });

  it('a hole in the log is an outage: down from expected-next-tick to the next event', () => {
    // Ticks every minute 0..10m, silence until 70m, ticks again to 80m.
    const ts: number[] = [];
    for (let t = 0; t <= 10 * MIN; t += MIN) ts.push(t);
    for (let t = 70 * MIN; t <= 80 * MIN; t += MIN) ts.push(t);
    const report = analyzeUptime(ts, { now: 80 * MIN, tickMs: MIN });
    expect(report?.gaps).toEqual([{ from: 11 * MIN, to: 70 * MIN, downMs: 59 * MIN }]);
    expect(report?.downMs).toBe(59 * MIN);
    expect(report?.measuredMs).toBe(80 * MIN);
    expect(report?.uptimeRatio).toBeCloseTo((80 * MIN - 59 * MIN) / (80 * MIN), 10);
    expect(report?.meetsTarget).toBe(false);
  });

  it('a stale tail counts: silence from the last event to now is downtime too', () => {
    const ts = [0, MIN, 2 * MIN];
    const report = analyzeUptime(ts, { now: 32 * MIN, tickMs: MIN });
    expect(report?.gaps).toEqual([{ from: 3 * MIN, to: 32 * MIN, downMs: 29 * MIN }]);
    expect(report?.downMs).toBe(29 * MIN);
  });

  it('a gap within the grace (≤ 2× tick) is jitter, not an outage', () => {
    const ts = [0, MIN, 3 * MIN, 4 * MIN]; // one missed beat: gap of exactly 2×tick
    const report = analyzeUptime(ts, { now: 4 * MIN, tickMs: MIN });
    expect(report?.downMs).toBe(0);
    expect(report?.gaps).toEqual([]);
  });

  it('clips an outage that straddles the window start; measures only the window', () => {
    // Window = last 30m of a 100m history. Outage 5m..50m straddles the
    // window start (70m): only 70m..50m — nothing — wait: outage ends at 50m
    // which is BEFORE the window start, so nothing of it counts. Use an
    // outage 60m..85m instead: in-window part is 70m..85m.
    const ts = [0, 5 * MIN, 60 * MIN, 85 * MIN, 95 * MIN, 100 * MIN];
    const report = analyzeUptime(ts, {
      now: 100 * MIN,
      tickMs: 5 * MIN,
      windowMs: 30 * MIN,
    });
    expect(report?.measuredMs).toBe(30 * MIN);
    // Outage from 60m+tick=65m → 85m, clipped to window start 70m → 70m..85m.
    expect(report?.gaps).toEqual([{ from: 70 * MIN, to: 85 * MIN, downMs: 15 * MIN }]);
    expect(report?.downMs).toBe(15 * MIN);
  });

  it('measurement starts at the first event, not the window edge — no phantom downtime before the log existed', () => {
    // First event 10m ago with a 7-day window: measuredMs is 10m, ratio 1.
    const now = 1_700_000_000_000;
    const ts = [now - 10 * MIN, now - 5 * MIN, now];
    const report = analyzeUptime(ts, { now, tickMs: 5 * MIN });
    expect(report?.measuredMs).toBe(10 * MIN);
    expect(report?.uptimeRatio).toBe(1);
  });

  it('returns null when there is nothing to measure', () => {
    expect(analyzeUptime([], { now: 1000 })).toBeNull();
  });

  it('defaults: 5-minute ticks, 7-day window, 99% target', () => {
    expect(UPTIME_TICK_MS).toBe(5 * MIN);
    expect(UPTIME_WINDOW_MS).toBe(7 * 24 * 60 * MIN);
    expect(UPTIME_TARGET).toBe(0.99);
  });
});

describe('UptimeMonitor (liveness markers)', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-uptime-mon-'));
    store = new TaskStore({ dataDir, debounceMs: 1 });
  });

  afterAll(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const markerLines = (workspaceId: string): Array<{ event: string; ts: number }> => {
    const path = eventsLogPath(dataDir, workspaceId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  };

  it('stamps server.started on start, ticks while running, and stops cleanly', async () => {
    const ws = store.createWorkspace('harborlight-deploy');
    const monitor = new UptimeMonitor({ dataDir, tasks: store, tickMs: 25 });
    monitor.start();
    // Started marker lands synchronously for every existing workspace.
    expect(markerLines(ws.id).some((l) => l.event === SERVER_STARTED_EVENT)).toBe(true);

    await new Promise((r) => setTimeout(r, 120));
    const ticks = markerLines(ws.id).filter((l) => l.event === SERVER_TICK_EVENT).length;
    expect(ticks).toBeGreaterThanOrEqual(2);

    monitor.stop();
    await new Promise((r) => setTimeout(r, 80));
    const after = markerLines(ws.id).filter((l) => l.event === SERVER_TICK_EVENT).length;
    expect(after).toBe(ticks); // no beats after stop
  });

  it('a workspace created after start joins the tick loop', async () => {
    const monitor = new UptimeMonitor({ dataDir, tasks: store, tickMs: 25 });
    monitor.start();
    const late = store.createWorkspace('late-joiner');
    await new Promise((r) => setTimeout(r, 120));
    monitor.stop();
    expect(markerLines(late.id).some((l) => l.event === SERVER_TICK_EVENT)).toBe(true);
  });
});

describe('GET /api/workspaces/:id/events — uptime rendered into the activity payload', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-uptime-route-'));
    handle = createServer({ port: 0, dataDir, uptimeTickMs: 25 });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries an uptime report computed from the log, and strips tick rows from the activity list', async () => {
    const createRes = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'deploy-check', goal: 'Stay up.' }),
    });
    expect(createRes.ok).toBe(true);
    const { workspace } = (await createRes.json()) as { workspace: { id: string } };

    // One real store event so the activity list has a row to keep.
    const taskRes = await fetch(`${base}/api/workspaces/${workspace.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Watch the gauges', assignee: 'human' }),
    });
    expect(taskRes.ok).toBe(true);

    // Let the 25ms tick loop write real markers.
    await new Promise((r) => setTimeout(r, 120));

    // Positive control for the absence below: the raw log really does
    // contain tick lines — otherwise "no ticks in the response" is vacuous.
    const raw = readFileSync(eventsLogPath(dataDir, workspace.id), 'utf8');
    expect(raw).toContain(`"event":"${SERVER_TICK_EVENT}"`);

    const res = await fetch(`${base}/api/workspaces/${workspace.id}/events`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      events: Array<{ event: string }>;
      uptime: { uptimeRatio: number; meetsTarget: boolean; target: number } | null;
    };
    // The activity list keeps real events and drops the measurement substrate.
    expect(body.events.some((e) => e.event === 'task.created')).toBe(true);
    expect(body.events.some((e) => e.event === SERVER_TICK_EVENT)).toBe(false);
    // The report exists and is internally consistent. (No ratio-quality
    // claim here: at a 25ms tick the grace window is 50ms, and event-loop
    // jitter under test load is the same order of magnitude — exact numbers
    // go through the real route in the synthetic-log test below, and the
    // math itself is pinned by the pure tests above.)
    expect(body.uptime).not.toBeNull();
    const u = body.uptime as NonNullable<typeof body.uptime> & {
      tickMs: number;
      downMs: number;
      measuredMs: number;
    };
    expect(u.target).toBe(UPTIME_TARGET);
    expect(u.tickMs).toBe(25);
    expect(u.uptimeRatio).toBeCloseTo((u.measuredMs - u.downMs) / u.measuredMs, 10);
    expect(u.meetsTarget).toBe(u.uptimeRatio >= u.target);
  });

  it('a synthetic outage at real scale comes back with exact numbers through the route', async () => {
    // A second server with the DEFAULT 5-minute tick: its live loop cannot
    // fire inside this test, so the hand-written log below is the only
    // measurement substrate and the numbers are deterministic.
    const dir2 = mkdtempSync(join(tmpdir(), 'lf-uptime-route2-'));
    const handle2 = createServer({ port: 0, dataDir: dir2 });
    try {
      const base2 = `http://localhost:${handle2.port}`;
      const createRes = await fetch(`${base2}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'outage-postmortem' }),
      });
      const { workspace } = (await createRes.json()) as { workspace: { id: string } };

      // 60 minutes of history: started + ticks to −50m, silence (the
      // outage), ticks resume at −10m. Expected: down from −45m (the beat
      // that never came) to −10m = 35 minutes of a 60-minute measurement.
      const now = Date.now();
      const at = (minAgo: number) => now - minAgo * MIN;
      const lines = [
        { event: SERVER_STARTED_EVENT, workspaceId: workspace.id, ts: at(60) },
        { event: SERVER_TICK_EVENT, workspaceId: workspace.id, ts: at(55) },
        { event: SERVER_TICK_EVENT, workspaceId: workspace.id, ts: at(50) },
        { event: SERVER_TICK_EVENT, workspaceId: workspace.id, ts: at(10) },
        { event: SERVER_TICK_EVENT, workspaceId: workspace.id, ts: at(5) },
        { event: SERVER_TICK_EVENT, workspaceId: workspace.id, ts: at(0) },
      ];
      const { appendFileSync, mkdirSync } = await import('node:fs');
      const logPath = eventsLogPath(dir2, workspace.id);
      mkdirSync(join(dir2, 'workspaces'), { recursive: true });
      appendFileSync(logPath, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

      const res = await fetch(`${base2}/api/workspaces/${workspace.id}/events`);
      const body = (await res.json()) as {
        events: Array<{ event: string }>;
        uptime: {
          downMs: number;
          measuredMs: number;
          uptimeRatio: number;
          meetsTarget: boolean;
          gaps: Array<{ downMs: number }>;
        } | null;
      };
      // server.started is honest activity and stays visible (presence
      // control for the tick absence right after it).
      expect(body.events.some((e) => e.event === SERVER_STARTED_EVENT)).toBe(true);
      expect(body.events.some((e) => e.event === SERVER_TICK_EVENT)).toBe(false);
      expect(body.uptime).not.toBeNull();
      const u = body.uptime as NonNullable<typeof body.uptime>;
      // Date.now() at request time drifts a few ms past `now` — allow 5s.
      const SLOP = 5_000;
      expect(Math.abs(u.downMs - 35 * MIN)).toBeLessThan(SLOP);
      expect(Math.abs(u.measuredMs - 60 * MIN)).toBeLessThan(SLOP);
      expect(u.gaps.length).toBe(1);
      // 25 up of 60 measured ≈ 41.7% — far below 99%.
      expect(u.uptimeRatio).toBeLessThan(0.5);
      expect(u.meetsTarget).toBe(false);
    } finally {
      await handle2.stop();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('reports uptime: null for a workspace whose log has no lines yet', async () => {
    const createRes = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unmeasured' }),
    });
    const { workspace } = (await createRes.json()) as { workspace: { id: string } };
    // A brand-new workspace may already have caught a tick from the loop, so
    // which answer is correct depends on the log — and the log is read on
    // BOTH sides of the request, because a tick landing between the response
    // and a single read makes the check demand an answer the server could
    // not have given yet. (That race went red on CI while passing locally.)
    const path = eventsLogPath(dataDir, workspace.id);
    const hasLines = () => existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
    const before = hasLines();
    const res = await fetch(`${base}/api/workspaces/${workspace.id}/events`);
    const body = (await res.json()) as { events: unknown[]; uptime: unknown };
    const after = hasLines();
    if (before !== after) {
      // A tick raced the request: both answers are honest, so all this can
      // still assert is that the field IS one of the two shapes.
      expect(body.uptime === null || typeof body.uptime === 'object').toBe(true);
    } else if (after) {
      expect(body.uptime).not.toBeNull();
    } else {
      expect(body.uptime).toBeNull();
    }
    expect(body.events).toEqual([]);
  });
});
