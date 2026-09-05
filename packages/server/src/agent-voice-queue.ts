/**
 * The voice change-request queue: an utterance queued while no agent was
 * live on a board (§2.4 "agent away — queued"), held until the next attach
 * or heartbeat drains it.
 *
 * Split out of `task-agents.ts`, where this was one of the two delivery
 * queues reachable only through `AgentStorePersistence` — see that file's
 * header. `AgentStorePersistence` is imported here as a TYPE ONLY: it
 * erases at compile time, so `AgentStore` importing `AgentVoiceQueue` back
 * from this file creates no runtime cycle between the two.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import type { AgentStorePersistence } from './task-agents.ts';
import { cryptoId } from './task-fields.ts';
import type { VoiceRoute } from './tasks.ts';

/**
 * How long an emitted utterance is left alone before the queue offers it again.
 *
 * The floor is "how long can a busy agent reasonably take to acknowledge a
 * channel frame" — a frame lands at a turn boundary, so it waits out whatever
 * tool call is in progress. The ceiling is Bryan noticing nothing happened. 90
 * seconds sits between: past it, an unacked entry is far more likely lost than
 * pending, and re-offering costs at worst one duplicated instruction where NOT
 * re-offering costs the whole request.
 */
export const VOICE_ACK_GRACE_MS = 90_000;

/** One change-utterance waiting for an agent to attach (§2.4: "agent away —
 *  queued"). Persisted synchronously — "queued" is a promise, and a promise
 *  that lives only in memory dies with the process (grounded-pending). */
export interface QueuedVoiceRequest {
  /** Names this entry so a receipt can clear exactly one. Absent on rows
   *  written before the queue became the record rather than the fallback —
   *  those still drain, they just cannot be acked individually. */
  id?: string;
  /**
   * When the server last put this on the wire, or absent if it never has.
   *
   * An emitted-and-unacked entry and a lost one look identical from here, so
   * this is what the grace window is measured from: long enough that a working
   * agent has had its chance to acknowledge, short enough that a genuinely
   * lost utterance comes back quickly.
   */
  emittedAt?: number;
  transcript: string;
  context?: unknown;
  actor: TaskActor;
  /**
   * What the voice fast path ALREADY applied to the board for this utterance,
   * as the speaker was told it — present only when it applied something.
   *
   * An utterance can carry more than the one verb voice handles ("mark this
   * done and then draft the migration notes"), and with no agent live the
   * queue is the only durable channel for the rest of it. Delivering the
   * transcript alone would ask the agent to redo the half that already
   * happened; this field is how the same row says "that part is done".
   */
  applied?: string;
  ts: number;
}

/** Where a workspace's queued voice requests persist. Exported so tests
 *  assert the real contract path. */
