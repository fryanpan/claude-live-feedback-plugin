/**
 * The deploy boot watchdog — the process that survives the restart.
 *
 * A deploy ends by killing the server that performed it, so nothing inside
 * that server can find out whether the restart produced a serving process.
 * This script is spawned DETACHED alongside the restart
 * (`spawnDeployVerifier` in deploy.ts) and does exactly one thing: if the
 * deploy record is still `pending` when its deadline passes, write the
 * durable `boot-failed` verdict.
 *
 * It never writes `healthy` — that verdict belongs to the restarted server
 * (`confirmDeployBoot`, called from bin.ts once it is actually serving),
 * because "the port answered" is a weaker claim than "I finished coming up".
 * And it never fails a record whose deadline is in the future: a NEWER
 * deploy's record carries a newer deadline, so a stale watchdog reads it and
 * stands down rather than failing somebody else's restart.
 *
 * The one race it has to survive: it is spawned a beat BEFORE the deploy
 * result is persisted (the restart is scheduled inside `runDeploy`; the
 * write happens as the result propagates out). So a non-pending first read
 * does not mean "nothing to do" — the record may simply not be there yet.
 * It waits a grace period for a pending record to APPEAR, and only a record
 * it has actually seen pending can make it write anything.
 */
import { expireDeployVerification, readDeployLog } from './deploy.ts';

/** How often the log is re-read. The verdict deadline is minutes; seconds of
 *  lag on the write are invisible. */
export const VERIFY_POLL_INTERVAL_MS = 2_000;

/** How long to wait for the pending record to appear at all. The persist is
 *  milliseconds behind the spawn; this covers a slow disk, not a design. */
export const VERIFY_APPEAR_GRACE_MS = 15_000;

export interface WatchDeps {
  readLog: () => ReturnType<typeof readDeployLog>;
  expire: () => ReturnType<typeof expireDeployVerification>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export type WatchOutcome =
  /** The record resolved — the restarted server confirmed, or a newer deploy
   *  replaced it. Either way this watchdog's work is somebody else's. */
  | 'resolved'
  /** The deadline passed still pending; the failed verdict was written. */
  | 'expired'
  /** No pending record ever appeared within the grace window. */
  | 'never-pending';

/** The loop, with every clock and file injected so a test drives it in
 *  milliseconds against a scratch log. */
export async function watchDeployBoot(deps: WatchDeps): Promise<WatchOutcome> {
  const startedAt = deps.now();
  let sawPending = false;
  for (;;) {
    const last = deps.readLog();
    if (last?.verification?.state === 'pending') {
      sawPending = true;
      if (deps.expire()) return 'expired';
    } else if (sawPending) {
      return 'resolved';
    } else if (deps.now() - startedAt >= VERIFY_APPEAR_GRACE_MS) {
      return 'never-pending';
    }
    await deps.sleep(VERIFY_POLL_INTERVAL_MS);
  }
}

if (import.meta.main) {
  const logFile = process.argv[2];
  if (!logFile) {
    console.error('usage: deploy-verify.ts <deploy-log.json>');
    process.exit(2);
  }
  const outcome = await watchDeployBoot({
    readLog: () => readDeployLog(logFile),
    expire: () => expireDeployVerification(logFile),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  if (outcome === 'expired') {
    console.error(`[deploy-verify] wrote boot-failed to ${logFile}`);
  }
  process.exit(0);
}
