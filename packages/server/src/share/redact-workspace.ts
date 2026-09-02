import type { HubWorkspace } from '../tasks.ts';

/**
 * Strip a board's record down to what a share or collab visitor needs.
 *
 * `GET /api/workspaces/<id>` is on the visitor allowlist, documented there as
 * "workspace name + goal text", and it used to answer with the stored
 * `HubWorkspace` verbatim. That record is partly a description of the HOST
 * rather than of the board: `notesHome.repoRoot` is an absolute path on this
 * machine, and `retiredBy` carries an actor id the way every other visitor
 * surface refuses to (`redactHubEventForVisitor` reduces an actor to name and
 * kind; `listPublicAttachments` drops `endpoint`; `redactWorkspaceFilesForVisitor`
 * drops `root`). A visitor was handed one link, and the answer mapped a
 * filesystem for them.
 *
 * ALLOWLIST, NOT DENYLIST — the same rule `redactMetaForVisitor` is built on.
 * A field added to `HubWorkspace` later is withheld by default rather than
 * shipped until somebody notices it went out. The set below is exactly what
 * the board client declares it reads (`HubWorkspaceInfo` in
 * `markdown-app/src/hub/hub-board-model.ts`), so widening it is a deliberate act
 * with a surface asking for the field.
 *
 * `leadAgentId` STAYS: who is responsible for a board is workspace content,
 * a visitor already sees agent ids on the presence strip through
 * `PublicAttachment`, and the header says "nobody" without it.
 */
export function redactHubWorkspaceForVisitor(workspace: HubWorkspace): Partial<HubWorkspace> {
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
