/**
 * The two renderers that turn a feedback-server event into the one line an
 * agent reads in its context, plus the receipt that follows a voice frame.
 *
 * Lifted out of `mcp.ts` unchanged. That file connects a stdio transport at
 * the bottom, so importing it starts an MCP server — which is why nothing
 * could import these and why the wording of every channel line went untested
 * except through a spawned bundle or a regex over the source. Everything the
 * renderers touch outside their own payload is passed in: the notification
 * sink, the HTTP client, this session's identity, and the clock.
 *
 * `emitChannelMessage` is the entry point. Board families (`task.`, `decision.`,
 * `workspace.`, `agent.`, `voice.`) go to `emitBoardChannelMessage`; everything
 * else keeps the doc-shaped path.
 */
import { decisionAnsweredLine } from './decision-line.ts';
import {
  type HeldRowPayload,
  type StalledRowPayload,
  readyIdleLine,
  reviewAnsweredLine,
  reviewItemHeldLine,
  stalledLine,
} from './nudge-line.ts';
import { isSelfAuthoredEvent } from './self-authored.ts';
import { voiceRequestLine } from './voice-line.ts';

/** One `notifications/claude/channel` frame, as the MCP server sends it. */
export interface ChannelNotification {
  method: 'notifications/claude/channel';
  params: {
    source: string;
    sent_at: string;
    content: string;
    meta: Record<string, unknown>;
  };
}

/** Everything the renderers need from the process around them. */
export interface ChannelDeps {
  /** Where a rendered line goes — `server.notification` in the real process. */
  notify: (n: ChannelNotification) => Promise<void>;
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** This session's agent id, read only to suppress its own events. */
  authorId: string;
  /** Injectable so a test can assert a rendered `sent_at` without a race. */
  now?: () => number;
}

export interface ChannelMessages {
  emitChannelMessage(event: string, rawPayload: unknown): Promise<void>;
  emitBoardChannelMessage(event: string, rawPayload: unknown): Promise<void>;
}

/** Bind the renderers to one process's dependencies. */
export function createChannelMessages(deps: ChannelDeps): ChannelMessages {
  return {
    emitChannelMessage: (event, payload) => emitChannelMessage(deps, event, payload),
    emitBoardChannelMessage: (event, payload) => emitBoardChannelMessage(deps, event, payload),
  };
}

function nowMs(deps: ChannelDeps): number {
  return (deps.now ?? Date.now)();
}

function nowIso(deps: ChannelDeps): string {
  return new Date(nowMs(deps)).toISOString();
}

export interface ChannelPayload {
  docId?: string;
  threadId?: string;
  /** A comment ON a review item: the item's id, stamped by the server at the
   *  top level (also on `thread.anchor` for a `review-item` anchor). */
  reviewItemId?: string;
  thread?: {
    anchor?: {
      kind?: string;
      reviewItemId?: string;
      snippet?: { text?: string };
      original?: { snippet?: { text?: string } };
    };
    status?: string;
    comments?: Array<{ author?: { name?: string }; text?: string; ts?: number }>;
  };
  comment?: { author?: { name?: string }; text?: string; ts?: number };
  /** Who performed a resolve/reopen — the frame's own attribution, present
   *  on servers that stamp it. Comment events carry `comment.author`. */
  actor?: { name?: string };
  // Suggested edits (redline-suggestions phase 2): suggestion.created /
  // suggestion.accepted / suggestion.rejected carry `sid` + `suggestion`
  // instead of `threadId` + `thread`.
  sid?: string;
  suggestion?: { author?: { name?: string }; kind?: string; snippet?: string };
  // doc.sync_error: a disk↔doc sync failure on a bound file. `message` names
  // what happened and how to recover; `backupPath` is where the overwritten
  // external bytes were saved, when a backup applied.
  path?: string;
  backupPath?: string;
  message?: string;
}

/** Board/workspace event families formatted by emitBoardChannelMessage. Thread
 *  and suggestion events on the same workspace stream keep the doc-shaped
 *  path below. */
const BOARD_EVENT_RE = /^(task|decision|workspace|agent|voice)\./;

