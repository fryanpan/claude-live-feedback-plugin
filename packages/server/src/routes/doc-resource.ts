/**
 * The `/api/docs/:id/...` resource block's first family: the doc's own
 * surface — read, delete, its task chips, the plan/review/research asks the
 * meeting floats fire, its repo home, and the read-only content/status/diff
 * views. Split out of `routes/docs.ts`'s `handleDocResourceRoutes`, which
 * still owns the `/api/docs/:id/...` match and the `docId`/`room`/`rest`
 * resolution — see that file's header for why call order across the three
 * families is not load-bearing.
 */
import type { Thread } from '@feedback/core';
import { type Anchor, anchors } from '@feedback/core';
import { showFile } from '../git-diff.ts';
import {
  RESEARCH_TOPIC_MAX,
  askCommentFor,
  researchAskComment,
  researchPlaceholderMarkdown,
  researchSectionTitle,
} from '../huddle.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import { taskIdOfBodyDoc } from '../task-projection.ts';
import { clipToWordBoundary } from '../task-title.ts';
import { type Task, taskChip } from '../tasks.ts';
import type { DocResourceRouteRequest, DocRoutesContext } from './docs.ts';

/**
 * The doc's own routes: `''`, `threads` GET, `tasks`, `plan`,
 * `plan-request`, `lead-presence`, `review-request`, `research-request`,
 * `home`, `content` GET, `status`, `diff`, `activity`, `hooks/fire`.
 * `undefined` means none of them matched.
 */
