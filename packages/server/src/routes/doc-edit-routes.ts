/**
 * The `/api/docs/:id/...` resource block's content-edit family: whole-doc
 * rewrite, disk reparse, agent anchors (and their edit/insert/delete
 * subroutes), find_and_replace, suggestions (list/resolve-all/accept/
 * reject), and the three structural deletes. Split out of
 * `routes/docs.ts`'s `handleDocResourceRoutes`; see that file's header for
 * why call order across the three families is not load-bearing.
 *
 * The ticket named the exact-string routes only; the `agent_anchors/:id/...`
 * and `suggestions/:id/(accept|reject)` prefix matches are each a
 * continuation of the route directly above it (creating an anchor vs.
 * editing/deleting one; listing suggestions vs. resolving one), so they
 * moved here with their family rather than staying unassigned.
 */
import { taskIdOfBodyDoc } from '../task-projection.ts';
import {
  type DocResourceRouteRequest,
  type DocRoutesContext,
  PLACEMENT_INVALID,
  parsePlacement,
  parseSuggestionAuthor,
  withSyncError,
} from './docs.ts';

/**
 * The content-edit routes: `content` POST, `reparse_from_disk`,
 * `agent_anchors` (+ `agent_anchors/:id/...`), `find_and_replace`,
 * `suggestions` (+ `suggestions/resolve_all` and `suggestions/:id/...`),
 * `delete_block_at_anchor`, `delete_blocks_in_range`, `delete_section`.
 * `undefined` means none of them matched.
 */
