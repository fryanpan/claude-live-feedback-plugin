/**
 * The comment delivery queue: a comment addressed to one agent, queued while
 * that agent is not live to receive it.
 *
 * Split out of `task-agents.ts`, where this was the second of the two
 * delivery queues reachable only through `AgentStorePersistence` — see that
 * file's header. Same shape as `agent-voice-queue.ts` (the queue is the
 * record; live delivery is the fast path; the row clears on a receipt) with
 * the divergence the comment queue's own banner in the old file called out:
 * rows are ADDRESSED to one agent and drain only for it, and a drain never
 * removes anything — only `ackComment` does.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOICE_ACK_GRACE_MS } from './agent-voice-queue.ts';
import type { AgentStorePersistence } from './task-agents.ts';
import { cryptoId } from './task-fields.ts';

/**
 * One comment waiting for the agent it is addressed to.
 *
 * Same durable-queue contract as `QueuedVoiceRequest` — the queue is the
 * record, live delivery is the fast path, and the row clears on a receipt
 * from the receiving process — with the one divergence voice got wrong and
 * this queue must not copy: the row is ADDRESSED. `agentId` names who it is
 * for at queue time, and every drain filters on it, so a bystander attaching
 * first cannot walk off with the lead's comments.
 */
export interface QueuedComment {
  /** Names this row so a receipt can clear exactly one. */
  id: string;
  /** The agent this row is FOR. It drains only to this agent. */
  agentId: string;
  docId: string;
  threadId?: string;
  /** The broadcast this row stands in for: thread.created | thread.replied. */
  event: string;
  /** Who wrote the comment — never the addressee; the queue site excludes
   *  an agent's own comments before a row is written. */
  author: { id: string; name: string };
  text: string;
  /**
   * The broadcast payload verbatim, replayed on redelivery so the frame an
   * agent gets late is the same frame it would have gotten live — plus the
   * `commentQueueId` the redelivery stamps on top.
   */
  payload?: unknown;
  /** When the server last put this row on the wire (see QueuedVoiceRequest —
   *  emitted is not delivered; the grace window is measured from here). */
  emittedAt?: number;
  ts: number;
}

/** Where a workspace's queued comments persist. Exported so tests assert the
 *  real contract path. */
