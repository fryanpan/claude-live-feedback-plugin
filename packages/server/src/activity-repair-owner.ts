#!/usr/bin/env bun
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LockHolder, acquireActivityLock, releaseActivityLock } from './activity-lock.ts';
import { activityLogPath, isOwnerActor } from './activity.ts';
import { loadIdentityLinks } from './identity-links.ts';

/**
 * Recompute `isOwner` on every row already in `<dataDir>/activity.jsonl`.
 *
 * WHY THIS EXISTS AND THE BACKFILL IS NOT ENOUGH. `activity-backfill.ts`
 * rebuilds the stream from the `.ydoc` snapshots, so it can only reproduce
 * the comment family (comment / reply / resolve). `read_session` and
 * `doc_open` were never written into a CRDT — they are live-capture only and
 * are not reconstructable from anything. Measured on the live stream, 711 of
 * the 1,120 mis-attributed rows are exactly those two types, so a backfill
 * re-run repairs well under half of them and leaves the rest wrong forever.
 * The backfill also APPENDS: a re-run adds a second row with the same
 * `eventId`, and which of the pair a reader keeps is the reader's dedupe
 * policy, not ours.
 *
 * So this rewrites the file, and because `activity.jsonl` holds the only copy
 * of the read events, the rewrite has to be impossible to interleave with the
 * server's appends rather than merely checked for afterwards:
 *
 *   - `--write` REFUSES unless it can take the data dir's activity-writer
 *     lock, which the server holds for as long as it is up. "Stop the server
 *     first" is therefore verified, not assumed. A dry run ignores the lock —
 *     reading is not writing.
 *   - the original is moved aside with `rename`, which is atomic and is also
 *     the backup. From that instant no append can reach it: `appendActivity`
 *     opens the path by NAME each time, so a writer that ignored the lock
 *     creates a fresh `activity.jsonl` instead of writing into the file being
 *     replaced.
 *   - if such a file appears before the swap, its rows are SPLICED onto the
 *     end of the repaired content rather than clobbered by the rename. This
 *     is the case the old size-check could only detect, and detection was
 *     never a remedy — by then the rows were already gone.
 *   - lines that do not parse are carried through byte-for-byte rather than
 *     dropped. A row this tool cannot read is still somebody's data.
 *
 * Nothing but `isOwner` changes — not the `eventId`, not `actorId`, not the
 * recorded name. The link is a lens on who an id belongs to; it is not a
 * licence to rewrite what the stream observed.
 *
 * Idempotent: a second run recomputes the same values and reports 0 changed.
 */

export interface RepairStats {
  /** Rows read, parseable or not. */
  rows: number;
  /** Rows whose `isOwner` was false and is now true. */
  falseToTrue: number;
  /** Rows whose `isOwner` was true and is now false. Expected to be 0 — a
   *  non-zero count means the registry disagrees with a past run and is worth
   *  reading before writing, which is why the dry run is the default. */
  trueToFalse: number;
  /** Lines that did not parse as JSON and were carried through verbatim. */
  unparseable: number;
  /** How many identity links were in force. A repair that loaded none can
   *  only ever report 0 changed, and that is a broken run rather than a
   *  clean one. */
  identityLinksLoaded: number;
  /** Per-actor breakdown of the changes, `"<actorId> (<actorName>)"` -> count. */
  changedByActor: Record<string, number>;
  /** Where the pre-repair copy was written, when the run wrote anything. */
  backupPath?: string;
  /** Set when `--write` was refused because something else holds the data
   *  dir's activity-writer lock — normally the running server. Nothing was
   *  written; stop that process and run again. */
  refusedLockHeldBy?: LockHolder;
  /** Rows a writer appended after the log was moved aside, carried onto the
   *  end of the repaired file rather than discarded. Non-zero means something
   *  wrote while holding no lock, which is worth investigating even though no
   *  data was lost. */
  splicedRows?: number;
}

export interface RepairOptions {
  dataDir: string;
  /** When false (the default), computes the stats and writes nothing. */
  write?: boolean;
  /**
   * Fires in the window between moving the log aside and swapping the
   * repaired file in. A test seam, and the only way to exercise the splice:
   * the window is microseconds wide, so a test that tried to race it would
   * pass by luck and fail in CI.
   */
  onBeforeSwap?: () => void;
}

