#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type DocMeta, type Thread, listThreads, readDocMeta } from '@feedback/core';
import * as Y from 'yjs';
import {
  type Event,
  appendActivity,
  authorFields,
  buildEventDoc,
  classifyActor,
  eventId,
  isOwnerActor,
  payloadDigest,
  toUtcIso,
  wordCount,
} from './activity.ts';
import { readPrivateMeta } from './private-meta.ts';

/**
 * Backfill the hands-on activity stream from persisted .ydoc files.
 *
 * Scans every .ydoc in `<dataDir>` AND `<dataDir>/_archive`, reads each doc's
 * threads (every comment carries a ts + author), and emits comment / reply /
 * resolve / reopen events using the SAME deterministic eventId scheme as live
 * capture — so a re-run dedupes (identical ids) and never double-counts.
 *
 * Scope:
 *   - Only comment-family events backfill. read_session / doc_open were never
 *     recorded historically (scroll wasn't tracked), so they're not
 *     backfillable — they're complete only from this feature's go-live.
 *   - The first comment of a thread → `comment`; each subsequent comment →
 *     `reply`. A currently-resolved thread emits one `resolve` event at the
 *     thread's last-activity time. (reopen history isn't recoverable from a
 *     CRDT snapshot, which only holds current state — noted in the report.)
 *   - Reaches back to WR's clean-data window (~2026-04-17). Older events are
 *     skipped by default.
 *
 * Never deletes or modifies .ydoc files — read-only over the snapshots.
 */

/** Start of WR's clean-data window. Events before this are skipped. */
export const CLEAN_DATA_START_MS = Date.parse('2026-04-17T00:00:00.000Z');

export interface BackfillStats {
  filesScanned: number;
  docsWithThreads: number;
  events: number;
  byType: Record<string, number>;
  personComments: number;
  /** person comment+reply events whose ts falls in [Apr17, Jun13]. */
  personCommentsValidationWindow: number;
  skippedBeforeWindow: number;
}

function emptyStats(): BackfillStats {
  return {
    filesScanned: 0,
    docsWithThreads: 0,
    events: 0,
    byType: {},
    personComments: 0,
    personCommentsValidationWindow: 0,
    skippedBeforeWindow: 0,
  };
}

/** Load a .ydoc snapshot into a fresh Y.Doc (read-only). */
function loadYdoc(path: string): Y.Doc | null {
  try {
    const buf = readFileSync(path);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(buf));
    return ydoc;
  } catch (err) {
    console.error(`[backfill] failed to load ${path}:`, err);
    return null;
  }
}

/** Enumerate the .ydoc files in dataDir and dataDir/_archive. */
function ydocFiles(dataDir: string): string[] {
  const out: string[] = [];
  const collect = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.ydoc')) out.push(join(dir, f));
    }
  };
  collect(dataDir);
  collect(join(dataDir, '_archive'));
  return out;
}

/**
 * Emit the comment-family events for one doc's threads into `out`.
 * Pure (no I/O) so it's unit-testable; the caller persists.
 */
export function eventsForDoc(meta: DocMeta, threads: Thread[]): Event[] {
  const out: Event[] = [];
  const doc = buildEventDoc(meta);
  for (const thread of threads) {
    thread.comments.forEach((c, i) => {
      if (c.ts < CLEAN_DATA_START_MS) return;
      const type = i === 0 ? 'comment' : 'reply';
      const actor = classifyActor(c.author);
      const ts = toUtcIso(c.ts);
      const id = eventId({
        ts,
        actor,
        docId: meta.docId,
        type,
        threadId: thread.id,
        payloadDigest: payloadDigest(c.text),
      });
      out.push({
        eventId: id,
        ts,
        type,
        actor,
        actorId: authorFields(c.author).id,
        actorName: authorFields(c.author).name,
        isOwner: isOwnerActor(c.author),
        threadId: thread.id,
        doc,
        payload: { text: c.text, wordCount: wordCount(c.text) },
      });
    });
    // A currently-resolved thread → one resolve event at last-activity time.
    // The resolver isn't recorded in the snapshot; attribute to the doc owner
    // (the reviewer who resolves), classified person.
    if (thread.status === 'resolved' && thread.lastActivity >= CLEAN_DATA_START_MS) {
      const ts = toUtcIso(thread.lastActivity);
      const resolver = thread.createdBy;
      const actor = classifyActor(resolver);
      const id = eventId({
        ts,
        actor,
        docId: meta.docId,
        type: 'resolve',
        threadId: thread.id,
        payloadDigest: '',
      });
      out.push({
        eventId: id,
        ts,
        type: 'resolve',
        actor,
        // `createdBy` is persisted in the CRDT exactly like `author` above,
        // so it is the same shape gamble and gets the same reader.
        actorId: authorFields(resolver).id,
        actorName: authorFields(resolver).name,
        isOwner: isOwnerActor(resolver),
        threadId: thread.id,
        doc,
        payload: {},
      });
    }
  }
  return out;
}

