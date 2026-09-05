/**
 * The board half of the dispatch: tasks, goals, review items and the links
 * between them.
 *
 * Creating and rewriting rows, moving them through their statuses, placing
 * them in goal bands, and the whole review-item family — filing a question,
 * answering it, revising it, withdrawing it, asking for more. What holds it
 * together is that every arm addresses a TASK, by `taskId` or by a
 * `reviewItemId` that resolves to one, and every reply is trimmed to ids and
 * status rather than echoing the row the caller just wrote.
 *
 * Four helpers came with the arms because nothing else reads them:
 * `TaskPayload` (the fields the trimmed results pick out of the wire object),
 * `taskCreatedSummary`, `heldResult` — the quality gate's verdict, spelled
 * once for both doors that can be held — and the two lookups that make a
 * bare `reviewItemId` a universal address.
 *
 * Dependencies arrive in an explicit context rather than captured from
 * `mcp.ts`, following `routes/task-routes-context.ts` in the server. The two
 * helpers that call the server take that context as their first argument;
 * they used to close over the entry point's `http` and `AUTHOR`, and that is
 * the only line of moved code the split rewrote.
 *
 * The handler answers `undefined` for a name it does not know. Every arm is
 * the code that stood in the switch, moved with its comments and dedented one
 * level; no tool's arguments, behaviour or reply changed here.
 */
import { parseThreadReviewItemId } from '@feedback/core/review-item-id';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { projectTaskRows } from '../task-projection.ts';

/** What the board tools read out of `mcp.ts`. */
export interface TaskToolContext {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  /** This process's identity, sent on everything it authors. */
  AUTHOR: AgentAuthor;
  /** The "somebody else already holds this" line, or nothing. */
  claimNoticeFor: (taskId: string) => Promise<string | undefined>;
}

/** The task shape the hub routes return — only the fields the trimmed tool
 *  results read; the wire object carries more. */
interface TaskPayload {
  id: string;
  title: string;
  status: string;
  assignee: string;
  goal: string;
  order: number;
  body?: string;
  quote?: string;
  links?: unknown[];
  transitions?: unknown[];
  after?: string[];
  afterEnforce?: string[];
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
}

/** Trimmed create/promote result (§3.10: an edit returns ids + status, not
 *  the object the caller just wrote). */
function taskCreatedSummary(
  task: TaskPayload,
  ignoredLinks?: unknown[],
  shapeGaps?: string[],
  placed?: boolean,
) {
  return {
    taskId: task.id,
    goal: task.goal,
    order: task.order,
    status: task.status,
    assignee: task.assignee,
    // Whether the CALLER named a goal — which is not the same question as
    // `goal === 'chores'`, because an explicit 'chores' is a placement and an
    // omitted goal that landed there is not. Only the create call can still
    // tell them apart, so it is the call that has to say.
    ...(placed !== undefined ? { placed } : {}),
    // Advisory, and only on decisions: which parts of the decision shape the
    // body doesn't visibly have. Returned rather than swallowed for the same
    // reason as ignoredLinks — the call succeeded, and the caller is the only
    // one who can still fix it.
    ...(shapeGaps !== undefined && shapeGaps.length > 0 ? { shapeGaps } : {}),
    // A dropped ref has to survive the trip back to the caller or the
    // partial-accept is just a silent loss with extra steps. The route
    // returns it; a summary that omits it is the same "one layer away"
    // failure as a route that doesn't forward a param.
    ...(ignoredLinks !== undefined && ignoredLinks.length > 0 ? { ignoredLinks } : {}),
  };
}

/**
 * ONE implementation of "record the answer to a question on a ticket",
 * reached by two verbs.
 *
 * `answer_decision` is the older one and keeps its exact signature, because a
 * peer's session resolved its bundle at launch and its prompts, skills and
 * habits all name that verb; `answer_review_item` is the entity's. What must
 * NOT happen is two hand-written copies of the routing rule, because that is
 * how two implementations of one act start disagreeing about what was
 * recorded — the same reason the store's `r-legacy` row delegates into
 * `answerDecision` rather than stamping its own answer.
 *
 * No `reviewItemId` means the OLD door, byte for byte, carrying the legacy
 * `optionId` key. That is not a fallback: on a ticket that is itself a
 * decision, the derived review item and the embedded decision are the same
 * question, and `/answer` is where it is answered.
 */
