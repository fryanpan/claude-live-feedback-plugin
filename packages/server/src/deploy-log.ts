/**
 * The deploy record: its shape, its durable file, and who gets to say the
 * restart worked.
 *
 * Split out of `deploy.ts` (A7), which decides whether to deploy and then
 * does it. This half is what SURVIVES that — a deploy ends by killing the
 * process that performed it, so everything about the outcome has to be
 * readable from a file afterwards, by a process that did none of the work.
 *
 * Three writers, and they must agree on the record without ever meeting:
 * the deploy stamps `pending` before the restart kills it, the RESTARTED
 * server stamps `healthy`, and a detached watchdog stamps `boot-failed` when
 * the deadline passes with neither having happened. That is why this file is
 * the leaf and holds the shape: `DeployResult` is a wire format between
 * processes, not an internal type of the runner.
 *
 * `VERIFY_BOOT_TIMEOUT_MS` travelled with them — it is the deadline written
 * into the record and the one `bootFailedResult` quotes back — and `deploy.ts`
 * imports it, and the four record types, back under the names it published.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How long a restarted server gets to confirm its own boot before the
 *  deploy is recorded as `boot-failed`. Prod's restart re-runs
 *  `scripts/serve.ts`, which rebuilds both browser bundles and then hydrates
 *  every persisted document before the port answers — minutes on a bad day,
 *  so the deadline is generous. What it must never be is infinite: a
 *  `pending` that nothing expires is the 200-on-a-dead-server this exists to
 *  remove. */
export const VERIFY_BOOT_TIMEOUT_MS = 180_000;

/** A bound document whose write-back flush has not fired yet. */
export interface BusyDoc {
  docId: string;
  path: string;
}

export type DeployStatus =
  | 'deployed'
  /** Nothing to pull, but the served client was built from an older ref, so
   *  the server was restarted to rebuild and republish it. */
  | 'restarted'
  | 'up-to-date'
  | 'refuse-diverged'
  | 'refuse-dirty'
  | 'refuse-busy'
  /** `bun install` failed after the pull (or before a restart-only), so the
   *  restart was refused — the running server keeps its working
   *  dependencies rather than booting into a missing import. */
  | 'install-failed'
  /** The restart was scheduled and the server never confirmed a healthy
   *  boot before the verification deadline. Written by the watchdog, or
   *  derived at read time from a `pending` past its deadline. */
  | 'boot-failed'
  | 'error';

/**
 * Whether the restart a deploy scheduled actually produced a serving
 * process. Three states, written by three different actors:
 *
 * - `pending` — stamped by the deploy itself, with the deadline, before the
 *   restart kills the process that stamped it.
 * - `healthy` — stamped by the RESTARTED server once it is serving
 *   (`confirmDeployBoot`). Nothing else may claim health: the deploy cannot
 *   know it, and the watchdog knowing the port answered is weaker than the
 *   server knowing it finished coming up.
 * - `failed` — stamped by the detached watchdog when the deadline passes
 *   with the record still pending, or derived at read time when even the
 *   watchdog did not survive to write it.
 */
export type DeployVerification =
  | { state: 'pending'; deadlineAt: number }
  | { state: 'healthy'; confirmedAt: number; detail: string }
  /** `statusWas` keeps the status the deploy earned before the expiry
   *  overwrote it, so a late confirmation can restore it. */
  | { state: 'failed'; failedAt: number; detail: string; statusWas: DeployStatus };

export interface DeployResult {
  /** The deploy did what it set out to do. A refusal is `ok: false` with a
   *  status that says which refusal — never a thrown error, because the
   *  caller asked "can you deploy" and the answer is information. */
  ok: boolean;
  status: DeployStatus;
  /** What the deploy source was parked on before, read from the checkout. */
  before: string | null;
  /** And after. Read the same way — never parsed out of git's output, which
   *  reports success for a pull that moved nothing. */
  after: string | null;
  /** Whether the checkout actually moved. This is the answer people want. */
  changed: boolean;
  behind: number;
  ahead: number;
  /** Every modified tracked path, including the ones that did not block —
   *  so a deploy that proceeded over a modified doc reads as a decision
   *  rather than an oversight. */
  dirtyPaths?: string[];
  /** The subset that refused the deploy. */
  blockingPaths?: string[];
  /** Bound docs still holding un-flushed edits, when that is what refused. */
  busyDocs?: BusyDoc[];
  /** A restart was scheduled. It is fire-and-forget by necessity: the
   *  restart kills the process that would have reported on it. */
  restartRequested: boolean;
  /** Whether `bun install` ran (it runs before every restart). Absent on
   *  paths that never reached one. */
  installed?: boolean;
  /** Whether the restarted server actually came back. Present exactly when
   *  a restart was requested — see `DeployVerification`. */
  verification?: DeployVerification;
  /** Whether the caller overrode the busy-document refusal. */
  forced?: boolean;
  requestedBy?: string;
  message: string;
  ranAt: number;
}

// ---------------------------------------------------------------------------
// The durable trace
// ---------------------------------------------------------------------------

