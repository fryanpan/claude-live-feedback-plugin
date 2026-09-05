import type { BoardWorkspace, ParallelismCapChange } from '../tasks.ts';

/**
 * Strip a board's record down to what a share or collab visitor needs.
 *
 * `GET /workspaces/<id>` is on the visitor allowlist, documented there as
 * "workspace name + goal text", and it used to answer with the stored
 * `BoardWorkspace` verbatim. That record is partly a description of the HOST
 * rather than of the board: `notesHome.repoRoot` is an absolute path on this
 * machine, and `retiredBy` carries an actor id the way every other visitor
 * surface refuses to (`redactBoardEventForVisitor` reduces an actor to name and
 * kind; `listPublicAttachments` drops `endpoint`; `redactWorkspaceFilesForVisitor`
 * drops `root`). A visitor was handed one link, and the answer mapped a
 * filesystem for them.
 *
 * ALLOWLIST, NOT DENYLIST — the same rule `redactMetaForVisitor` is built on.
 * A field added to `BoardWorkspace` later is withheld by default rather than
 * shipped until somebody notices it went out. The set below is exactly what
 * the board client declares it reads (`BoardWorkspaceInfo` in
 * `workspaces-app/src/board/board-model.ts`), so widening it is a deliberate act
 * with a surface asking for the field.
 *
 * `leadAgentId` STAYS: who is responsible for a board is workspace content,
 * a visitor already sees agent ids on the presence strip through
 * `PublicAttachment`, and the header says "nobody" without it.
 */
export function redactBoardWorkspaceForVisitor(workspace: BoardWorkspace): Partial<BoardWorkspace> {
  return {
    id: workspace.id,
    name: workspace.name,
    goals: workspace.goals,
    createdAt: workspace.createdAt,
    ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
    ...(workspace.leadAgentSince !== undefined ? { leadAgentSince: workspace.leadAgentSince } : {}),
    ...(workspace.retiredAt !== undefined ? { retiredAt: workspace.retiredAt } : {}),
    ...(workspace.retiredReason !== undefined ? { retiredReason: workspace.retiredReason } : {}),
  };
}

/** A cap move as a visitor may be told it: everything but the actor's id. */
export type VisitorCapChange = Omit<ParallelismCapChange, 'actor'> & {
  actor: { name: string; kind: 'person' | 'agent' };
};

/**
 * Who last moved this board's parallelism cap, reduced to the display actor
 * every other visitor surface uses.
 *
 * The cap and its author are board content — "set by X 2h ago" is what stops
 * a lowered cap being a mystery — so what is withheld is the id alone, the
 * same field `redactBoardWorkspaceForVisitor` strips from `retiredBy` and
 * `redactBoardEventForVisitor` strips from every board event's actor.
 *
 * ONE function because there are three doors onto this fact and they must
 * not answer differently: `GET /workspaces/<id>`, `GET …/settings`, and
 * the board's own SSE feed. The first had an inline reduction of its own and
 * the second had none, so a member reading the settings panel got the id the
 * board record beside it had been refusing since the cap shipped.
 */
export function redactCapChangeForVisitor(change: ParallelismCapChange): VisitorCapChange {
  return {
    ...change,
    actor: { name: change.actor.name, kind: change.actor.kind },
  };
}
