/**
 * The task store's event bus and audit trail: the append-only
 * `<workspaceId>.events.jsonl` log (plan §3.6: "the event log is the audit
 * trail"), the in-process listener fan-out the SSE transport hangs off, and
 * the observed-work clock every emitted event feeds for free.
 *
 * Split out of `tasks.ts` — the emit choke point was a layer below the
 * store's own verbs, not a fifth one beside them. What it needs from the
 * store arrives through `TaskEventBusPersistence`, the same seam
 * `WorkspaceStore` / `GoalStore` / `AgentStore` already use, so no caller of
 * `TaskStore.onEvent` or of the store's own verb methods has to learn that
 * emit now crosses a file boundary.
 *
 * `emit`'s own order is the contract callers rely on and is preserved
 * exactly: audit append FIRST (§3.6 — "an event was emitted" and "the audit
 * log has it" must be the same fact by construction), then the
 * observed-work note, then the listener fan-out.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdCandidates } from '@feedback/core';
import type { AgentAttachment, TaskStoreEvent } from './tasks.ts';

/** Where a workspace's append-only event audit log lives (plan §3.6: "the
 *  event log is the audit trail"). Exported so tests assert the real path. */
export function eventsLogPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.events.jsonl`);
}

/** What the bus needs from the store: where the audit log lives, who is
 *  attached to a workspace (for the observed-work note), and how to stamp a
 *  live agent's clock. */
export interface TaskEventBusPersistence {
  dataDir(): string;
  attachmentsFor(workspaceId: string): Map<string, AgentAttachment> | undefined;
  noteAgentToolCall(workspaceId: string, agentId: string, at?: number): boolean;
}

/** One store's event bus: the listener set `onEvent` subscribes into, plus
 *  the choke point every store mutation's event passes through. */
export class TaskEventBus {
  private eventListeners = new Set<(event: TaskStoreEvent) => void>();

  constructor(private readonly p: TaskEventBusPersistence) {}

  /** Subscribe to store events; returns the unsubscribe. The SSE transport
   *  and audit log (a later commit) hang off this. */
  onEvent(listener: (event: TaskStoreEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  emit(event: TaskStoreEvent): void {
    // Audit FIRST, at the emit choke point: "an event was emitted" and "the
    // audit log has it" are the same fact by construction (§3.6), so the log
    // can never disagree with what subscribers saw.
    this.appendAudit(event);
    this.noteObservedWork(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[tasks] event listener threw:', err);
      }
    }
  }

  /** Append one JSON line to the per-workspace events.jsonl. Shaped exactly
   *  like the SSE payload (`event` key, not `type`) so the two records are
   *  the same bytes-modulo-transport. Synchronous append — an event either
   *  reaches both the log and the listeners, or (I/O failure, logged loudly)
   *  the listeners still fire: delivery beats bookkeeping. */
  private appendAudit(event: TaskStoreEvent): void {
    try {
      const dir = join(this.p.dataDir(), 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const { type, ...rest } = event;
      appendFileSync(
        eventsLogPath(this.p.dataDir(), event.workspaceId),
        `${JSON.stringify({ event: type, ...rest })}\n`,
      );
    } catch (err) {
      console.error('[tasks] failed to append audit event:', err);
    }
  }

  /**
   * Every emitted board change is also EVIDENCE that its author was alive at
   * that moment, so the work clock moves here rather than at ~20 call sites.
   *
   * The call-site version of this is what failed: `noteAgentToolCall` shipped
   * with no caller at all and sat unused, because "remember to also record
   * liveness" is exactly the kind of step that gets forgotten. At the choke
   * point it cannot be — a new route that emits is observed for free.
   *
   * Two things it deliberately does NOT do:
   *  - `agent.*` events never count. A heartbeat asserting work is what
   *    collapsed the two clocks into one and made `unresponsive` unreachable;
   *    `attachAgent` sets both clocks itself and needs no help here.
   *  - A person's edit never moves an agent's clock. The actor is resolved
   *    against the attachment roster, and a name that matches nothing is a
   *    no-op.
   */
  private noteObservedWork(event: TaskStoreEvent): void {
    if (event.type.startsWith('agent.')) return;
    const { workspaceId } = event;
    const attachments = this.p.attachmentsFor(workspaceId);
    if (!attachments || attachments.size === 0) return;
    const actor = (event as { actor?: { id?: unknown; name?: unknown } }).actor;
    if (!actor) return;
    // Match on every spelling a roster could hold. The event's actor id and
    // the attachment key demonstrably disagree in the field — `live-feedback`
    // against `agent-live-feedback` on the same session — so matching one
    // spelling matches roughly none of the fleet.
    const candidates = new Set<string>();
    for (const raw of [actor.id, actor.name]) {
      if (typeof raw !== 'string') continue;
      candidates.add(raw.trim().toLowerCase());
      for (const c of agentIdCandidates(raw)) candidates.add(c);
    }
    if (candidates.size === 0) return;
    for (const agentId of attachments.keys()) {
      if (!candidates.has(agentId.trim().toLowerCase())) continue;
      // Through the public method rather than touching the field, so there
      // is exactly one definition of "the agent was observed working" — and
      // so that method finally has the production caller whose absence is
      // the whole reason the clock never moved.
      this.p.noteAgentToolCall(workspaceId, agentId, event.ts);
      return;
    }
  }
}