export function repairActivityOwner(opts: RepairOptions): RepairStats {
  const stats: RepairStats = {
    rows: 0,
    falseToTrue: 0,
    trueToFalse: 0,
    unparseable: 0,
    identityLinksLoaded: 0,
    changedByActor: {},
  };
  const links = loadIdentityLinks(opts.dataDir);
  if (links.error) console.error(`[repair] ${links.error}`);
  stats.identityLinksLoaded = links.loaded;

  const path = activityLogPath(opts.dataDir);
  if (!existsSync(path)) return stats;

  // Take the lock BEFORE reading, so the snapshot the repair computes from is
  // one no other writer can be extending. A dry run skips this entirely: it
  // reads and reports, and a read never has to exclude anyone.
  const lock = opts.write === true ? acquireActivityLock(opts.dataDir, 'activity-repair') : null;
  if (lock && !lock.ok) {
    stats.refusedLockHeldBy = lock.heldBy;
    console.error(
      `[repair] refusing to write: ${lock.path} is held by pid ${lock.heldBy?.pid} (${lock.heldBy?.holder}). ` +
        'Stop the server for this data dir and run again.',
    );
    return stats;
  }

  try {
    const original = readFileSync(path, 'utf8');
    // A trailing newline means a final empty segment; keep it out of the row
    // count and put it back on write.
    const endsWithNewline = original.endsWith('\n');
    const lines = original.split('\n');
    if (endsWithNewline) lines.pop();

    const out: string[] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        out.push(line);
        continue;
      }
      stats.rows++;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        event = parsed as Record<string, unknown>;
      } catch {
        stats.unparseable++;
        out.push(line);
        continue;
      }
      const author = { id: event.actorId, name: event.actorName };
      const isOwner = isOwnerActor(author);
      if (isOwner === event.isOwner) {
        out.push(line);
        continue;
      }
      if (isOwner) stats.falseToTrue++;
      else stats.trueToFalse++;
      const key = `${String(event.actorId ?? '')} (${String(event.actorName ?? '')})`;
      stats.changedByActor[key] = (stats.changedByActor[key] ?? 0) + 1;
      event.isOwner = isOwner;
      out.push(JSON.stringify(event));
    }

    const changed = stats.falseToTrue + stats.trueToFalse;
    if (opts.write !== true || changed === 0) return stats;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(opts.dataDir, `activity.jsonl.${stamp}.bak`);
    // `rename` rather than `copy`: it is atomic, it IS the backup, and it
    // takes the append target away in one step. Every later `appendActivity`
    // opens the path by name, finds nothing, and starts a fresh file — so
    // from here on nothing can be written into the file being replaced.
    renameSync(path, backup);
    stats.backupPath = backup;

    const tmp = `${path}.repair.tmp`;
    let content = out.join('\n') + (endsWithNewline ? '\n' : '');
    try {
      opts.onBeforeSwap?.();
      // Did a writer that ignored the lock start a new log in the meantime?
      // Carry its rows onto the end rather than letting the swap delete them.
      if (existsSync(path)) {
        const rogue = readFileSync(path, 'utf8');
        const rogueRows = rogue.split('\n').filter((l) => l.trim() !== '').length;
        if (rogueRows > 0) {
          stats.splicedRows = rogueRows;
          console.error(
            `[repair] ${rogueRows} row(s) were appended to ${path} while it was being repaired — ` +
              'spliced onto the end. Something wrote without holding the lock.',
          );
          if (!content.endsWith('\n') && content !== '') content += '\n';
          content += rogue;
        }
        rmSync(path, { force: true });
      }
      writeFileSync(tmp, content);
      renameSync(tmp, path);
    } catch (err) {
      // Put the original back. Nothing else can have created `path` here that
      // we have not already folded in above.
      try {
        rmSync(tmp, { force: true });
        if (!existsSync(path)) renameSync(backup, path);
      } catch {}
      stats.backupPath = undefined;
      throw err;
    }
    return stats;
  } finally {
    if (lock) releaseActivityLock(lock);
  }
}

// Standalone runnable. DRY RUN BY DEFAULT — pass --write to rewrite the log.
if (import.meta.main) {
  const dataDir = process.argv[2] ?? join(process.cwd(), 'data');
  const write = process.argv.includes('--write');
  const stats = repairActivityOwner({ dataDir, write });
  console.log(JSON.stringify({ dataDir, write, ...stats }, null, 2));
  if (!write) {
    console.log('\nDry run — nothing was written. Re-run with --write to apply.');
    console.log('--write requires the server for this data dir to be STOPPED; it is verified,');
    console.log('not assumed — the run refuses if anything holds the activity-writer lock.');
  } else if (stats.refusedLockHeldBy) {
    console.error('\nNothing was written. Stop the process named above and run again:');
    console.error('  launchctl kill SIGTERM gui/$(id -u)/com.fryanpan.claude-workspaces');
    process.exitCode = 1;
  }
}
