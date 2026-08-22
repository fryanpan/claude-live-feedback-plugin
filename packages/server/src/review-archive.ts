import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The archive manifest: what an archived review WAS, so putting it back is one
 * call rather than an archaeology session.
 *
 * Archiving a review moves its members' `.ydoc` files out of the top level of
 * the data dir, which is the whole mechanism — `hydrateFromDisk` reads only
 * the top level, so the docs stop loading, stop costing a poll, and leave the
 * home page; `activity-backfill` scans `_archive` explicitly, so they keep
 * feeding analysis. But that move also takes the members out of `rooms.list()`,
 * and `rooms.list()` is the ONLY thing that knows which docIds belong to a
 * review (membership lives in each member's own meta). Without a manifest,
 * "unarchive this review" would mean parsing every `.ydoc` in `_archive` to
 * find out — so the writer records the member list, and the operator's reason,
 * on the way out.
 *
 * The manifest deliberately does NOT end in `.ydoc`: the backfill's enumerator
 * filters on that suffix, so a manifest is invisible to analysis rather than a
 * doc that fails to parse.
 */
export interface ArchivedReview {
  setId: string;
  /** ISO-8601 UTC. */
  archivedAt: string;
  /** Display name of whoever asked — an agent's `CW_AGENT_NAME`, usually. */
  archivedBy: string;
  /** Free text: why this review is finished. Replayed on the archived list. */
  reason?: string;
  title?: string;
  root?: string;
  docIds: string[];
  /**
   * Hub boards the review was linked to when it was archived. Archiving
   * detaches it from each (a board row pointing at a doc that no longer loads
   * is a dead end), and unarchive re-attaches exactly these — so the round
   * trip lands the review back where it was rather than orphaned.
   */
  linkedWorkspaces: string[];
}

export const ARCHIVE_DIR = '_archive';

export function archiveDirPath(dataDir: string): string {
  return join(dataDir, ARCHIVE_DIR);
}

export function ensureArchiveDir(dataDir: string): string {
  const dir = archiveDirPath(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function manifestPath(dataDir: string, setId: string): string {
  return join(archiveDirPath(dataDir), `${setId}.review.json`);
}

export function writeArchiveManifest(dataDir: string, manifest: ArchivedReview): void {
  ensureArchiveDir(dataDir);
  writeFileSync(manifestPath(dataDir, manifest.setId), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Read one review's manifest, or null when nothing is archived under that id. */
export function readArchiveManifest(dataDir: string, setId: string): ArchivedReview | null {
  const path = manifestPath(dataDir, setId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ArchivedReview>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.docIds)) return null;
    return {
      setId: parsed.setId ?? setId,
      archivedAt: parsed.archivedAt ?? '',
      archivedBy: parsed.archivedBy ?? 'unknown',
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.root !== undefined ? { root: parsed.root } : {}),
      docIds: parsed.docIds.filter((d): d is string => typeof d === 'string'),
      linkedWorkspaces: Array.isArray(parsed.linkedWorkspaces)
        ? parsed.linkedWorkspaces.filter((d): d is string => typeof d === 'string')
        : [],
    };
  } catch (err) {
    console.error(`[archive] unreadable manifest for ${setId}:`, err);
    return null;
  }
}

/**
 * Drop a manifest once its review is back in the live data dir.
 *
 * This is the one hard delete in the archive path and it is the permitted
 * kind: the manifest is a control file describing where content went, and by
 * the time it is removed the content it described is out of `_archive` and
 * back at the top level. No user content and no history rides on it.
 */
export function removeArchiveManifest(dataDir: string, setId: string): void {
  try {
    rmSync(manifestPath(dataDir, setId), { force: true });
  } catch (err) {
    console.error(`[archive] failed to remove manifest for ${setId}:`, err);
  }
}

/** Every archived review, newest first. */
export function listArchivedReviews(dataDir: string): ArchivedReview[] {
  const dir = archiveDirPath(dataDir);
  if (!existsSync(dir)) return [];
  const out: ArchivedReview[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.review.json')) continue;
      const setId = file.slice(0, -'.review.json'.length);
      const m = readArchiveManifest(dataDir, setId);
      if (m) out.push(m);
    }
  } catch (err) {
    console.error('[archive] failed to list archived reviews:', err);
    return out;
  }
  return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
