import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocMeta } from '@feedback/core';

/**
 * A doc's listing row, on disk, next to its `.ydoc`.
 *
 * Every boot loads all 5,600-odd persisted docs into memory, and roughly all
 * of that exists to answer questions that never need the document's contents:
 * what is it called, which workspace is it in, how many threads are open, when
 * did it last move. A CRDT is the wrong shape for those — it costs 62-125 KB
 * resident per doc and has to be decoded to be asked.
 *
 * So the answers are written out beside the doc. The index is DERIVED state:
 * the `.ydoc` remains the source of truth and the index can always be
 * rebuilt from it, which is what makes it safe to delete, safe to skip, and
 * safe to regenerate on a version bump.
 *
 * It is written inside `persistRoomNow`, in the same debounced write as the
 * `.ydoc` and the private sidecar, and it goes wherever the sidecar goes —
 * staged with it, restored with it, purged with it, moved with it. If the
 * three could be written or moved independently they would eventually
 * disagree, and a stale index is worse than no index: it describes a doc
 * that is not there, on a board where nobody would suspect the listing.
 */
export const DOC_INDEX_VERSION = 1;

export interface DocIndexEntry {
  /** Bumped when the shape changes; a mismatched entry is ignored and the
   *  doc falls back to its `.ydoc`, which is always authoritative. */
  v: number;
  /**
   * The doc's metadata exactly as `list()` reports it, MINUS the derived
   * `lastActivityAt`.
   *
   * Deliberately the whole of DocMeta rather than the handful of fields a
   * board renders today. A subset would make `listFromIndex` a different
   * answer from `list` the first time a caller reads a field nobody
   * remembered to add — and the whole value of this file is that those two
   * cannot differ. `lastActivityAt` stays out because it is derived from the
   * `.ydoc` mtime, which is readable without loading the doc; storing it
   * would create a second copy that could go stale.
   */
  meta: DocMeta;
  /** Open and total thread counts, for the board's per-row badges. */
  threads: { open: number; total: number };
  /** Most recent comment timestamp across the doc's threads, when it has any. */
  lastThreadActivityAt?: number;
}

const SUFFIX = '.index.json';

/** Where a doc's index lives, given the directory its `.ydoc` is in. */
export function docIndexPath(dir: string, docId: string): string {
  return join(dir, `${docId}${SUFFIX}`);
}

export function writeDocIndex(dir: string, docId: string, entry: DocIndexEntry): void {
  writeFileSync(docIndexPath(dir, docId), JSON.stringify(entry));
}

/**
 * One doc's index, or null when it is missing, unreadable or a version this
 * build does not understand. Never throws: a damaged index must degrade to
 * "no index" — which the caller answers by reading the `.ydoc` — rather than
 * taking down a listing.
 */
export function readDocIndex(dir: string, docId: string): DocIndexEntry | null {
  try {
    const raw = readFileSync(docIndexPath(dir, docId), 'utf8');
    const parsed = JSON.parse(raw) as DocIndexEntry;
    if (!parsed || parsed.v !== DOC_INDEX_VERSION || !parsed.meta?.docId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteDocIndex(dir: string, docId: string): void {
  try {
    rmSync(docIndexPath(dir, docId), { force: true });
  } catch {
    // Derived state. A file that would not delete is litter the next write
    // overwrites, not a failure worth propagating into a delete's result.
  }
}

/** Stage a doc's index alongside its staged `.ydoc`, so an uncommitted
 *  delete is as reversible for the index as it is for the doc. */
export function stageDocIndex(dir: string, docId: string): void {
  const p = docIndexPath(dir, docId);
  try {
    if (existsSync(p)) renameSync(p, `${p}.deleting`);
  } catch {
    // Same reasoning as deleteDocIndex.
  }
}

export function unstageDocIndex(dir: string, docId: string): void {
  const p = docIndexPath(dir, docId);
  try {
    if (existsSync(`${p}.deleting`)) renameSync(`${p}.deleting`, p);
  } catch {}
}

export function dropStagedDocIndex(dir: string, docId: string): void {
  try {
    rmSync(`${docIndexPath(dir, docId)}.deleting`, { force: true });
  } catch {}
}

/** Move a doc's index between directories, the way the sidecar moves. */
export function moveDocIndex(fromDir: string, toDir: string, docId: string): void {
  const from = docIndexPath(fromDir, docId);
  try {
    if (existsSync(from)) renameSync(from, docIndexPath(toDir, docId));
  } catch {}
}

/**
 * Every readable index in a directory, keyed by docId.
 *
 * Reads the top level only, exactly as `hydrateFromDisk` does — a doc that
 * has been archived lives in a subdirectory and must not appear in a listing
 * of the live ones.
 */
export function readAllDocIndexes(dir: string): Map<string, DocIndexEntry> {
  const out = new Map<string, DocIndexEntry>();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith(SUFFIX)) continue;
    const docId = file.slice(0, -SUFFIX.length);
    if (!docId) continue;
    const entry = readDocIndex(dir, docId);
    if (entry) out.set(docId, entry);
  }
  return out;
}
