/**
 * WHO IS ALREADY ON THIS ROW, said at the moment of the claim.
 *
 * The queue route learned to carry `ownerSession` and `claimedBy` on every
 * row (#329), which fixed the read. It did not fix the TIMING: a dispatcher
 * reads the queue once and then transitions rows for the rest of the session,
 * so the presence read and the pickup decision are separated by however long
 * that session runs. `task_transition` to in-progress is where the collision
 * actually happens — on 2026-08-17 two sessions each built a complete answer
 * to one task with neither able to detect the other — and it was the one
 * surface that said nothing.
 *
 * INFORMATIONAL, ALWAYS, AND IT SAYS SO. Nothing here refuses a second taker.
 * Two agents on one row is sometimes right; that same collision produced two
 * designs whose disagreement made the choice legible. The failure is not the
 * overlap, it is the overlap nobody could see. A warning that reads like a
 * gate would be worse than silence, because the next agent would drop work it
 * was allowed to do — hence the sentence that stays in every rendering.
 *
 * A RECENCY READ, NEVER CONTENT IDENTITY. A session that thinks for an hour
 * produces no new commit and still holds the row, which is what a
 * sha-comparing guard gets wrong. The only question asked here is whether the
 * server has heard from that session lately.
 *
 * Kept out of mcp.ts — a bundle entry point that exports nothing — for the
 * same reason `nudge-line.ts` and `voice-line.ts` are: the wording is a
 * decision, and inline in a 3,000-line switch it cannot be asserted.
 */

/** The presence shape the queue route returns — `OwnerSession` server-side.
 *  Declared structurally rather than imported: the MCP package does not
 *  depend on the server's types, and a row from an older server simply
 *  arrives without these fields. */
export interface SessionPresence {
  agentId: string;
  /** Last time the session SAID it was alive. */
  lastHeartbeat: number;
  /** Last time the server SAW it do something. */
  lastToolCallAt: number;
  state: 'active' | 'unresponsive' | 'away';
  stateLabel: string;
  pluginVersion?: string;
}

/** `ClaimSession` server-side: the same, plus WHEN the row was taken. */
export interface ClaimPresence extends SessionPresence {
  /** The row's latest transition into in-progress. */
  at: number;
}

/** As much of a queue row as this decision needs. */
export interface PresenceRow {
  id: string;
  title?: string;
  /** The session behind the row's OWNER. */
  ownerSession?: SessionPresence;
  /** The session that last moved the row into in-progress. The only one that
   *  exists on a row nobody assigned — a transition never touches
   *  `assignee`, so an owner-keyed read names the FILER instead. */
  claimedBy?: ClaimPresence;
}

/** Mirrors mcp.ts's helper of the same name, duplicated for the same reason
 *  `nudge-line.ts` duplicates it: mcp.ts exports nothing. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A duration as a person reads one — coarse, because the reader is deciding
 *  whether a gap is unusual rather than measuring it. */
function humanDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Is this presence a LIVE hold by somebody else?
 *
 * `active` only, deliberately. `away` is an owner in name only — warning
 * there would fire on every stale row on a board, which is how a warning gets
 * skimmed. `unresponsive` (heartbeat fresh, no observed work) is
 * process-up-agent-wedged, and that is precisely the row somebody SHOULD take
 * over: a warning there fires on the case where picking it up is right.
 */
function heldByAnother(p: SessionPresence | undefined, selfAgentId: string): boolean {
  return p !== undefined && p.state === 'active' && p.agentId !== selfAgentId;
}

/** The row, named by whatever it actually carries. */
function namedRow(row: PresenceRow): string {
  return row.title ? `${row.id} "${truncate(row.title, 60)}"` : row.id;
}

/**
 * The line a claim carries when somebody live is already on the row, or
 * undefined when the row is free — which is the common case, and the one that
 * must stay silent.
 *
 * `claimedBy` wins over `ownerSession` when both name a live session: the
 * claimant is the one actually working it, and the owner may only be whoever
 * filed the ticket.
 */
export function claimWarning(
  row: PresenceRow,
  selfAgentId: string,
  now: number,
): string | undefined {
  const claim = heldByAnother(row.claimedBy, selfAgentId) ? row.claimedBy : undefined;
  const owner = claim ? undefined : row.ownerSession;
  const holder = claim ?? (heldByAnother(owner, selfAgentId) ? owner : undefined);
  if (!holder) return undefined;

  const seen = `last seen ${humanDuration(Math.max(0, now - holder.lastToolCallAt))} ago`;
  const held = claim
    ? `is already IN PROGRESS under session ${holder.agentId} (${seen}, claimed ${humanDuration(Math.max(0, now - claim.at))} ago)`
    : `is owned by session ${holder.agentId}, which is live (${seen})`;

  return `[claim] ${namedRow(row)} ${held}. Do not start this row blind — message that session over claude-hive, agree who has it, and take a different row if they do. Nothing here refuses you: two sessions on one row is sometimes right, but it has to be a decision rather than a collision neither side can see.`;
}
