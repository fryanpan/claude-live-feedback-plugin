/**
 * Blocked — the one derivation, shared by the server and the browser.
 *
 * **Blocked is DERIVED, never stored, and that is a deliberate choice.** A
 * fifth `TaskStatus` was the obvious shape and it was rejected: a stored
 * status has to be entered and left, which means two writes nobody makes on
 * purpose (block it when an edge is added, un-block it when the last blocker
 * closes) and one state that can be WRONG — a row sitting in `blocked` with
 * every dependency finished, because the un-block write was missed by a
 * crash, a restore from a sidecar, or an edge removed by a caller that
 * predates the rule. The `after` edges are already the truth; asking them
 * every time cannot drift from them.
 *
 * It also settles the product question the ticket asks by name. Setting a
 * blocker is what makes a ticket blocked, so there is no separate status
 * control to keep in step with the edges, and a row "returns to todo" the
 * instant its last blocker closes because it never left `todo` underneath.
 * The only thing that has to be WRITTEN on that clearance is the record that
 * it happened, which is the `task.unblocked` audit row the store emits.
 *
 * Two predicates, because two questions are being asked and conflating them
 * is what would put the wrong ring on a row:
 *
 *  - `openBlockerIds` — which tickets is this one waiting on? Read by the
 *    queue (a row waiting on anything is not work you can pick up) and by the
 *    panel (the blocking tickets it lists in Related Links).
 *  - `isBlocked` — does the board draw this row as blocked? Only a `todo` row
 *    ever does. `in-progress` means somebody is on it anyway, `done` means it
 *    happened, and `triage` means nobody has agreed it is work — each of
 *    those is a louder fact about the row than what it waits on, and each
 *    already owns the row's mark.
 */

/** The two fields a blocked reading needs off a row, from any of the three
 *  shapes that carry them (the store's `Task`, the wire's `TaskPayload`, the
 *  board's `HubTask`). Structural on purpose: this module must not import a
 *  store type into the browser or a browser type into the store. */
export interface BlockableRow {
  status: string;
  /** Tickets this row waits on. Absent reads as none — a row projected by a
   *  server older than the field, and a hand-built test row. */
  after?: readonly string[];
}

/** What a blocker has to say for itself to be judged open. */
export interface BlockerLookupRow {
  status: string;
  /** Soft-deleted rows do not block: an archived ticket is off the board, and
   *  a row held by one nobody can see is a row nobody can clear. */
  archivedAt?: number;
}

/**
 * The ids in `after` that are still open — the blockers.
 *
 * A dangling id blocks NOTHING, which is the same rule the transition gate
 * and the queue already use: the dependency was deleted, and wedging its
 * dependants forever behind a blocker nobody can find is worse than losing
 * the edge. `lookup` returning `undefined` is that case.
 */
export function openBlockerIds(
  row: BlockableRow,
  lookup: (taskId: string) => BlockerLookupRow | undefined,
): string[] {
  const out: string[] = [];
  for (const id of row.after ?? []) {
    const dep = lookup(id);
    if (!dep) continue;
    if (dep.status === 'done') continue;
    if (dep.archivedAt !== undefined) continue;
    out.push(id);
  }
  return out;
}

/** True when the board should draw this row as blocked — see the module note
 *  for why `todo` is the only status that ever does. */
export function isBlocked(
  row: BlockableRow,
  lookup: (taskId: string) => BlockerLookupRow | undefined,
): boolean {
  if (row.status !== 'todo') return false;
  return openBlockerIds(row, lookup).length > 0;
}

/** A lookup over an array — the shape every caller here happens to hold. */
export function blockerLookup<T extends BlockerLookupRow & { id: string }>(
  rows: readonly T[],
): (taskId: string) => T | undefined {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (taskId) => byId.get(taskId);
}
