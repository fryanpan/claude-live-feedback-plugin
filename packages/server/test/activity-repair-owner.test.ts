/**
 * The historical half of the identity-link fix.
 *
 * A backfill re-run cannot repair the whole stream: it rebuilds from `.ydoc`
 * snapshots, and `read_session` / `doc_open` never existed in a CRDT. On the
 * live stream those two types are 711 of the 1,120 mis-attributed rows, so
 * the repair has to be able to touch rows the backfill can never regenerate —
 * without disturbing anything else in a file that is the only copy of them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityLogPath, resetOwnerIdentities } from '../src/activity';
import { acquireActivityLock, activityLockPath, releaseActivityLock } from '../src/activity-lock';
import { repairActivityOwner } from '../src/activity-repair-owner';
import { identityLinksPath } from '../src/identity-links';

const tmpDirs: string[] = [];

function seedDir(rows: unknown[], links?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'activity-repair-'));
  tmpDirs.push(dir);
  writeFileSync(activityLogPath(dir), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  if (links !== undefined) writeFileSync(identityLinksPath(dir), JSON.stringify(links));
  return dir;
}

function readRows(dir: string): Record<string, unknown>[] {
  return readFileSync(activityLogPath(dir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const linkedRead = {
  eventId: 'e1',
  ts: '2026-08-01T00:00:00.000Z',
  type: 'read_session',
  actor: 'person',
  actorId: 'anon-fixture1',
  actorName: 'Owner Fullname',
  isOwner: false,
  payload: { durationMs: 1000 },
};
const unlinkedSameName = {
  eventId: 'e2',
  ts: '2026-08-01T00:01:00.000Z',
  type: 'comment',
  actor: 'person',
  actorId: 'anon-fixture2',
  actorName: 'Owner Fullname',
  isOwner: false,
  payload: {},
};
const knownOwner = {
  eventId: 'e3',
  ts: '2026-08-01T00:02:00.000Z',
  type: 'comment',
  actor: 'person',
  actorId: 'known-bryan',
  actorName: 'Bryan',
  isOwner: true,
  payload: {},
};

afterEach(() => {
  resetOwnerIdentities();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repairActivityOwner', () => {
  test('dry run is the default and writes nothing', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const stats = repairActivityOwner({ dataDir: dir });
    expect(stats.falseToTrue).toBe(1);
    expect(readRows(dir)[0].isOwner).toBe(false);
    expect(stats.backupPath).toBeUndefined();
  });

  test('repairs a read_session the backfill can never regenerate', () => {
    const dir = seedDir([linkedRead, unlinkedSameName, knownOwner], {
      links: { 'anon-fixture1': 'known-bryan' },
    });
    const stats = repairActivityOwner({ dataDir: dir, write: true });
    expect(stats.rows).toBe(3);
    expect(stats.falseToTrue).toBe(1);
    expect(stats.trueToFalse).toBe(0);
    expect(stats.identityLinksLoaded).toBe(1);
    const rows = readRows(dir);
    expect(rows[0].isOwner).toBe(true);
    // Negative control: the unlinked session with the SAME self-reported name
    // is untouched. The link is the evidence, not the name.
    expect(rows[1].isOwner).toBe(false);
    // Positive control: an already-correct owner row is left alone.
    expect(rows[2].isOwner).toBe(true);
  });

  test('changes only isOwner — every other field is byte-identical', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    repairActivityOwner({ dataDir: dir, write: true });
    const row = readRows(dir)[0];
    expect(row).toEqual({ ...linkedRead, isOwner: true });
  });

  test('keeps a timestamped backup of the pre-repair file', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const before = readFileSync(activityLogPath(dir), 'utf8');
    const stats = repairActivityOwner({ dataDir: dir, write: true });
    expect(stats.backupPath).toBeTruthy();
    expect(existsSync(stats.backupPath as string)).toBe(true);
    expect(readFileSync(stats.backupPath as string, 'utf8')).toBe(before);
  });

  test('is idempotent — a second run changes nothing', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    repairActivityOwner({ dataDir: dir, write: true });
    const second = repairActivityOwner({ dataDir: dir, write: true });
    expect(second.falseToTrue).toBe(0);
    expect(second.trueToFalse).toBe(0);
    expect(second.backupPath).toBeUndefined();
  });

  test('carries an unparseable line through verbatim rather than dropping it', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    writeFileSync(activityLogPath(dir), `${JSON.stringify(linkedRead)}\n{ truncated row\n`);
    const stats = repairActivityOwner({ dataDir: dir, write: true });
    expect(stats.unparseable).toBe(1);
    const text = readFileSync(activityLogPath(dir), 'utf8');
    expect(text).toContain('{ truncated row');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  test('with no link file loaded, it reports zero links and changes nothing', () => {
    // The failure this guards: a run against the wrong data dir loads no
    // links, reports a clean 0 changed, and reads exactly like success.
    const dir = seedDir([linkedRead]);
    const stats = repairActivityOwner({ dataDir: dir, write: true });
    expect(stats.identityLinksLoaded).toBe(0);
    expect(stats.falseToTrue).toBe(0);
  });

  test('a missing log is not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-repair-'));
    tmpDirs.push(dir);
    expect(repairActivityOwner({ dataDir: dir, write: true }).rows).toBe(0);
  });
});

/**
 * The rewrite must be impossible to interleave with the server's appends, not
 * merely detected afterwards — a `read_session` row lost to a clobbered
 * rename exists nowhere else. See activity-lock.ts.
 */