export interface BoardEventPayload {
  workspaceId?: string;
  /** On `voice.request`: the durable queue row this frame came from. Sending
   *  it back is what takes the row off the queue. Absent from a server older
   *  than the durable queue, in which case the frame is all there is and
   *  there is nothing to acknowledge. */
  queueId?: string;
  taskId?: string;
  taskIds?: string[];
  task?: { title?: string };
  actor?: { id?: string; name?: string };
  goal?: string;
  assignee?: string;
  from?: string;
  to?: string;
  note?: string;
  fromGoal?: string;
  toGoal?: string;
  answer?: string;
  /** `decision.answered` and `workspace.review_answered`: the answered task's
   *  links, which decide whether the line offers a propagation checklist.
   *  See decision-line.ts and nudge-line.ts. */
  links?: unknown[];
  newGoal?: string;
  kind?: string;
  movedToChores?: string[];
  agentId?: string;
  leadAgentId?: string;
  batchId?: string;
  riskTier?: string;
  reason?: string;
  titleFrom?: string;
  titleTo?: string;
  title?: string;
  /** `workspace.ready_idle` only: how much was ready and how long the board
   *  had stood still when the wake fired. See ready-nudge.ts. */
  readyCount?: number;
  idleMs?: number;
  /** `workspace.ready_idle` only: the DENOMINATOR — how many open rows the
   *  pass examined — plus what it withheld and why, and the rows it could not
   *  evaluate at all. All three absent from a server older than the
   *  dependency-state gate, which is why the line renders without them. */
  consideredCount?: number;
  held?: Record<string, number>;
  undetermined?: { count?: number; reasons?: string[] };
  /** `workspace.stalled` only: how many rows have stopped moving, the rows
   *  themselves, and the rows waiting on a person nobody has actually asked.
   *  See stall-nudge.ts and nudge-line.ts. */
  stalledCount?: number;
  rows?: StalledRowPayload[];
  unfiled?: StalledRowPayload[];
  /** `workspace.stalled`: review items the quality gate is holding past the
   *  window. `workspace.review_item_held`: the one item this frame is about.
   *  See nudge-line.ts. */
  heldItems?: HeldRowPayload[];
  reviewItemId?: string;
  headline?: string;
  overdue?: boolean;
  heldMs?: number;
  trigger?: string;
  transcript?: string;
  ack?: string;
  route?: string;
  context?: { surface?: string; docId?: string; taskId?: string; visibleHeading?: string };
}

/**
 * Forward a workspace-board event as a compact channel message. Two §3.7-style
 * suppressions, both deliberate: `agent.heartbeat` never forwards (a
 * clock tick every few minutes is pure context noise), and an event whose
 * actor is THIS agent never forwards (never deliver an author's own events
 * back to them — §3.10 companion rule).
 */
