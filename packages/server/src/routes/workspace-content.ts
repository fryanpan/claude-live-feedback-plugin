import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { reviewIdOf } from '@feedback/core';
/**
 * Content filed onto a board: a doc attached, a tracker imported, a huddle opened.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import {
  huddleAlias,
  huddleFilePath,
  huddleSeedMarkdown,
  huddleTitle,
  parseHuddleKind,
  parseHuddleTopic,
} from '../huddle.ts';
import { browserCannotBindBody, isBrowserRequest } from '../middleware/write-gate.ts';
import { redactMetaForVisitor, relativeReviewUrl } from '../share/redact-meta.ts';
import {
  applyImport,
  importBanner,
  importMarkerFor,
  parseTrackerMarkdown,
} from '../task-import.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_MESSAGE,
  resolveAssignee,
} from '../task-owner.ts';
import { isRetired, retiredRefusal } from '../tasks.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceContent(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    rooms,
    dataDir,
    j,
    safeJson,
    externalBaseUrl,
    withReviewUrl,
    fileUnderHubWorkspace,
    unfileFromDefault,
    workspacesOfDoc,
  } = ctx;
  const { req, pathname, authorFor, visitor } = rq;
  // attach_doc: link an existing doc or review to a hub workspace.
  const wsAttachMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/docs$/);
  if (wsAttachMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsAttachMatch[1] ?? '');
    const body = await safeJson(req);
    const addressed = body?.docId as string | undefined;
    if (!addressed || typeof addressed !== 'string') return j(400, { error: 'docId required' });
    // The link target must exist: either a doc room, or a REVIEW id (a
    // diff review / folder bind, attached as one unit). Only the first
    // kind canonicalizes — a review id names no room, so there is
    // nothing to resolve it to.
    const attachRoom = rooms.get(addressed);
    const docId = attachRoom?.docId ?? addressed;
    /**
     * A member may file onto their board something they can ALREADY see.
     * They may not pull something in from outside it.
     *
     * The path names the shared board, so the guard's scope check says yes;
     * what decides where this write REACHES is the `docId` in the body, which
     * the guard never read. Attaching is what makes a doc readable here —
     * share scoping answers on the boards holding a doc, and this call adds
     * one — so an unrestricted attach would be a read of any doc on the
     * server, wearing a write's clothes. Doc ids are readable slugs, so
     * guessing one is not a stretch, and the doc LIST is refused precisely to
     * stop that enumeration.
     *
     * So the test is the guard's own: is the target already inside the shared
     * board's scope? That still leaves the verb its real subject — a file
     * inside a folder bind or diff review filed here, which a member can open
     * but which has no row of its own — and it leaves out everything the
     * member could not open a second ago.
     *
     * `workspacesOfDoc` is `shareWorkspacesOf`, the resolver the host guard
     * reads, rather than a second membership rule written here.
     *
     * The owner is unaffected: `visitor` is null for a request from the box.
     * Refused in the words every out-of-board refusal uses, so the reply does
     * not say which guessed doc ids are real.
     */
    if (visitor) {
      const reachable =
        visitor.workspaceId !== undefined &&
        (workspacesOfDoc(docId).includes(visitor.workspaceId) ||
          workspacesOfDoc(addressed).includes(visitor.workspaceId));
      if (!reachable) return j(403, { error: 'out_of_share_scope' });
    }
    // AFTER the scope check, and only for that reason. This answers "is
    // there such a doc" — a fact about the whole server, not about this
    // board — so running it first made the route an existence oracle: a doc
    // on somebody else's board came back 403 and a made-up id came back 404,
    // which is the doc LIST one id at a time. A member now gets the same
    // out-of-board refusal either way, and the miss reaches only callers who
    // could have attached the doc had it been there.
    const exists = attachRoom !== undefined || rooms.list().some((m) => reviewIdOf(m) === docId);
    if (!exists) return j(404, { error: 'doc not found', docId });
    const res = taskStore.attachDoc(workspaceId, docId);
    if (!res.ok) return j(404, res);
    // A doc filed here is no longer unfiled.
    unfileFromDefault(docId, workspaceId);
    // attachDoc emits no store event; refresh the projection's docIds.
    taskProjection.ensureWorkspace(workspaceId);
    return j(200, { ok: true, workspace: taskStore.getWorkspace(workspaceId) });
  }
  // import_tasks_markdown (§3.10 / §3.12 commit 10): ingest a
  // hand-maintained tracker (group headings + status tables). The
  // DEFAULT is a dry-run that returns the mapping and touches nothing;
  // apply:true creates the goals + tasks and stamps the source file
  // with a banner + hub link so the old tracker can't quietly stay a
  // second source of truth (a stamped file refuses re-import).
  const wsImportMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/import-tasks$/);
  if (wsImportMatch && req.method === 'POST') {
    // Reads a markdown file off disk by path. Agents only — see
    // browserCannotBindBody.
    if (isBrowserRequest(req.headers)) return j(403, browserCannotBindBody());
    const workspaceId = decodeURIComponent(wsImportMatch[1] ?? '');
    const body = await safeJson(req);
    const path = body?.path;
    if (typeof path !== 'string' || path.length === 0) {
      return j(400, { error: 'path required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    if (!existsSync(path)) return j(404, { error: 'file not found', path });
    const markdown = readFileSync(path, 'utf8');
    const alreadyImported = importMarkerFor(markdown);
    const mapping = parseTrackerMarkdown(markdown, workspace);
    if (body?.apply !== true) {
      return j(200, {
        dryRun: true,
        workspaceId,
        path,
        ...(alreadyImported !== null ? { alreadyImported } : {}),
        mapping,
      });
    }
    if (alreadyImported !== null) {
      return j(409, { error: 'already-imported', workspaceId: alreadyImported });
    }
    // An import inherits the importer's identity for every row that
    // names nobody, so an anonymous importer would file those rows under
    // the generic word — the one thing every other create refuses. The
    // test is per row and the refusal is whole: a tracker whose owner
    // column is filled in imports fine no matter who ran it, and one
    // that isn't fails before anything is written, so there is no
    // partial state to reason about. The dry run above stays allowed —
    // it creates nothing, and it's what you read while fixing this.
    if (mapping.tasks.some((row) => !resolveAssignee(row.assignee, author))) {
      return j(400, { error: ASSIGNEE_REQUIRED_ERROR, message: ASSIGNEE_REQUIRED_MESSAGE });
    }
    // Looked up BEFORE the apply now: when the tracker is bound as a
    // live doc, the imported rows carry a structured origin ref back to
    // it — the doc→task tie used to exist only in the file's banner,
    // which no backlink query can see. A pending plan gate on the bound
    // doc holds the rows as drafts, same as the batch route.
    const resolved = resolve(path);
    const bound = rooms
      .list()
      .find((m) => m.sourceUrl !== undefined && resolve(m.sourceUrl) === resolved);
    const res = applyImport(taskStore, workspaceId, mapping, {
      actor: author,
      ...(bound !== undefined ? { origin: { kind: 'doc', docId: bound.docId } } : {}),
      ...(bound !== undefined && bound.planState === 'pending'
        ? { planHold: { docId: bound.docId } }
        : {}),
    });
    if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
    // Stamp the source file. If the tracker is bound as a live doc,
    // pull the banner into the live doc too — reparse right after our
    // own write, so disk (which we just wrote) wins the race with the
    // doc's debounced flush.
    const hubUrl = `${externalBaseUrl()}/workspaces/${encodeURIComponent(workspaceId)}`;
    writeFileSync(
      path,
      importBanner({
        workspaceId,
        hubUrl,
        taskCount: res.tasksCreated.length,
        ts: Date.now(),
      }) + markdown,
    );
    if (bound) rooms.reparseFromDisk(bound.docId);
    // Task/goal events already refreshed the projection; this covers a
    // mapping with zero new goals and zero tasks (nothing emitted).
    taskProjection.ensureWorkspace(workspaceId);
    return j(200, {
      ok: true,
      workspaceId,
      hubUrl,
      stamped: true,
      goalsCreated: res.goalsCreated,
      tasksCreated: res.tasksCreated,
      failures: res.failures,
      skipped: mapping.skipped,
      ignoredColumns: mapping.ignoredColumns,
      // Hand-copied, like every field above it — a mapping field that
      // isn't listed here is silently dropped on the apply path while
      // the dry-run (which spreads `mapping`) still shows it.
      warnings: mapping.warnings,
    });
  }
  // --- REST: start a huddle ---
  // The Board's "Make a plan" / "Have a meeting" buttons. ONE call: a
  // workspace-tied markdown doc, titled by its kind and the clock, empty or headed
  // by the topic, filed on this board exactly as every other board doc
  // is (so `list_docs`, the hub's docs list and the board fan-out see
  // it with no new verb), flagged `huddle`, and answered with where to
  // open it. The mic is the browser's to start; the server's part ends
  // at the doc. A member of this board reaches it too (Bryan, 2026-09-03:
  // a share link means full access), which is why the reply's doc metadata
  // below is redacted rather than returned raw.
  const wsHuddlesMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/huddles$/);
  if (wsHuddlesMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsHuddlesMatch[1] ?? '');
    const body = await safeJson(req);
    const targetBoard = taskStore.getWorkspace(workspaceId);
    if (!targetBoard) return j(404, { error: 'workspace-not-found' });
    if (isRetired(targetBoard)) {
      return j(409, { error: 'workspace-retired', message: retiredRefusal(targetBoard) });
    }
    const parsedTopic = parseHuddleTopic(body?.topic);
    if (!parsedTopic.ok) {
      return j(400, {
        error: 'bad topic',
        hint: 'topic is an optional short string — it becomes the first heading.',
      });
    }
    const parsedKind = parseHuddleKind(body?.kind);
    if (!parsedKind.ok) {
      return j(400, {
        error: 'bad kind',
        hint: 'kind is optional: "plan" or "discussion".',
      });
    }
    // The task this huddle is FOR, when there is one. Judged before
    // the doc is minted so a bad id costs nothing; recorded after, as
    // a link on the task (`links`, the same ref `link_refs` writes),
    // which is what lets a row spun off the huddle join the task's
    // band (`TaskStore.placeSpinoff`, rule 1). Optional: the Board's
    // two buttons start a huddle with no task at all.
    const huddleTaskId = body?.taskId;
    if (huddleTaskId !== undefined) {
      if (typeof huddleTaskId !== 'string' || huddleTaskId.trim().length === 0) {
        return j(400, {
          error: 'bad taskId',
          hint: 'taskId is an optional task id on this board.',
        });
      }
      if (taskStore.getTask(huddleTaskId)?.workspaceId !== workspaceId) {
        return j(404, { error: 'task-not-found' });
      }
    }
    const startedAt = Date.now();
    // Minted, never re-used: `createForCaller` answers an existing doc
    // for a name that already resolves, and a huddle is always new.
    let created = rooms.createForCaller(huddleAlias(startedAt), {
      type: 'markdown',
      title: huddleTitle(startedAt, parsedKind.kind),
      huddle: true,
      huddleKind: parsedKind.kind,
    });
    if (created.ok && !created.minted) {
      created = rooms.createForCaller(huddleAlias(startedAt), {
        type: 'markdown',
        title: huddleTitle(startedAt, parsedKind.kind),
        huddle: true,
        huddleKind: parsedKind.kind,
      });
    }
    if (!created.ok || !created.minted) {
      return j(500, { error: 'huddle-not-minted' });
    }
    const room = created.room;
    const docId = room.docId;
    const hubWorkspaceId = fileUnderHubWorkspace(docId, workspaceId);
    // The file first, then the bind — `attachFile` seeds the room from
    // the file when the room is empty, so the topic heading lands
    // through the same path a bound project file's content does, and
    // the doc is a record on disk before anyone has typed a word.
    const file = huddleFilePath(dataDir, docId);
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file))
        writeFileSync(file, huddleSeedMarkdown(parsedTopic.topic, parsedKind.kind));
    } catch (err) {
      console.error(`[huddle] could not write ${file}:`, err);
      return j(500, { error: 'huddle-file-failed' });
    }
    const attached = await rooms.attachFileAsync(docId, file);
    if (!attached.ok) return j(409, { error: 'attach_failed', attached });
    if (typeof huddleTaskId === 'string') {
      const linked = taskStore.linkRef(huddleTaskId, { kind: 'doc', docId });
      // Link changes emit no store event; refresh by hand, as the
      // link-refs route does.
      if (linked.ok) taskProjection.ensureWorkspace(linked.task.workspaceId);
    }
    const decorated = withReviewUrl(room.meta, hubWorkspaceId);
    /**
     * The reply's doc metadata, as this caller may see it.
     *
     * A huddle's `sourceUrl` is the file it was just seeded into, under the
     * owner's data directory — an absolute path on the machine. The doc read
     * this reply stands in for (`GET /api/docs/<id>`) has run every visitor's
     * metadata through `redactMetaForVisitor` since the first share; a route
     * that mints a doc and answers with its raw meta is the second door.
     */
    const meta = visitor
      ? {
          ...redactMetaForVisitor(decorated, { workspaceScoped: true }),
          ...(relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) !== undefined
            ? { reviewUrl: relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) }
            : {}),
        }
      : decorated;
    const reviewUrl = (meta as { reviewUrl?: string }).reviewUrl;
    return j(200, {
      docId,
      ...(typeof huddleTaskId === 'string' ? { taskId: huddleTaskId } : {}),
      // Where the Board opens it — the SPA doc route under THIS board,
      // relative so the client navigates within its own origin.
      url: `/workspaces/${encodeURIComponent(hubWorkspaceId)}/docs/${encodeURIComponent(docId)}`,
      ...(reviewUrl !== undefined ? { reviewUrl } : {}),
      hubWorkspaceId,
      meta,
      ...(parsedTopic.topic !== undefined ? { topic: parsedTopic.topic } : {}),
    });
  }
  return undefined;
}
