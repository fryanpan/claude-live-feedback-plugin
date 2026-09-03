/**
 * Ports this machine's other fleet services already own.
 *
 * A dev or staging server binding one of these does not fail loudly — there
 * is no cross-process lock on a TCP port, so the bind just succeeds. The
 * failure shows up later and sideways: on 2026-09-0x a staging server bound
 * the IPv6 wildcard on 8791 while the fleet's Notion webhook receiver held
 * `127.0.0.1:8791`. The moment the receiver restarted, the staging build
 * inherited every Notion webhook and answered them `unknown_host` — and its
 * OWN health check stayed green throughout, because the port was still
 * answering, just to the wrong process.
 *
 * Kept in one place so `scripts/staging.ts` and `bin.ts` check the same list
 * and agree on why each entry is there, instead of one of them drifting.
 */
export interface ReservedPort {
  port: number;
  /** Who owns it, for the refusal message — not a hostname or PID, just
   *  enough for a person to know what NOT to kill. */
  owner: string;
}

export const RESERVED_PORTS: readonly ReservedPort[] = [
  { port: 8787, owner: 'prod (the claude-workspaces server)' },
  { port: 8791, owner: "the fleet's Notion webhook receiver" },
  { port: 7900, owner: 'claude-hive' },
  { port: 7902, owner: 'the GitHub broker' },
];

/** The owner of `port`, or `null` when it is not reserved. Pure — no sockets,
 *  so it can be asserted against without booting anything. */
export function reservedPortOwner(port: number): string | null {
  return RESERVED_PORTS.find((p) => p.port === port)?.owner ?? null;
}

/** A ready-to-print refusal, or `null` when `port` is free to use. Shared so
 *  the two callers give the same guidance, not two differently-worded ones. */
export function reservedPortError(port: number): string | null {
  const owner = reservedPortOwner(port);
  if (!owner) return null;
  return (
    `port ${port} is reserved for ${owner}. ` +
    'Pick a port 8800 or above (or 0 to let the OS choose one).'
  );
}
