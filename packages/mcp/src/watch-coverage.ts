/**
 * The inside view of a session's own coverage.
 *
 * The measured incident: a peer held six docs under `watch_doc` and believed
 * it was listening. It had never attached to the board those docs live on. A
 * voice note and a re-triage request queued SILENTLY, and every probe the
 * agent could run answered confidently — `list_watched_docs` said six watches,
 * all live. Six watches IS the true answer to the question that probe asks.
 * It is the wrong question.
 *
 * The server now answers the right one on `GET /api/agents/:id/watches`
 * (`coverage`). This module is the half that makes the answer reach somebody:
 * it reads that block without ever inventing one, and turns it into the line
 * a respawned session gets unprompted. Unprompted is the whole point — an
 * agent that does not know the gap exists never runs the probe that would
 * show it.
 *
 * It lives beside mcp.ts rather than inside it for the reason author.ts,
 * frame-dedup.ts and declare-lead.ts do: mcp.ts ends in a top-level
 * `await server.connect(transport)` and exports nothing, so a test can only
 * read its source — and source-reading cannot check what a sentence says.
 */

export interface CoverageQueue {
  queuedVoice: number;
  /** 0 or 1 — the pending re-triage is a single coalesced ask. */
  pendingRetriage: number;
  /** 0 or 1 — likewise. */
  pendingBucketReview: number;
  taskReviews: number;
}

/** One `ws:<id>` key in this session's watch set, as the server resolved it. */
export interface CoverageWorkspaceRow {
  key: string;
  workspaceId: string;
  kind: 'board' | 'grouping';
  name?: string;
  attached?: boolean;
  /** The displayed active/away label. NOT the delivery gate — see `live`. */
  heartbeatFresh?: boolean;
  /** Whether work actually reaches this session here. This is the covered
   *  one; absent on servers older than the release that split the two. */
  live?: boolean;
  lead?: boolean;
  queued?: CoverageQueue;
  queuedTotal?: number;
}

/**
 * A board this session covers on paper but not in fact.
 *
 * Wider than "no attachment record", and the width is the fix: every
 * delivery gate asks `hasLiveAttachment`, so an hour-old record satisfies
 * "attached" while the whole queue routes to nobody. A declared lead that
 * went quiet is exactly that state, and it is the state this feature creates.
 *
 * "Live" here means what the gates mean: the server has OBSERVED this agent
 * recently — a heartbeat or a tool call, whichever is later — and a channel
 * is open to carry the delivery. Deliberately not the displayed active/away
 * label, whose window is far shorter: selecting rows on the label reported
 * boards that were being served perfectly, and sent the reader off to claim
 * a seat it did not need.
 */
export interface CoverageUnattachedBoard {
  workspaceId: string;
  name: string;
  /** Empty when the board is in scope through its OWN `ws:` key — which is
   *  all a declared lead holds. */
  watchedDocs: string[];
  queued: CoverageQueue;
  queuedTotal: number;
  /** A record exists for this session. Not the same as covered. */
  attached: boolean;
  /** …and its heartbeat is inside the heartbeat window. Names which clock
   *  lapsed; it is not what admitted this row, since rows are selected on the
   *  delivery gate. */
  heartbeatFresh: boolean;
  /** Who holds the seat, when anyone does. */
  leadAgentId?: string;
  /** Whether that agent (someone OTHER than this session) is live on it, by
   *  the same predicate that decides whether claiming the seat is refused. */
  leadLive: boolean;
}

export interface WatchCoverage {
  agentId: string;
  workspaces: CoverageWorkspaceRow[];
  unattachedBoards: CoverageUnattachedBoard[];
}

/**
 * Read the `coverage` block off a watches response — or answer `undefined`.
 *
 * `undefined` and "an empty coverage block" are NOT the same answer and must
 * never be collapsed. An older server, the shared-identity refusal, an
 * unreachable box: all of those mean *unknown*, and rendering unknown as an
 * empty block would render it as "nothing is missing" — the reassuring lie
 * this readout exists to stop telling, restated by the thing meant to end it.
 */
export function parseCoverage(res: unknown): WatchCoverage | undefined {
  if (!res || typeof res !== 'object') return undefined;
  const raw = (res as { coverage?: unknown }).coverage;
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<WatchCoverage>;
  if (typeof c.agentId !== 'string') return undefined;
  if (!Array.isArray(c.workspaces) || !Array.isArray(c.unattachedBoards)) return undefined;
  return {
    agentId: c.agentId,
    workspaces: c.workspaces,
    unattachedBoards: c.unattachedBoards,
  };
}

/** The boards this session follows, is not LIVE on, and that have something
 *  actually waiting. Uncovered-with-nothing-queued is the ordinary case
 *  (every doc bound without a board lands on a default holding pen) and is
 *  deliberately not an alarm. */
