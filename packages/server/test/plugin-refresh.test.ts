/**
 * Requesting a plugin refresh — the half of delivery a session CAN run itself.
 *
 * The failure this exists to end: `main` reached 0.1.26 while every peer's
 * cache sat at 0.1.15, because delivery depended on a person remembering to
 * run one command. The drift signal made that visible; this makes it fixable
 * from inside any session, and then makes it happen without being asked.
 *
 * The load-bearing property in here is that `changed` is read from DISK, not
 * from the CLI's own account of itself. `claude plugin update` reports
 * success when it copies nothing — that is precisely how 25 commits went
 * undelivered while both ends showed green.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_REF,
  PluginRefresher,
  type RunResult,
  readInstalledPluginVersion,
  resolveClaudeBin,
  runPluginRefresh,
} from '../src/plugin-refresh';

const installedFile = (records: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-installed-'));
  const file = join(dir, 'installed_plugins.json');
  writeFileSync(file, JSON.stringify(records));
  return file;
};

describe('readInstalledPluginVersion', () => {
  test('reads the user-scope record for the plugin', () => {
    const file = installedFile({
      version: 2,
      plugins: {
        'other@somewhere': [{ scope: 'user', version: '9.9.9' }],
        [PLUGIN_REF]: [{ scope: 'user', version: '0.1.27', installPath: '/cache/0.1.27' }],
      },
    });
    expect(readInstalledPluginVersion(file)).toBe('0.1.27');
  });

  test('prefers the user scope over a project-scoped install', () => {
    // User scope is the fleet-wide one — it is what a peer in any directory
    // resolves. A project install is one repo's business.
    const file = installedFile({
      plugins: {
        [PLUGIN_REF]: [
          { scope: 'project', projectPath: '/tmp/x', version: '0.9.9' },
          { scope: 'user', version: '0.1.27' },
        ],
      },
    });
    expect(readInstalledPluginVersion(file)).toBe('0.1.27');
  });

  test('falls back to the newest record when nothing is user-scoped', () => {
    const file = installedFile({
      plugins: {
        [PLUGIN_REF]: [
          { scope: 'project', version: '0.1.9' },
          { scope: 'project', version: '0.1.26' },
        ],
      },
    });
    expect(readInstalledPluginVersion(file)).toBe('0.1.26');
  });

  test('returns null for a missing file, missing plugin, or unreadable json', () => {
    expect(readInstalledPluginVersion('/nope/installed_plugins.json')).toBeNull();
    expect(readInstalledPluginVersion(installedFile({ plugins: {} }))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'lf-installed-'));
    const bad = join(dir, 'installed_plugins.json');
    writeFileSync(bad, '{ not json');
    expect(readInstalledPluginVersion(bad)).toBeNull();
  });
});

describe('resolveClaudeBin', () => {
  const exists = (present: string[]) => (p: string) => present.includes(p);

  test('takes the first candidate that exists', () => {
    expect(
      resolveClaudeBin({ candidates: ['/a/claude', '/b/claude'], exists: exists(['/b/claude']) }),
    ).toBe('/b/claude');
  });

  test('an override is authoritative — it never falls back to a candidate', () => {
    // Same rule the scrub gate learned the hard way: an override that quietly
    // falls back means a caller can believe it pointed somewhere it did not.
    // Here the fallback would silently run a DIFFERENT binary than the
    // operator named.
    expect(
      resolveClaudeBin({
        override: '/custom/claude',
        candidates: ['/a/claude'],
        exists: exists(['/a/claude']),
      }),
    ).toBeNull();
    // Positive control: the same override resolves when it does exist.
    expect(
      resolveClaudeBin({
        override: '/custom/claude',
        candidates: ['/a/claude'],
        exists: exists(['/custom/claude', '/a/claude']),
      }),
    ).toBe('/custom/claude');
  });

  test('returns null when nothing resolves', () => {
    expect(resolveClaudeBin({ candidates: ['/a/claude'], exists: exists([]) })).toBeNull();
  });
});

describe('runPluginRefresh', () => {
  const ran = (): { calls: Array<{ bin: string; args: string[] }>; run: RunFn } => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    return {
      calls,
      run: async (bin, args) => {
        calls.push({ bin, args });
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  };
  type RunFn = (bin: string, args: string[]) => Promise<RunResult>;

  test('invokes the binary directly, with no shell between', async () => {
    // The whole reason a previous session concluded agents may not deploy:
    // `claude` is a shell FUNCTION here that injects flags ahead of the
    // subcommand, so a shelled-out `claude plugin update …` is parsed as a
    // prompt. Spawning the resolved path with an argv array cannot hit that.
    const { calls, run } = ran();
    await runPluginRefresh({
      bin: '/bin/claude',
      run,
      installedVersion: () => '0.1.27',
      now: () => 1,
    });
    expect(calls).toEqual([{ bin: '/bin/claude', args: ['plugin', 'update', PLUGIN_REF] }]);
  });

  test('reports the change from DISK, not from the CLI saying it updated', async () => {
    // `claude plugin update` prints success when it copies nothing. Believing
    // its prose is the exact bug that let 25 commits sit undelivered with
    // green on both ends.
    const res = await runPluginRefresh({
      bin: '/bin/claude',
      run: async () => ({
        status: 0,
        stdout: 'updated from 0.1.1 to 0.9.9 for scope user. Restart to apply changes.',
        stderr: '',
      }),
      installedVersion: () => '0.1.27', // never moves
      now: () => 5,
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.before).toBe('0.1.27');
    expect(res.after).toBe('0.1.27');
  });

  test('reports a real change when the installed version actually moves', async () => {
    // Positive control for the test above — without it, `changed: false`
    // could just mean the field is hardcoded.
    let version = '0.1.26';
    const res = await runPluginRefresh({
      bin: '/bin/claude',
      run: async () => {
        version = '0.1.27';
        return { status: 0, stdout: '', stderr: '' };
      },
      installedVersion: () => version,
      now: () => 5,
    });
    expect(res.changed).toBe(true);
    expect(res.before).toBe('0.1.26');
    expect(res.after).toBe('0.1.27');
    expect(res.ranAt).toBe(5);
  });

  test('a non-zero exit is not ok, and says why', async () => {
    const res = await runPluginRefresh({
      bin: '/bin/claude',
      run: async () => ({ status: 1, stdout: '', stderr: 'marketplace not found' }),
      installedVersion: () => '0.1.26',
      now: () => 1,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('marketplace not found');
  });

  test('no binary resolved: fails without ever spawning', async () => {
    const { calls, run } = ran();
    const res = await runPluginRefresh({
      bin: null,
      run,
      installedVersion: () => '0.1.26',
      now: () => 1,
    });
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
    expect(res.message.toLowerCase()).toContain('claude');
  });
});

describe('PluginRefresher', () => {
  const counter = () => {
    const state = { runs: 0 };
    const run = async () => {
      state.runs++;
      return {
        ok: true,
        before: '0.1.26',
        after: '0.1.27',
        changed: true,
        message: 'ok',
        ranAt: 0,
      };
    };
    return { state, run };
  };

  test('concurrent callers share one run', async () => {
    // Every peer on the board can call this. A burst must not become a burst
    // of `git fetch`es against the marketplace.
    let resolveRun: (() => void) | null = null;
    let runs = 0;
    const refresher = new PluginRefresher({
      run: async () => {
        runs++;
        await new Promise<void>((r) => {
          resolveRun = r;
        });
        return { ok: true, before: 'a', after: 'b', changed: true, message: '', ranAt: 0 };
      },
      now: () => 0,
      minIntervalMs: 0,
    });
    const a = refresher.refresh();
    const b = refresher.refresh();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(1);
    (resolveRun as unknown as () => void)();
    expect((await a).after).toBe('b');
    expect((await b).after).toBe('b');
    expect(runs).toBe(1);
  });

  test('a second ask inside the window reuses the result instead of re-fetching', async () => {
    const { state, run } = counter();
    let clock = 1000;
    const refresher = new PluginRefresher({ run, now: () => clock, minIntervalMs: 60_000 });
    await refresher.refresh();
    clock += 30_000;
    await refresher.refresh();
    expect(state.runs).toBe(1);
  });

  test('past the window it runs again', async () => {
    const { state, run } = counter();
    let clock = 1000;
    const refresher = new PluginRefresher({ run, now: () => clock, minIntervalMs: 60_000 });
    await refresher.refresh();
    clock += 61_000;
    await refresher.refresh();
    expect(state.runs).toBe(2);
  });

  test('last() is null until something has run, then holds the latest result', async () => {
    const { run } = counter();
    const refresher = new PluginRefresher({ run, now: () => 0, minIntervalMs: 0 });
    expect(refresher.last()).toBeNull();
    await refresher.refresh();
    expect(refresher.last()?.after).toBe('0.1.27');
  });

  test('a thrown run becomes a failed result rather than an unhandled rejection', async () => {
    // This runs on a timer in prod. A throw that escapes takes the server
    // down with it, which is a spectacularly bad trade for a cache update.
    const refresher = new PluginRefresher({
      run: async () => {
        throw new Error('spawn ENOENT');
      },
      now: () => 0,
      minIntervalMs: 0,
    });
    const res = await refresher.refresh();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('ENOENT');
  });
});
