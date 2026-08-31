import {
  constants,
  accessSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { extname, join } from 'node:path';

/**
 * A mockup's HTML, captured beside its `.ydoc` so the link outlives the file.
 *
 * A mockup is bound to a docId, but the HTML itself lives outside the repo —
 * by project rule, and in practice inside an agent session's scratch
 * directory. When that directory is cleaned up the binding survives and the
 * content does not: the link still looks valid and serves a 404. That happened
 * to a review Bryan had been asked to look at, and the mock had to be rebuilt
 * from the design doc and re-bound to the same id. A rebuild, not a restore —
 * nobody could say it matched what he had been shown.
 *
 * The failure is silent AND delayed, which is what makes it worth code rather
 * than a rule: the agent that made the mock is gone, the link reads fine, and
 * the person who finds out is the reviewer, at the moment he sits down.
 *
 * So the served page stops depending on a directory nobody promised to keep:
 *
 * - **Bind captures.** `POST /api/docs` reads the file before it creates
 *   anything, so an unreachable path fails at bind time — with the path in the
 *   message — instead of 404ing at read time in front of the reviewer.
 * - **Serving re-captures.** Every serve refreshes the capture from the live
 *   file, so the fallback is the last thing anyone was actually shown rather
 *   than whatever round one looked like. Mockups iterate; a snapshot frozen at
 *   bind would be its own silent-wrong-content bug.
 * - **The live file still wins** while it is readable, so editing a mock and
 *   reloading keeps working exactly as it did.
 *
 * The capture is a copy, never the original: nothing here writes to, moves, or
 * removes the agent's own file. And a capture is only ever replaced by content
 * read from that file moments earlier — see `captureMockup` for the one case
 * it refuses, which is the case where replacing would lose the good copy.
 */

/** Suffix for a capture file, next to `<docId>.ydoc` in the data dir. */
const CAPTURE_SUFFIX = '.mock.html';

/** Where a mockup's captured HTML lives, given the dir its `.ydoc` is in. */
export function mockupCapturePath(dir: string, docId: string): string {
  return join(dir, `${docId}${CAPTURE_SUFFIX}`);
}

/**
 * Whether a bound source is the HTML kind — the only kind with a capture.
 *
 * Keyed on `.html` alone because that is what the static route's content-type
 * table answers `text/html` for, and this predicate stands in for that
 * decision. A mockup bound to an image or a `.htm` file is served straight
 * from disk exactly as it was before, and has no captured copy to fall back
 * on.
 */
export function isHtmlMockupSource(path: string): boolean {
  return extname(path).toLowerCase() === '.html';
}

export type MockupSourceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Can this path be read as a mockup right now?
 *
 * `existsSync` alone is not the question — a path can exist and still be
 * unreadable (mode, or a directory where a file was meant), and both of those
 * reach the reviewer as the same blank 404. So this asks for read permission
 * on a regular file, and names which of those failed.
 */
export function checkMockupSource(path: string): MockupSourceCheck {
  if (!existsSync(path)) return { ok: false, reason: 'no such file' };
  try {
    if (!statSync(path).isFile()) return { ok: false, reason: 'not a regular file' };
  } catch (err) {
    return {
      ok: false,
      reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'stat failed'})`,
    };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch (err) {
    return {
      ok: false,
      reason: `unreadable (${(err as NodeJS.ErrnoException).code ?? 'no read permission'})`,
    };
  }
  return { ok: true };
}

/** The live file's text, or null when it cannot be read. */
export function readMockupHtml(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The captured copy, or null when this doc has never been captured. */
export function readMockupCapture(dataDir: string, docId: string): string | null {
  const path = mockupCapturePath(dataDir, docId);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`[mockup-capture] unreadable capture for ${docId}:`, err);
    return null;
  }
}

export type CaptureOutcome = 'written' | 'unchanged' | 'refused-empty' | 'failed';

/**
 * Store `html` as this doc's capture.
 *
 * Refuses exactly one write: emptying a capture that has content. Once the
 * source is gone the capture is the only copy left, and a blank page is
 * indistinguishable from the 404 this whole mechanism exists to prevent — so a
 * truncated or half-written source cannot take the good copy with it. Every
 * other write is content read from the bound file moments earlier, replacing
 * an older copy of that same file.
 */
export function captureMockup(dataDir: string, docId: string, html: string): CaptureOutcome {
  const existing = readMockupCapture(dataDir, docId);
  if (existing === html) return 'unchanged';
  if (html.trim() === '' && existing !== null && existing.trim() !== '') return 'refused-empty';
  try {
    writeFileSync(mockupCapturePath(dataDir, docId), html);
    return 'written';
  } catch (err) {
    console.error(`[mockup-capture] failed to capture ${docId}:`, err);
    return 'failed';
  }
}

/**
 * Drop a doc's capture. Called from the purge path only.
 *
 * Archiving deliberately leaves it where it is: the capture is addressed by
 * docId in the data dir, so a doc that comes back out of `_archive` finds its
 * copy exactly where it left it, and an archived mockup is not served in the
 * meantime. A purge is the one place that is asking for the bytes to be gone.
 */
export function deleteMockupCapture(dataDir: string, docId: string): void {
  try {
    rmSync(mockupCapturePath(dataDir, docId), { force: true });
  } catch {
    /* best effort — a stray capture is inert */
  }
}