export async function handleDocResourceCore(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const {
    rooms,
    taskStore,
    taskProjection,
    webhooks,
    leadPresence,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    backTargetFor,
    unlinkFromEveryHubWorkspace,
    withReviewUrl,
    fileReviewRequest,
  } = ctx;
  const {
    req,
    url,
    docId,
    room,
    rest,
    visitor,
    authorFor,
    refuseCategoryAuthor,
    metaFor,
    withTaskChips,
  } = rq;
  // Tasks referencing this doc under EITHER of its names: origin and
  // link refs routinely hold the caller-chosen alias rather than the
  // minted id, and an exact-match query under only the canonical id
  // silently drops those rows from the doc's own surface.
  const docTaskRows = (): Task[] => {
    const rows = taskStore.tasksReferencingDoc(docId);
    const alias = room.meta.alias;
    const all =
      alias === undefined || alias === docId
        ? rows
        : (() => {
            const seen = new Set(rows.map((t) => t.id));
            return [
              ...rows,
              ...taskStore.tasksReferencingDoc(alias).filter((t) => !seen.has(t.id)),
            ];
          })();
    // `tasksReferencingDoc` spans every workspace, deliberately — a ref may
    // cross a board, and a row on another board pointing here is a real
    // link. For a caller scoped to ONE board it is also a read of a board
    // they were never given: this doc is theirs to open, and the chip hands
    // them a private row's id, title, status and assignee off the back of
    // it. Filtered exactly as `GET /api/tasks/<id>/links` filters backlinks,
    // and as `withTaskChips` filters the thread half of the same surface.
    return all.filter((t) => !visitor || t.workspaceId === visitor.workspaceId);
  };
  // The chip a MEMBER sees carries what the doc page's derived-work
  // strip draws: where the row lives (a board id is an unguessable
  // URL capability, so it never reaches a visitor), and the two
  // plan-linkage marks. A visitor keeps the bare §3.3 chip.
  const docTaskEntries = (): Array<Record<string, unknown>> =>
    docTaskRows().map((t) =>
      visitor
        ? { ...taskChip(t) }
        : {
            ...taskChip(t),
            workspaceId: t.workspaceId,
            ...(t.planHold !== undefined ? { planHeld: true } : {}),
            ...(t.possiblyStale !== undefined ? { possiblyStale: true } : {}),
          },
    );
  if (rest === '' && req.method === 'GET') {
    // Doc→task surfacing (§3.12 commit 4): chips for the tasks that
    // reference this doc — directly or via one of its threads.
    // Visitor-safe by construction (§3.3 rule 2); omitted when empty.
    const taskRefs = docTaskEntries();
    // Which hub workspace this doc is attached to, so the doc surface
    // can route voice utterances (§3.8: voice is not board-only).
    // OWNER ONLY: a workspace id is an unguessable URL capability, and
    // a doc-scoped visitor must not learn it from a member doc.
    const hubWs = visitor ? null : taskStore.workspaceOfDoc(docId);
    // Where the review app's `←` should go: the board that links this
    // doc, rather than the machine-wide landing page. OWNER ONLY for
    // the same reason `hubWorkspaceId` is — a board id is an
    // unguessable URL capability, and a share visitor must not learn
    // one from a member doc. Resolved through the review when the
    // doc is a member of a review, which is where `hubWorkspaceId`
    // deliberately stops.
    const backTo = visitor ? null : backTargetFor(docId, room.meta.workspaceId);
    // Who the Make Plan float names ("Ask <lead> to create a plan").
    // Owner-only like the board id it comes from; a lead id is
    // already a display name everywhere the hub shows one.
    const lead = hubWs ? taskStore.getWorkspace(hubWs)?.leadAgentId : undefined;
    return j(200, {
      meta: metaFor(room.meta),
      ...(taskRefs.length > 0 ? { tasks: taskRefs } : {}),
      ...(hubWs ? { hubWorkspaceId: hubWs } : {}),
      ...(lead !== undefined ? { leadAgentId: lead } : {}),
      ...(backTo ? { backTo: { workspaceId: backTo.id, name: backTo.name } } : {}),
    });
  }
  if (rest === '' && req.method === 'DELETE') {
    const force = url.searchParams.get('force') === 'true';
    const res = rooms.deleteDoc(docId, { force });
    if (res.ok) {
      unlinkFromEveryHubWorkspace(docId);
      return j(200, res);
    }
    return j(res.error === 'has-open-threads' ? 409 : 404, res);
  }
  if (rest === 'threads' && req.method === 'GET') {
    const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
    const filter = status ? { status } : undefined;
    const threads: Array<Thread & { docId?: string }> = rooms
      .listThreads(docId, filter)
      .map((t) => withTaskChips(docId, t));
    // A `.md` diff member's companion editor doc holds the threads
    // the reviewer left in the File view. The agent asked about the
    // member because that is the id it was handed; answer for the
    // file, and tag each companion thread with the doc it lives on
    // so a reply lands there. Member threads keep their shape.
    const companionId = rooms.companionOf(docId);
    if (companionId) {
      for (const t of rooms.listThreads(companionId, filter)) {
        threads.push({ ...withTaskChips(companionId, t), docId: companionId });
      }
      threads.sort((a, b) => b.lastActivity - a.lastActivity);
    }
    return j(200, { threads });
  }
  // Task-chip resolution (§3.3 rule 2): how a chip inside a doc
  // resolves for a DOC-scoped invite, which never gets the workspace
  // board room. The chip is the visitor-safe shape (id, title,
  // status, assignee) — adding a field to it is a sharing decision.
  if (rest === 'tasks' && req.method === 'GET') {
    return j(200, { docId, tasks: docTaskEntries() });
  }
  // The plan gate's one control: a doc becomes a pending plan, or a
  // pending plan is approved — which clears every draft hold pointing
  // at it and releases the held rows to todo, attributed to the
  // approver. Owner-only: approval is a decision about the board, and
  // a share visitor does not hold that seat.
  if (rest === 'plan' && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const body = await safeJson(req);
    const state = body?.state;
    if (state !== 'pending' && state !== 'approved') {
      return j(400, { error: "state must be 'pending' or 'approved'" });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const set = rooms.setPlanState(docId, state, author.name);
    if (!set.ok) return j(404, { error: 'doc not found' });
    let released: string[] = [];
    if (state === 'approved') {
      const ids = room.meta.alias ? [docId, room.meta.alias] : [docId];
      const rel = taskStore.releasePlanHolds(ids, author);
      released = rel.released;
      // Holds cleared WITHOUT a transition (archived rows, rows
      // already moved) emit nothing — refresh those boards by hand,
      // the linkRef pattern.
      for (const wsId of rel.workspaceIds) taskProjection.ensureWorkspace(wsId);
    }
    return j(200, { docId, planState: state, released });
  }
  // The Make Plan float's press: the person asking this doc's agent
  // for a plan. The ask IS a comment — a subject-anchored thread
  // from the presser, riding the existing thread.created channel to
  // whoever watches — plus a server-written stamp so a reopened doc
  // renders "plan requested" rather than offering a first ask.
  // Owner-only for the same reason `plan` is: asking for board work
  // is a member's seat.
  //
  // ALSO the board's own Plan control: a ticket's comments live in its
  // body doc (`task:<id>`), so the task panel presses this same route
  // and inherits the thread, the channel and the stamp. Only the words
  // differ — `askCommentFor` picks them.
  if (rest === 'plan-request' && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // The same door every other comment route holds: the ask names a
    // person for the agent to answer, and the bare category "agent"
    // names nobody.
    if (isCategoryAuthor(author)) return refuseCategoryAuthor();
    const thread = await rooms.postComment(
      docId,
      null,
      author,
      askCommentFor(taskIdOfBodyDoc(docId) !== null, 'plan'),
      { kind: 'subject' },
      { generate: false },
    );
    if (!thread) return j(404, { error: 'doc not found' });
    const stamped = rooms.setPlanRequested(docId, author.name);
    return j(200, {
      docId,
      threadId: thread.id,
      ...(stamped.ok ? { requestedAt: stamped.requestedAt } : {}),
    });
  }
  // Whether this doc's asks have a live lead to land on. The page
  // registers itself by asking; changes arrive on its event stream.
  if (rest === 'lead-presence' && req.method === 'GET') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    return j(200, leadPresence.watch(docId));
  }
  // The Review float's press — the meeting's other one-tap ask: the
  // presser asking this doc's agent to read the notes and transcript
  // and question what is thin. Same shape as plan-request: the ask is
  // a subject thread from the presser, and the stamp names that
  // thread so the float can offer another ask once it is resolved.
  if (rest === 'review-request' && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    if (isCategoryAuthor(author)) return refuseCategoryAuthor();
    const filed = await fileReviewRequest(
      docId,
      author,
      askCommentFor(taskIdOfBodyDoc(docId) !== null, 'review'),
    );
    if (!filed) return j(404, { error: 'doc not found' });
    return j(200, { docId, ...filed });
  }
  // The pointer pill's Research press. NOT a task (it was, and Bryan
  // found a board row where the mock had a section in the notes):
  // an anchored thread on the selected line, from the presser, plus
  // a placeholder section inserted right after that line for the
  // agent to fill. Same channel as the two floats — a comment every
  // watching agent already hears — and the thread names the section
  // so the answer lands where the person will look.
  if (rest === 'research-request' && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    if (isCategoryAuthor(author)) return refuseCategoryAuthor();
    const topicRaw = typeof body?.topic === 'string' ? body.topic.trim() : '';
    if (!topicRaw) return j(400, { error: 'topic required' });
    const topic = clipToWordBoundary(topicRaw, RESEARCH_TOPIC_MAX);
    const anchor = body?.anchor as Anchor | undefined;
    if (!anchor || anchor.kind !== 'text-range') {
      return j(400, { error: 'a text-range anchor is required' });
    }
    const anchorCheck = anchors.validateAnchor(anchor);
    if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
    const thread = await rooms.postComment(docId, null, author, researchAskComment(topic), anchor, {
      generate: false,
    });
    if (!thread) return j(404, { error: 'doc not found' });
    // After the thread, so the section follows the selection — the
    // same insertion an agent's insert_blocks_after_thread makes.
    // Top-level: a selection inside a bullet must not nest a
    // heading inside that bullet; the section goes after the list.
    const placed = rooms.insertBlocksAfterThread(
      docId,
      thread.id,
      researchPlaceholderMarkdown(topic),
      { placement: 'top-level' },
    );
    if (!placed.ok) {
      console.error(`[research-request] placeholder on ${docId}: ${placed.error}`);
    }
    return j(200, {
      docId,
      threadId: thread.id,
      section: researchSectionTitle(topic),
      placeholder: placed.ok,
    });
  }
  // --- The doc's repo home: pin, read, unpin. OWNER ONLY — a home is
  // host paths, which a share visitor must never see. The visitor
  // allowlist in host-guard already refuses unknown doc subroutes;
  // this is the local stop for the collab-host path.
  if (rest === 'home') {
    if (visitor) return j(403, { error: 'not available on a share' });
    if (req.method === 'GET') {
      const status = rooms.docHomeStatus(docId);
      return status ? j(200, { docId, ...status }) : j(404, { error: 'no home pinned' });
    }
    if (req.method === 'PUT') {
      const body = await safeJson(req);
      // Accept `{ home: {...} }` or the three fields at top level.
      const res = rooms.setDocHome(docId, body?.home ?? body);
      if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
      return j(200, { docId, home: res.home, placement: res.placement });
    }
    if (req.method === 'DELETE') {
      const res = rooms.clearDocHome(docId);
      return res.ok ? j(200, { docId, ok: true }) : j(404, { error: 'no home pinned' });
    }
    return j(405, { error: 'method not allowed' });
  }
  if (rest === 'content' && req.method === 'GET') {
    const doc = rooms.getDoc(docId);
    if (!doc) return j(404, { error: 'doc not found' });
    // `reader` marks this caller's copy of the doc as current-as-of-
    // now, which is what lets the stale-write guard below judge their
    // next whole-doc rewrite by order instead of the blunt time
    // window. Sent by get_doc since 0.1.113; older bundles omit it.
    const reader = url.searchParams.get('reader');
    if (reader) rooms.noteAgentRead(docId, reader);
    return j(200, doc);
  }
  // Cheap doc health check — metadata + counts, never the body.
  // Exists because get_doc has returned 320KB for one doc: an agent
  // that only needs "bound? wedged? how big?" must not have to pay
  // for (or overflow on) the content to find out.
  if (rest === 'status' && req.method === 'GET') {
    const status = rooms.getDocStatus(docId);
    if (!status) return j(404, { error: 'doc not found' });
    if (visitor) {
      // Same rule as `sourceUrl` in PRIVATE_META_KEYS: host-machine
      // paths are not workspace content. syncError goes with it —
      // its message can embed the bound path (backup locations,
      // parse errors naming the file).
      const { path: _path, syncError: _syncError, ...visitorSafe } = status;
      return j(200, visitorSafe);
    }
    return j(200, status);
  }
  // Diff-review rendering data: the file's text at the BASE commit
  // (the target text is the doc's own content, streamed over Yjs).
  // Computed on demand from the repo; if the worktree has since been
  // cleaned up, baseText comes back null and the client falls back to
  // the full-file view, which needs nothing beyond the ydoc.
  if (rest === 'diff' && req.method === 'GET') {
    const meta = room.meta;
    if (meta.type !== 'diff') return j(400, { error: 'not a diff doc' });
    const { workspaceRoot, diffBase, diffTarget, relPath } = meta;
    const basePath = meta.diffOldPath ?? relPath;
    let baseText: string | null = null;
    let error: string | undefined;
    if (meta.diffStatus === 'added') {
      baseText = '';
    } else if (workspaceRoot && diffBase && basePath) {
      baseText = showFile(workspaceRoot, diffBase, basePath);
      if (baseText === null) error = 'base content unavailable (repo moved or pruned?)';
    } else {
      error = 'diff metadata incomplete';
    }
    return j(200, {
      baseText,
      status: meta.diffStatus,
      oldPath: meta.diffOldPath,
      base: diffBase,
      target: diffTarget,
      additions: meta.diffAdditions,
      deletions: meta.diffDeletions,
      ...(error ? { error } : {}),
    });
  }
  // Browser-originated reading activity (read_session / doc_open). The
  // markdown/code review surfaces POST interaction-bounded reading
  // sessions here; the server resolves doc/repo/producedBy and stamps
  // actor=person. Unknown types are ignored (400). See activity.ts.
  if (rest === 'activity' && req.method === 'POST') {
    const body = await safeJson(req);
    const type = body?.type as 'read_session' | 'doc_open' | undefined;
    if (type !== 'read_session' && type !== 'doc_open') {
      return j(400, { error: 'type must be read_session or doc_open' });
    }
    const payload = (body?.payload as Record<string, unknown> | undefined) ?? {};
    // Never DEFAULT to Bryan. This endpoint is in a share visitor's
    // scope, so an omitted author used to record their reading
    // activity as his — the one identity on the server that carries
    // any weight. An unattributed read is now unattributed.
    const author = authorFor(body?.author) ?? ANONYMOUS_ACTOR;
    const res = rooms.recordReadEvent(docId, type, payload, author);
    // Fold a successful task read_session onto the task record's
    // cumulative reading time. `recordReadEvent` clamps `payload`
    // in place (see `clampReadPayload`), so `durationMs` here is
    // already the server-trusted value, not whatever the browser
    // sent. Quiet on the task (no event, no `updatedAt`) — see
    // `TaskStore.recordReadingTime`.
    if (res.ok && type === 'read_session') {
      const taskId = taskIdOfBodyDoc(docId);
      const durationMs = payload.durationMs;
      if (taskId && typeof durationMs === 'number' && durationMs > 0) {
        taskStore.recordReadingTime(taskId, Math.round(durationMs / 1000));
      }
    }
    return res.ok ? j(200, { ok: true }) : j(404, res);
  }
  if (rest === 'hooks/fire' && req.method === 'POST') {
    // debug-fires the last thread update again
    const ts = rooms.listThreads(docId);
    if (ts.length === 0) return j(404, { error: 'no threads' });
    const last = ts[ts.length - 1]!;
    if (room.webhookUrl) {
      await webhooks.send(room.webhookUrl, {
        event: 'thread.replied',
        docId,
        threadId: last.id,
        thread: last,
        doc: withReviewUrl(room.meta),
        seq: ++room.seq,
      });
    }
    return j(200, { fired: !!room.webhookUrl });
  }
  return undefined;
}
