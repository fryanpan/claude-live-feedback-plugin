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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeploySource } from '../src/deploy-source.ts';
import {
  BUSY_SETTLE_MS,
  type BusyDoc,
  type DeployDeps,
  type DeployResult,
  Deployer,
  deployLogPath,
  readDeployLog,
  runDeploy,
  servedRefReader,
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
    // No test in this file may sleep for real. `wait` is a REQUIRED dep for
    // exactly that reason: forgetting it is a compile error rather than a
    // suite that takes 1.5s longer per busy fixture.
    wait: async () => {},
    now: () => 1_700_000_000_000,
    ...over,
  };
}

/** A `wait` that records what it was asked to wait for and returns at once. */
function fakeWait() {
  const asked: number[] = [];
  return {
    asked,
    wait: async (ms: number) => {
      asked.push(ms);
    },
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

  it('a document that settles during the wait proceeds', async () => {
    // The refusal is about a ~800ms write-back debounce. Asking once catches
    // every edit that finished a moment ago and refuses a deploy nothing
    // would have lost — so the busy answer is re-read after a settle window.
    const git = fakeGit(behindScript());
    const w = fakeWait();
    let asked = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        wait: w.wait,
        busyDocs: () => (asked++ === 0 ? busy : []),
        readSource: movingSource('aaaaaaa', 'bbbbbbb', git),
      }),
    );
    expect(res.status).toBe('deployed');
    expect(res.busyDocs).toBeUndefined();
    // It really did wait, and it really did ask again.
    expect(w.asked).toEqual([BUSY_SETTLE_MS]);
    expect(asked).toBe(2);
  });

  it('and one still being typed in after the wait still refuses', async () => {
    // The other direction on the same mechanism. Bryan, 2026-08-18, asked
    // and answered: refuse by default. A settle window that let a busy doc
    // through would be that ruling reversed by accident.
    const git = fakeGit(behindScript());
    const w = fakeWait();
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        wait: w.wait,
        busyDocs: () => busy,
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('refuse-busy');
    expect(res.busyDocs).toEqual(busy);
    expect(res.message).toContain('live-plan.md');
    expect(w.asked).toEqual([BUSY_SETTLE_MS]);
    expect(restarts).toBe(0);
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
  });

  it('does not wait when nothing is busy', async () => {
    // The negative control for the two above: a settle window on every
    // deploy would put 1.5s on the clean path for nothing.
    const git = fakeGit(behindScript());
    const w = fakeWait();
    const res = await runDeploy(
      deps({ git: git.run, wait: w.wait, readSource: movingSource('a', 'b', git) }),
    );
    expect(res.status).toBe('deployed');
    expect(w.asked).toEqual([]);
  });

  it('force skips the wait entirely — there is nothing to wait for', async () => {
    const git = fakeGit(behindScript());
    const w = fakeWait();
    const res = await runDeploy(
      deps({
        git: git.run,
        wait: w.wait,
        busyDocs: () => busy,
        readSource: movingSource('a', 'b', git),
      }),
      { force: true },
    );
    expect(res.status).toBe('deployed');
    expect(res.forced).toBe(true);
    expect(w.asked).toEqual([]);
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

describe('runDeploy — a checkout at the tip serving an older client', () => {
  /** Nothing to fetch: the checkout is exactly where origin is. */
  function currentScript(): Record<string, { ok: boolean; stdout: string }> {
    return {
      'fetch --quiet origin': { ok: true, stdout: '' },
      [AHEAD_BEHIND]: { ok: true, stdout: '0\t0\n' },
      [STATUS]: { ok: true, stdout: '' },
    };
  }

  it('restarts to republish the client, without merging anything', async () => {
    // Somebody ran `git pull` in the deploy source by hand and did not
    // restart. git says current; the browser is still on the old bundle.
    const git = fakeGit(currentScript());
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        readServed: () => 'older99',
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('restarted');
    expect(res.ok).toBe(true);
    expect(res.restartRequested).toBe(true);
    expect(restarts).toBe(1);
    // Nothing was pulled, so the checkout did not move — and saying it did
    // would be the same lie in the other direction.
    expect(res.changed).toBe(false);
    expect(res.before).toBe('aaaaaaa');
    expect(res.after).toBe('aaaaaaa');
    expect(git.calls.map((c) => c.join(' '))).not.toContain(MERGE);
    expect(res.message).toContain('older99');
  });

  it('and stays put when the served client was built from HEAD', async () => {
    // Same fixture, one field different. A rule that always restarts passes
    // the test above and fails this one.
    const git = fakeGit(currentScript());
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        readServed: () => 'aaaaaaa',
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('up-to-date');
    expect(res.restartRequested).toBe(false);
    expect(restarts).toBe(0);
  });

  it('does not refuse over a bound document — no file is rewritten', async () => {
    // The busy refusal exists because a PULL overwrites files under an
    // editor. A restart writes nothing, and `handle.stop()` flushes every
    // pending write-back on the way down (rooms.ts `flush`), so refusing
    // here would block a deploy over a hazard that is not present.
    const git = fakeGit(currentScript());
    const w = fakeWait();
    let restarts = 0;
    const res = await runDeploy(
      deps({
        git: git.run,
        wait: w.wait,
        readServed: () => 'older99',
        busyDocs: () => [{ docId: 'd1', path: '/repo/docs/live-plan.md' }],
        restart: () => {
          restarts++;
        },
      }),
    );
    expect(res.status).toBe('restarted');
    expect(restarts).toBe(1);
    expect(w.asked).toEqual([]);
  });

  it('a deployment with no release root reports up-to-date, not a restart', async () => {
    // dev, staging, a bare bin.ts. `readServed` is absent because there is
    // no published client to compare against, and a restart there bounces
    // every live editor to rebuild a bundle nobody is serving.
    const git = fakeGit(currentScript());
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
    expect(restarts).toBe(0);
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

describe('servedRefReader', () => {
  /** A published release, built by hand: `current` → `releases/<id>` with a
   *  provenance file. Synthetic; nothing here is a real bundle. */
  function publish(root: string, id: string, provenance: Record<string, unknown> | null): void {
    const dir = join(root, 'releases', id);
    mkdirSync(join(dir, 'markdown-app'), { recursive: true });
    if (provenance) {
      writeFileSync(join(dir, 'release.json'), `${JSON.stringify(provenance)}\n`);
    }
    rmSync(join(root, 'current'), { force: true });
    symlinkSync(dir, join(root, 'current'));
  }

  it('reads the ref the served release recorded', () => {
    const root = mkdtempSync(join(tmpdir(), 'served-ref-'));
    try {
      publish(root, '20260101T000000000Z-000001', {
        id: '20260101T000000000Z-000001',
        publishedAt: 1_700_000_000_000,
        sourceRef: 'abc1234',
      });
      const read = servedRefReader(root);
      expect(read).not.toBeNull();
      expect(read?.()).toBe('abc1234');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers null for a release that recorded none — not a match', () => {
    // Positive control above: the same reader CAN see a ref, so this null is
    // the release's silence rather than a reader that never reads anything.
    const root = mkdtempSync(join(tmpdir(), 'served-ref-'));
    try {
      publish(root, '20260101T000000000Z-000001', {
        id: '20260101T000000000Z-000001',
        publishedAt: 1_700_000_000_000,
      });
      expect(servedRefReader(root)?.()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is absent entirely when this deployment publishes no release', () => {
    // Not "a reader that answers null" — no reader at all, so `runDeploy`
    // never asks and never restarts dev or staging over prod's releases.
    expect(servedRefReader(null)).toBeNull();
    expect(servedRefReader(undefined)).toBeNull();
    expect(servedRefReader('   ')).toBeNull();
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
