/**
 * Reading and writing the discovery slot, with the ownership rules from
 * `discovery-owner.ts` applied at the only two moments that matter: publish
 * and release.
 *
 * `scripts/serve.ts` used to inline both — a bare `writeFileSync` at startup
 * and a bare `unlinkSync` in `cleanup()`. That is where prod lost its entry
 * to a throwaway supervisor on 2026-08-30. The logic lives here instead so
 * there is one path, and so it can be tested against a real filesystem under
 * a throwaway HOME rather than by spawning servers.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DiscoveryEntry,
  shouldClaimDiscovery,
  shouldReleaseDiscovery,
} from './discovery-owner.ts';
import { DISCOVERY_FILE, discoveryDir, resolveDiscoveryFile } from './machine-paths.ts';

export type { DiscoveryEntry };

/** Is this pid still around? Signal 0 asks without delivering anything. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return (err as { code?: string }).code === 'EPERM';
  }
}

/**
 * The current entry, or null when there is none or it cannot be parsed.
 *
 * A corrupt file reads as null deliberately: it names no owner, so treating
 * it as one would wedge the slot shut until somebody deleted it by hand.
 */
export function readDiscovery(home: string): DiscoveryEntry | null {
  const path = resolveDiscoveryFile(home, existsSync);
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed?.port !== 'number' || typeof parsed?.pid !== 'number') return null;
    return parsed as DiscoveryEntry;
  } catch {
    return null;
  }
}

/**
 * Publish our port, unless a live server on a different port owns the slot.
 *
 * Returns 'declined' in that case rather than throwing: a staging server that
 * cannot publish is working correctly, and should say so and carry on.
 */
export function publishDiscovery(args: {
  home: string;
  port: number;
  pid: number;
  isAlive?: (pid: number) => boolean;
}): 'claimed' | 'declined' {
  const { home, port, pid, isAlive = pidIsAlive } = args;
  const existing = readDiscovery(home);
  if (!shouldClaimDiscovery({ existing, ourPort: port, isAlive })) return 'declined';
  const dir = discoveryDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, DISCOVERY_FILE),
    `${JSON.stringify({ port, pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  return 'claimed';
}

/**
 * Remove the entry on the way out — only if it is still ours.
 *
 * `ourPublishedPid` is the pid we actually wrote, so a supervisor that
 * DECLINED to publish passes something that never matches and correctly keeps
 * its hands off.
 */
export function releaseDiscovery(args: {
  home: string;
  ourPublishedPid: number | null;
}): 'released' | 'kept' {
  const { home, ourPublishedPid } = args;
  if (ourPublishedPid === null) return 'kept';
  const existing = readDiscovery(home);
  if (!shouldReleaseDiscovery({ existing, ourPublishedPid })) return 'kept';
  const path = resolveDiscoveryFile(home, existsSync);
  if (!path) return 'kept';
  try {
    unlinkSync(path);
  } catch {
    return 'kept';
  }
  return 'released';
}