export function boardsWaitingOnYou(coverage: WatchCoverage | undefined): CoverageUnattachedBoard[] {
  return (coverage?.unattachedBoards ?? []).filter((b) => b.queuedTotal > 0);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describeQueue(q: CoverageQueue): string {
  const parts: string[] = [];
  if (q.queuedVoice > 0) parts.push(plural(q.queuedVoice, 'voice note'));
  if (q.pendingRetriage > 0) parts.push(plural(q.pendingRetriage, 're-triage request'));
  if (q.pendingBucketReview > 0) parts.push(plural(q.pendingBucketReview, 'bucket review'));
  if (q.taskReviews > 0) parts.push(plural(q.taskReviews, 'task review'));
  return parts.join(', ');
}

/**
 * The remedy for ONE board, which depends on who is sitting in its seat.
 *
 * A single blanket sentence was wrong in two directions. On a board a live
 * peer leads, "declare yourself lead" is advice to evict them — the incumbent
 * gets no event it is told to act on, and the declaring agent cannot tell a
 * takeover from claiming an empty seat. (`setLeadAgent` now refuses that case
 * outright, so the advice would not merely be rude, it would not work.) On a
 * board this session already leads and has simply gone quiet, "you have no
 * attachment" is false, and the fix it names is not the fix.
 */
function remedyFor(b: CoverageUnattachedBoard, agentId: string): string {
  if (b.leadLive && b.leadAgentId !== undefined && b.leadAgentId !== agentId) {
    return (
      `${b.leadAgentId} holds the lead seat and is live, so the queue is addressed to them — ` +
      `ask them rather than taking it. attach_agent(workspaceId: "${b.workspaceId}") makes you ` +
      'addressable and subscribed without moving the seat.'
    );
  }
  if (b.attached && !b.heartbeatFresh) {
    return (
      'your attachment is stale — the server has not seen a heartbeat OR a tool call from you ' +
      'on this board inside the observed-work window, so deliveries for it are parking. ' +
      `heartbeat(workspaceId: "${b.workspaceId}") now, and every few minutes while you work it.`
    );
  }
  return (
    `set_workspace_lead(workspaceId: "${b.workspaceId}") attaches, subscribes and hands the ` +
    'backlog over in one call.'
  );
}

/**
 * One line naming every board that is waiting on this session — or `null`.
 *
 * `null` when the server said nothing (unknown, and a guess would be worse
 * than a gap), and `null` when the boards it named are quiet. Both silences
 * are deliberate: a line on every respawn is noise, and noise is precisely
 * what gets filtered out right before the one that mattered.
 */
export function coverageAlertLine(coverage: WatchCoverage | undefined): string | null {
  const waiting = boardsWaitingOnYou(coverage);
  if (waiting.length === 0) return null;
  const agentId = coverage?.agentId ?? '';
  const described = waiting
    .map((b) => {
      const via =
        b.watchedDocs.length > 0
          ? `${plural(b.watchedDocs.length, 'doc')} watched`
          : 'this board watched directly';
      return (
        `"${b.name}" (${b.workspaceId}) — ${via}, ${b.queuedTotal} waiting ` +
        `(${describeQueue(b.queued)}); ${remedyFor(b, agentId)}`
      );
    })
    .join(' ');
  return (
    `[not covered] ${plural(waiting.length, 'board')} you follow ` +
    `${waiting.length === 1 ? 'has' : 'have'} work queued for a lead, and you are not live on ` +
    `${waiting.length === 1 ? 'it' : 'them'}. Watching is not attaching, and an attachment the ` +
    'server has stopped observing is not attached either — every delivery gate asks for recent ' +
    `observed work, a heartbeat or a tool call, plus an open channel. ${described}`
  );
}

/**
 * The boards a respawned session must RE-ATTACH to, not merely re-subscribe.
 *
 * `ensureWatchesRestored` re-wires watch KEYS. Nothing re-issues the
 * attachment, and the attachment sidecar hydrates with the heartbeat from
 * before the restart — so a lead came back subscribed and `away`, and every
 * lead-addressed delivery kept queuing silently. That is the incident again,
 * on the far side of its own fix.
 *
 * Only boards this session already leads or was already attached to. Not
 * every board it can reach: `attachAgent` CLAIMS an empty seat, so attaching
 * on restore to whatever board a watched doc happens to sit on would have a
 * respawn quietly taking seats nobody gave it.
 */
export function boardsToReattach(coverage: WatchCoverage | undefined): string[] {
  return (coverage?.workspaces ?? [])
    .filter((w) => w.kind === 'board' && (w.lead === true || w.attached === true))
    .filter((w) => w.heartbeatFresh !== true)
    .map((w) => w.workspaceId);
}

/**
 * The whole restore-notice body, or `null` for "say nothing".
 *
 * Note it can speak with an EMPTY restore list. That is the incident's exact
 * shape: the session had wired its watches by hand this run, so there was
 * nothing to restore and the notice said nothing at all — while four items
 * sat queued for a seat nobody held.
 */
export function restoreNoticeContent(opts: {
  restored: string[];
  pruned: string[];
  agentName: string;
  /** Boards the restore re-ATTACHED to. A re-wired key puts events back on
   *  the wire; it does nothing about the attachment the delivery gates test,
   *  and the two repairs failing separately is what let a respawned lead read
   *  "watches restored" and still be invisible. */
  reattached?: string[];
  coverage?: WatchCoverage | undefined;
}): string | null {
  const lines: string[] = [];
  const n = opts.restored.length;
  const reattached = opts.reattached ?? [];
  if (n > 0 || opts.pruned.length > 0) {
    const dropped = opts.pruned.length > 0 ? `; ${opts.pruned.length} dropped (doc gone)` : '';
    lines.push(
      `[watches restored] ${plural(n, 'watch', 'watches')} re-wired from the server for ` +
        `${opts.agentName} after restart${dropped}: ${opts.restored.join(', ')}`,
    );
  }
  if (reattached.length > 0) {
    lines.push(
      `[attachments restored] re-attached to ${plural(reattached.length, 'board')} whose ` +
        'attachment came back stale, so lead-addressed work reaches this session again: ' +
        `${reattached.join(', ')}`,
    );
  }
  const alert = coverageAlertLine(opts.coverage);
  if (alert) lines.push(alert);
  return lines.length > 0 ? lines.join('\n') : null;
}
