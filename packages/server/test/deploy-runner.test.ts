/**
 * The deploy, driven end to end over a fake git and a fake restart.
 *
 * NOTHING in this file may reach a real checkout or a real `launchctl`. Every
 * git call is a scripted table lookup and the restart is a counter; if either
 * seam is ever removed, these tests would deploy the machine that runs CI.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploySource } from '../src/deploy-source.ts';
import {
  type BusyDoc,
  type DeployDeps,
  type DeployResult,
  Deployer,
  deployLogPath,
  readDeployLog,
  runDeploy,
  writeDeployLog,
} from '../src/deploy.ts';

/** A scripted git. The key is the joined argv; anything unscripted fails,
 *  so a command the code starts issuing shows up as a failure rather than
 *  as a silent empty string. */
function fakeGit(script: Record<string, { ok: boolean; stdout: string }>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const key = args.join(' ');
    return script[key] ?? { ok: false, stdout: `unscripted: ${key}` };
  };
  return { run, calls };
}

const AHEAD_BEHIND = 'rev-list --left-right --count HEAD...@{u}';
const STATUS = 'status --porcelain -z --untracked-files=no';
const INCOMING = 'diff --name-only -z HEAD @{u}';
const MERGE = 'merge --ff-only @{u}';

/** A source that moves from `before` to `after` the first time git merges —
 *  modelled on disk state, NOT on what git printed. */
function movingSource(before: string, after: string, git: { calls: string[][] }) {
  return (): DeploySource => ({
    sourceRef: git.calls.some((c) => c.join(' ') === MERGE) ? after : before,
  });
}

function deps(over: Partial<DeployDeps> & { git: DeployDeps['git'] }): DeployDeps {
  return {
    readSource: () => ({ sourceRef: 'aaaaaaa' }),
    busyDocs: () => [],
    restart: () => {},
    now: () => 1_700_000_000_000,
    ...over,
  };
}

/** The happy case: 3 commits behind, clean tree, nothing bound is busy. */
function behindScript(): Record<string, { ok: boolean; stdout: string }> {
  return {
    'fetch --quiet origin': { ok: true, stdout: '' },
    [AHEAD_BEHIND]: { ok: true, stdout: '0\t3\n' },
    [STATUS]: { ok: true, stdout: '' },
    [INCOMING]: { ok: true, stdout: 'packages/server/src/server.ts\0' },
    [MERGE]: { ok: true, stdout: 'Fast-forward\n' },
  };
}

describe('runDeploy — the fast-forward', () => {
  it('fetches, fast-forwards, and schedules exactly one restart', async () => {
    const git = fakeGit(behindScript());
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        readSource: movingSource('aaaaaaa', 'bbbbbbb', git),
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('deployed');
    expect(res.ok).toBe(true);
    expect(res.before).toBe('aaaaaaa');
    expect(res.after).toBe('bbbbbbb');
    expect(res.changed).toBe(true);
    expect(res.behind).toBe(3);
    expect(res.restartRequested).toBe(true);
    expect(restarts).toBe(1);
    // Shape before behaviour: the fetch really did precede the merge.
    const order = git.calls.map((c) => c[0]);
    expect(order.indexOf('fetch')).toBeLessThan(order.indexOf('merge'));
  });

  it('never rebases, resets, forces, or runs a bare `git pull`', async () => {
    const git = fakeGit(behindScript());
    await runDeploy(deps({ git: git.run, readSource: movingSource('a', 'b', git) }));
    const flat = git.calls.map((c) => c.join(' '));
    // Positive control first: the probe can see the commands that ARE there.
    expect(flat).toContain(MERGE);
    expect(flat.some((c) => /\brebase\b/.test(c))).toBe(false);
    expect(flat.some((c) => /\breset\b/.test(c))).toBe(false);
    expect(flat.some((c) => /(^|\s)(--force|-f)(\s|$)/.test(c))).toBe(false);
    expect(flat.some((c) => /^pull(\s|$)/.test(c))).toBe(false);
  });

  it('reads `changed` off the checkout, not out of git output', async () => {
    // `git merge` says "Fast-forward" and the ref did NOT move. Anything
    // that believed the prose would report a delivery it never made.
    const git = fakeGit(behindScript());
    const res = await runDeploy(
      deps({ git: git.run, readSource: () => ({ sourceRef: 'aaaaaaa' }) }),
    );
    expect(res.status).toBe('deployed');
    expect(res.changed).toBe(false);
  });

  it('and reports a move git called a no-op', async () => {
    const git = fakeGit({
      ...behindScript(),
      [MERGE]: { ok: true, stdout: 'Already up to date.\n' },
    });
    const res = await runDeploy(
      deps({ git: git.run, readSource: movingSource('aaaaaaa', 'bbbbbbb', git) }),
    );
    expect(res.changed).toBe(true);
  });
});

