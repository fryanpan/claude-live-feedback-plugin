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
  heartbeatFresh?: boolean;
  lead?: boolean;
  queued?: CoverageQueue;
  queuedTotal?: number;
}

/** A board holding docs this session watches, where it has NO attachment. */
export interface CoverageUnattachedBoard {
  workspaceId: string;
  name: string;
  watchedDocs: string[];
  queued: CoverageQueue;
  queuedTotal: number;
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

/** The boards this session watches docs on, is not attached to, and that have
 *  something actually waiting. Unattached-with-nothing-queued is the ordinary
 *  case (every doc bound without a board lands on a default holding pen) and
 *  is deliberately not an alarm. */
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
  const described = waiting
    .map(
      (b) =>
        `"${b.name}" (${b.workspaceId}) — ${plural(b.watchedDocs.length, 'doc')} watched, ` +
        `${b.queuedTotal} waiting (${describeQueue(b.queued)})`,
    )
    .join('; ');
  const first = waiting[0] as CoverageUnattachedBoard;
  return (
    `[not attached] you watch docs on ${plural(waiting.length, 'board')} where you have no ` +
    `attachment, and ${waiting.length === 1 ? 'it has' : 'they have'} work queued for a lead: ` +
    `${described}. Watching a doc is not attaching — every delivery gate asks whether the ` +
    'lead is ATTACHED, so none of that reaches you until you are. ' +
    `set_workspace_lead(workspaceId: "${first.workspaceId}") attaches, subscribes and hands ` +
    'the backlog over in one call.'
  );
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
  coverage?: WatchCoverage | undefined;
}): string | null {
  const lines: string[] = [];
  const n = opts.restored.length;
  if (n > 0 || opts.pruned.length > 0) {
    const dropped = opts.pruned.length > 0 ? `; ${opts.pruned.length} dropped (doc gone)` : '';
    lines.push(
      `[watches restored] ${plural(n, 'watch', 'watches')} re-wired from the server for ` +
        `${opts.agentName} after restart${dropped}: ${opts.restored.join(', ')}`,
    );
  }
  const alert = coverageAlertLine(opts.coverage);
  if (alert) lines.push(alert);
  return lines.length > 0 ? lines.join('\n') : null;
}
