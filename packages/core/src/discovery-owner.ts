/**
 * Ownership rules for the discovery file every peer resolves the server
 * through (`~/.claude/claude-workspaces/server.json`).
 *
 * The path is built from `$HOME` alone — see `discoveryDir` — so it is a
 * single machine-wide slot that every supervisor writes and, on the way out,
 * unlinked unconditionally. On 2026-08-30 that cost prod its entry: a
 * throwaway supervisor on another port exited, `unlinkSync` ran, and every
 * peer's MCP began reporting "server not found" while prod kept answering 200
 * on 8787 and launchd still reported the job running. `bun run staging` does
 * exactly the same thing every time it is stopped, which makes reviewing a
 * branch enough to break the fleet.
 *
 * Keying the path per port was the alternative. It is rejected because the
 * READERS have no port to key on — a peer's MCP resolves the file precisely
 * because it does not know where the server is. So the slot stays single, and
 * these two predicates decide who may write it and who may remove it.
 *
 * Where the rules conflict, they prefer a STALE entry over an ABSENT one: a
 * stale entry points somewhere, so a reader gets a connection error naming a
 * port — and the next honest start reclaims it. An absent entry produces the
 * silent failure above, which names nothing.
 *
 * Pure by construction: liveness arrives as an injected `isAlive`, so the
 * policy is testable without spawning anything.
 */

/** What the discovery file holds. Written by `scripts/serve.ts`. */
export type DiscoveryEntry = {
  port: number;
  pid: number;
  startedAt: string;
};

/**
 * May we publish our entry over what is already there?
 *
 * Yes when the slot is free, when the entry is for our own port (a restart
 * refreshing itself), or when whoever wrote it is gone. No when a LIVE server
 * on a different port owns it — that is prod, and we are not it.
 */
export function shouldClaimDiscovery(args: {
  existing: DiscoveryEntry | null;
  ourPort: number;
  isAlive: (pid: number) => boolean;
}): boolean {
  const { existing, ourPort, isAlive } = args;
  if (!existing) return true;
  if (existing.port === ourPort) return true;
  return !isAlive(existing.pid);
}

/**
 * May we remove the entry on our way out?
 *
 * Only if it is still the one we published. Matching on the pid we wrote —
 * not on the port — is what makes this safe: a second supervisor on our port,
 * or a prod restart that republished after us, both leave a pid that is not
 * ours, and taking that entry away would strand its readers.
 */
export function shouldReleaseDiscovery(args: {
  existing: DiscoveryEntry | null;
  ourPublishedPid: number;
}): boolean {
  const { existing, ourPublishedPid } = args;
  if (!existing) return false;
  return existing.pid === ourPublishedPid;
}
