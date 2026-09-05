/**
 * Two layers, deliberately split:
 *
 *   1. Flag parsing and preset resolution — pure functions, run everywhere.
 *   2. A real screenshot through the real script — runs only where a Chrome
 *      binary exists, because the thing worth pinning is that headless Chrome
 *      plus Emulation.setDeviceMetricsOverride actually delivers a 430px
 *      window, which a resized real window cannot (Chrome floors near 500px).
 *      A unit test over the CDP params would pass against a script that
 *      launched nothing.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  DEFAULT_CHROME_BIN,
  MOBILE_TIER_MAX_WIDTH,
  PRESETS,
  RUN_ID_ENV,
  UsageError,
  describeStaleProfiles,
  findStaleProfiles,
  parseArgs,
  parseSize,
  profilePrefix,
  profilesOfRun,
  resolveChromeBin,
  resolvePreset,
  resolveRunId,
  sanitizeRunId,
} from './ui-shot-lib.ts';

describe('ui-shot flag parsing', () => {
  it('defaults to the iPad landscape preset, desktop layout, scale 1', () => {
    const o = parseArgs(['--url', 'http://x/', '--out', 'a.png']);
    expect(o).toMatchObject({
      url: 'http://x/',
      width: 1180,
      height: 820,
      mobile: false,
      scale: 1,
      out: 'a.png',
      fullPage: false,
      settleMs: DEFAULTS.settleMs,
      timeoutMs: DEFAULTS.timeoutMs,
    });
    expect(o.eval).toBeUndefined();
    expect(o.waitFor).toBeUndefined();
  });

  it('the phone preset is 430x932 and turns mobile emulation on', () => {
    const o = parseArgs(['--url', 'http://x/', '--preset', 'phone', '--out', 'a.png']);
    expect([o.width, o.height, o.mobile]).toEqual([430, 932, true]);
  });

  it('presets are case-insensitive and unknown ones are a usage error naming the known set', () => {
    expect(resolvePreset('IPad')).toEqual(PRESETS.ipad);
    expect(() => resolvePreset('desktop')).toThrow(UsageError);
    expect(() => resolvePreset('desktop')).toThrow(/ipad, phone/);
  });

  it('--size takes WxH in any of the three separators and rejects garbage', () => {
    expect(parseSize('1366x1024')).toEqual({ width: 1366, height: 1024 });
    expect(parseSize('430X932')).toEqual({ width: 430, height: 932 });
    expect(parseSize('430×932')).toEqual({ width: 430, height: 932 });
    for (const bad of ['1366', '0x900', '12.5x900', 'wide']) {
      expect(() => parseSize(bad), bad).toThrow(UsageError);
    }
  });

  it('mobile defaults from the tier boundary and the explicit flags override it', () => {
    const at = (w: number, ...extra: string[]) =>
      parseArgs(['--url', 'u', '--out', 'a.png', '--size', `${w}x800`, ...extra]).mobile;
    expect(at(MOBILE_TIER_MAX_WIDTH)).toBe(true);
    expect(at(MOBILE_TIER_MAX_WIDTH + 1)).toBe(false);
    expect(at(430, '--no-mobile')).toBe(false);
    expect(at(1366, '--mobile')).toBe(true);
  });

  it('a bare positional is the URL; a second one is an error', () => {
    expect(parseArgs(['http://x/', '--out', 'a.png']).url).toBe('http://x/');
    expect(() => parseArgs(['http://x/', 'http://y/', '--out', 'a.png'])).toThrow(/unexpected/);
  });

  it('--eval-file reads through the injected reader', () => {
    const o = parseArgs(['--url', 'u', '--eval-file', 'probe.js'], (p) => `/*${p}*/ 1 + 1`);
    expect(o.eval).toBe('/*probe.js*/ 1 + 1');
  });

  it('refuses a run with nothing to produce, conflicting size flags, and dangling values', () => {
    expect(() => parseArgs(['--url', 'u'])).toThrow(/nothing to do/);
    expect(() =>
      parseArgs(['--url', 'u', '--out', 'a', '--preset', 'phone', '--size', '1x1']),
    ).toThrow(/mutually exclusive/);
    expect(() => parseArgs(['--url', 'u', '--out'])).toThrow(/--out needs a value/);
    expect(() => parseArgs(['--out', 'a.png'])).toThrow(/--url is required/);
    expect(() => parseArgs(['--url', 'u', '--out', 'a', '--settle', '-5'])).toThrow(/--settle/);
    expect(() => parseArgs(['--url', 'u', '--out', 'a', '--bogus'])).toThrow(/unknown flag/);
  });
});

describe('ui-shot Chrome binary resolution', () => {
  const exists = (ok: string[]) => (p: string) => ok.includes(p);

  it('prefers --chrome, then CW_CHROME_BIN, then the /Applications path', () => {
    expect(resolveChromeBin('/flag', { CW_CHROME_BIN: '/env' }, exists(['/flag', '/env']))).toBe(
      '/flag',
    );
    expect(resolveChromeBin(undefined, { CW_CHROME_BIN: '/env' }, exists(['/env']))).toBe('/env');
    expect(resolveChromeBin(undefined, {}, exists([DEFAULT_CHROME_BIN]))).toBe(DEFAULT_CHROME_BIN);
  });

  it('an explicit path that is missing fails loudly instead of falling through', () => {
    expect(() => resolveChromeBin('/nope', { CW_CHROME_BIN: '/env' }, exists(['/env']))).toThrow(
      /--chrome/,
    );
    expect(() => resolveChromeBin(undefined, { CW_CHROME_BIN: '/nope' }, exists([]))).toThrow(
      /CW_CHROME_BIN/,
    );
  });
});

describe('ui-shot profile naming', () => {
  it('stamps the run id into the directory name so a leak is attributable', () => {
    expect(profilePrefix('shot7')).toBe('cw-ui-shot-shot7-');
    expect(resolveRunId({}, 4242)).toBe('pid4242');
    expect(resolveRunId({ [RUN_ID_ENV]: 'vitest-4' }, 1)).toBe('vitest4');
  });

  it('run ids are alphanumeric, so the separator before the random suffix stays unambiguous', () => {
    expect(sanitizeRunId('a-b/c 1')).toBe('abc1');
    expect(sanitizeRunId('x'.repeat(40))).toHaveLength(24);
    // With `-` allowed inside an id, run "ab" would own run "abc"'s profiles.
    expect(profilesOfRun(['cw-ui-shot-ab-1', 'cw-ui-shot-abc-1'], 'ab')).toEqual([
      'cw-ui-shot-ab-1',
    ]);
  });

  it("another run's profile is never counted as this run's leak", () => {
    const names = ['cw-ui-shot-other-AbCdEf', 'cw-ui-shot-mine-123456', 'unrelated'];
    expect(profilesOfRun(names, 'mine')).toEqual(['cw-ui-shot-mine-123456']);
    expect(profilesOfRun(names, 'nobody')).toEqual([]);
  });
});

describe('ui-shot stale profile report', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('names day-old profiles instead of counting them, and deletes nothing', () => {
    dir = mkdtempSync(join(tmpdir(), 'ui-shot-stale-'));
    for (const name of ['cw-ui-shot-old-AAAAAA', 'cw-ui-shot-new-BBBBBB', 'unrelated-dir']) {
      mkdirSync(join(dir, name));
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'cw-ui-shot-old-AAAAAA'), twoDaysAgo, twoDaysAgo);

    const stale = findStaleProfiles(dir);
    expect(stale.map((s) => s.name)).toEqual(['cw-ui-shot-old-AAAAAA']);

    const report = describeStaleProfiles(stale, dir);
    expect(report).toContain('cw-ui-shot-old-AAAAAA');
    expect(report).toMatch(/4[0-9]h old/);
    expect(report).not.toContain('cw-ui-shot-new-BBBBBB');

    // Reporting must never be deletion: a stale-looking profile can belong to
    // another agent's long-running session.
    expect(readdirSync(dir).sort()).toEqual([
      'cw-ui-shot-new-BBBBBB',
      'cw-ui-shot-old-AAAAAA',
      'unrelated-dir',
    ]);
  });

  it('ignores non-profile entries and anything younger than the cutoff', () => {
    dir = mkdtempSync(join(tmpdir(), 'ui-shot-stale-'));
    mkdirSync(join(dir, 'cw-ui-shot-fresh-CCCCCC'));
    mkdirSync(join(dir, 'some-other-tmp'));
    expect(findStaleProfiles(dir)).toEqual([]);
    expect(describeStaleProfiles([], dir)).toBe('');
  });
});

const CHROME = process.env.CW_CHROME_BIN ?? DEFAULT_CHROME_BIN;
const SCRIPT = resolve(process.cwd(), 'scripts/ui-shot.ts');

describe.skipIf(!existsSync(CHROME))('ui-shot against real headless Chrome', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('screenshots a data: URL at 430px and the page reports innerWidth 430', () => {
    dir = mkdtempSync(join(tmpdir(), 'ui-shot-test-'));
    const out = join(dir, 'nested', 'phone.png');
    const profilesBefore = readdirSync(tmpdir()).filter((d) => d.startsWith('cw-ui-shot-')).length;
    // Mobile emulation behaves like a phone, which is the point and also a
    // trap for this fixture: without the viewport meta the page lays out at
    // Chrome's 980px legacy width, and if the content overflows (the default
    // 8px body margin plus a 100vw box did it) the visual viewport zooms out
    // and innerWidth reads 438. Both are real-phone behaviour; a page that
    // fits reports exactly 430.
    const html =
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>probe</title><style>body{margin:0}</style>' +
      '<main style="width:100%;height:50vh;background:#c33"></main>';
    const url = `data:text/html,${encodeURIComponent(html)}`;
    const r = spawnSync(
      'bun',
      [
        SCRIPT,
        '--url',
        url,
        '--preset',
        'phone',
        '--out',
        out,
        '--settle',
        '200',
        '--eval',
        'window.innerWidth',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(1000);
    const summary = JSON.parse(r.stdout);
    expect(summary.result).toBe(430);
    expect(summary.page).toMatchObject({
      innerWidth: 430,
      innerHeight: 932,
      devicePixelRatio: 1,
      title: 'probe',
    });
    expect(summary.screenshot).toBe(out);
    // The throwaway profile must not survive the run.
    const profilesAfter = readdirSync(tmpdir()).filter((d) => d.startsWith('cw-ui-shot-')).length;
    expect(profilesAfter).toBeLessThanOrEqual(profilesBefore);
  }, 60_000);

  it('exits 2 with usage on bad flags, without launching Chrome', () => {
    const r = spawnSync('bun', [SCRIPT, '--url'], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: bun run ui:shot/);
  });
});
