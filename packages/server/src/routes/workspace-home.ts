import { parseThreadReviewItemId } from '@feedback/core';
/**
 * The Home queue: where a review item lives, what is waiting on a person, and the instructions above it.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { LEGACY_REVIEW_ITEM_ID } from '../tasks.ts';
import { wantsJson } from '../workspace-path.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceHome(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    docStore,
    homeBriefs,
    j,
    safeJson,
    homePayload,
    reviewItemsFor,
    resolveWorkspaceForDoc,
  } = ctx;
  const { req, pathname, url, visitor, authorFor } = rq;
  /**
   * WHOSE marker this request may move or read.
   *
   * Everything in the Home payload is per person — the caught-up marker, the
   * brief written against it — and until this line the person came from the
   * request itself: `?user=` on the GET, `author.name` on the POST. On a
   * board with more than one member that is one person naming another and
   * being served their queue, or moving their marker, which the member
   * boundary otherwise forbids everywhere else.
   *
   * `authorFor` is the server's own verdict and already ranks the proofs: a
   * Cloudflare Access email or a session outranks whatever the body claims,
   * and a share visitor with nothing proven is their own stable guest. So a
   * VERIFIED caller is whoever was verified, full stop.
   *
   * It answers undefined for the caller every other route lets speak for
   * itself — an agent or the owner over loopback, with no session at all —
   * and those fall back to the name the request supplies, exactly as before.
   * That is the same boundary `authorFor` draws for attribution on every
   * write, rather than a second rule about markers.
   *
   * The key is still the display NAME, not the identity id, because that is
   * what the stored markers hold; two verified people whose display names
   * collide share a marker, which is a pre-existing property of the store and
   * not something this line makes worse.
   */
  const verifiedPerson = (claimed: unknown): string => authorFor(claimed)?.name?.trim() ?? '';
  // The human's queue, to the board's agent-side `next` below: every
  // open thread across this workspace's tasks and docs that is ASKING
  // a person something — an unanswered agent comment with a direct
  // question in it, OR a declared item nobody has answered, which
  // stays whatever else is said in the thread. A status note is not a
  // row (Bryan, 2026-08-21 — see `ReviewBand` in review-queue.ts).
  // Decisions are NOT here — the board already holds every task, so
  // shipping them again would put the priority rule in two places;
  // the client merges the two halves and orders them (see
  // `reviewQueue` in board-review-model).
  //
  // One request rather than one per doc: a board with forty tasks is a
  // board with forty rooms, and the strip has to be right at first
  // paint or it is not a "what do I look at next" surface.
  // WHERE a review item lives, from its bare id — the lookup that makes
  // `reviewItemId` a universal address. Two id families, two answers
  // from one route: a derived `rt-…` id decodes to the doc-thread
  // triple it encodes (verified to still exist before it is answered —
  // a decodable id is a claim, not a fact), and a minted `r-…` id is
  // found on whichever ticket holds it. The fixed r-legacy id is on
  // every legacy-decision ticket at once, so alone it addresses
  // nothing and is refused by name.
  const reviewItemResolveMatch = pathname.match(/^\/api\/review-items\/([^/]+)$/);
  if (reviewItemResolveMatch && req.method === 'GET') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const reviewItemId = decodeURIComponent(reviewItemResolveMatch[1] ?? '');
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) {
      return j(400, {
        error: 'ambiguous',
        message:
          "every legacy-decision ticket derives this same id — address the ticket's own decision with its taskId and no reviewItemId",
      });
    }
    const threadAddress = parseThreadReviewItemId(reviewItemId);
    if (threadAddress) {
      const { docId, threadId, commentId } = threadAddress;
      const comment = docStore.getThread(docId, threadId)?.comments.find((c) => c.id === commentId);
      if (!comment?.review) return j(404, { error: 'unknown-review-item' });
      const workspaceId = resolveWorkspaceForDoc(docId);
      return j(200, {
        reviewItemId,
        kind: 'doc-thread',
        docId,
        threadId,
        commentId,
        // `resolveWorkspaceForDoc` answers `null`, never `undefined`, so
        // the test has to be against `null` — otherwise a doc no board
        // holds ships `workspaceId: null` and `set_review_item_criteria`
        // reads the key as present and PUTs `/workspaces/null/...`.
        ...(workspaceId !== null ? { workspaceId } : {}),
      });
    }
    const found = taskStore.findReviewItem(reviewItemId);
    if (!found) return j(404, { error: 'unknown-review-item' });
    return j(200, {
      reviewItemId,
      kind: 'task-item',
      taskId: found.taskId,
      workspaceId: found.workspaceId,
    });
  }
  const wsReviewMatch = pathname.match(/^\/workspaces\/([^/]+)\/review-items$/);
  if (wsReviewMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(wsReviewMatch[1] ?? '');
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    return j(200, { workspaceId, items: reviewItemsFor(workspace) });
  }
  // ── Home pane (§ approved home-pane design) ──────────────────────
  // GET: the brief + marker + instructions for ONE person. `user` is
  // required because everything in the payload is per person — an
  // anonymous read would silently share one marker between everyone.
  const wsHomeMatch = pathname.match(/^\/workspaces\/([^/]+)\/home$/);
  // `?format=json`, for the reason `GET /workspaces/<id>` carries the same
  // gate: `home` is one of the board's four page tabs.
  if (wsHomeMatch && req.method === 'GET' && wantsJson(url)) {
    const workspaceId = decodeURIComponent(wsHomeMatch[1] ?? '');
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    const person = verifiedPerson(undefined) || (url.searchParams.get('user') ?? '').trim();
    if (person === '') {
      return j(400, { error: 'user is required — the read marker and brief are per person' });
    }
    return j(200, homePayload(workspace, person, Date.now()));
  }
  // "Mark caught up": move the reader's marker. `at` supports undo —
  // the response names what it replaced, and posting that value back
  // restores it (0 = never read). A removal must be reversible.
  const wsHomeReadMatch = pathname.match(/^\/workspaces\/([^/]+)\/home\/read$/);
  if (wsHomeReadMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsHomeReadMatch[1] ?? '');
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    const body = await safeJson(req);
    const person =
      verifiedPerson(body?.author) ||
      String((body?.author as { name?: unknown } | undefined)?.name ?? '').trim();
    if (person === '') return j(400, { error: 'author.name is required' });
    const at =
      typeof body?.at === 'number' && Number.isFinite(body.at) && body.at >= 0
        ? body.at
        : Date.now();
    return j(200, { ok: true, ...homeBriefs.markRead(workspaceId, person, at) });
  }
  // "Save & Update Summary": the instructions persist workspace-wide
  // and apply to this summary and future summaries. Every cached brief
  // is dropped (they were written under the old instructions), and the
  // response is the full home payload so the caller repaints — with
  // `generating` true when a summarizer is wired, because the drop
  // makes every brief stale by construction.
  const wsHomeInstrMatch = pathname.match(/^\/workspaces\/([^/]+)\/home\/instructions$/);
  if (wsHomeInstrMatch && req.method === 'PUT') {
    const workspaceId = decodeURIComponent(wsHomeInstrMatch[1] ?? '');
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    const body = await safeJson(req);
    // The instructions are the BOARD's, not this person's — `person` only
    // decides whose payload comes back — but it is read from the same place
    // for the same reason.
    const person =
      verifiedPerson(body?.author) ||
      String((body?.author as { name?: unknown } | undefined)?.name ?? '').trim();
    if (person === '') return j(400, { error: 'author.name is required' });
    const instructions = typeof body?.instructions === 'string' ? body.instructions : '';
    if (instructions.trim() === '') {
      return j(400, { error: 'instructions are required — to reset, save the default text' });
    }
    homeBriefs.setInstructions(workspaceId, instructions);
    return j(200, homePayload(workspace, person, Date.now()));
  }
  return undefined;
}