describe('runDeploy — the refusals', () => {
  it('an up-to-date source does not restart and does not merge', async () => {
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '0\t0\n' },
      [STATUS]: { ok: true, stdout: '' },
    });
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('up-to-date');
    expect(res.ok).toBe(true);
    expect(res.restartRequested).toBe(false);
    expect(restarts).toBe(0);
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('refuses a diverged source without touching it', async () => {
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '2\t5\n' },
      [STATUS]: { ok: true, stdout: '' },
    });
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('refuse-diverged');
    expect(res.ahead).toBe(2);
    expect(res.behind).toBe(5);
    expect(res.message).toContain('2 commits');
    expect(restarts).toBe(0);
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('refuses when a file the pull rewrites is modified, and names it', async () => {
    const git = fakeGit({
      ...behindScript(),
      [STATUS]: { ok: true, stdout: ' M packages/server/src/server.ts\0 M docs/plan.md\0' },
    });
    const res = await runDeploy(deps({ git: git.run }));
    expect(res.status).toBe('refuse-dirty');
    expect(res.blockingPaths).toEqual(['packages/server/src/server.ts']);
    // Every modified path is reported, so proceeding over one reads as a
    // decision rather than an oversight.
    expect(res.dirtyPaths).toEqual(['docs/plan.md', 'packages/server/src/server.ts']);
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('deploys over a modified file the pull does not touch', async () => {
    // The positive control for the case above, on the same shape: a bound
    // review doc under docs/ is modified for hours at a time in the deploy
    // source, and blocking on it would make the feature unusable.
    const git = fakeGit({ ...behindScript(), [STATUS]: { ok: true, stdout: ' M docs/plan.md\0' } });
    const res = await runDeploy(deps({ git: git.run, readSource: movingSource('a', 'b', git) }));
    expect(res.status).toBe('deployed');
    expect(res.dirtyPaths).toEqual(['docs/plan.md']);
  });
});

describe('runDeploy — bound documents holding un-flushed edits', () => {
  const busy: BusyDoc[] = [{ docId: 'd1', path: '/repo/docs/live-plan.md' }];

  it('refuses and names the document', async () => {
    const git = fakeGit(behindScript());
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        busyDocs: () => busy,
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('refuse-busy');
    expect(res.busyDocs).toEqual(busy);
    expect(res.message).toContain('live-plan.md');
    expect(restarts).toBe(0);
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('force overrides it — same fixture, opposite answer', async () => {
    const git = fakeGit(behindScript());
    const res = await runDeploy(
      deps({ git: git.run, busyDocs: () => busy, readSource: movingSource('a', 'b', git) }),
      { force: true },
    );
    expect(res.status).toBe('deployed');
    expect(res.forced).toBe(true);
  });

  it('is checked AFTER the git decision — a diverged source reports divergence', async () => {
    // Otherwise a checkout with an unpushed commit AND an open doc sends
    // someone off to close their editor over the wrong problem.
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '1\t1\n' },
      [STATUS]: { ok: true, stdout: '' },
    });
    const res = await runDeploy(deps({ git: git.run, busyDocs: () => busy }));
    expect(res.status).toBe('refuse-diverged');
  });

  it('does not consult bound documents at all when there is nothing to pull', async () => {
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '0\t0\n' },
      [STATUS]: { ok: true, stdout: '' },
    });
    let asked = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        busyDocs: () => {
          asked++;
          return busy;
        },
      }),
    );
    expect(res.status).toBe('up-to-date');
    expect(asked).toBe(0);
  });
});