/** Where the last deploy result is kept. */
export function deployLogPath(dataDir: string): string {
  return join(dataDir, 'deploy-log.json');
}

/**
 * A deploy ends by killing the process that performed it, so an in-memory
 * `last()` is empty in exactly the situation someone asks the question. The
 * write happens as soon as `runDeploy` resolves, which is inside the restart
 * delay — the restart is scheduled, not immediate, precisely so the result
 * and the response both get out first.
 */
export function writeDeployLog(file: string, result: DeployResult): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp~`;
    writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    console.error('[deploy] could not record the deploy result:', err);
  }
}

export function readDeployLog(file: string): DeployResult | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeployResult;
    return typeof parsed?.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Boot verification — who gets to say the restart worked
// ---------------------------------------------------------------------------

/**
 * The RESTARTED server confirms the deploy that restarted it. Called from
 * `bin.ts` once the server is actually serving (port bound, documents
 * hydrated) — which is the only vantage point that can claim health, because
 * the deploy's own process is dead by then and the watchdog can only see
 * that something answered.
 *
 * A live server wins even PAST the deadline, in both write orders — a boot
 * that lands late flips a still-pending record and also overturns a
 * `boot-failed` the watchdog already wrote. The alternative is a verdict
 * decided by which writer got to the file first: the same slow boot reading
 * healthy or failed depending on scheduling. The deadline's honest meaning
 * is "as of then, nothing had come up", and the lateness is kept in the
 * detail rather than in the verdict. An ordinary boot with no restart in
 * flight, or one already confirmed, is left alone.
 */
export function confirmDeployBoot(file: string, now: () => number = Date.now): DeployResult | null {
  const last = readDeployLog(file);
  if (!last || !last.restartRequested) return null;
  const v = last.verification;
  if (v?.state === 'pending') {
    const late = now() >= v.deadlineAt;
    const updated: DeployResult = {
      ...last,
      verification: {
        state: 'healthy',
        confirmedAt: now(),
        detail: late
          ? 'the restarted server came up and confirmed its own boot — after the ' +
            'verification deadline, so a reader in between saw boot-failed'
          : 'the restarted server came up and confirmed its own boot',
      },
    };
    writeDeployLog(file, updated);
    return updated;
  }
  if (v?.state === 'failed') {
    const updated: DeployResult = {
      ...last,
      ok: true,
      status: v.statusWas,
      verification: {
        state: 'healthy',
        confirmedAt: now(),
        detail:
          'the restarted server came up after the verification deadline had already ' +
          'expired the deploy — the boot-failed verdict is overturned',
      },
    };
    writeDeployLog(file, updated);
    return updated;
  }
  return null;
}

/** The failed-boot verdict, shared by the watchdog's durable write and the
 *  read-time derivation so the two can never tell different stories. Exported
 *  by the split: the read-time derivation is `Deployer.last`, which stayed
 *  with the runner, and a second copy of this verdict is exactly the drift
 *  the comment above forbids. */
export function bootFailedResult(last: DeployResult, now: number): DeployResult {
  return {
    ...last,
    ok: false,
    status: 'boot-failed',
    verification: {
      state: 'failed',
      statusWas: last.status,
      failedAt: now,
      detail:
        `the restarted server never confirmed a healthy boot within ${
          VERIFY_BOOT_TIMEOUT_MS / 1000
        }s — it may be crash-looping (a missing dependency, a startup throw); ` +
        'check the launchd error log',
    },
  };
}

/**
 * The watchdog's one write: a record still `pending` past its own deadline
 * becomes a durable `boot-failed`. Deliberately keyed on the RECORD's
 * deadline rather than on who spawned the watchdog — a newer deploy's record
 * carries a future deadline, so a stale watchdog reads it and stands down
 * instead of failing somebody else's restart.
 */
export function expireDeployVerification(
  file: string,
  now: () => number = Date.now,
): DeployResult | null {
  const last = readDeployLog(file);
  if (!last || last.verification?.state !== 'pending') return null;
  if (now() < last.verification.deadlineAt) return null;
  const updated = bootFailedResult(last, now());
  writeDeployLog(file, updated);
  return updated;
}

/**
 * The boot watchdog, as a DETACHED process — its own process group, stdio
 * closed, unref'd — because `launchctl kickstart -k` is about to kill this
 * process and everything that dies with it. All it can do is expire a still
 * `pending` record into `boot-failed` (see `deploy-verify.ts`); the healthy
 * verdict belongs to the restarted server alone.
 */
export function spawnDeployVerifier(logFile: string): () => void {
  return () => {
    try {
      const script = fileURLToPath(new URL('./deploy-verify.ts', import.meta.url));
      // No shell, fixed argv — same rule as the restart below.
      const child = spawn(process.execPath, [script, logFile], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      // Losing the watchdog does not lose the verdict: a `pending` past its
      // deadline reads as failed at read time (`Deployer.last`). It only
      // loses the durable write.
      console.error('[deploy] could not spawn the boot verifier:', err);
    }
  };
}
