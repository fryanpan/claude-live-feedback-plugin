/**
 * Which plugin version each attached session is actually RUNNING, against the
 * one this server's deploy source would install.
 *
 * The failure this exists to end: `main` reached 0.1.26 while every peer's
 * plugin cache sat at 0.1.15, for eleven releases, and no surface said so.
 * Everything shipped in between was merged, green, and undeliverable. A merge
 * does not deliver — someone has to run the update, and then the session has
 * to restart — so "is this feature available?" has a different answer per
 * peer and nothing was answering it.
 *
 * What "released" means here is deliberately modest: the version in the
 * manifest of the checkout this server process was started from. That is the
 * same tree the client bundle is published from at restart, so it is exactly
 * "what a peer would get if they updated right now" — not "what is on
 * GitHub". A checkout nobody pulled reports its own staleness as current;
 * that is the same limitation the client release has, and it is honest about
 * being about the deploy source rather than about the remote.
 *
 * The other limit is the DOMAIN, and it is the sharper one. A session becomes
 * known to this server by calling `attach_agent` on a workspace, and that is
 * the ONLY way — there is no server-wide session registry to compare against.
 * So this module can only ever answer "is any session that attached to this
 * board behind", never "is the fleet behind". Measured in the field on
 * 2026-08-17: the board read `behind: []` over one attachment while a
 * separately-enumerated fleet had sessions three and twenty-eight releases
 * back. Fixing that one session moved the reading from "names one" to "names
 * nobody" with no change in the fleet's drift.
 *
 * The answer is NOT to invent a fleet registry here. It is that every reading
 * carries its domain and its count, so an empty `behind` list can be read as
 * what it is — "nothing attached here is behind" — instead of as a clearance.
 * `checkableAttachments` exists to make that count come from the same
 * population the check ran over.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Numeric, component-wise comparison. Returns -1 | 0 | 1. */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string): number[] =>
    // A component that is not a number counts as -1, which sorts BELOW any
    // real release: an unreadable version can then only ever prompt an
    // update, never suppress one.
    String(v)
      .trim()
      .split('.')
      .map((p) => {
        const n = Number.parseInt(p, 10);
        return Number.isNaN(n) ? -1 : n;
      });
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    // A missing trailing component is 0, so 0.1 == 0.1.0 and 0.1 < 0.1.1.
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Where the plugin manifest lives, relative to a repo root. */
const MANIFEST = 'packages/plugin/.claude-plugin/plugin.json';

/**
 * The version in this checkout's plugin manifest, or null if it cannot be
 * read. Null is a real answer — it means we do not know what current is, and
 * every caller must then decline to claim anyone is behind.
 */
export function readReleasedPluginVersion(rootDir: string = repoRoot()): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(rootDir, MANIFEST), 'utf8')) as {
      version?: unknown;
    };
    return typeof raw.version === 'string' && raw.version.trim().length > 0
      ? raw.version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * The directory a `file:` module URL points at.
 *
 * Exported because `.pathname` is NOT a filesystem path: it keeps percent
 * escapes, so a checkout under `~/My Code/` resolves to a directory that does
 * not exist, the manifest read fails, and the entire drift signal switches
 * itself off without a word. This machine's checkout has no spaces in it,
 * which is precisely why nothing here would ever have caught it.
 */
export function moduleDir(url: string): string {
  return dirname(fileURLToPath(url));
}

/** This file is `<root>/packages/server/src/plugin-release.ts`. */
function repoRoot(): string {
  return resolve(moduleDir(import.meta.url), '../../..');
}

/** The subset of an attachment this module needs — kept structural so the
 *  store's type does not have to be imported into a pure module. */
export interface VersionedAttachment {
  agentId: string;
  runtime: string;
  pluginVersion?: string;
}

/**
 * The attached sessions running an older bundle than the deploy source has.
 *
 * Two rules that are easy to get backwards:
 *
 * - **No reported version is behind.** The field ships in the same release
 *   that reads it, so silence means "older than this feature" rather than
 *   "unknown". Treating it as unknown would hide precisely the fleet-wide
 *   drift this was built for.
 * - **Ahead is not behind.** A session launched against a working tree can
 *   legitimately outrun a checkout that has not pulled. Telling it to
 *   downgrade would be worse than saying nothing.
 */
export function agentsBehind<T extends VersionedAttachment>(
  released: string | null,
  attachments: readonly T[],
): T[] {
  if (!released) return [];
  return checkableAttachments(attachments).filter(
    (a) => a.pluginVersion === undefined || compareSemver(a.pluginVersion, released) < 0,
  );
}

/**
 * The attachments this check can say anything about at all — i.e. its DOMAIN.
 *
 * Exported, and used by `agentsBehind` rather than duplicated inside it, so
 * "who was checked" and "who came back behind" can never answer over
 * different populations. That pairing is the whole point: an empty `behind`
 * list is only a clearance to the extent that this number is large, and for
 * most of this project's life it has been 1 — the single session that
 * attaches to its own board. A drift surface whose domain is "sessions that
 * opted in by attaching" measures PARTICIPATION, and the sessions least
 * likely to have attached are exactly the stale ones.
 *
 * A webhook or a managed agent has no plugin cache to update, so it can never
 * be behind — and must not inflate either count.
 */
export function checkableAttachments<T extends VersionedAttachment>(
  attachments: readonly T[],
): T[] {
  return attachments.filter((a) => a.runtime === 'claude-code-local');
}