describe('the repair will not write while the log has a live writer', () => {
  test('REFUSES --write while the lock is held, and changes nothing', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const server = acquireActivityLock(dir, 'server');
    try {
      const stats = repairActivityOwner({ dataDir: dir, write: true });
      expect(stats.refusedLockHeldBy?.holder).toBe('server');
      expect(stats.backupPath).toBeUndefined();
      // Untouched: a refusal has to mean nothing happened.
      expect(readRows(dir)[0].isOwner).toBe(false);
    } finally {
      releaseActivityLock(server);
    }
  });

  test('a DRY RUN still reports while the lock is held — reading is not writing', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const server = acquireActivityLock(dir, 'server');
    try {
      const stats = repairActivityOwner({ dataDir: dir });
      expect(stats.falseToTrue).toBe(1);
      expect(stats.refusedLockHeldBy).toBeUndefined();
    } finally {
      releaseActivityLock(server);
    }
  });

  test('positive control: the same run succeeds once the writer releases', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const server = acquireActivityLock(dir, 'server');
    expect(repairActivityOwner({ dataDir: dir, write: true }).refusedLockHeldBy).toBeTruthy();
    releaseActivityLock(server);
    expect(repairActivityOwner({ dataDir: dir, write: true }).falseToTrue).toBe(1);
    expect(readRows(dir)[0].isOwner).toBe(true);
  });

  test('releases the lock when it is done, and after a failure', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    repairActivityOwner({ dataDir: dir, write: true });
    expect(existsSync(activityLockPath(dir))).toBe(false);
    // A second server can take it straight afterwards.
    const after = acquireActivityLock(dir, 'server');
    expect(after.ok).toBe(true);
    releaseActivityLock(after);
  });

  test('a rogue append during the rewrite is SPLICED ON, never discarded', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const rogue = { ...knownOwner, eventId: 'rogue-1' };
    // The repair renames the log aside before writing, so an appender that
    // ignored the lock creates a fresh `activity.jsonl` rather than writing
    // into the file being replaced. `onBeforeSwap` stands in for that writer,
    // firing in exactly the window the old size check could only detect.
    const stats = repairActivityOwner({
      dataDir: dir,
      write: true,
      onBeforeSwap: () => appendFileSync(activityLogPath(dir), `${JSON.stringify(rogue)}\n`),
    });
    expect(stats.splicedRows).toBe(1);
    const rows = readRows(dir);
    expect(rows).toHaveLength(2);
    expect(rows[0].isOwner).toBe(true);
    expect(rows[1].eventId).toBe('rogue-1');
  });

  test('the backup survives a rogue append too', () => {
    const dir = seedDir([linkedRead], { links: { 'anon-fixture1': 'known-bryan' } });
    const stats = repairActivityOwner({
      dataDir: dir,
      write: true,
      onBeforeSwap: () =>
        appendFileSync(
          activityLogPath(dir),
          `${JSON.stringify({ ...knownOwner, eventId: 'r' })}\n`,
        ),
    });
    expect(readFileSync(stats.backupPath as string, 'utf8')).toBe(
      `${JSON.stringify(linkedRead)}\n`,
    );
  });
});
