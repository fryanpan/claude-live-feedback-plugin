/**
 * `GET /api/workspaces/:id/related-work` — what on this board already covers
 * a request, before anybody writes a plan for it.
 *
 * The route's whole job is to assemble candidates out of board state and hand
 * them to the scorer in `@feedback/core/related-work`, which is pure and
 * unit-tested on its own. Nothing is decided here and nothing is written: a
 * caller reads the answer, and a person decides whether the new plan extends
 * what came back, replaces it, or stands on its own.
 *
 * The candidate set is deliberately narrow, because a list nobody can read is
 * the same as no list:
 *
 *   • Every LIVE goal band — not archived, not a reserved band. A goal is
 *     where a plan lands, so a goal that lines up is the most important thing
 *     the caller can be told.
 *
 *   • Docs filed under this board that READ AS A PLAN (title or path), plus
 *     any doc a live goal LINKS regardless of how it reads. The second half
 *     matters more than it looks: the meeting notes a goal came out of are
 *     rarely called a plan, and they are exactly the doc a new plan should
 *     cite rather than duplicate.
 *
 * `?docId=` is the request's own context — the notes or doc the ask came from
 * — and it is the ONLY thing that earns a link bonus. A band that links that
 * doc is marked `linked`, so the goal that owns this conversation surfaces
 * even when its title shares no word with the request. That is the 2026-09-02
 * case literally: the planning pass wrote a goal with no description and no
 * link to the huddle notes, beside work that was already there.
 *
 * The bonus is relative to the request and never absolute, which is a
 * correction a test made. Marking a doc `linked` because SOME goal points at
 * it is a permanent property of the doc, so the huddle notes came back scored
 * 0.35 against "rotate the sending credentials" — a request they have nothing
 * to do with. A relation has to be a relation TO SOMETHING; being linked in
 * general is just being on the board. So a goal's links earn a doc a place in
 * the candidate set, and only a tie to `docId` is paid for.
 *
 * Reading is free — no author, no write — so the route sits behind the same
 * gate as the rest of the board's reads and takes no body.
 */
import { type RelatedWorkCandidate, readsAsPlan, scoreRelatedWork } from '@feedback/core';
import { isReservedGoalId } from '../task-goals.ts';
import { isArchived } from '../tasks.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/**
 * How much of a doc's markdown is scored.
 *
 * A body read is a hydrate-and-evict for every non-resident doc (see
 * `DocStore.readMarkdownBody`), and a plan doc runs to pages. The opening of a
 * plan is where its subject is stated — title, problem statement, the goal it
 * serves — so the first few thousand characters carry nearly all of the
 * signal at a fraction of the tokenizing. A longer read would change the
 * ranking only where a doc mentions the request once, deep in an appendix,
 * which is the case a reader would call a false positive anyway.
 */
const BODY_SCAN_CHARS = 4000;

/** Longest `q` the route reads. A request is a sentence or a paragraph; past
 *  this it is somebody pasting a document, and the extra terms only dilute the
 *  overlap they are matched by. Truncated rather than refused — a caller who
 *  pastes too much should get an answer, not an error. */
const MAX_RELATED_QUERY_LENGTH = 2000;

/** Ceiling on how many of the board's docs are opened for one request. Boards
 *  carry thousands of diff-review members; a matching step that reads them all
 *  would be the slowest call on the server. Plan-shaped docs are few, so this
 *  is a guard against a pathological board, not a normal limit. */
const MAX_DOC_BODIES = 40;

