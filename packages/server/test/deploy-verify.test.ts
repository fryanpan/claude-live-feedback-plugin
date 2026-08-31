/**
 * The deploy's boot verification, end to end over a scratch log file.
 *
 * The mechanism spans three processes in production — the deploy that dies,
 * the server that comes back, the watchdog that outlives both — but every
 * hand-off is a read or write of `deploy-log.json`, so the whole lifecycle is
 * drivable here through the file. Nothing in this suite spawns a process,
 * restarts anything, or sleeps for real.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERIFY_APPEAR_GRACE_MS, watchDeployBoot } from '../src/deploy-verify.ts';
import {
  type DeployResult,
  Deployer,
  VERIFY_BOOT_TIMEOUT_MS,
  confirmDeployBoot,
  deployLogPath,
  expireDeployVerification,
  readDeployLog,
  writeDeployLog,
} from '../src/deploy.ts';

const T0 = 1_700_000_000_000;

/** What a deploy writes just before its restart kills it. */
function pendingRecord(over: Partial<DeployResult> = {}): DeployResult {
  return {
    ok: true,
    status: 'deployed',
    before: 'aaaaaaa',
    after: 'bbbbbbb',
    changed: true,
    behind: 1,
    ahead: 0,
    restartRequested: true,
    installed: true,
    verification: { state: 'pending', deadlineAt: T0 + VERIFY_BOOT_TIMEOUT_MS },
    message: 'fixture deploy',
    ranAt: T0,
    ...over,
  };
}

