import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Boot cost and steady-state poll cost, measured rather than reasoned about.
 *
 * `node:fs` is mocked BEFORE `rooms.ts` is imported so every `statSync` /
 * `existsSync` the room layer performs runs through a counter. That is the
 * honest way to count the mtime poll: its body is two stat syscalls per tick
 * per bound doc, twice a second, and on the production box 1,672 re-bound
 * docs made that a permanent background load for documents nobody had open.
 *
 * Fixtures are synthetic (public repo) and built in a SUBPROCESS — the
 * builder's own save timers and polls would otherwise land inside the
 * steady-state window this measures.
 */

const fs = { ...realFs };
let statCalls = 0;
let existsCalls = 0;
/**
 * Only count syscalls against THIS test's fixture paths. The whole suite runs
 * in one process, so an unfiltered counter measures every other test file's
 * bindings too — which is how the steady-state assertion passed alone and
 * failed in the full run.
 */
let countedPrefixes: string[] = [];
const counts = (args: unknown[]): boolean => {
  const p = args[0];
  return typeof p === 'string' && countedPrefixes.some((prefix) => p.startsWith(prefix));
};

mock.module('node:fs', () => ({
  ...fs,
  statSync: (...args: unknown[]) => {
    if (counts(args)) statCalls++;
    return (fs.statSync as (...a: unknown[]) => unknown)(...args);
  },
  existsSync: (...args: unknown[]) => {
    if (counts(args)) existsCalls++;
    return (fs.existsSync as (...a: unknown[]) => unknown)(...args);
  },
}));

const { Rooms } = await import('../src/rooms.ts');
const { SseHub } = await import('../src/sse.ts');
const { createWebhookDispatcher } = await import('../src/webhooks.ts');

type RoomsInstance = InstanceType<typeof Rooms>;

function makeRooms(dataDir: string): RoomsInstance {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fixture size. The committed defaults are small enough to keep the suite
 * fast; the env overrides exist so the same harness can be run at production
 * scale (`LF_BOOTPERF_LIVE=1672 LF_BOOTPERF_DEAD=1469 LF_BOOTPERF_HUB=600
 * LF_BOOTPERF_BODY=40`) without a second, drifting copy of it.
 */
const envNum = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
/** Bound docs whose source file still exists — the ones that re-bind at boot
 *  and, before this change, each armed a poll forever. */
const LIVE_BOUND = envNum('LF_BOOTPERF_LIVE', 400);
/** Bound docs whose source file is gone — loaded and parsed, never polled. */
const DEAD_BOUND = envNum('LF_BOOTPERF_DEAD', 150);
/** Hub rooms (`task:`) — server-owned, never file-bound. */
const HUB = envNum('LF_BOOTPERF_HUB', 50);
/** Body paragraphs per synthetic doc. */
const BODY = envNum('LF_BOOTPERF_BODY', 3);
const TOTAL = LIVE_BOUND + DEAD_BOUND + HUB;

let dataDir: string;
let srcDir: string;
let aliasToId: Record<string, string> = {};
let liveIds: string[] = [];

describe('boot cost', () => {
  let booted: RoomsInstance;
  let bootMs = 0;
  let bootStatCalls = 0;
  let steadyStatRate = 0;
  let rssDeltaMb = 0;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'lf-bootperf-data-'));
    srcDir = fs.mkdtempSync(join(tmpdir(), 'lf-bootperf-src-'));
    countedPrefixes = [dataDir, srcDir];
    const built = Bun.spawnSync([
      process.execPath,
      'run',
      join(import.meta.dir, 'fixtures', 'make-boot-fixture.ts'),
      dataDir,
      srcDir,
      String(LIVE_BOUND),
      String(DEAD_BOUND),
      String(HUB),
      String(BODY),
    ]);
    if (built.exitCode !== 0) {
      throw new Error(`fixture build failed: ${built.stderr.toString()}`);
    }
    const lines = built.stdout.toString().trim().split('\n');
    ({ aliasToId, liveIds } = JSON.parse(lines[lines.length - 1]));

    statCalls = 0;
    existsCalls = 0;
    const rssBefore = process.memoryUsage.rss();
    const t0 = performance.now();
    booted = makeRooms(dataDir);
    bootMs = performance.now() - t0;
    bootStatCalls = statCalls + existsCalls;
    rssDeltaMb = (process.memoryUsage.rss() - rssBefore) / 1024 / 1024;

    // Steady state: stat syscalls over a window with nothing happening.
    statCalls = 0;
    existsCalls = 0;
    const w0 = performance.now();
    await sleep(1100);
    const windowSec = (performance.now() - w0) / 1000;
    steadyStatRate = (statCalls + existsCalls) / windowSec;

    console.log(
      `\n[boot-perf] docs=${TOTAL} (bound-live=${LIVE_BOUND} bound-dead=${DEAD_BOUND} hub=${HUB})\n` +
        `[boot-perf] boot=${bootMs.toFixed(0)}ms bootStatCalls=${bootStatCalls}\n` +
        `[boot-perf] steadyStatRate=${steadyStatRate.toFixed(0)}/s ` +
        `rssDelta=${rssDeltaMb.toFixed(0)}MB\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(srcDir, { recursive: true, force: true });
  });

  it('the syscall counter can see a real call', () => {
    // Positive control for the assertion below. A filter that matched nothing
    // would report a serene 0/s steady state no matter what the poll was
    // doing, so prove the probe speaks before trusting its silence.
    expect(bootStatCalls).toBeGreaterThan(0);
  });

  it('every persisted doc is discoverable after boot', () => {
    expect(booted.list().length).toBe(TOTAL);
    expect(liveIds.length).toBe(LIVE_BOUND);
  });

  it('every alias still resolves to the doc it was minted for', () => {
    // Through `metaOf`, which resolves aliases the same way `get` does but
    // does not bind. Sweeping 3,141 aliases through `get` would establish
    // every binding in the fixture and leave the later measurements reading
    // this test's own footprint rather than the server's.
    for (const [alias, docId] of Object.entries(aliasToId)) {
      expect(booted.metaOf(alias)?.docId).toBe(docId);
    }
    // Spot-check the binding door itself on one doc, so "resolves" is not
    // only proven through the non-binding accessor.
    const [firstAlias, firstId] = Object.entries(aliasToId)[0] ?? [];
    expect(booted.get(firstAlias ?? '')?.docId).toBe(firstId);
  });

  it('steady state does not poll docs nobody has opened', () => {
    expect(steadyStatRate).toBeLessThan(50);
  });

  it('a landing-page sweep over every doc does not re-arm the polls', async () => {
    // The exclusion that keeps the win: `list` + `listThreads` per doc is
    // what the landing page does, and binding there would put all ~1,672
    // polls back on the first page view. Measured, because this is precisely
    // the mistake that reads correct.
    for (const meta of booted.list()) {
      booted.listThreads(meta.docId);
      booted.metaOf(meta.docId);
    }
    statCalls = 0;
    existsCalls = 0;
    const w0 = performance.now();
    await sleep(1100);
    const rate = (statCalls + existsCalls) / ((performance.now() - w0) / 1000);
    expect(rate).toBeLessThan(50);
  });
});
