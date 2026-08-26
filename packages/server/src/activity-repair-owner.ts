#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
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
 * So this rewrites the file. Two safeguards, because `activity.jsonl` holds
 * the only copy of the read events:
 *
 *   - the original is copied to a timestamped `.bak` beside it BEFORE
 *     anything is written, and the new file lands via a temp + rename, so an
 *     interrupted run leaves the original intact;
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
  /** Set when the log grew between the read and the write, and the rewrite
   *  was therefore ABANDONED. `activity.jsonl` is append-only and a live
   *  server writes to it on every comment and read session, so a rewrite of a
   *  stale snapshot would silently drop whatever arrived in between. */
  abortedConcurrentWrite?: boolean;
}

export interface RepairOptions {
  dataDir: string;
  /** When false (the default), computes the stats and writes nothing. */
  write?: boolean;
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

  const sizeAtRead = statSync(path).size;
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

  // Append-only file, live writer: if it grew while we were computing, the
  // rows we hold are stale and writing them back would delete the new ones.
  // Bail loudly rather than quietly truncating the stream.
  if (statSync(path).size !== sizeAtRead) {
    stats.abortedConcurrentWrite = true;
    console.error(
      `[repair] ${path} grew during the run — nothing written. Stop the server (or retry) and run again.`,
    );
    return stats;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(opts.dataDir, `activity.jsonl.${stamp}.bak`);
  copyFileSync(path, backup);
  stats.backupPath = backup;
  const tmp = `${path}.repair.tmp`;
  writeFileSync(tmp, out.join('\n') + (endsWithNewline ? '\n' : ''));
  renameSync(tmp, path);
  return stats;
}

// Standalone runnable. DRY RUN BY DEFAULT — pass --write to rewrite the log.
if (import.meta.main) {
  const dataDir = process.argv[2] ?? join(process.cwd(), 'data');
  const write = process.argv.includes('--write');
  const stats = repairActivityOwner({ dataDir, write });
  console.log(JSON.stringify({ dataDir, write, ...stats }, null, 2));
  if (!write) {
    console.log('\nDry run — nothing was written. Re-run with --write to apply.');
  }
}
