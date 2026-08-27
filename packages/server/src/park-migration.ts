/**
 * Move every row still carrying the removed `parked` state onto the board's
 * new spelling for it: `triage`, plus a comment holding the date and the
 * reason (board ticket, 2026-08-27).
 *
 * Runs at server start rather than as a script somebody has to remember. Prod
 * restarts on every merge, so shipping the code ships the migration; a script
 * would have left the live board disagreeing with the build for as long as
 * nobody ran it, and the rows involved are exactly the ones nobody is looking
 * at.
 *
 * ── The ordering is the whole safety argument ────────────────────────────
 *
 * Comment FIRST, clear second, and never the other way round. The project
 * rule is that user content is never hard-deleted, and `parkedUntil` +
 * `parkedReason` are somebody's words about why work was deferred. Once the
 * comment exists they are duplicated, and clearing them destroys nothing;
 * before it exists, clearing them is the only step in this file that could
 * lose something. A row whose comment could not be written keeps its fields
 * and is reported as skipped, so the next start tries again.
 *
 * Idempotent by construction, for the same reason: the fields ARE the work
 * list, so a migrated row is invisible to the next pass. Nothing needs a
 * "migrated" marker and nothing has to remember whether it ran.
 */
import type { LegacyParkFields, Task, TaskStore } from './tasks.ts';

/** Who the moved rows are attributed to. An agent rather than a person: no
 *  human made this decision today, and attributing it to one would put a name
 *  on a comment they did not write. */
export const PARK_MIGRATION_ACTOR = {
  id: 'agent-workspaces-server',
  name: 'Claude Workspaces',
  kind: 'agent',
} as const;

export interface ParkMigrationResult {
  /** Rows moved out of the old state, with what they carried. */
  migrated: Array<{ taskId: string; workspaceId: string } & LegacyParkFields>;
  /** Rows whose comment could not be written. Their fields are UNTOUCHED —
   *  the next start retries them. */
  skipped: Array<{ taskId: string; reason: string }>;
}

export interface ParkMigrationDeps {
  store: TaskStore;
  /** Post the note on the task's own discussion. Returns false when the
   *  comment did not land, which is what holds the clear back. */
  comment: (task: Task, text: string) => Promise<boolean>;
  /** Build the note. Injected so the route and this file cannot drift into
   *  two wordings of the same event. */
  note: (fields: LegacyParkFields, from: string) => string;
}

export async function migrateParkedRows(deps: ParkMigrationDeps): Promise<ParkMigrationResult> {
  const { store, comment, note } = deps;
  const result: ParkMigrationResult = { migrated: [], skipped: [] };
  for (const workspace of store.listWorkspaces()) {
    for (const row of store.listTasks(workspace.id)) {
      const legacy = row as Task & LegacyParkFields;
      if (legacy.parkedUntil === undefined && legacy.parkedReason === undefined) continue;
      const carried: LegacyParkFields = {
        ...(legacy.parkedUntil !== undefined ? { parkedUntil: legacy.parkedUntil } : {}),
        ...(legacy.parkedReason !== undefined ? { parkedReason: legacy.parkedReason } : {}),
      };
      const from = row.status;
      let landed = false;
      try {
        landed = await comment(row, note(carried, from));
      } catch (err) {
        result.skipped.push({ taskId: row.id, reason: `comment threw: ${String(err)}` });
        continue;
      }
      if (!landed) {
        result.skipped.push({ taskId: row.id, reason: 'comment did not land' });
        continue;
      }
      // `same-status` is the ordinary case for a row already in triage, and
      // `goal-not-triageable` cannot happen (goal rows never carried a park),
      // but neither is a reason to leave the fields on the row: the comment
      // is written, so the state has already been preserved.
      store.transition(row.id, 'triage', { actor: PARK_MIGRATION_ACTOR });
      store.clearLegacyPark(row.id);
      result.migrated.push({ taskId: row.id, workspaceId: workspace.id, ...carried });
    }
  }
  return result;
}