/** Answers the route below, or `undefined` when the path is not it. */
export async function handleWorkspaceRelated(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, docStore, j } = ctx;
  const { req, pathname, url } = rq;
  const match = pathname.match(/^\/api\/workspaces\/([^/]+)\/related-work$/);
  if (!match || req.method !== 'GET') return undefined;

  const workspaceId = decodeURIComponent(match[1] ?? '');
  const workspace = taskStore.getWorkspace(workspaceId);
  if (!workspace) return j(404, { error: 'workspace not found' });

  const rawQuery = url.searchParams.get('q') ?? '';
  const query = rawQuery.slice(0, MAX_RELATED_QUERY_LENGTH).trim();
  if (query.length === 0) {
    return j(400, {
      error: 'q required',
      hint: "Pass ?q=<the request in the words it was asked in>. The match is over the board's goal titles, goal prose and plan docs; scoring does not depend on how long the request is, so paste the whole ask rather than boiling it down to a keyword.",
    });
  }
  // The doc the request came out of, when the caller has one. Used only to
  // mark link relations; an id naming nothing simply matches nothing.
  const fromDocId = url.searchParams.get('docId') ?? undefined;
  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 20) : undefined;

  const goals = taskStore.listGoalRows(workspaceId).filter((g) => !isArchived(g));
  const candidates: RelatedWorkCandidate[] = [];

  // Which docs each live goal points at. `links` is row-owned and survives
  // every goal-list edit, so it is the durable half of "these two things
  // belong together". Read once, used twice: to qualify docs as candidates,
  // and to find the bands tied to the request's own context.
  const docsOfGoal = new Map<string, Set<string>>();
  // docId → the title of a goal that points at it, for a candidate's reason.
  const anyGoalLinking = new Map<string, string>();
  for (const goal of goals) {
    const docs = new Set<string>();
    for (const ref of goal.links ?? []) {
      // Both kinds carry a docId: a `thread` ref names a comment inside a doc,
      // and for relatedness it is the doc that matters.
      if (ref.kind !== 'doc' && ref.kind !== 'thread') continue;
      docs.add(ref.docId);
      if (!anyGoalLinking.has(ref.docId)) anyGoalLinking.set(ref.docId, goal.title);
    }
    docsOfGoal.set(goal.id, docs);
  }

  // The bands tied to the doc this request came out of. Empty when the caller
  // named no context, and then no link bonus is paid to anything — a plain
  // text match is the whole answer, which is the correct answer to a request
  // that arrived with no context to relate to.
  const contextGoals = goals.filter(
    (g) => fromDocId !== undefined && docsOfGoal.get(g.id)?.has(fromDocId) === true,
  );
  const contextGoalIds = new Set(contextGoals.map((g) => g.id));

  for (const goal of goals) {
    // The Chores band is a holding pen the board mints for itself; a plan
    // never lands there, so offering it as an option would be noise.
    if (isReservedGoalId(goal.id)) continue;
    const linked = contextGoalIds.has(goal.id);
    candidates.push({
      kind: 'goal',
      id: goal.id,
      title: goal.title,
      ...(goal.body !== undefined ? { body: goal.body.slice(0, BODY_SCAN_CHARS) } : {}),
      ...(linked
        ? { linked: true, linkNote: 'this goal already links the doc the request came from' }
        : {}),
      url: `/workspaces/${workspaceId}?goal=${goal.id}`,
    });
  }

  let bodiesRead = 0;
  for (const docId of workspace.docIds) {
    if (docId === fromDocId) continue; // The request's own doc is not a match for itself.
    const meta = docStore.peekMeta(docId);
    if (!meta || meta.type !== 'markdown') continue;
    const path = meta.relPath ?? meta.sourceUrl;
    const title = meta.title ?? meta.alias ?? docId;
    const linkedFrom = anyGoalLinking.get(docId);
    // Either shape earns a PLACE in the candidate set: it reads as a plan, or
    // a goal already pointed at it. Everything else on the board stays out.
    if (!readsAsPlan({ title, path }) && linkedFrom === undefined) continue;
    // A place is not a bonus. Only a doc filed under a band that links the
    // request's own doc counts as related TO THIS REQUEST — a sibling of the
    // notes the ask came from.
    const sibling = contextGoals.find((g) => docsOfGoal.get(g.id)?.has(docId) === true);
    let body: string | undefined;
    if (bodiesRead < MAX_DOC_BODIES) {
      bodiesRead++;
      body = docStore.readMarkdownBody(docId)?.slice(0, BODY_SCAN_CHARS) ?? undefined;
    }
    candidates.push({
      kind: 'doc',
      id: docId,
      title,
      ...(path !== undefined ? { path } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(sibling !== undefined
        ? {
            linked: true,
            linkNote: `filed under "${sibling.title}" alongside the doc the request came from`,
          }
        : {}),
      url: `/review/${docId}`,
    });
  }

  const matches = scoreRelatedWork(query, candidates, limit !== undefined ? { limit } : {});
  return j(200, {
    workspaceId,
    query,
    ...(fromDocId !== undefined ? { docId: fromDocId } : {}),
    /** How many rows were considered — so an empty answer reads as "nothing
     *  lines up" rather than "the board was empty". */
    considered: candidates.length,
    matches,
  });
}
