/**
 * Well-known paths on the machine, across the live-feedback →
 * claude-workspaces rename.
 *
 * These are the names a git diff cannot move: `scripts/migrate-rename.ts`
 * relocates them on the box at rollout, and this module is what every reader
 * resolves them through. Kept in one place because the readers are in
 * different packages — the server writes the discovery file, the MCP child
 * and `scripts/share.ts` read it — and three hand-written copies of a
 * two-element fallback list is exactly the drift this repo has been bitten by
 * before.
 */

import { join } from 'node:path';

/**
 * The one slug every machine-level name is built from. The discovery
 * directory, the state root under `~/.local/state`, and the cloudflared
 * config all use it, which is why `scripts/migrate-rename.ts` moves them as
 * one set — and why it imports these rather than spelling them again.
 */
export const PRODUCT_SLUG = 'claude-workspaces';
export const PRODUCT_SLUG_LEGACY = 'live-feedback';

export const DISCOVERY_DIR_CURRENT = PRODUCT_SLUG;
export const DISCOVERY_DIR_LEGACY = PRODUCT_SLUG_LEGACY;
export const DISCOVERY_FILE = 'server.json';

/** Directory under `$XDG_STATE_HOME` (or `~/.local/state`) holding releases. */
export const STATE_ROOT_DIR = PRODUCT_SLUG;

/** Where the server publishes its live port, newest name first. */
export function discoveryCandidates(home: string): string[] {
  return [DISCOVERY_DIR_CURRENT, DISCOVERY_DIR_LEGACY].map((dir) =>
    join(home, '.claude', dir, DISCOVERY_FILE),
  );
}

/** The directory the server WRITES. Only ever the current name. */
export function discoveryDir(home: string): string {
  return join(home, '.claude', DISCOVERY_DIR_CURRENT);
}

/**
 * First discovery file that exists, or undefined.
 *
 * The legacy candidate is permanent, not a transition scaffold. The rollout
 * restarts the server and respawns every session, and nothing orders those
 * two events — a child that comes up before the server has rewritten the new
 * path would otherwise find nothing and throw, which reads to its agent as
 * "the server is down" rather than as a half-finished migration.
 */
export function resolveDiscoveryFile(
  home: string,
  exists: (path: string) => boolean,
): string | undefined {
  return discoveryCandidates(home).find(exists);
}