export async function handleDocEditRoutes(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const { rooms, taskStore, j, safeJson, rewriteTaskBody } = ctx;
  const { req, docId, rest, visitor, authorFor } = rq;
  // Whole-doc rewrite through the live doc — the safe replacement for
  // Write-the-bound-file + reparse_from_disk, which raced the
  // write-back and clobbered (see docs/research/2026-08-03 review).
  if (rest === 'content' && req.method === 'POST') {
    const body = await safeJson(req);
    const markdown = String(body?.markdown ?? '');
    if (markdown.length === 0) return j(400, { error: 'markdown is required' });
    // Stale-write guard (2026-08-26 incident): a whole-doc rewrite
    // built from a copy that predates a human's live edits destroys
    // those edits with a 200. The DEFAULT path is the protected one —
    // an old bundle that omits every new field still gets refused
    // when a human edited recently; only the explicit confirm field
    // opens the gate, and even then the backup below has already run.
    if (body?.confirmOverwriteHumanEdits !== true) {
      const reader = authorFor(body?.author)?.id;
      const stale = rooms.staleWriteCheck(docId, reader);
      if (stale) {
        return j(409, {
          error: 'stale-write',
          humanEditedAt: stale.humanEditedAt,
          ...(stale.lastReadAt !== undefined ? { lastReadAt: stale.lastReadAt } : {}),
          message:
            `REFUSED: a human edited this doc at ${new Date(stale.humanEditedAt).toISOString()}` +
            (stale.lastReadAt !== undefined
              ? `, AFTER your last read at ${new Date(stale.lastReadAt).toISOString()}`
              : ', within the last 10 minutes') +
            ' — a full rewrite from your in-context copy would destroy their work.' +
            ' Re-read the doc with get_doc, re-apply your change onto the CURRENT' +
            ' content (prefer a scoped tool: find_and_replace, rewrite_thread_region,' +
            ' edit_at_anchor), and only if a whole-doc rewrite is truly needed retry' +
            ' set_doc_content with confirmOverwriteHumanEdits: true.',
        });
      }
    }
    // A `task:<id>` doc is a task's DESCRIPTION, not a free-standing
    // document, and rewriting one is an act the board has a name for.
    // Reachable here by anyone who knows the docId convention, so this
    // route runs the same ceremony `/api/tasks/:id/body` does rather
    // than writing the room and walking away. It is not refused: that
    // would take away the only body-rewrite a bundle older than
    // `update_task_body` (0.1.24) has, to buy a guarantee this branch
    // can simply provide.
    const bodyTaskId = taskIdOfBodyDoc(docId);
    const bodyTask = bodyTaskId ? taskStore.getTask(bodyTaskId) : undefined;
    if (bodyTask) {
      const author = authorFor(body?.author);
      const res = rewriteTaskBody(bodyTask, markdown, {
        ...(author ? { actor: author } : {}),
      });
      return res.ok ? j(200, { ok: true }) : j(409, res);
    }
    const res = rooms.setDocContent(docId, markdown);
    return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
  }
  if (rest === 'reparse_from_disk' && req.method === 'POST') {
    const res = rooms.reparseFromDisk(docId);
    return res.ok ? j(200, res) : j(409, res);
  }
  if (rest === 'agent_anchors' && req.method === 'POST') {
    const body = await safeJson(req);
    const find = String(body?.find ?? '');
    if (find.length === 0) return j(400, { error: 'find is required' });
    const res = rooms.createAgentAnchor(docId, {
      find,
      contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
      contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
      occurrence: typeof body?.occurrence === 'number' ? body.occurrence : undefined,
      label: body?.label ? String(body.label) : undefined,
    });
    return res.ok ? j(200, res) : j(409, res);
  }
  const anchorMatch = rest.match(/^agent_anchors\/([^/]+)(\/.*)?$/);
  if (anchorMatch) {
    const anchorId = decodeURIComponent(anchorMatch[1] ?? '');
    const anchorRest = anchorMatch[2] ?? '';
    if (anchorRest === '/edit' && req.method === 'POST') {
      const body = await safeJson(req);
      const kind = body?.kind as 'replace' | 'insert_after' | undefined;
      const text = String(body?.text ?? '');
      if (kind !== 'replace' && kind !== 'insert_after') {
        return j(400, { error: 'kind must be replace or insert_after' });
      }
      const res = rooms.editAtAgentAnchor(docId, anchorId, { kind, text });
      return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
    }
    if (anchorRest === '/insert_blocks' && req.method === 'POST') {
      const body = await safeJson(req);
      const markdown = String(body?.markdown ?? '');
      if (markdown.length === 0) return j(400, { error: 'markdown is required' });
      const placement = parsePlacement(body?.placement);
      if (placement === PLACEMENT_INVALID) {
        return j(400, { error: "placement must be 'after-block' or 'top-level'" });
      }
      const res = rooms.insertBlocksAtAnchor(docId, anchorId, markdown, { placement });
      return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
    }
    if (anchorRest === '' && req.method === 'DELETE') {
      const removed = rooms.deleteAgentAnchor(docId, anchorId);
      return removed ? j(200, { ok: true }) : j(404, { error: 'anchor not found' });
    }
  }
  if (rest === 'find_and_replace' && req.method === 'POST') {
    const body = await safeJson(req);
    const find = String(body?.find ?? '');
    const replace = String(body?.replace ?? '');
    if (find.length === 0) return j(400, { error: 'find is required' });
    const contextBefore = body?.contextBefore ? String(body.contextBefore) : undefined;
    const contextAfter = body?.contextAfter ? String(body.contextAfter) : undefined;
    const occurrence = typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined;
    const replaceAll = body?.replaceAll === true;
    if (body?.suggest === true) {
      if (replaceAll) {
        // Bulk suggestions are out of scope: the suggestion model is
        // one proposal per span, each individually acceptable.
        return j(400, {
          error: 'replaceAll cannot be combined with suggest — propose spans one at a time',
        });
      }
      const author = parseSuggestionAuthor(visitor ? { author: authorFor(body?.author) } : body);
      if (!author) return j(400, { error: 'author required when suggest is true' });
      const res = rooms.createSuggestion(docId, {
        find,
        replace,
        contextBefore,
        contextAfter,
        occurrence,
        parseInlineMarks: body?.parseInlineMarks === true,
        author,
      });
      return res.ok ? j(200, res) : j(409, res);
    }
    const res = rooms.findAndReplace(docId, {
      find,
      replace,
      contextBefore,
      contextAfter,
      occurrence,
      replaceAll,
      parseInlineMarks: body?.parseInlineMarks === true,
    });
    // Piggy-back any pending sync trouble on the response: agents act
    // on edit results, not on get_doc, so this is where a conflict
    // actually gets seen.
    return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
  }
  // Suggested edits (redline-suggestions phase 2, commit 3): list/
  // accept/reject/resolve-all over the doc's pending proposals. See
  // `suggest: true` on find_and_replace / rewrite_region above for
  // creation.
  if (rest === 'suggestions' && req.method === 'GET') {
    return j(200, { suggestions: rooms.listSuggestions(docId) });
  }
  if (rest === 'suggestions/resolve_all' && req.method === 'POST') {
    const body = await safeJson(req);
    const action = body?.action as 'accept' | 'reject' | undefined;
    if (action !== 'accept' && action !== 'reject') {
      return j(400, { error: 'action must be accept or reject' });
    }
    const authorId = body?.authorId ? String(body.authorId) : undefined;
    const res = rooms.resolveAllSuggestions(docId, { action, authorId });
    return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
  }
  const suggestionMatch = rest.match(/^suggestions\/([^/]+)\/(accept|reject)$/);
  if (suggestionMatch && req.method === 'POST') {
    const sid = decodeURIComponent(suggestionMatch[1] ?? '');
    const action = suggestionMatch[2];
    const res =
      action === 'accept' ? rooms.acceptSuggestion(docId, sid) : rooms.rejectSuggestion(docId, sid);
    return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
  }
  if (rest === 'delete_block_at_anchor' && req.method === 'POST') {
    const body = await safeJson(req);
    const threadId = body?.threadId ? String(body.threadId) : undefined;
    const anchorId = body?.anchorId ? String(body.anchorId) : undefined;
    if ((threadId && anchorId) || (!threadId && !anchorId)) {
      return j(400, { error: 'exactly one of threadId or anchorId required' });
    }
    const res = threadId
      ? rooms.deleteBlockAtThread(docId, threadId)
      : rooms.deleteBlockAtAgentAnchor(docId, anchorId!);
    return res.ok ? j(200, res) : j(409, res);
  }
  if (rest === 'delete_blocks_in_range' && req.method === 'POST') {
    const body = await safeJson(req);
    const startFind = String(body?.startFind ?? '');
    const endFind = String(body?.endFind ?? '');
    if (startFind.length === 0 || endFind.length === 0) {
      return j(400, { error: 'startFind and endFind are required' });
    }
    const res = rooms.deleteBlocksInRange(docId, {
      startFind,
      endFind,
      contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
      contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
      startOccurrence:
        typeof body?.startOccurrence === 'number' ? Number(body.startOccurrence) : undefined,
      endOccurrence:
        typeof body?.endOccurrence === 'number' ? Number(body.endOccurrence) : undefined,
    });
    return res.ok ? j(200, res) : j(409, res);
  }
  if (rest === 'delete_section' && req.method === 'POST') {
    const body = await safeJson(req);
    const heading = String(body?.heading ?? '');
    if (heading.length === 0) return j(400, { error: 'heading is required' });
    const res = rooms.deleteSection(docId, {
      heading,
      level: typeof body?.level === 'number' ? Number(body.level) : undefined,
      occurrence: typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
    });
    return res.ok ? j(200, res) : j(409, res);
  }
  return undefined;
}