export function commentQueuePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.comment-queue.json`);
}

/**
 * The queue is DELIVERY state, not the record — the comment itself lives in
 * its thread's ydoc. An addressee that never sends receipts (a session on an
 * old bundle) must not grow the file without bound, so past this many rows
 * the oldest are dropped. Capping delivery bookkeeping is not a soft-delete
 * concern (CLAUDE.md: "the rule is about user content and history").
 */
export const MAX_QUEUED_COMMENTS = 200;

/** Same reasoning as VOICE_ACK_GRACE_MS, same number: past it an unacked row
 *  is far more likely lost than pending, and re-offering costs at worst one
 *  duplicate frame (which the MCP's eid dedup collapses) where NOT
 *  re-offering costs the comment. */
export const COMMENT_ACK_GRACE_MS = VOICE_ACK_GRACE_MS;

/** The comment queue itself: one per `AgentStore`, holding no state of its
 *  own — the durable record is the sidecar file `commentQueuePath` names. */
export class AgentCommentQueue {
  constructor(private readonly p: AgentStorePersistence) {}

  // ── Comment queue ────────────────────────────────────────────────────────
  // The voice queue's shape (the queue is the record; live delivery is the
  // fast path; the row clears on a receipt) with two deliberate differences:
  // rows are ADDRESSED to one agent and drain only for it, and a drain never
  // removes anything — only `ackComment` does, so a handover the session
  // never read comes back after the grace window instead of dying with the
  // response body that carried it.

  /**
   * Queue one comment for one agent. SYNCHRONOUS write, like
   * `queueVoiceRequest` and for the same reason: "queued" is a promise, and
   * a promise living in a debounce dies with the process.
   */
  queueComment(
    workspaceId: string,
    item: {
      agentId: string;
      docId: string;
      threadId?: string;
      event: string;
      author: { id: string; name: string };
      text: string;
      payload?: unknown;
    },
  ): string | false {
    if (!this.p.hasWorkspace(workspaceId)) return false;
    const id = cryptoId('cq');
    const queued: QueuedComment = {
      id,
      agentId: item.agentId,
      docId: item.docId,
      ...(item.threadId !== undefined ? { threadId: item.threadId } : {}),
      event: item.event,
      author: { id: item.author.id, name: item.author.name },
      text: item.text,
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
      ts: Date.now(),
    };
    try {
      const dir = join(this.p.dataDir(), 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Oldest dropped past the cap — PER ADDRESSEE, not across the file.
      // This file is delivery bookkeeping and the comment itself lives in
      // its thread, so an addressee that never acks (an old bundle, an
      // orphaned durable watch) must not grow it forever. But the cap it
      // hits must be its own: a shared cap would let one dead addressee's
      // backlog silently evict a LIVE agent's still-pending row, with no
      // signal anywhere that it happened.
      const existing = this.listQueuedComments(workspaceId);
      const mine = existing.filter((q) => q.agentId === item.agentId);
      const overflow = mine.length + 1 - MAX_QUEUED_COMMENTS;
      let next = [...existing, queued];
      if (overflow > 0) {
        const drop = new Set(mine.slice(0, overflow).map((q) => q.id));
        next = next.filter((q) => !drop.has(q.id));
      }
      writeFileSync(
        commentQueuePath(this.p.dataDir(), workspaceId),
        `${JSON.stringify({ queue: next }, null, 2)}\n`,
      );
      return id;
    } catch (err) {
      console.error(`[tasks] failed to queue comment for ${workspaceId}:`, err);
      return false;
    }
  }

  /** Read the whole queue without touching it (badges, tests, coverage). */
  listQueuedComments(workspaceId: string): QueuedComment[] {
    const path = commentQueuePath(this.p.dataDir(), workspaceId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { queue?: QueuedComment[] };
      return (parsed.queue ?? []).filter(
        (q) => typeof q?.id === 'string' && typeof q?.agentId === 'string',
      );
    } catch (err) {
      console.error(`[tasks] unreadable comment queue for ${workspaceId} — skipped:`, err);
      return [];
    }
  }

  /** Replace the queue file, removing it when nothing is left — same
   *  synchronous write as `queueComment`, and for the same reason. */
  writeCommentQueue(workspaceId: string, queue: QueuedComment[]): void {
    const path = commentQueuePath(this.p.dataDir(), workspaceId);
    try {
      if (queue.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, `${JSON.stringify({ queue }, null, 2)}\n`);
    } catch (err) {
      console.error(`[tasks] failed to rewrite comment queue for ${workspaceId}:`, err);
    }
  }

  /** Record that this row went out on the wire. Not the same as delivered —
   *  the row stays on the books until the ack. */
  markCommentEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry) return false;
    entry.emittedAt = Date.now();
    this.writeCommentQueue(workspaceId, queue);
    return true;
  }

  /**
   * Roll back an emitted mark for a row whose send reached NO socket. The
   * heartbeat route marks a row emitted when it hands it over, then attempts
   * the addressed frame — but `sse.sendToAgent` returning 0 is a real answer
   * ("the agent holds no stream"), and a row left marked against a send that
   * never happened waits out a full grace window before anything re-offers
   * it. Worse, if the agent's stream stays down while its heartbeats keep
   * landing, the cycle repeats forever: mark → silent 0-sink send → grace →
   * mark again. Clearing the mark makes the very next heartbeat a fresh
   * delivery attempt instead. No-op (false) for unknown or un-emitted rows.
   */
  clearCommentEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry || entry.emittedAt === undefined) return false;
    // JSON.stringify drops an undefined property, so the persisted row
    // comes back with no emittedAt at all — indistinguishable from never
    // having been sent, which is the point.
    entry.emittedAt = undefined;
    this.writeCommentQueue(workspaceId, queue);
    return true;
  }

  /**
   * The receiving process confirms it has the comment — the ONLY thing that
   * removes a row. False for an unknown id, so a stale or replayed receipt
   * is never licence to clear anything else.
   */
  ackComment(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const next = queue.filter((q) => q.id !== id);
    if (next.length === queue.length) return false;
    this.writeCommentQueue(workspaceId, next);
    return true;
  }

  /**
   * Hand over what THIS agent should hear now, marking each row emitted but
   * removing nothing. `freshProcess` is the attach case, exactly as for
   * voice: whatever was in flight went to a process that is gone, so the
   * grace window protects nobody there.
   */
  takeDeliverableComments(
    workspaceId: string,
    agentId: string,
    opts?: { freshProcess?: boolean },
  ): QueuedComment[] {
    const queue = this.listQueuedComments(workspaceId);
    if (queue.length === 0) return [];
    const now = Date.now();
    const inFlight = (q: QueuedComment): boolean =>
      !opts?.freshProcess &&
      q.emittedAt !== undefined &&
      now - q.emittedAt < this.p.commentAckGraceMs;
    const handOver = queue.filter((q) => q.agentId === agentId && !inFlight(q));
    if (handOver.length === 0) return [];
    for (const q of handOver) q.emittedAt = now;
    this.writeCommentQueue(workspaceId, queue);
    return handOver;
  }
}
