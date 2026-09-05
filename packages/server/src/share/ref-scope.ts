/**
 * May THIS caller point a cross-reference at THAT thing?
 *
 * A `Ref` is the one field a member can write that names something by id
 * without the id ever appearing in the path. The host guard reads paths, so
 * it never saw these: a member allowed to file and edit rows on their own
 * board could store `{kind:'task', taskId:'<a row on another board>'}` on one
 * of them, and backlinks are COMPUTED per read — so the pointing row then
 * showed up as a chip on a board that member was never given, written from
 * outside it. The read side was already filtered (`GET /api/tasks/<id>/links`
 * drops backlinks from other boards); this is the write side of the same
 * rule.
 *
 * The rule is the guard's own, not a second one: the ref's target must
 * resolve to a workspace the request is already scoped to. `workspacesOf` is
 * `shareWorkspacesOf`, the same resolver `shareScopeAllows` and `collabScope`
 * read, so "inside this board" has one answer in this server.
 *
 * A NON-EXISTENT target answers exactly the same as a target on somebody
 * else's board — both resolve to no workspace and both are refused. That is
 * deliberate and it is the whole reason the check reads this way rather than
 * "does it exist and is it mine": refusing only the foreign ones would turn
 * this route into the doc list one id at a time, which is the existence
 * oracle `POST /workspaces/<id>/docs` records in `workspace-content.ts`.
 * The cost is that a member cannot store a dangling annotation the owner
 * still can, which is a fair trade for not answering "is this id real".
 *
 * The owner and every agent are unaffected: `visitor` is null for a request
 * from the box, and this answers true without asking anything.
 */
import type { Ref } from '@feedback/core';
import type { ShareTarget } from '../middleware/host-guard.ts';

/** The refusal a ref outside the caller's board earns — the same body every
 *  other out-of-board refusal uses, so the reply cannot be read as a hint
 *  about which guessed ids are real. */
export const OUT_OF_SHARE_SCOPE = { error: 'out_of_share_scope' } as const;

/**
 * Is this ref inside the workspace this request is scoped to?
 *
 * `url` is the one kind that names nothing on this server — it carries a
 * caller-supplied http(s) URL, already scheme-checked by `isValidRef` — so
 * there is no board for it to be outside of and it is always allowed.
 */
export function refInVisitorScope(
  ref: Ref,
  visitor: ShareTarget | null,
  workspacesOf: (id: string) => string[],
): boolean {
  if (!visitor) return true;
  const scope = visitor.workspaceId;
  // A visitor scoped to no workspace at all holds nothing (the app shell and
  // no more), so it may point at nothing. Fail closed.
  if (scope === undefined || scope === '') return false;
  const inside = (id: string): boolean => {
    const owners = workspacesOf(id);
    // `Array.isArray` for the reason `shareScopeAllows` gives at its own use
    // of this resolver: a bare string also answers `.includes`, and would
    // grant on any SUBSTRING match.
    return Array.isArray(owners) && owners.includes(scope);
  };
  switch (ref.kind) {
    case 'url':
      return true;
    case 'doc':
    case 'thread':
      return inside(ref.docId);
    case 'task':
      // `task:<id>` is the id a board holds a row's BODY under — the same
      // spelling the guard resolves `/api/tasks/<id>/…` through.
      return inside(`task:${ref.taskId}`);
    case 'diff':
      // A diff ref names a review, which is a workspace: it is in scope when
      // it IS the scope, or when the scope covers it.
      return ref.workspaceId === scope || inside(ref.workspaceId);
  }
}

/** The same question about a list, answering the FIRST ref that is out of
 *  scope — so a caller's refusal names something rather than nothing. */
export function firstRefOutOfScope(
  refs: readonly Ref[] | undefined,
  visitor: ShareTarget | null,
  workspacesOf: (id: string) => string[],
): Ref | undefined {
  if (!visitor || !refs) return undefined;
  return refs.find((ref) => !refInVisitorScope(ref, visitor, workspacesOf));
}

/**
 * The same question about a BARE task id.
 *
 * Two writes name a dependency as a plain string rather than as a `Ref`:
 * `POST /api/tasks/<id>/after` replaces the edge set, and the `blockedBy`
 * arm of `.../park` adds to it. Both are member-allowed and both take their
 * ids from the body, so they LOOK like the `links` route's hole with none of
 * the `Ref` shape around it.
 *
 * They are not, and it is worth writing down why rather than leaving the
 * next reader to re-derive it: the store refuses a cross-board edge on its
 * own, on BOTH write paths (`state.tasks.has(dep)` in `setDependencies` and
 * in `createTask` — the map is per workspace), and it refuses a foreign id
 * and a made-up one with the same `unknown-after`. So this check closes no
 * reachable leak today. What it does is refuse in the BOUNDARY's words
 * before the store is asked at all, so that the member rule has one answer
 * across every body-borne id, and so that a later relaxation of that
 * same-workspace check — or a verb that moves a row between boards — does
 * not silently open the door this module exists to hold.
 */
export function firstTaskIdOutOfScope(
  ids: readonly string[],
  visitor: ShareTarget | null,
  workspacesOf: (id: string) => string[],
): string | undefined {
  if (!visitor) return undefined;
  return ids.find((taskId) => !refInVisitorScope({ kind: 'task', taskId }, visitor, workspacesOf));
}

/**
 * The blockers a scoped caller may be TOLD about.
 *
 * The transition gate reports what a row waits on — each blocker's id,
 * title, status and `needs` — and it reads those rows through the store's
 * GLOBAL `getTask`, not through the board's own map. Only the write checks
 * keep a foreign id out of `after` in the first place, so the report is one
 * relaxation of those away from carrying a private row's title to whoever
 * moves the pointing row. It costs a filter to make the report not depend
 * on them: what a scoped caller is told is cut to their own board, and the
 * verdict is untouched, because a member who cannot see the holding row
 * cannot finish it either.
 *
 * Generic over the blocker shape so this module keeps naming nothing from
 * the task store.
 */
export function blockersInVisitorScope<T extends { taskId: string }>(
  blockers: readonly T[] | undefined,
  visitor: ShareTarget | null,
  workspacesOf: (id: string) => string[],
): T[] | undefined {
  if (blockers === undefined) return undefined;
  if (!visitor) return [...blockers];
  return blockers.filter((b) =>
    refInVisitorScope({ kind: 'task', taskId: b.taskId }, visitor, workspacesOf),
  );
}
