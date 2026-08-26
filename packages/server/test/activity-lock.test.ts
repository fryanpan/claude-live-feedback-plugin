/**
 * `activity.jsonl` is append-only and the server appends to it on every
 * comment and every read session. The repair tool rewrites it wholesale, so
 * the two must never run at once — an append landing between the repair's
 * read and its rename goes into a file that is about to be replaced, and
 * `read_session` / `doc_open` rows exist nowhere else.
 *
 * Detecting that afterwards is not enough, because by then the row is gone.
 * The writer and the repairer therefore share one exclusive lock: the server
 * takes it while it is up, the repair refuses to write unless it can take it,
 * and "stop the server first" becomes a verified precondition rather than an
 * instruction in a doc nobody reads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireActivityLock, activityLockPath, releaseActivityLock } from '../src/activity-lock';

const tmpDirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'activity-lock-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('acquireActivityLock', () => {
  test('takes a free lock and names itself in the file', () => {
    const dir = scratchDir();
    const held = acquireActivityLock(dir, 'test-holder');
    expect(held.ok).toBe(true);
    expect(existsSync(activityLockPath(dir))).toBe(true);
    const body = JSON.parse(readFileSync(activityLockPath(dir), 'utf8'));
    expect(body.pid).toBe(process.pid);
    expect(body.holder).toBe('test-holder');
    releaseActivityLock(held);
    expect(existsSync(activityLockPath(dir))).toBe(false);
  });

  test('REFUSES while a live holder has it, and says who', () => {
    const dir = scratchDir();
    const first = acquireActivityLock(dir, 'server');
    expect(first.ok).toBe(true);
    const second = acquireActivityLock(dir, 'activity-repair');
    expect(second.ok).toBe(false);
    // The operator has to be able to act on this: a refusal that does not
    // name the process holding the lock is a dead end.
    expect(second.heldBy?.pid).toBe(process.pid);
    expect(second.heldBy?.holder).toBe('server');
    releaseActivityLock(first);
  });

  test('reclaims a lock whose holder is gone', () => {
    const dir = scratchDir();
    // A crashed server leaves its lock behind. Refusing forever on a dead
    // pid would make the tool unusable after exactly the incident that most
    // needs it.
    writeFileSync(
      activityLockPath(dir),
      JSON.stringify({ pid: 0x7ffffffe, holder: 'server', startedAt: '2026-01-01T00:00:00.000Z' }),
    );
    const held = acquireActivityLock(dir, 'activity-repair');
    expect(held.ok).toBe(true);
    expect(held.reclaimedStale).toBe(true);
    releaseActivityLock(held);
  });

  test('an unreadable lock file is treated as stale rather than jamming forever', () => {
    const dir = scratchDir();
    writeFileSync(activityLockPath(dir), 'not json at all');
    const held = acquireActivityLock(dir, 'activity-repair');
    expect(held.ok).toBe(true);
    releaseActivityLock(held);
  });

  test('releasing a lock somebody else now holds leaves theirs alone', () => {
    const dir = scratchDir();
    const mine = acquireActivityLock(dir, 'activity-repair');
    // Simulate: my lock was reclaimed as stale and a live server took it —
    // in this same process, so a pid comparison would not notice.
    writeFileSync(
      activityLockPath(dir),
      JSON.stringify({ pid: process.pid, holder: 'server', token: 'someone-else', startedAt: 'x' }),
    );
    releaseActivityLock(mine);
    expect(existsSync(activityLockPath(dir))).toBe(true);
  });

  test('releasing a failed acquisition removes nothing', () => {
    const dir = scratchDir();
    const first = acquireActivityLock(dir, 'server');
    const second = acquireActivityLock(dir, 'activity-repair');
    releaseActivityLock(second);
    expect(existsSync(activityLockPath(dir))).toBe(true);
    releaseActivityLock(first);
    expect(existsSync(activityLockPath(dir))).toBe(false);
  });
});