describe('runDeploy — git going wrong', () => {
  it('a failed fetch is an error, not an up-to-date', async () => {
    const git = fakeGit({ 'fetch --quiet origin': { ok: false, stdout: '' } });
    const res = await runDeploy(deps({ git: git.run }));
    expect(res.status).toBe('error');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('fetch');
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('an unreadable ahead/behind count is an error, never 0/0', async () => {
    // 0/0 renders as "already current" — the quietest way to skip a deploy.
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: 'fatal: no upstream configured\n' },
    });
    const res = await runDeploy(deps({ git: git.run }));
    expect(res.status).toBe('error');
    expect(res.status).not.toBe('up-to-date');
    expect(res.message).toContain('upstream');
  });

  it('an unreadable working tree is an error, not a clean one', async () => {
    const git = fakeGit({
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '0\t2\n' },
      [STATUS]: { ok: false, stdout: '' },
    });
    const res = await runDeploy(deps({ git: git.run }));
    expect(res.status).toBe('error');
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('a refused fast-forward does not schedule a restart', async () => {
    const git = fakeGit({ ...behindScript(), [MERGE]: { ok: false, stdout: '' } });
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('error');
    expect(res.restartRequested).toBe(false);
    expect(restarts).toBe(0);
  });
});

describe('Deployer', () => {
  it('exposes no way to restart without pulling', () => {
    // The ordering is meant to be structural. If a `restart()` verb ever
    // appears on this class, the guarantee is gone and a comment saying
    // "always pull first" is what is left.
    const names = Object.getOwnPropertyNames(Deployer.prototype).filter((n) => n !== 'constructor');
    expect(names.sort()).toEqual(['deploy', 'last']);
  });

  it('collapses concurrent calls into one run', async () => {
    let runs = 0;
    const d = new Deployer({
      run: async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 10));
        return { status: 'up-to-date', ok: true } as DeployResult;
      },
    });
    const [a, b] = await Promise.all([d.deploy(), d.deploy()]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
  });

  it('turns a throw into a result rather than taking the server down', async () => {
    const d = new Deployer({
      run: async () => {
        throw new Error('git exploded');
      },
      now: () => 5,
    });
    const r = await d.deploy();
    expect(r.status).toBe('error');
    expect(r.message).toContain('git exploded');
    expect(d.last()?.message).toContain('git exploded');
  });

  it('reads its last result back from disk, because the deploy killed the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-log-'));
    try {
      const file = deployLogPath(dir);
      const stored = { status: 'deployed', ok: true, after: 'bbbbbbb' } as DeployResult;
      writeDeployLog(file, stored);
      // Shape before behaviour: the file really holds what we think.
      expect(JSON.parse(readFileSync(file, 'utf8')).after).toBe('bbbbbbb');

      const fresh = new Deployer({
        run: async () => ({ status: 'up-to-date' }) as DeployResult,
        loadLast: () => readDeployLog(file),
      });
      expect(fresh.last()?.after).toBe('bbbbbbb');

      // A process that never deployed and has no log answers null, not a
      // fabricated all-clear.
      const empty = new Deployer({
        run: async () => ({ status: 'up-to-date' }) as DeployResult,
        loadLast: () => readDeployLog(join(dir, 'nope.json')),
      });
      expect(empty.last()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists every result, including the refusals', async () => {
    const seen: DeployResult[] = [];
    const d = new Deployer({
      run: async () => ({ status: 'refuse-busy', ok: false }) as DeployResult,
      persist: (r) => seen.push(r),
    });
    await d.deploy();
    expect(seen.map((r) => r.status)).toEqual(['refuse-busy']);
  });
});