function withLog(body: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-verify-'));
  try {
    body(deployLogPath(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('confirmDeployBoot — the restarted server claims its own health', () => {
  it('flips a pending restart to healthy, durably', () => {
    withLog((file) => {
      writeDeployLog(file, pendingRecord());
      const confirmed = confirmDeployBoot(file, () => T0 + 30_000);
      expect(confirmed?.verification).toEqual({
        state: 'healthy',
        confirmedAt: T0 + 30_000,
        detail: 'the restarted server came up and confirmed its own boot',
      });
      // The deploy's own facts survive the confirmation.
      expect(confirmed?.status).toBe('deployed');
      expect(confirmed?.ok).toBe(true);
      // Durable, not in-memory: the next process reads the verdict.
      expect(readDeployLog(file)?.verification?.state).toBe('healthy');
    });
  });

  it('leaves an ordinary boot alone — no deploy in flight, nothing to confirm', () => {
    withLog((file) => {
      // Positive control first: the same call CAN write (above), so these
      // nulls are refusals, not a writer that never writes.
      const settled = pendingRecord({
        verification: { state: 'healthy', confirmedAt: T0 + 1, detail: 'already confirmed' },
      });
      writeDeployLog(file, settled);
      expect(confirmDeployBoot(file, () => T0 + 2)).toBeNull();
      expect(readDeployLog(file)?.verification).toEqual(settled.verification);

      // A refusal that never restarted has nothing pending either.
      writeDeployLog(file, pendingRecord({ restartRequested: false, verification: undefined }));
      expect(confirmDeployBoot(file, () => T0 + 2)).toBeNull();
    });
  });

  it('answers null with no log at all', () => {
    withLog((file) => {
      expect(confirmDeployBoot(file, () => T0)).toBeNull();
    });
  });
});

describe('expireDeployVerification — the watchdog fails what nobody confirmed', () => {
  it('does not touch a record whose deadline has not passed', () => {
    withLog((file) => {
      writeDeployLog(file, pendingRecord());
      expect(expireDeployVerification(file, () => T0 + VERIFY_BOOT_TIMEOUT_MS - 1)).toBeNull();
      expect(readDeployLog(file)?.verification?.state).toBe('pending');
    });
  });

  it('a pending record past its deadline becomes a durable boot-failed', () => {
    withLog((file) => {
      writeDeployLog(file, pendingRecord());
      const failed = expireDeployVerification(file, () => T0 + VERIFY_BOOT_TIMEOUT_MS + 1);
      expect(failed?.status).toBe('boot-failed');
      expect(failed?.ok).toBe(false);
      expect(failed?.verification?.state).toBe('failed');
      expect(failed?.message).toBe('fixture deploy');
      const onDisk = readDeployLog(file);
      expect(onDisk?.status).toBe('boot-failed');
      expect(onDisk?.verification?.state).toBe('failed');
      if (onDisk?.verification?.state === 'failed') {
        expect(onDisk.verification.detail).toContain('never confirmed a healthy boot');
      }
    });
  });

  it('never fails a record the server already confirmed — even long after', () => {
    withLog((file) => {
      writeDeployLog(file, pendingRecord());
      confirmDeployBoot(file, () => T0 + 10_000);
      expect(expireDeployVerification(file, () => T0 + VERIFY_BOOT_TIMEOUT_MS * 10)).toBeNull();
      expect(readDeployLog(file)?.verification?.state).toBe('healthy');
    });
  });
});

describe('watchDeployBoot — the loop the detached watchdog runs', () => {
  /** Drives the loop with a fake clock that advances on every sleep. */
  function drive(file: string, opts: { confirmAtMs?: number } = {}) {
    let now = T0;
    return watchDeployBoot({
      readLog: () => {
        if (opts.confirmAtMs !== undefined && now - T0 >= opts.confirmAtMs) {
          confirmDeployBoot(file, () => now);
        }
        return readDeployLog(file);
      },
      expire: () => expireDeployVerification(file, () => now),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
  }

  it('stands down once the restarted server confirms', async () => {
    await withLogAsync(async (file) => {
      writeDeployLog(file, pendingRecord());
      expect(await drive(file, { confirmAtMs: 20_000 })).toBe('resolved');
      expect(readDeployLog(file)?.verification?.state).toBe('healthy');
    });
  });

  it('writes boot-failed when the deadline passes with nobody home', async () => {
    await withLogAsync(async (file) => {
      writeDeployLog(file, pendingRecord());
      expect(await drive(file)).toBe('expired');
      expect(readDeployLog(file)?.status).toBe('boot-failed');
    });
  });

  it('tolerates being spawned before the deploy result is persisted', async () => {
    // The real spawn happens inside `runDeploy`, a beat before the result is
    // written. A watchdog that trusted its FIRST read would see the previous
    // deploy's settled record and exit — and the crash it was spawned to
    // catch would go unrecorded.
    await withLogAsync(async (file) => {
      writeDeployLog(
        file,
        pendingRecord({
          verification: { state: 'healthy', confirmedAt: T0 - 1000, detail: 'previous deploy' },
        }),
      );
      let now = T0;
      let polls = 0;
      const outcome = await watchDeployBoot({
        readLog: () => {
          // The new pending record lands on the second poll.
          if (++polls === 2) writeDeployLog(file, pendingRecord());
          return readDeployLog(file);
        },
        expire: () => expireDeployVerification(file, () => now),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
      expect(outcome).toBe('expired');
      expect(readDeployLog(file)?.status).toBe('boot-failed');
    });
  });

  it('exits without writing when no pending record ever appears', async () => {
    await withLogAsync(async (file) => {
      const settled = pendingRecord({
        verification: { state: 'healthy', confirmedAt: T0 - 1000, detail: 'previous deploy' },
      });
      writeDeployLog(file, settled);
      expect(await drive(file)).toBe('never-pending');
      expect(readDeployLog(file)?.verification).toEqual(settled.verification);
    });
  });

  it('the grace window outlives more than one poll', () => {
    // Shape check on the constants the loop is built from: a grace shorter
    // than a couple of polls would make "never-pending" a coin flip.
    expect(VERIFY_APPEAR_GRACE_MS).toBeGreaterThan(4_000);
  });
});

async function withLogAsync(body: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-verify-'));
  try {
    await body(deployLogPath(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Deployer.last — the reader gets the verdict, not the stale intent', () => {
  it('re-reads a pending record from disk, so another process settling it is seen', async () => {
    await withLogAsync(async (file) => {
      writeDeployLog(file, pendingRecord());
      const d = new Deployer({
        run: async () => pendingRecord(),
        loadLast: () => readDeployLog(file),
        now: () => T0 + 60_000,
      });
      expect(d.last()?.verification?.state).toBe('pending');
      // The restarted server writes healthy behind this process's back…
      confirmDeployBoot(file, () => T0 + 90_000);
      // …and the next read reports it instead of the cached pending.
      expect(d.last()?.verification?.state).toBe('healthy');
    });
  });

  it('presents a pending record past its deadline as boot-failed even with no watchdog', async () => {
    await withLogAsync(async (file) => {
      writeDeployLog(file, pendingRecord());
      const d = new Deployer({
        run: async () => pendingRecord(),
        loadLast: () => readDeployLog(file),
        now: () => T0 + VERIFY_BOOT_TIMEOUT_MS + 1,
      });
      const seen = d.last();
      expect(seen?.status).toBe('boot-failed');
      expect(seen?.ok).toBe(false);
      // Positive control on the same fixture: before the deadline the same
      // reader reports the honest in-between state.
      const early = new Deployer({
        run: async () => pendingRecord(),
        loadLast: () => readDeployLog(file),
        now: () => T0 + 1,
      });
      expect(early.last()?.verification?.state).toBe('pending');
      expect(early.last()?.status).toBe('deployed');
    });
  });
});