export interface BackfillOptions {
  dataDir: string;
  /** When false, computes stats but writes nothing. Default true. */
  write?: boolean;
}

/**
 * Run the backfill. Returns stats including the person-comment count in WR's
 * validation window (Apr17 -> Jun13), which should land near the 549-comment
 * target WR provided.
 */
export function runBackfill(opts: BackfillOptions): BackfillStats {
  const stats = emptyStats();
  const valStart = CLEAN_DATA_START_MS;
  const valEnd = Date.parse('2026-06-13T23:59:59.999Z');
  for (const path of ydocFiles(opts.dataDir)) {
    stats.filesScanned++;
    const ydoc = loadYdoc(path);
    if (!ydoc) continue;
    const meta = readDocMeta(ydoc);
    if (!meta.docId) {
      // docId is the .ydoc basename; recover it if the CRDT meta is bare.
      const base = path.split('/').pop() ?? '';
      meta.docId = base.replace(/\.ydoc$/, '');
    }
    // `owner` / `workspaceRoot` / `producedBy` moved out of the CRDT into a
    // sidecar (they described the host, and the CRDT syncs to share
    // visitors). This reads .ydoc files directly rather than through a room,
    // so it has to merge the sidecar itself or every event loses its repo
    // and its producedBy attribution.
    //
    // The data dir is the fallback and the .ydoc's own directory wins.
    // Archiving
    // carries the sidecar along with its .ydoc into `_archive`, so a
    // dataDir-only lookup would silently strip repo and producedBy off every
    // archived doc's events — the archive would still be scanned and the
    // stream would still be non-empty, which is precisely the shape of a
    // regression nobody notices. The fallback is not belt-and-braces: the
    // ~174 ydocs hand-moved into `_archive` in June left their sidecars
    // behind at the top level, and they still have to resolve.
    Object.assign(meta, readPrivateMeta(opts.dataDir, meta.docId));
    Object.assign(meta, readPrivateMeta(dirname(path), meta.docId));
    const threads = listThreads(ydoc);
    if (threads.length === 0) {
      ydoc.destroy();
      continue;
    }
    stats.docsWithThreads++;
    const events = eventsForDoc(meta, threads);
    for (const ev of events) {
      stats.events++;
      stats.byType[ev.type] = (stats.byType[ev.type] ?? 0) + 1;
      const tsMs = Date.parse(ev.ts);
      if (ev.actor === 'person' && (ev.type === 'comment' || ev.type === 'reply')) {
        stats.personComments++;
        if (tsMs >= valStart && tsMs <= valEnd) stats.personCommentsValidationWindow++;
      }
      if (opts.write !== false) appendActivity(opts.dataDir, ev);
    }
    ydoc.destroy();
  }
  return stats;
}

// Standalone runnable: `bun run packages/server/src/activity-backfill.ts [dataDir]`
if (import.meta.main) {
  const dataDir = process.argv[2] ?? join(process.cwd(), 'data');
  const dryRun = process.argv.includes('--dry-run');
  const stats = runBackfill({ dataDir, write: !dryRun });
  console.log(
    JSON.stringify(
      {
        dataDir,
        dryRun,
        ...stats,
      },
      null,
      2,
    ),
  );
}