async function emitBoardChannelMessage(
  deps: ChannelDeps,
  event: string,
  rawPayload: unknown,
): Promise<void> {
  const p = (rawPayload ?? {}) as BoardEventPayload;
  if (event === 'agent.heartbeat') return;
  // A per-turn note from another agent's Stop hook. The server keeps it off
  // the workspace stream (server.ts, the broadcast listener); this is the
  // belt to that suspender, so a replayed or older-server frame still does
  // not cost this session a wake turn — and, relayed, its own Stop hook
  // would post a note that wakes the first agent back.
  if (event === 'task.noted') return;
  if (p.actor?.id === deps.authorId) return;

  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  let body: string;
  switch (event) {
    case 'task.created':
      body = `[task.created] "${truncate(p.task?.title ?? p.taskId ?? '', 60)}" → ${p.goal ?? '?'}${
        p.assignee ? ` (assignee ${p.assignee})` : ''
      }`;
      break;
    case 'task.transitioned':
      body = `[task.transitioned] ${p.taskId}: ${p.from} → ${p.to}${by}${
        p.note ? ` — ${truncate(p.note, 80)}` : ''
      }`;
      break;
    case 'task.assigned':
      body = `[task.assigned] ${p.taskId}: ${p.from} → ${p.to}${by}`;
      break;
    case 'task.regrouped':
      body = `[task.regrouped] ${p.taskId}: ${p.fromGoal} → ${p.toGoal}${by}`;
      break;
    // Both rewrite events lead with the OLD name when it moved — the only
    // name a reader who filed the row would recognise.
    case 'task.retitled':
      body = `[task.retitled] "${truncate(p.titleFrom ?? '', 60)}" → "${truncate(p.titleTo ?? '', 60)}"${by}${
        p.reason ? ` — ${truncate(p.reason, 80)}` : ''
      }`;
      break;
    case 'task.body_edited':
      body =
        p.titleFrom && p.titleTo
          ? `[task.body_edited] reshaped "${truncate(p.titleFrom, 60)}" → "${truncate(p.titleTo, 60)}"${by}${
              p.reason ? ` — ${truncate(p.reason, 80)}` : ''
            }`
          : `[task.body_edited] ${p.taskId}${by}${p.reason ? ` — ${truncate(p.reason, 80)}` : ''}`;
      break;
    // Nothing emits this since the risk gate was removed (2026-08-18). Kept
    // so a replayed or historical row still relays as a sentence rather than
    // falling through to the bare-slug default.
    case 'task.gate_refused':
      body = `[task.gate_refused] ${p.taskId}: ${p.riskTier}-tier ${p.reason}${by} — → ${p.to} did NOT happen`;
      break;
    // The propagation clause is conditional on the task having links, so the
    // wording is a decision that has to be assertable — see decision-line.ts.
    case 'decision.answered':
      body = decisionAnsweredLine(p);
      break;
    case 'workspace.lead_changed':
      // Worth forwarding even though it is not a task: it changes WHO the
      // board's lead-addressed asks go to, including when that is you.
      body =
        p.leadAgentId === deps.authorId
          ? `[workspace.lead_changed]${by}: you are now the lead agent — this board's asks are addressed to you`
          : `[workspace.lead_changed]${by}: lead agent is now ${p.leadAgentId ?? '?'}`;
      break;
    case 'workspace.goals_changed': {
      const moved = p.movedToChores?.length ?? 0;
      body = `[workspace.goals_changed] ${p.kind ?? 'edit'}${by}${
        moved > 0 ? ` — ${moved} task(s) moved to Backlog, re-place with set_task_goal` : ''
      }`;
      break;
    }
    // The board waking its lead. Addressed rather than broadcast, and it costs
    // the recipient a turn — so it must name what is waiting rather than fall
    // through to the bare-slug default, which is where both of these landed
    // until now. See nudge-line.ts.
    case 'workspace.ready_idle':
      body = readyIdleLine(p);
      break;
    case 'workspace.review_answered':
      body = reviewAnsweredLine(p);
      break;
    // The third wake, and the one that names work somebody said they were
    // doing. Its own case rather than a shape shared with ready_idle: the
    // reader's next act is to drive a named list of rows, not to take the top
    // of the queue.
    case 'workspace.stalled':
      body = stalledLine(p);
      break;
    // The quality gate holding one of THIS agent's items — addressed to the
    // filer, so it is always about the reader's own filing. Rendered with the
    // ids and the reason because the next act is one revise call.
    case 'workspace.review_item_held':
      body = reviewItemHeldLine(p);
      break;
    case 'agent.attached':
    case 'agent.detached':
      body = `[${event}] ${p.agentId ?? '?'}`;
      break;
    // Three routes, three different things to say — and one of them is "say
    // nothing". An action the fast path already applied must NOT read as work
    // to do; see voice-line.ts.
    case 'voice.request': {
      const line = voiceRequestLine(p);
      if (line === null) return;
      body = line;
      break;
    }
    default:
      body = `[${event}]${p.taskId ? ` task ${p.taskId}` : ''}`;
  }

  await deps.notify({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: nowIso(deps),
      content: body,
      meta: {
        workspace_id: p.workspaceId ?? 'unknown',
        ...(p.taskId ? { task_id: p.taskId } : {}),
        event,
        ...(p.actor?.name ? { author: p.actor.name } : {}),
      },
    },
  });

  // The frame is now in this session's hands, so tell the server it can stop
  // holding the row. Deliberately AFTER the notification and not before: an
  // ack sent first would clear the durable copy on the strength of an intent,
  // which is the same fire-and-forget the queue exists to replace.
  //
  // Never throws and never blocks the frame. A failed ack leaves the row on
  // the queue, so the cost is that the utterance is offered again once the
  // grace window lapses — late and duplicated beats silently dropped, and
  // that asymmetry is the whole reason the receipt is on this side.
  if (event === 'voice.request' && typeof p.queueId === 'string' && p.workspaceId) {
    try {
      await deps.http(
        'POST',
        `/workspaces/${encodeURIComponent(p.workspaceId)}/voice-queue/${encodeURIComponent(p.queueId)}/ack`,
        {},
      );
    } catch {
      // Left on the queue on purpose — see above.
    }
  }
}