export function voiceQueuePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.voice-queue.json`);
}

/** The voice queue itself: one per `AgentStore`, holding no state of its
 *  own — the durable record is the sidecar file `voiceQueuePath` names. */
export class AgentVoiceQueue {
  constructor(private readonly p: AgentStorePersistence) {}

  // ── Voice (§2.4 / §3.8) ──────────────────────────────────────────────────

  /**
   * Record a voice utterance + its routing outcome. This is the §3.6
   * `voice.request` row: it reaches the audit log and every subscriber via
   * the emit choke point, so "voice always answers" has a checkable
   * artifact. Returns false (and emits nothing) for an unknown workspace.
   */
  recordVoiceRequest(
    workspaceId: string,
    req: {
      transcript: string;
      route: VoiceRoute;
      ack: string;
      context?: unknown;
      /** The queue row this utterance was written to. The receiving agent
       *  acknowledges it, which is what takes the row off the queue. */
      queueId?: string;
      actor: { id: string; name: string; kind?: string };
    },
  ): boolean {
    if (!this.p.hasWorkspace(workspaceId)) return false;
    this.p.emit({
      type: 'voice.request',
      workspaceId,
      transcript: req.transcript,
      route: req.route,
      ack: req.ack,
      ...(req.queueId !== undefined ? { queueId: req.queueId } : {}),
      ...(req.context !== undefined ? { context: req.context } : {}),
      actor: {
        id: req.actor.id,
        name: req.actor.name,
        kind: classifyActor(req.actor),
      },
      ts: Date.now(),
    });
    return true;
  }

  /**
   * Queue a change-utterance for the next agent attach. SYNCHRONOUS write,
   * unlike every other sidecar: the caller is about to tell the speaker
   * "queued", and an ack grounded in a debounce that a crash can drop would
   * be the summaries-incident lie. Queue writes are rare (only while no
   * agent is live), so the sync cost is nothing.
   */
  queueVoiceRequest(
    workspaceId: string,
    item: {
      transcript: string;
      context?: unknown;
      actor: { id: string; name: string; kind?: string };
      applied?: string;
    },
  ): string | false {
    if (!this.p.hasWorkspace(workspaceId)) return false;
    const id = cryptoId('vq');
    const queued: QueuedVoiceRequest = {
      id,
      transcript: item.transcript,
      ...(item.context !== undefined ? { context: item.context } : {}),
      actor: { id: item.actor.id, name: item.actor.name, kind: classifyActor(item.actor) },
      ...(item.applied !== undefined ? { applied: item.applied } : {}),
      ts: Date.now(),
    };
    const path = voiceQueuePath(this.p.dataDir(), workspaceId);
    try {
      const dir = join(this.p.dataDir(), 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const existing = this.listQueuedVoice(workspaceId);
      writeFileSync(path, `${JSON.stringify({ queue: [...existing, queued] }, null, 2)}\n`);
      return id;
    } catch (err) {
      console.error(`[tasks] failed to queue voice request for ${workspaceId}:`, err);
      return false;
    }
  }

  /** Read the queue without draining it (the board could render a badge). */
  listQueuedVoice(workspaceId: string): QueuedVoiceRequest[] {
    const path = voiceQueuePath(this.p.dataDir(), workspaceId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        queue?: QueuedVoiceRequest[];
      };
      return (parsed.queue ?? []).filter((q) => typeof q?.transcript === 'string');
    } catch (err) {
      console.error(`[tasks] unreadable voice queue for ${workspaceId} — skipped:`, err);
      return [];
    }
  }

  /** Replace the queue file, removing it when nothing is left — same
   *  synchronous write as `queueVoiceRequest`, and for the same reason. */
  writeVoiceQueue(workspaceId: string, queue: QueuedVoiceRequest[]): void {
    const path = voiceQueuePath(this.p.dataDir(), workspaceId);
    try {
      if (queue.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, `${JSON.stringify({ queue }, null, 2)}\n`);
    } catch (err) {
      console.error(`[tasks] failed to rewrite voice queue for ${workspaceId}:`, err);
    }
  }

  /**
   * Record that this entry has gone out on the wire.
   *
   * Not the same as delivered, and the difference is the whole point: the
   * server knows what it wrote to a socket and nothing more. Until an ack
   * comes back the entry stays on the books.
   */
  markVoiceEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedVoice(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry) return false;
    entry.emittedAt = Date.now();
    this.writeVoiceQueue(workspaceId, queue);
    return true;
  }

  /**
   * The receiving process confirms it has the utterance. THIS is what makes a
   * live delivery durable — before it, the route's only record that a message
   * had been sent was a socket write that nothing checked.
   *
   * Returns false for an id that is not on the queue, rather than treating a
   * stale or replayed receipt as licence to clear anything.
   */
  ackVoiceRequest(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedVoice(workspaceId);
    const next = queue.filter((q) => q.id !== id);
    if (next.length === queue.length) return false;
    this.writeVoiceQueue(workspaceId, next);
    return true;
  }

  /**
   * Hand over what this agent should act on, and keep what might still be in
   * flight.
   *
   * `freshProcess` is the attach case. A session that just attached cannot be
   * holding anything: whatever was emitted went to the process that is gone,
   * so the grace window protects nobody and only delays the redelivery.
   */
  drainVoiceQueue(workspaceId: string, opts?: { freshProcess?: boolean }): QueuedVoiceRequest[] {
    const queue = this.listQueuedVoice(workspaceId);
    if (queue.length === 0) return [];
    const now = Date.now();
    const inFlight = (q: QueuedVoiceRequest): boolean =>
      !opts?.freshProcess &&
      q.emittedAt !== undefined &&
      now - q.emittedAt < this.p.voiceAckGraceMs;
    const handOver = queue.filter((q) => !inFlight(q));
    this.writeVoiceQueue(
      workspaceId,
      queue.filter((q) => inFlight(q)),
    );
    return handOver;
  }
}
