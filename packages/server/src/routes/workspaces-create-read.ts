/**
 * Creating a board or binding a folder, the diff review beside it, and the two reads of a board.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { classifyActor } from '../actor-identity.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import {
  redactCapChangeForVisitor,
  redactHubWorkspaceForVisitor,
} from '../share/redact-workspace.ts';
import { summarizeGoals } from '../task-queue.ts';
import { isRetired, retiredNotice } from '../tasks.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceCreateRead(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    rooms,
    j,
    safeJson,
    isValidDocId,
    withReviewUrl,
    parallelismCapView,
    fileUnderHubWorkspace,
  } = ctx;
  const { req, pathname, visitor, authorFor } = rq;
  // --- REST: workspaces (hub create OR folder bind) ---
  // One resource, two shapes: `folderPath` binds a folder of files
  // (the review), `name` creates a hub Workspace —
  // a NEW first-class entity with a crypto-random id that tasks and
  // goals hang off (plan §3.12 commit 1). Nothing is migrated between
  // the two; attach_doc LINKS existing docs/reviews to a hub workspace.
  if (pathname === '/api/workspaces' && req.method === 'POST') {
    const body = await safeJson(req);
    const folderPath = body?.folderPath as string | undefined;
    // Creating a board by name involves no file and stays open to the
    // app; binding a FOLDER names a host path, and that is agents only
    // — see browserCannotBindBody.
    if (folderPath && isBrowserRequest(req.headers)) {
      return j(403, browserCannotBindBody());
    }
    if (!folderPath && typeof body?.name === 'string' && body.name.trim().length > 0) {
      // `body.goal` is the removed workspace-level text goal. Read
      // deliberately nowhere: bundles built before the removal still
      // send it, and refusing a field the server has stopped caring
      // about would fail a caller for saying something harmless.
      // Who leads the board. Explicit `leadAgentId` wins; otherwise the
      // CREATING agent takes the seat — which is the whole point of
      // "every workspace has a lead, always": the common path is an
      // agent minting a board for work it is about to do. A person
      // creating one leaves the seat open rather than being installed
      // as an agent lead; the first agent to attach claims it.
      const claimed = body?.leadAgentId;
      const author = authorFor(body?.author);
      const leadAgentId =
        typeof claimed === 'string' && claimed.trim().length > 0
          ? claimed.trim()
          : author && classifyActor(author) === 'agent'
            ? author.id
            : undefined;
      const workspace = taskStore.createWorkspace(body.name.trim(), {
        ...(leadAgentId !== undefined ? { leadAgentId } : {}),
      });
      // createWorkspace emits no event (nothing subscribes to a
      // workspace that doesn't exist yet), so the route brings the
      // board room up itself.
      taskProjection.ensureWorkspace(workspace.id);
      return j(200, { workspace });
    }
    if (!folderPath || typeof folderPath !== 'string') {
      return j(400, { error: 'folderPath (folder bind) or name (hub workspace) required' });
    }
    const res = rooms.bindFolder({
      folderPath,
      // `workspaceId` is what this body key was called before a review
      // stopped being a workspace; both are read, neither is required.
      setId: (body?.setId ?? body?.workspaceId) as string | undefined,
      title: body?.title as string | undefined,
      include: Array.isArray(body?.include) ? (body.include as string[]) : undefined,
      // Accepted by bindFolder and honoured by the scan since forever,
      // but this route never forwarded it — so bind_folder's exclude had
      // no effect end-to-end. It matters more now: refresh_workspace
      // persists and replays the exclude, which is meaningless if the
      // bind could never set one. (/api/diffs already forwarded it.)
      exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
      maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
      owner: body?.owner as string | undefined,
      producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
    });
    if (!res.ok) {
      // not-found → 404; reserved-namespace → 400 (the caller chose an
      // id it may not have, and no amount of narrowing fixes that);
      // too-many-files → 409 (guardrail, caller must narrow the folder
      // or raise maxFiles).
      const status =
        res.error === 'not-found' ? 404 : res.error === 'reserved-namespace' ? 400 : 409;
      return j(status, res);
    }
    // The GROUPING goes on the board, not its members: `res.workspaceId`
    // is the review id, and one row for the whole bind is the unit a
    // reader thinks in. See the vocabulary note above `fileUnderHubWorkspace`.
    const hubWorkspaceId = fileUnderHubWorkspace(
      res.workspaceId,
      body?.hubWorkspaceId as string | undefined,
    );
    return j(200, {
      ...res,
      // The review's id, under the name the CRDT already stores it as.
      // `workspaceId` (from ...res) carries the SAME value and is
      // deprecated for one release — a caller built before the rename
      // reads it by that name, and a key must never change MEANING.
      setId: res.workspaceId,
      hubWorkspaceId,
      files: res.files.map((f) => ({
        ...f,
        reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
      })),
    });
  }
  // --- REST: diff reviews ---
  // One doc per changed file, grouped as a workspace (= the review id).
  // Default mode diffs base → the WORKING TREE (live: docs bind to the
  // files on disk and re-render as the agent edits); pass `target` for a
  // review pinned to a commit. Returns per-file reviewUrls plus an
  // entryUrl (first changed file) the agent can hand to a human.
  if (pathname === '/api/diffs' && req.method === 'POST') {
    // `repo` is a host path this server will read and serve — the same
    // class as the folder bind above, and refused on the same terms.
    // See browserCannotBindBody. Omitting `base` scans the WHOLE folder
    // and makes every file in it lazily openable, so this is the wider
    // of the two, not the narrower.
    if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
    const body = await safeJson(req);
    const repoPath = body?.repo as string | undefined;
    const base = body?.base as string | undefined;
    const target = body?.target as string | undefined;
    if (!repoPath) {
      return j(400, {
        error:
          'repo is required. base optional: omit for a BROWSE workspace (no diff); pass base to diff against the working tree; base+target for a pinned range.',
      });
    }
    if (target && !base) {
      return j(400, { error: 'target requires base' });
    }
    const reviewId = body?.reviewId as string | undefined;
    if (reviewId !== undefined && !isValidDocId(reviewId)) {
      return j(400, { error: 'bad reviewId' });
    }
    const res = rooms.bindDiff({
      repoPath,
      base,
      target,
      reviewId,
      title: body?.title as string | undefined,
      exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
      groups: Array.isArray(body?.groups)
        ? (body.groups as Array<{ title: string; paths: string[]; details?: string }>)
        : undefined,
      maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
      owner: body?.owner as string | undefined,
      producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
    });
    if (!res.ok) {
      const status =
        res.error === 'not-found' || res.error === 'bad-ref'
          ? 404
          : res.error === 'empty-diff' ||
              res.error === 'group-details-too-long' ||
              res.error === 'bad-groups'
            ? 400
            : 409;
      return j(status, res);
    }
    const files = res.files.map((f) => ({
      ...f,
      reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
    }));
    // Land the reviewer on the MEATIEST change, not the first file
    // alphabetically (which is usually dotfile/config noise on a big
    // review). The in-page tree navigates to everything else.
    const entry = files.reduce(
      (best, f) =>
        (f.additions ?? 0) + (f.deletions ?? 0) > (best.additions ?? 0) + (best.deletions ?? 0)
          ? f
          : best,
      files[0],
    );
    // One row per REVIEW on the board, never one per changed file — the
    // members are reachable through the review's own tree. Idempotent, so
    // a re-run that omits `hubWorkspaceId` cannot sweep a live review out
    // of the board a reviewer already filed it on.
    const hubWorkspaceId = fileUnderHubWorkspace(
      res.reviewId,
      body?.hubWorkspaceId as string | undefined,
    );
    // `setId` is the same value as `reviewId`, under the name the CRDT
    // stores it as — both stay, and neither changes meaning.
    return j(200, {
      ...res,
      setId: res.reviewId,
      hubWorkspaceId,
      files,
      entryUrl: entry?.reviewUrl,
    });
  }
  // List bound workspaces with rolled-up triage signals (fileCount,
  // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
  // this to treat a folder bind as one cleanup unit.
  if (pathname === '/api/workspaces' && req.method === 'GET') {
    return j(200, {
      workspaces: rooms.listWorkspaces(),
      // Hub workspaces (the boards) are a different thing from the
      // reviews above and stay in their own key rather than
      // being mixed into one list. They belong on this route because a
      // workspace the SERVER materialized for an unfiled doc has no
      // other way to be found: nobody was told its id at creation time.
      hubWorkspaces: taskStore.listWorkspaces().map((w) => ({
        id: w.id,
        name: w.name,
        docCount: w.docIds.length,
        createdAt: w.createdAt,
        // Present only when true, so a client that has never heard of
        // retirement reads exactly what it read before, and one that
        // has can filter on the key's presence.
        ...(isRetired(w) ? { retired: true, retiredAt: w.retiredAt } : {}),
      })),
    });
  }
  // --- REST: hub workspaces + tasks (plan §3.10) ---
  // Every handler below hand-copies body fields into the store call.
  // A field that isn't copied is silently discarded while the request
  // still returns 200 — so every param here has an HTTP-level test in
  // task-routes.test.ts (the `groups` lesson).
  const hubWsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (hubWsMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(hubWsMatch[1] ?? '');
    const stored = taskStore.getWorkspace(workspaceId);
    if (!stored) return j(404, { error: 'workspace not found' });
    // A visitor gets a PROJECTION, never the stored record. This route
    // is on the visitor allowlist as "workspace name + goal text"
    // (host-guard.ts), and the record it used to answer with verbatim
    // carries `notesHome.repoRoot` — an absolute path on this machine —
    // and `retiredBy`, an actor id every neighbouring visitor surface
    // strips. See redactHubWorkspaceForVisitor. The local surface keeps
    // the whole record: `notesHome` is what the settings panel edits.
    const workspace = visitor ? redactHubWorkspaceForVisitor(stored) : stored;
    // Goals with their counts, in priority order. The goals were always
    // in this payload and no MCP tool read it, so ordering lived in
    // each agent's head; the counts are what make the list answer
    // "where is the open work" without a second call per goal.
    const capView = parallelismCapView(workspaceId);
    // Who moved the cap, given to a visitor the way every other visitor
    // surface gives an actor: name and kind, no id. The SAME change over
    // their SSE feed is already reduced by `displayActor`
    // (redactHubEventForVisitor), and the transport and the surface have
    // to agree about the same fact — an id here is one the neighbouring
    // `retiredBy` redaction exists to strip. The local surface keeps the
    // full actor. Shared with `GET …/settings`, the third door onto this
    // fact, which used to answer it with the id still on.
    const capLastChange =
      capView?.lastChange === undefined
        ? undefined
        : visitor
          ? redactCapChangeForVisitor(capView.lastChange)
          : capView.lastChange;
    return j(200, {
      workspace,
      // How many builders the board may run and how many it is running,
      // so an agent deciding what to work on sees the ceiling in the
      // same read as the goals — `set_parallelism_cap` changes it.
      ...(capView
        ? {
            parallelismCap: {
              value: capView.cap,
              isDefault: capView.isDefault,
              inUse: capView.inUse,
              free: capView.free,
              // Who moved it last, when, from what — so a lowered cap
              // is a fact with an author, not a mystery.
              ...(capLastChange !== undefined ? { lastChange: capLastChange } : {}),
            },
          }
        : {}),
      // The rows argument is what lets each band carry its own status
      // (and done attribution) — the counts say where the open work is,
      // the status says what somebody declared about the band itself.
      goalSummary: summarizeGoals(
        taskStore.listTasks(workspaceId),
        stored.goals,
        taskStore.listGoalRows(workspaceId),
      ),
      // The board has been stood down. Present only when it has, and
      // carrying prose rather than a flag, because the reader is
      // usually an agent deciding whether to work here and a boolean
      // gives it nothing to act on.
      ...(isRetired(stored) ? { retired: retiredNotice(stored) } : {}),
    });
  }
  return undefined;
}