async function emitChannelMessage(
  deps: ChannelDeps,
  event: string,
  rawPayload: unknown,
): Promise<void> {
  if (BOARD_EVENT_RE.test(event)) {
    await emitBoardChannelMessage(deps, event, rawPayload);
    return;
  }
  // The doc-shaped companion to the actor check in emitBoardChannelMessage:
  // never deliver an author's own thread event back to them. The fan-out
  // reaches the author's own watch stream by design (it is one subscriber
  // among many), so the suppression belongs at the render point, where it
  // covers the doc channel, every board channel, and the replay buffer with
  // one gate — and where it cannot affect a browser, which must still watch
  // its own comment appear. Fails OPEN on any ambiguity; see self-authored.ts.
  if (isSelfAuthoredEvent(event, rawPayload, deps.authorId)) return;
  const p = (rawPayload ?? {}) as ChannelPayload;
  const docId = p.docId ?? 'unknown';

  // A recorded syncError means somebody's write into the bound file just
  // lost — rendered as a sentence naming the file, what happened, and where
  // the overwritten bytes went, because the bare-slug fallback below would
  // bury exactly the event whose whole point is being noticed.
  if (event === 'doc.sync_error') {
    const where = p.path ?? docId;
    const body = `[sync error] ${where}: ${p.message ?? 'disk↔doc sync failed — call get_doc for details'}`;
    await deps.notify({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: nowIso(deps),
        content: body,
        meta: {
          doc_id: docId,
          event,
          ...(p.path ? { path: p.path } : {}),
          ...(p.backupPath ? { backup_path: p.backupPath } : {}),
        },
      },
    });
    return;
  }

  if (event.startsWith('suggestion.')) {
    const sid = p.sid ?? '';
    const action = event.slice('suggestion.'.length); // created | accepted | rejected
    const author = p.suggestion?.author?.name ?? '';
    const snippet = p.suggestion?.snippet ?? '';
    const kind = p.suggestion?.kind ?? '';
    const header = snippet ? `"${truncate(snippet, 60)}"` : sid;
    const body = `[suggestion ${action}] ${author ? `${author}: ` : ''}${kind} ${header}`.trim();
    await deps.notify({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: nowIso(deps),
        content: body,
        meta: {
          doc_id: docId,
          sid,
          event,
          author,
          anchor_text: snippet,
        },
      },
    });
    return;
  }

  const threadId = p.threadId ?? '';
  const snippet =
    p.thread?.anchor?.snippet?.text ?? p.thread?.anchor?.original?.snippet?.text ?? '';
  // A comment ON one of this agent's review items. The server stamps the id
  // at the top level; an older server sends only the anchor. Named in the
  // readable line, not just the meta, because the line is what the agent
  // reads — and "which item do they mean" is the lookup revise_review_item
  // should not need.
  const reviewItemId =
    p.reviewItemId ??
    (p.thread?.anchor?.kind === 'review-item' ? p.thread.anchor.reviewItemId : undefined);
  // Resolve/reopen are STATUS changes, not speech: the person who clicked is
  // `actor` on the frame, never any comment author. The old comments[0]
  // fallback named the thread's CREATOR as the resolver, and the
  // comments.at(-1) fallback put someone else's words in their mouth — 17
  // resolves in the field, every one misattributed. An older server sends no
  // actor; a blank author is honest there, a guessed one is the bug.
  const statusChange = event === 'thread.resolved' || event === 'thread.reopened';
  const author = statusChange
    ? (p.actor?.name ?? '')
    : (p.comment?.author?.name ?? p.thread?.comments?.[0]?.author?.name ?? '');
  const text = statusChange ? '' : (p.comment?.text ?? p.thread?.comments?.at(-1)?.text ?? '');
  const sentAt = new Date(p.comment?.ts ?? nowMs(deps)).toISOString();

  // Human-readable body — what the agent reads in their context.
  const action = event.startsWith('thread.') ? event.slice('thread.'.length) : event;
  const header = snippet ? `on "${truncate(snippet, 60)}"` : '';
  const onItem = reviewItemId
    ? ` on review item ${reviewItemId}${snippet ? ` "${truncate(snippet, 60)}"` : ''} —`
    : '';
  const body = text
    ? `[${action}]${onItem} ${author ? `${author}: ` : ''}${text}`
    : `[${action}]${onItem}${author ? ` by ${author} —` : ''} thread ${threadId} ${header}`.trim();

  await deps.notify({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: sentAt,
      content: body,
      meta: {
        doc_id: docId,
        thread_id: threadId,
        ...(reviewItemId ? { review_item_id: reviewItemId } : {}),
        event,
        author,
        anchor_text: snippet,
      },
    },
  });
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
