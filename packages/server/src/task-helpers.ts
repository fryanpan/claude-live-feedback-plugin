/**
 * Pure per-store helpers with no state of their own: the nested-goal payload
 * shape a caller or an old sidecar may still send, and the attachment-runtime
 * check. Split out of `tasks.ts` for the same reason `task-fields.ts` and
 * `task-owner.ts` already are — `task-persistence.ts` needs both and may not
 * import a VALUE from the file that imports it, the same rule `task-agents.ts`
 * and `workspace-store.ts` follow for their own pure helpers. `tasks.ts`
 * imports them back and re-exports them, so no caller outside either file
 * changes.
 */
import type { WorkspaceGoal } from './tasks.ts';

export type AttachmentRuntime = 'claude-code-local' | 'managed-agent' | 'webhook';

const ATTACHMENT_RUNTIMES: ReadonlySet<string> = new Set([
  'claude-code-local',
  'managed-agent',
  'webhook',
]);

export function isAttachmentRuntime(v: unknown): v is AttachmentRuntime {
  return typeof v === 'string' && ATTACHMENT_RUNTIMES.has(v);
}

/**
 * A goal list as it may arrive from OUTSIDE — a payload written before
 * subgoals were removed, or a workspace on disk that still holds them.
 *
 * Subgoals are gone from the product (Bryan, 2026-08-30: *"We no longer
 * support subgoals. If there's any code left for subgoals remove it"*), but
 * a stored board is not rewritten by that decision. `flattenNestedGoals` is
 * the one door such a payload comes through, and every one of them arrives
 * flat on the other side.
 */
export interface NestedGoalInput {
  id: string;
  title: string;
  dueAt?: number;
  subgoals?: NestedGoalInput[];
}

/**
 * Splice any nested goals into the top level, each one landing directly after
 * the parent that held it.
 *
 * That position is not a choice: the board has drawn subgoals as flat rows in
 * exactly this order all along, so a flattened list looks like the board the
 * reader already had. Depth beyond one level was never written, but the walk
 * is recursive anyway — a payload that has it should still load rather than
 * lose rows.
 */
export function flattenNestedGoals(goals: readonly NestedGoalInput[]): WorkspaceGoal[] {
  const out: WorkspaceGoal[] = [];
  const walk = (list: readonly NestedGoalInput[]) => {
    for (const g of list) {
      out.push({ id: g.id, title: g.title, ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}) });
      if (g.subgoals?.length) walk(g.subgoals);
    }
  };
  walk(goals);
  return out;
}
