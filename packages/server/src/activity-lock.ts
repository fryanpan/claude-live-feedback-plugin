import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One exclusive lock over a data dir's `activity.jsonl`.
 *
 * WHY. The log is append-only and the server appends on every comment and
 * every read session. `activity-repair-owner.ts` rewrites the whole file, so
 * the two must not overlap: an append landing between the repair's read and
 * its rename goes into a file that is about to be replaced, and
 * `read_session` / `doc_open` rows exist nowhere else — no `.ydoc`, no
 * backfill, nothing to rebuild them from.
 *
 * A size check before the rename only DETECTS that, and by the time it fires
 * the alternative is already to abandon the run. What makes the overlap
 * impossible instead is a token both sides hold: the server takes this lock
 * while it is up, and the repair refuses to write unless it can take it. That
 * turns "stop the server first" from an instruction in a doc into a verified
 * precondition.
 *
 * Per DATA DIR rather than machine-wide on purpose. A staging server on its
 * own throwaway dir must not block a repair of prod's, and vice versa — the
 * thing being guarded is the file, not the machine.
 *
 * Deliberately advisory for the SERVER: it acquires best-effort and boots
 * either way. A lock that could stop the server from starting would convert a
 * leftover file into an outage, which is a worse failure than the one it
 * guards against. The refusal lives on the repair side, where refusing means
 * "changed nothing".
 */
export const ACTIVITY_LOCK_FILE = 'activity-writer.lock';

/** Where the lock lives inside a data dir. */
export function activityLockPath(dataDir: string): string {
  return join(dataDir, ACTIVITY_LOCK_FILE);
}

export interface LockHolder {
  pid: number;
  holder: string;
  startedAt: string;
  /** Unique per acquisition. Identity cannot rest on the pid alone: pids are
   *  reused, and a process whose own lock was reclaimed as stale would
   *  otherwise delete its successor's on the way out — including its
   *  successor in the SAME process. */
  token?: string;
}

export interface ActivityLock {
  ok: boolean;
  path: string;
  /** Set when `ok` is false: who is holding it, so a refusal is actionable. */
  heldBy?: LockHolder;
  /** True when a previous holder's lock was found abandoned and taken over. */
  reclaimedStale?: boolean;
  /** The token written into the file, checked again on release. */
  token?: string;
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      holder: typeof parsed.holder === 'string' ? parsed.holder : 'unknown',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
    };
  } catch {
    return null;
  }
}

/** Is that pid still running? `signal 0` checks existence without signalling. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeLock(path: string, holder: string, token: string): boolean {
  try {
    // 'wx' is O_CREAT|O_EXCL: the create either wins or throws, so two
    // processes racing here cannot both believe they hold the lock.
    const fd = openSync(path, 'wx');
    try {
      writeSync(
        fd,
        `${JSON.stringify(
          { pid: process.pid, holder, token, startedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
      );
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the lock, or report who has it.
 *
 * A lock whose recorded pid is gone — or that does not parse — is treated as
 * abandoned and taken over. Refusing forever on a dead pid would make the
 * repair unusable after precisely the crash that most needs it, and would
 * turn a stray file into a permanent outage of the tool.
 */
export function acquireActivityLock(dataDir: string, holder: string): ActivityLock {
  const path = activityLockPath(dataDir);
  const token = randomUUID();
  if (writeLock(path, holder, token)) return { ok: true, path, token };

  const existing = readHolder(path);
  if (existing && pidAlive(existing.pid)) return { ok: false, path, heldBy: existing };

  // Abandoned (dead pid) or unreadable: clear it and take it. If the retry
  // still loses, somebody else won the same race — report them.
  try {
    rmSync(path, { force: true });
  } catch {}
  if (writeLock(path, holder, token)) return { ok: true, path, token, reclaimedStale: true };
  return { ok: false, path, heldBy: readHolder(path) ?? undefined };
}

/**
 * Release a lock this process took. A no-op for a failed acquisition, and it
 * refuses to delete a lock that now records somebody else — otherwise a
 * process whose lock was reclaimed as stale would delete its successor's on
 * the way out.
 */
export function releaseActivityLock(lock: ActivityLock): void {
  if (!lock.ok) return;
  const current = readHolder(lock.path);
  // Only ever delete the acquisition we made. A different token means our
  // lock was reclaimed and somebody else holds this file now.
  if (!current || current.token !== lock.token) return;
  try {
    rmSync(lock.path, { force: true });
  } catch {}
}

/** Who holds the lock right now, if anyone live does. For a status read that
 *  must not take the lock itself. */
export function activityLockHolder(dataDir: string): LockHolder | null {
  const path = activityLockPath(dataDir);
  if (!existsSync(path)) return null;
  const held = readHolder(path);
  return held && pidAlive(held.pid) ? held : null;
}
