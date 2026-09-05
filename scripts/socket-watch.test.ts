/**
 * The socket watcher's alerting path, driven end to end.
 *
 * The defect this covers: the watcher logged WARN to its CSV for eight hours
 * before the Mac ran out of kernel TCP control blocks on 2026-09-04, and told
 * nobody. What has to be true now is not "it can post" but "it posts ONCE per
 * state change" — at a 15s cadence, an eight-hour WARN is 1,920 samples, and
 * a comment per sample buries the row it lands on.
 *
 * So the shape of the test is a sequence, not a call: OK → WARN → WARN →
 * CRITICAL → OK, against a fake CSV and a temp state file, asserting exactly
 * three posts land and naming which ones. Every run is `--dry-run`; nothing
 * here may reach the real board.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ALERTER = join(import.meta.dirname, 'socket-watch-alert.py');

let dir: string;
let csv: string;
let state: string;

/**
 * An hour of samples climbing at a steady 3,600 leaked blocks an hour, ending
 * at `endLeak`. Real column order, because the alerter reads the CSV by header
 * name and a renamed column must fail this test rather than pass it silently.
 */
function writeCsv(endLeak: number): void {
  const rows = ['ts,status,pcbcount,enumerable_sockets,mbuf_pct,canary,top_holders'];
  const end = Date.UTC(2026, 8, 4, 12, 0, 0);
  const samples = 60;
  for (let i = 0; i < samples; i++) {
    const at = new Date(end - (samples - 1 - i) * 60_000);
    const leak = endLeak - (samples - 1 - i) * 60;
    const enumerable = 300;
    const ts = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
    rows.push(`${ts},OK,${leak + enumerable},${enumerable},2.1,ok,"bun/101=4 "`);
  }
  writeFileSync(csv, `${rows.join('\n')}\n`);
}

function runAlerter(
  status: string,
  leak: number,
  extra: string[] = [],
): { stdout: string; stderr: string; code: number } {
  const res = spawnSync(
    'python3',
    [ALERTER, '--status', status, '--leak', String(leak), '--csv', csv, '--state', state, ...extra],
    { encoding: 'utf8' },
  );
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', code: res.status ?? -1 };
}

function postedText(stdout: string): string | undefined {
  const line = stdout.split('\n').find((l) => l.startsWith('[dry-run] Socket'));
  return line?.replace('[dry-run] ', '');
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'socket-watch-'));
  csv = join(dir, 'socket-watch.csv');
  state = join(dir, 'socket-watch.state');
  writeCsv(121_600);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('socket-watch alerting', () => {
  it('posts once per state change across OK → WARN → WARN → CRITICAL → OK', () => {
    const sequence: Array<[string, number]> = [
      ['OK', 21_000],
      ['WARN', 121_600],
      ['WARN', 122_400],
      ['CRITICAL', 151_000],
      ['OK', 21_000],
    ];
    const posts: Array<{ status: string; text: string }> = [];
    for (const [status, leak] of sequence) {
      const run = runAlerter(status, leak, ['--dry-run']);
      expect(run.code, `${status} at ${leak} exited ${run.code}: ${run.stderr}`).toBe(0);
      const text = postedText(run.stdout);
      if (text) posts.push({ status, text });
    }

    expect(posts.map((p) => p.status)).toEqual(['WARN', 'CRITICAL', 'OK']);
    // The first OK is where the watcher came in, not a recovery: a fresh
    // start on a healthy machine has nothing to announce.
    expect(posts).toHaveLength(3);
    // And the state it recorded is the one it last spoke about.
    expect(readFileSync(state, 'utf8').trim()).toBe('OK');
  });

  it('names the metric, the hourly rate, the projection and the row link', () => {
    runAlerter('OK', 21_000, ['--dry-run']);
    const text = postedText(runAlerter('WARN', 121_600, ['--dry-run']).stdout) ?? '';

    expect(text).toContain('pcbcount minus enumerable sockets');
    // 3,600 leaked blocks an hour over the fixture's hour of samples.
    expect(text).toContain('climbing 3,600/hr');
    // (163,000 − 121,600) ÷ 3,600 ≈ 11.5 hours of headroom left.
    expect(text).toContain('About 12 hours to the 163,000 failure point');
    expect(text).toContain('(/workspaces/w-DRa7BgNaZkqh?task=t-kkAtJxK85M4O)');
    expect(wordCount(text)).toBeLessThan(60);
  });

  it('says the machine is already refusing sockets when the canary failed', () => {
    runAlerter('OK', 21_000, ['--dry-run']);
    const text =
      postedText(
        runAlerter('CRITICAL', 155_000, ['--dry-run', '--canary', 'probe-failed']).stdout,
      ) ?? '';

    expect(text).toContain('already refusing new sockets');
    // No projection once there is nothing left to project.
    expect(text).not.toContain('failure point');
    expect(wordCount(text)).toBeLessThan(60);
  });

  it('keeps the alert owing when the post cannot be delivered', () => {
    runAlerter('OK', 21_000, ['--dry-run']);
    // Port 1 on loopback refuses immediately; nothing is started here.
    const run = runAlerter('WARN', 121_600, ['--base-url', 'http://127.0.0.1:1', '--timeout', '2']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('will retry');
    // The state file still says OK, so the next sample tries again — the
    // whole point, since the server may be down for the same reason.
    expect(readFileSync(state, 'utf8').trim()).toBe('OK');
  });

  it('reports a short history as an unknown rate rather than inventing one', () => {
    writeFileSync(
      csv,
      [
        'ts,status,pcbcount,enumerable_sockets,mbuf_pct,canary,top_holders',
        '2026-09-04T12:00:00Z,WARN,121900,300,2.1,ok,"bun/101=4 "',
        '2026-09-04T12:00:15Z,WARN,121950,300,2.1,ok,"bun/101=4 "',
        '',
      ].join('\n'),
    );
    const text = postedText(runAlerter('WARN', 121_650, ['--dry-run']).stdout) ?? '';

    expect(text).toContain('rate not yet known');
    expect(text).toContain('Not climbing right now.');
  });
});
