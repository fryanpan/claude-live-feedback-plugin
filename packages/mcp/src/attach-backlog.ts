/**
 * Deliver the backlog half of an attach response whose body no tool call
 * reads.
 *
 * Three attach sites hand `queuedComments` (and `queuedVoice`) straight back
 * to the session as a tool result — `attach_agent`, `set_workspace_lead`,
 * and the heartbeat's SSE frames. The FOURTH site is `ensureWatchesRestored`,
 * the re-attach a respawned session runs on its own, and it is the one that
 * fires precisely in the failure mode this queue exists for (stream down,
 * process restarted). Its POST has no tool response to ride: before this
 * module the server drained the backlog into a body nobody read — voice rows
 * destructively (gone), comment rows marked emitted (suppressed for a full
 * grace window while the agent that just came back heard nothing).
 *
 * So the respawn delivery goes out as CHANNEL notifications — the same
 * rendering an SSE frame would have gotten — and each comment row is acked
 * only AFTER its emit succeeded, the same order `handleFrame` keeps and for
 * the same reason: an ack sent first clears the durable copy on the strength
 * of an intent.
 *
 * Lives outside mcp.ts because that file is a bundle entry point and exports
 * nothing, so ordering (emit before ack) and skip rules would otherwise be
 * untestable. Fixtures in the test are synthetic; the repo is public.
 */

/** A `queuedComments` row as the attach response carries it. Everything is
 *  `unknown`-tolerant: this renders whatever arrives on the wire, including
 *  from a server newer than this bundle. */
export interface BacklogCommentRow {
  id?: unknown;
  docId?: unknown;
  threadId?: unknown;
  event?: unknown;
  author?: { id?: string; name?: string };
  text?: unknown;
  ts?: unknown;
  /** The original broadcast payload, replayed verbatim when present so the
   *  late delivery reads exactly like the live one would have. */
  payload?: unknown;
}

/** A `queuedVoice` row. The server DRAINS these on attach — this response is
 *  the only copy, so delivery here is best-effort-or-lost. */
export interface BacklogVoiceRow {
  transcript?: unknown;
  ts?: unknown;
  applied?: unknown;
  context?: unknown;
  actor?: unknown;
}

export interface AttachBacklogDeps {
  /** Forward one event to the session (dedup + channel notification — the
   *  caller owns both). A throw means the session did NOT get it. */
  emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
  /** POST the receipt for one comment row. A throw leaves the row queued —
   *  redelivered after the grace window, which is the safe direction. */
  ackComment: (rowId: string) => Promise<void>;
}

/**
 * Returns how many rows of each kind actually reached the session. A comment
 * row is acked only when its emit did not throw; a row that cannot be
 * rendered at all (no id or no event anywhere) is left un-acked on purpose —
 * the grace-window redelivery over SSE is its remaining path.
 */
export async function deliverAttachBacklog(
  workspaceId: string,
  backlog: { queuedComments?: BacklogCommentRow[]; queuedVoice?: BacklogVoiceRow[] },
  deps: AttachBacklogDeps,
): Promise<{ comments: number; voice: number }> {
  let comments = 0;
  for (const row of backlog.queuedComments ?? []) {
    if (typeof row?.id !== 'string') continue;
    const original =
      row.payload && typeof row.payload === 'object'
        ? (row.payload as Record<string, unknown>)
        : undefined;
    const event =
      typeof original?.event === 'string'
        ? original.event
        : typeof row.event === 'string'
          ? row.event
          : undefined;
    if (event === undefined) continue;
    // Replay the original frame when the row carries it; otherwise rebuild
    // the minimal comment shape the channel renderer reads.
    const payload: Record<string, unknown> = original
      ? { ...original }
      : {
          event,
          ...(typeof row.docId === 'string' ? { docId: row.docId } : {}),
          ...(typeof row.threadId === 'string' ? { threadId: row.threadId } : {}),
          comment: {
            ...(row.author !== undefined ? { author: row.author } : {}),
            ...(typeof row.text === 'string' ? { text: row.text } : {}),
            ...(typeof row.ts === 'number' ? { ts: row.ts } : {}),
          },
        };
    payload.workspaceId = workspaceId;
    payload.commentQueueId = row.id;
    try {
      await deps.emit(event, payload);
    } catch {
      // Not delivered, so not acked: the row stays on the queue and comes
      // back after the grace window instead of dying with this attempt.
      continue;
    }
    comments += 1;
    try {
      await deps.ackComment(row.id);
    } catch {
      // Left on the queue on purpose — one duplicate beats a silent drop.
    }
  }

  let voice = 0;
  for (const row of backlog.queuedVoice ?? []) {
    if (typeof row?.transcript !== 'string') continue;
    // Mirror the wording the heartbeat drain uses, so an utterance reads the
    // same whichever door it arrived through — including the `applied` note
    // that stops an agent redoing what the fast path already did.
    const applied = typeof row.applied === 'string' ? row.applied : undefined;
    const payload: Record<string, unknown> = {
      route: 'agent',
      transcript: row.transcript,
      ack: applied
        ? `Delivered from the queue. Already applied: ${applied}`
        : 'Delivered from the queue.',
      ...(row.context !== undefined ? { context: row.context } : {}),
      ...(row.actor !== undefined ? { actor: row.actor } : {}),
      workspaceId,
    };
    try {
      await deps.emit('voice.request', payload);
      voice += 1;
    } catch {
      // The server already drained the row, so there is nothing to retry
      // against — but a failed notification here is a connection-level
      // failure the whole restore path shares, not a per-row hazard.
    }
  }
  return { comments, voice };
}