async function recordReviewAnswer(
  ctx: TaskToolContext,
  args: {
    taskId: string;
    text: string;
    reviewItemId?: string;
    answeredWith?: string;
  },
): Promise<{ task: TaskPayload }> {
  const { http, AUTHOR } = ctx;
  const { taskId, text, reviewItemId, answeredWith } = args;
  if (reviewItemId === undefined) {
    return (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/answer`, {
      text,
      ...(answeredWith !== undefined ? { optionId: answeredWith } : {}),
      author: AUTHOR,
    })) as { task: TaskPayload };
  }
  return (await http(
    'POST',
    `/api/tasks/${encodeURIComponent(taskId)}/review-items/${encodeURIComponent(reviewItemId)}/answer`,
    {
      text,
      ...(answeredWith !== undefined ? { answeredWith } : {}),
      author: AUTHOR,
    },
  )) as { task: TaskPayload };
}

/**
 * WHERE a bare `reviewItemId` lives — the lookup that makes the id a
 * universal address across every review-item tool.
 *
 * Two id families, two paths: a derived `rt-…` id IS its address (the triple
 * decodes locally, no round-trip — the doc route it is then used against
 * still 404s a forged one), and a minted `r-…` id is resolved through
 * `GET /api/review-items/:id`, which also names the workspace whose board
 * the item is judged on. The fixed `r-legacy` id is refused there by name —
 * it is on every legacy-decision ticket at once, so alone it addresses
 * nothing; the ticket's own decision is addressed by `taskId` with no
 * `reviewItemId`, as it always was.
 */
async function resolveReviewItemId(
  ctx: TaskToolContext,
  reviewItemId: string,
): Promise<
  | { kind: 'doc-thread'; docId: string; threadId: string; commentId: string }
  | { kind: 'task-item'; taskId: string; workspaceId?: string }
> {
  const thread = parseThreadReviewItemId(reviewItemId);
  if (thread) return { kind: 'doc-thread', ...thread };
  const res = (await ctx.http('GET', `/api/review-items/${encodeURIComponent(reviewItemId)}`)) as {
    taskId: string;
    workspaceId?: string;
  };
  return {
    kind: 'task-item',
    taskId: res.taskId,
    ...(res.workspaceId !== undefined ? { workspaceId: res.workspaceId } : {}),
  };
}

/**
 * The quality gate's verdict as a tool result carries it: present only when
 * the item was HELD, with the reason and the server's own next-step line.
 * One helper for both doors (add, revise) so they cannot spell it two ways.
 */
function heldResult(res: { held?: boolean; heldReason?: string; message?: string }): {
  held?: true;
  heldReason?: string;
  message?: string;
} {
  if (res.held !== true) return {};
  return {
    held: true,
    ...(res.heldReason !== undefined ? { heldReason: res.heldReason } : {}),
    ...(res.message !== undefined ? { message: res.message } : {}),
  };
}

/** Answers the board tools; `undefined` means "not one of mine". */
export async function handleTaskTool(
  name: string,
  a: Record<string, unknown>,
  ctx: TaskToolContext,
): Promise<CallToolResult | undefined> {
  const { http, ok, err, AUTHOR, claimNoticeFor } = ctx;
  switch (name) {
    case 'create_tasks': {
      const { workspaceId, tasks, sourceDoc } = a as {
        workspaceId: string;
        tasks: unknown[];
        sourceDoc?: { docId: string; mode?: 'plan' | 'discussion' };
      };
      const res = (await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/batch`,
        { tasks, author: AUTHOR, ...(sourceDoc !== undefined ? { sourceDoc } : {}) },
      )) as {
        tasks: TaskPayload[];
        failures: Array<{ index: number; title?: string; error: string; message?: string }>;
        ignoredLinks?: Array<{ taskId: string; ignored: unknown[] }>;
        shapeGaps?: Array<{ taskId: string; gaps: string[] }>;
        reviewAdvice?: Array<{ taskId: string; advice: string }>;
        held?: Array<{
          taskId: string;
          reviewItemId: string;
          heldReason: string;
          message: string;
        }>;
        visibility?: Array<{ taskId: string; note: string }>;
        placement?: { unplaced: string[]; goals: unknown[] };
        sourceDoc?: { docId: string; mode: string; held: boolean };
      };
      const gapsFor = (taskId: string) =>
        res.shapeGaps?.find((g) => g.taskId === taskId)?.gaps ?? undefined;
      // Two advice vocabularies on one response, each about its own half:
      // `shapeGaps` describes a decision-shaped BODY, `reviewAdvice` a
      // review item's payload. Renaming the older one would be a narrowing
      // for callers nobody here can restart, so both are forwarded.
      const adviceFor = (taskId: string) =>
        res.reviewAdvice?.find((r) => r.taskId === taskId)?.advice ?? undefined;
      // The row's ACTUAL visibility, stated plainly per row: a triage row
      // is returned by no dispatch read until transitioned, and a filed
      // review item is on the addressee's Home queue regardless of the
      // row's status. Forwarded verbatim — a success-shaped response for an
      // invisible ask is the defect this field exists to close.
      const visibilityFor = (taskId: string) =>
        res.visibility?.find((v) => v.taskId === taskId)?.note ?? undefined;
      const droppedFor = (taskId: string) =>
        res.ignoredLinks?.find((l) => l.taskId === taskId)?.ignored ?? undefined;
      // The quality gate's hold on a review filed WITH the row: the item
      // is on the ticket and OFF the reader's queue, and the same
      // one-layer-away failure applies — a success-shaped row for a hidden
      // ask, with no id to revise. Same fields as add_review_item's.
      const heldFor = (taskId: string) => {
        const h = res.held?.find((r) => r.taskId === taskId);
        return h === undefined
          ? {}
          : { reviewItemId: h.reviewItemId, ...heldResult({ held: true, ...h }) };
      };
      const unplaced = new Set(res.placement?.unplaced ?? []);
      return ok({
        // Board order, carrying the title so the caller can match rows back
        // to what it sent without holding its own index — the returned
        // order is deliberately NOT the order it sent them in.
        created: res.tasks.map((t) => ({
          title: t.title,
          ...taskCreatedSummary(t, droppedFor(t.id), gapsFor(t.id), !unplaced.has(t.id)),
          ...(adviceFor(t.id) !== undefined ? { reviewAdvice: adviceFor(t.id) } : {}),
          ...heldFor(t.id),
          ...(visibilityFor(t.id) !== undefined ? { visibility: visibilityFor(t.id) } : {}),
        })),
        // Always present, even when empty: a caller that has to check for
        // the KEY before checking the count reads "no failures" as "the
        // field is missing because this build doesn't report them".
        failures: res.failures,
        // Absent when every row was placed. One band list for the whole
        // call — the same answer repeated per row in a hundred-row burst
        // is noise, and the rows that need naming are the unplaced ones.
        ...(res.placement !== undefined ? { placement: res.placement } : {}),
        // What the doc gate did with this batch: held:true means every row
        // is a triage draft until the plan doc is approved on its page.
        ...(res.sourceDoc !== undefined ? { sourceDoc: res.sourceDoc } : {}),
      });
    }
    // COMPAT: `promote_to_task` is what this was called before the product
    // settled on spinning a comment off into work. Same arm, same arguments;
    // see deprecated-aliases.ts.
    case 'promote_to_task':
    case 'spin_off_task': {
      const {
        docId,
        threadId,
        workspaceId,
        title,
        body,
        assignee,
        assigneeKind,
        needs,
        goal,
        dueAt,
        links,
      } = a as {
        docId: string;
        threadId: string;
        workspaceId: string;
        title?: string;
        body?: string;
        assignee?: string;
        assigneeKind?: 'person' | 'agent';
        needs?: 'action' | 'decision';
        goal?: string;
        dueAt?: number;
        links?: unknown[];
      };
      const res = (await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/promote`,
        {
          workspaceId,
          ...(title !== undefined ? { title } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(assigneeKind !== undefined ? { assigneeKind } : {}),
          ...(needs !== undefined ? { needs } : {}),
          ...(goal !== undefined ? { goal } : {}),
          ...(dueAt !== undefined ? { dueAt } : {}),
          ...(links !== undefined ? { links } : {}),
          author: AUTHOR,
        },
      )) as {
        task: TaskPayload;
        ignoredLinks?: unknown[];
        placement?: { placed: boolean; goals?: unknown[] };
      };
      return ok({
        ...taskCreatedSummary(res.task, res.ignoredLinks, undefined, res.placement?.placed),
        ...(res.placement?.goals !== undefined ? { goals: res.placement.goals } : {}),
        title: res.task.title,
        quote: res.task.quote,
      });
    }
    case 'next_tasks': {
      const { workspaceId, assignee, limit, includeBlocked, includeArchived } = a as {
        workspaceId: string;
        assignee?: string;
        limit?: number;
        includeBlocked?: boolean;
        includeArchived?: boolean;
      };
      const qs = new URLSearchParams();
      if (assignee !== undefined) qs.set('assignee', assignee);
      if (limit !== undefined) qs.set('limit', String(limit));
      if (includeBlocked === true) qs.set('includeBlocked', 'true');
      if (includeArchived === true) qs.set('includeArchived', 'true');
      const query = qs.size > 0 ? `?${qs.toString()}` : '';
      const res = (await http(
        'GET',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/next${query}`,
      )) as { tasks: unknown[]; retired?: { since: number; reason?: string; notice: string } };
      // This is the "what should I do next" call, so a retired board has to
      // say so HERE — the queue still ranks (in-flight work is finishable)
      // and would otherwise read exactly like a live board's.
      return ok({
        workspaceId,
        ...(res.retired ? { retired: res.retired } : {}),
        tasks: res.tasks,
      });
    }
    case 'list_tasks': {
      const { workspaceId, goal, status, assignee, needs, fields, includeArchived } = a as {
        workspaceId: string;
        goal?: string;
        status?: string;
        assignee?: string;
        needs?: string;
        fields?: string[];
        includeArchived?: boolean;
      };
      const qs = new URLSearchParams();
      if (goal !== undefined) qs.set('goal', goal);
      if (status !== undefined) qs.set('status', status);
      if (assignee !== undefined) qs.set('assignee', assignee);
      if (needs !== undefined) qs.set('needs', needs);
      if (includeArchived === true) qs.set('includeArchived', 'true');
      const query = qs.size > 0 ? `?${qs.toString()}` : '';
      const res = (await http(
        'GET',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks${query}`,
      )) as { tasks: TaskPayload[] };
      // Trimmed handler-side, NOT at the route — an old bundle keeps
      // calling the REST route forever and must keep reading its shape.
      // Default: no body snapshot, no transition history. With `fields`:
      // exactly the picked keys per row.
      return ok({
        workspaceId,
        tasks: projectTaskRows(res.tasks, fields),
      });
    }
    case 'task_transition': {
      const { taskId, to, note, usage } = a as {
        taskId: string;
        to: string;
        note?: string;
        usage?: { inputTokens: number; outputTokens: number };
      };
      // WHO IS ALREADY ON THIS ROW — read BEFORE the move, because after it
      // the latest claim is this session's own. Only on a pickup: the
      // question is meaningless on a move to done or back to todo, and a
      // second GET on every transition would be a cost with no reader.
      //
      // Best-effort by construction. It is a warning, so a presence read
      // that fails must never take the transition with it — an agent that
      // cannot claim a task because the advisory read 500'd is strictly
      // worse off than one that claims it uninformed.
      const claimNotice = to === 'in-progress' ? await claimNoticeFor(taskId) : undefined;
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/transition`, {
        to,
        author: AUTHOR,
        ...(note !== undefined ? { note } : {}),
        ...(usage !== undefined ? { usage } : {}),
      })) as { task: TaskPayload; blockers: unknown[] };
      return ok({
        taskId,
        status: res.task.status,
        blockers: res.blockers,
        // Additive and advisory. The status code, the refusal semantics and
        // every other field are untouched — an old bundle calling this from
        // a session that cannot restart reads exactly what it always did,
        // which is the compat question CLAUDE.md says to ask at a
        // narrowing: there IS a caller that cannot be restarted, so nothing
        // narrows.
        ...(claimNotice !== undefined ? { warning: claimNotice } : {}),
      });
    }
    case 'assign_task': {
      const { taskId, assignee, assigneeKind } = a as {
        taskId: string;
        assignee: string;
        assigneeKind?: 'person' | 'agent';
      };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/assignee`, {
        assignee,
        ...(assigneeKind !== undefined ? { assigneeKind } : {}),
        author: AUTHOR,
      })) as { task: TaskPayload; changed: boolean; ownerKind?: string };
      // `ownerKind` is what the BOARD now says this owner is — the answer
      // the caller actually wanted, and not the same as "the call didn't
      // error". `unknown` here means the row will draw as "not recorded":
      // say `assigneeKind` and call again.
      return ok({
        taskId,
        assignee: res.task.assignee,
        changed: res.changed,
        ...(res.ownerKind !== undefined ? { ownerKind: res.ownerKind } : {}),
      });
    }
    case 'block_task': {
      const { taskId, blockedBy } = a as { taskId: string; blockedBy: string | string[] };
      const ids = Array.isArray(blockedBy) ? blockedBy : [blockedBy];
      if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '')) {
        return err('blockedBy must be a task id, or an array of them');
      }
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/park`, {
        blockedBy: ids,
        author: AUTHOR,
      })) as { task: TaskPayload; changed: boolean; after: string[] };
      // What the row waits on NOW, read off the store rather than echoed
      // back: naming a blocker the row already had is a no-op, and the
      // caller has to be able to see that nothing moved.
      return ok({
        taskId,
        blockedBy: res.after,
        status: res.task.status,
        changed: res.changed,
      });
    }
    /* REMOVED 2026-09-03: `park_task`, replaced by `block_task` above.
       "Not now" is spelled by naming what the row is waiting for, and triage
       goes back to meaning "nobody has vetted this".

       Removing the tool cannot break a peer: every session launches its own
       MCP child from its own version-keyed bundle, so a session that has not
       restarted still HAS park_task and still calls it. What it calls is
       `POST /api/tasks/:id/park`, which keeps accepting the old payload and
       still parks — that route is the compatibility surface, not this
       switch. (See "Removing an MCP tool cannot break a peer" in
       learnings.md.) An alias arm was tried and is wrong here: the two verbs
       take different payloads and do different things, so they cannot share
       a handler, and a second declared name would offer an agent two verbs
       for one job. */
    case 'archive_task': {
      const { taskId, reason } = a as { taskId: string; reason?: string };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/archive`, {
        ...(reason !== undefined ? { reason } : {}),
        author: AUTHOR,
      })) as { task: TaskPayload; changed: boolean };
      // The STORED stamps back rather than an echo of what was sent:
      // `changed: false` is the honest answer to archiving a row that was
      // already archived, and reading it beats inferring anything from a
      // 200.
      return ok({
        taskId,
        archivedAt: res.task.archivedAt ?? null,
        ...(res.task.archiveReason !== undefined ? { archiveReason: res.task.archiveReason } : {}),
        changed: res.changed,
      });
    }
    case 'unarchive_task': {
      const { taskId } = a as { taskId: string };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/restore`, {
        author: AUTHOR,
      })) as { task: TaskPayload; changed: boolean };
      return ok({
        taskId,
        goal: res.task.goal,
        status: res.task.status,
        changed: res.changed,
      });
    }
    case 'rewrite_task': {
      const { taskId, title, body, reason } = a as {
        taskId: string;
        title?: string;
        body?: string;
        reason?: string;
      };
      if (body === undefined && title === undefined) {
        return err('nothing to rewrite — pass title, body, or both');
      }
      if (body !== undefined) {
        // Body (with or without a title): one attributed act through the
        // /body route — ONE task.body_edited carrying both titles when the
        // same call renamed the row.
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/body`, {
          markdown: body,
          ...(title !== undefined ? { title } : {}),
          ...(reason !== undefined ? { reason } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload };
        // `quote` back, because this call is the one that can have filled
        // it: the caller sees the words it just preserved without a second
        // read.
        return ok({
          taskId,
          title: res.task?.title,
          body: res.task?.body,
          quote: res.task?.quote,
        });
      }
      // Title-only: the /title route, which emits an attributed
      // task.retitled when the name actually moves.
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/title`, {
        title,
        ...(reason !== undefined ? { reason } : {}),
        author: AUTHOR,
      })) as { task: TaskPayload; changed?: boolean };
      return ok({ taskId, title: res.task?.title, changed: res.changed ?? false });
    }
    case 'set_task_goal': {
      const { taskId, goal, position, batchId } = a as {
        taskId: string;
        goal: string;
        position?: number;
        batchId?: string;
      };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/goal`, {
        goal,
        author: AUTHOR,
        ...(position !== undefined ? { position } : {}),
        ...(batchId !== undefined ? { batchId } : {}),
      })) as { task: TaskPayload; changed: boolean };
      return ok({ taskId, goal: res.task.goal, order: res.task.order, changed: res.changed });
    }
    case 'set_goal_list': {
      const { workspaceId, goals, drop } = a as {
        workspaceId: string;
        goals: unknown[];
        drop?: string[];
      };
      const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
        goals,
        ...(drop !== undefined ? { drop } : {}),
        author: AUTHOR,
      })) as {
        changed: boolean;
        created: Array<{ id: string; title: string }>;
        movedToChores: string[];
        strandedDone: string[];
        bucketReview?: {
          requested: boolean;
          queued: boolean;
          taskIds: string[];
          newBands: Array<{ id: string; title: string }>;
          batchId?: string;
        };
      };
      return ok({
        workspaceId,
        changed: res.changed,
        // The ONLY place a caller learns the id of a band it just created —
        // it never chose one. Dropping this here would make the create
        // gesture unusable while every layer under it reported success.
        created: res.created,
        movedToChores: res.movedToChores,
        // Reported so the caller sees the half that used to be silent —
        // done tasks left pointing at an id the list no longer has.
        strandedDone: res.strandedDone,
        // Adding a band asks the LEAD to re-look at the unknown-goal
        // bucket: `taskIds` is that bucket, `requested` says it reached
        // them live, `queued` says it is waiting for their next attach.
        // Nothing was placed — the ask is to look.
        ...(res.bucketReview ? { bucketReview: res.bucketReview } : {}),
      });
    }
    case 'rename_goal': {
      const { workspaceId, goal, title, dueAt } = a as {
        workspaceId: string;
        goal: string;
        title: string;
        dueAt?: number | null;
      };
      const res = (await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
        {
          goal,
          title,
          ...(dueAt !== undefined ? { dueAt } : {}),
          author: AUTHOR,
        },
      )) as { changed: boolean; goal: { id: string; title: string; dueAt?: number } };
      return ok({ workspaceId, goal: res.goal, changed: res.changed });
    }
    case 'reorder_goals': {
      const { workspaceId, order } = a as {
        workspaceId: string;
        order: string[];
      };
      const res = (await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/reorder`,
        { order, author: AUTHOR },
      )) as { changed: boolean; order: string[] };
      return ok({
        workspaceId,
        order: res.order,
        changed: res.changed,
      });
    }
    case 'add_review_item': {
      const { taskId, review } = a as { taskId: string; review: unknown };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/review-items`, {
        review,
        author: AUTHOR,
      })) as {
        item?: { id?: string };
        reviewAdvice?: string;
        held?: boolean;
        heldReason?: string;
        message?: string;
      };
      return ok({
        taskId,
        reviewItemId: res.item?.id,
        // The gaps the server found in the shape. Dropping it here is the
        // "one layer away from where it's consumed" failure: the server
        // computed the advice, and the only party that can still act on it
        // never hears it.
        ...(res.reviewAdvice !== undefined ? { reviewAdvice: res.reviewAdvice } : {}),
        // The quality gate's verdict, when it held the item. Same failure
        // if dropped: the item is on the ticket and off the queue, and the
        // filer would read a bare id as "filed".
        ...heldResult(res),
      });
    }
    case 'answer_review_item': {
      const { taskId, reviewItemId, text, answeredWith } = a as {
        taskId?: string;
        reviewItemId?: string;
        text: string;
        answeredWith?: string;
      };
      let effectiveTaskId = taskId;
      if (effectiveTaskId === undefined) {
        if (reviewItemId === undefined) {
          return err(
            'which item? Pass its reviewItemId (from the queue row or the ticket), or taskId — alone for a ticket that is itself a decision, with reviewItemId for one of the items filed on it',
          );
        }
        const address = await resolveReviewItemId(ctx, reviewItemId);
        // An item raised on a doc thread records its answer where the ask
        // lives — the same door the reader's own tap goes through.
        if (address.kind === 'doc-thread') {
          await http(
            'POST',
            `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
              address.threadId,
            )}/answer`,
            {
              text,
              commentId: address.commentId,
              ...(answeredWith !== undefined ? { optionId: answeredWith } : {}),
              author: AUTHOR,
            },
          );
          return ok({
            reviewItemId,
            docId: address.docId,
            threadId: address.threadId,
            commentId: address.commentId,
            recorded: true,
          });
        }
        effectiveTaskId = address.taskId;
      }
      const res = await recordReviewAnswer(ctx, {
        taskId: effectiveTaskId,
        text,
        ...(reviewItemId !== undefined ? { reviewItemId } : {}),
        ...(answeredWith !== undefined ? { answeredWith } : {}),
      });
      return ok({
        taskId: effectiveTaskId,
        ...(reviewItemId !== undefined ? { reviewItemId } : {}),
        recorded: true,
        links: res.task.links ?? [],
      });
    }
    case 'revise_review_item': {
      const {
        taskId,
        reviewItemId,
        docId,
        threadId,
        commentId,
        headline,
        detail,
        options,
        reply,
        revisedRange,
      } = a as {
        taskId?: string;
        reviewItemId?: string;
        docId?: string;
        threadId?: string;
        commentId?: string;
        headline?: string;
        detail?: string;
        options?: unknown;
        reply?: string;
        revisedRange?: { start: number; end: number };
      };
      // The correction itself is the same words on either surface; only the
      // handle differs, so the patch is built once and posted at whichever
      // address the caller named.
      const patch = {
        ...(headline !== undefined ? { headline } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(revisedRange !== undefined ? { revisedRange } : {}),
        author: AUTHOR,
      };
      // An item raised on a doc thread is a review payload on a COMMENT, so
      // it is addressed (docId, threadId, commentId) — three ids, all or
      // none. Half an address is a caller who meant one surface and mistyped
      // it; picking a surface for them would revise an item nobody named.
      if (docId !== undefined || threadId !== undefined || commentId !== undefined) {
        if (taskId !== undefined || reviewItemId !== undefined) {
          return err(
            'two addresses in one call — pass taskId + reviewItemId for an item on a ticket, or docId + threadId + commentId for one raised on a doc thread, not both',
          );
        }
        if (docId === undefined || threadId === undefined || commentId === undefined) {
          return err(
            'the doc-thread form needs all three of docId + threadId + commentId — commentId is the thread.comments[].id that create_thread / post_reply returned when you raised the item',
          );
        }
        // Dropping it silently would lose the one sentence the caller wrote
        // for a person to read.
        if (reply !== undefined) {
          return err(
            '`reply` is ticket-only — a doc-thread item already lives in its thread, so point at the change there with post_reply',
          );
        }
        const docRes = (await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/revise`,
          { ...patch, commentId },
        )) as { held?: boolean; heldReason?: string; message?: string };
        // The hold, forwarded. This used to be dropped with a comment
        // saying the doc route runs no gate — true when it was written and
        // false since the gate reached this surface, which left a filer
        // reading `revised: true` for an item the queue still omits.
        return ok({ docId, threadId, commentId, revised: true, ...heldResult(docRes) });
      }
      let effectiveTaskId = taskId;
      if (effectiveTaskId === undefined) {
        if (reviewItemId === undefined) {
          return err(
            'which item? A bare reviewItemId (from the queue row or the ticket), taskId (+ reviewItemId for one of the items filed on the ticket), or docId + threadId + commentId for one raised on a doc thread',
          );
        }
        // The universal address: the id alone says where the item lives.
        const address = await resolveReviewItemId(ctx, reviewItemId);
        if (address.kind === 'doc-thread') {
          if (reply !== undefined) {
            return err(
              '`reply` is ticket-only — a doc-thread item already lives in its thread, so point at the change there with post_reply',
            );
          }
          const docRes = (await http(
            'POST',
            `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
              address.threadId,
            )}/revise`,
            { ...patch, commentId: address.commentId },
          )) as { held?: boolean; heldReason?: string; message?: string };
          return ok({
            reviewItemId,
            docId: address.docId,
            threadId: address.threadId,
            commentId: address.commentId,
            revised: true,
            ...heldResult(docRes),
          });
        }
        effectiveTaskId = address.taskId;
      }
      // `reviewItemId` omitted means the TICKET'S OWN decision — the row
      // whose words are the ticket's title, body and options, and which has
      // no item id of its own. The same shape `answer_decision` has always
      // taken for the same row, and the address a hold on it hands back.
      // `reply` is refused there for the doc form's reason inverted: the
      // ticket's decision has no item thread of its own to answer on.
      if (reviewItemId === undefined && reply !== undefined) {
        return err(
          "`reply` needs an item thread to land on, and a ticket's own decision has none — revise without `reply`, then point at the change with post_reply on the task",
        );
      }
      const targetItemId = reviewItemId ?? 'r-legacy';
      const res = (await http(
        'POST',
        `/api/tasks/${encodeURIComponent(effectiveTaskId)}/review-items/${encodeURIComponent(targetItemId)}/revise`,
        { ...patch, ...(reply !== undefined ? { reply } : {}) },
      )) as {
        threadId?: string;
        reviewAdvice?: string;
        held?: boolean;
        heldReason?: string;
        message?: string;
      };
      return ok({
        taskId: effectiveTaskId,
        ...(reviewItemId !== undefined ? { reviewItemId } : { decision: true }),
        revised: true,
        ...(res.threadId !== undefined ? { threadId: res.threadId } : {}),
        ...(reply !== undefined && res.threadId !== undefined ? { replied: true } : {}),
        ...(res.reviewAdvice !== undefined ? { reviewAdvice: res.reviewAdvice } : {}),
        // Re-judged on every revision; still held means still off the queue.
        ...heldResult(res),
      });
    }
    case 'withdraw_review_item': {
      const { reviewItemId, taskId, docId, threadId, commentId, reason, undo } = a as {
        reviewItemId?: string;
        taskId?: string;
        docId?: string;
        threadId?: string;
        commentId?: string;
        reason?: string;
        undo?: boolean;
      };
      const body = { author: AUTHOR, ...(reason !== undefined ? { reason } : {}) };
      const docWithdraw = async (address: {
        docId: string;
        threadId: string;
        commentId: string;
      }) => {
        await http(
          'POST',
          `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
            address.threadId,
          )}/withdraw${undo ? '/undo' : ''}`,
          { ...body, commentId: address.commentId },
        );
        return ok({
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          ...address,
          withdrawn: undo !== true,
        });
      };
      if (reviewItemId !== undefined) {
        if (docId !== undefined || threadId !== undefined || commentId !== undefined) {
          return err(
            'two addresses in one call — pass reviewItemId alone (it carries its own address), or the docId + threadId + commentId triple, not both',
          );
        }
        // A caller who already knows the ticket skips the resolve
        // round-trip; a bare minted id is looked up first.
        const address =
          taskId !== undefined
            ? { kind: 'task-item' as const, taskId }
            : await resolveReviewItemId(ctx, reviewItemId);
        if (address.kind === 'doc-thread') return docWithdraw(address);
        await http(
          'POST',
          `/api/tasks/${encodeURIComponent(address.taskId)}/review-items/${encodeURIComponent(
            reviewItemId,
          )}/withdraw${undo ? '/undo' : ''}`,
          body,
        );
        return ok({ taskId: address.taskId, reviewItemId, withdrawn: undo !== true });
      }
      // The original doc-thread address, byte for byte — the callers that
      // learned it from the thread they raised keep working unchanged.
      if (docId === undefined || threadId === undefined || commentId === undefined) {
        return err(
          'which item? Pass its reviewItemId (from the queue row or the ticket), or the full docId + threadId + commentId triple for one raised on a doc thread',
        );
      }
      return docWithdraw({ docId, threadId, commentId });
    }
    case 'request_more_info': {
      const { taskId, reviewItemId, question } = a as {
        taskId?: string;
        reviewItemId?: string;
        question: string;
      };
      let effectiveTaskId = taskId;
      if (effectiveTaskId === undefined) {
        if (reviewItemId === undefined) {
          return err(
            'which item? Pass its reviewItemId (from the queue row or the ticket), or taskId — alone for a ticket that is itself a decision, with reviewItemId for one of the items filed on it',
          );
        }
        // Resolved through the SERVER even for a decodable rt-… id, unlike
        // the sibling tools: they hand a decoded address to a doc route
        // that itself refuses a comment carrying no review, while this
        // branch posts an ORDINARY reply — so if the item's existence is
        // not checked here, a stale or forged id would land a question on
        // whatever unrelated thread it happens to name (codex review).
        const address = (await http(
          'GET',
          `/api/review-items/${encodeURIComponent(reviewItemId)}`,
        )) as
          | { kind: 'doc-thread'; docId: string; threadId: string }
          | { kind: 'task-item'; taskId: string };
        // A doc-thread item's conversation IS its thread — asking back is a
        // reply there, where the asker is already listening. No answer is
        // stamped, so the item stays open and stays on the queue, exactly
        // as the ticket form's info request does.
        if (address.kind === 'doc-thread') {
          await http(
            'POST',
            `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
              address.threadId,
            )}/comments`,
            { author: AUTHOR, text: question },
          );
          return ok({
            reviewItemId,
            docId: address.docId,
            threadId: address.threadId,
            asked: true,
          });
        }
        effectiveTaskId = address.taskId;
      }
      const path =
        reviewItemId === undefined
          ? `/api/tasks/${encodeURIComponent(effectiveTaskId)}/more-info`
          : `/api/tasks/${encodeURIComponent(effectiveTaskId)}/review-items/${encodeURIComponent(reviewItemId)}/more-info`;
      const res = (await http('POST', path, { question, author: AUTHOR })) as {
        task: TaskPayload;
      };
      return ok({
        taskId: effectiveTaskId,
        ...(reviewItemId !== undefined ? { reviewItemId } : {}),
        asked: true,
        links: res.task.links ?? [],
      });
    }
    case 'answer_decision': {
      const { taskId, text, optionId, reviewItemId } = a as {
        taskId: string;
        text: string;
        optionId?: string;
        reviewItemId?: string;
      };
      // `optionId` is the legacy spelling of `answeredWith`; one helper
      // decides which door to knock on so the two verbs cannot drift into
      // two answers of the same act.
      const res = await recordReviewAnswer(ctx, {
        taskId,
        text,
        ...(reviewItemId !== undefined ? { reviewItemId } : {}),
        ...(optionId !== undefined ? { answeredWith: optionId } : {}),
      });
      return ok({ taskId, recorded: true, links: res.task.links ?? [] });
    }
    case 'set_task_dependencies': {
      const { taskId, after, afterEnforce } = a as {
        taskId: string;
        after: string[];
        afterEnforce?: string[];
      };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/after`, {
        after,
        ...(afterEnforce !== undefined ? { afterEnforce } : {}),
        author: AUTHOR,
      })) as { task: TaskPayload; changed: boolean };
      return ok({
        taskId,
        changed: res.changed,
        after: res.task.after ?? [],
        afterEnforce: res.task.afterEnforce ?? [],
      });
    }
    case 'import_tasks_markdown': {
      const { workspaceId, path, apply } = a as {
        workspaceId: string;
        path: string;
        apply?: boolean;
      };
      // The route result is already the trimmed shape: the mapping on a
      // dry-run; ids + titles + counts (never full task objects) on apply.
      const res = await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/import-tasks`,
        { path, ...(apply !== undefined ? { apply } : {}), author: AUTHOR },
      );
      return ok(res);
    }
    case 'link_refs': {
      const { taskId, ref } = a as { taskId: string; ref: unknown };
      const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/links`, {
        ref,
      })) as { changed: boolean };
      return ok({ taskId, changed: res.changed });
    }
    case 'list_backlinks': {
      const { ref } = a as { ref: unknown };
      const res = (await http('POST', '/api/refs/backlinks', { ref })) as {
        tasks: unknown[];
      };
      return ok({ ref, tasks: res.tasks });
    }
    case 'unlink_refs': {
      const { taskId, ref } = a as { taskId: string; ref: unknown };
      const res = (await http('DELETE', `/api/tasks/${encodeURIComponent(taskId)}/links`, {
        ref,
      })) as { changed: boolean };
      return ok({ taskId, changed: res.changed });
    }
  }
  return undefined;
}
