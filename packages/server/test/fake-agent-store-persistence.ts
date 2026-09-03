/**
 * A minimal `AgentStorePersistence` for driving `AgentVoiceQueue` and
 * `AgentCommentQueue` directly in a unit test, without booting a `TaskStore`
 * or a server. Both queue classes only read `dataDir()`, `hasWorkspace()`,
 * `voiceAckGraceMs` / `commentAckGraceMs` and (voice only) `emit()`; the rest
 * of the interface is stubbed so the fake type-checks as the real thing.
 */
import type { AgentStoreEvent, AgentStorePersistence } from '../src/task-agents.ts';

export function fakePersistence(opts: {
  dataDir: string;
  knownWorkspaces: string[];
  voiceAckGraceMs?: number;
  commentAckGraceMs?: number;
  onEmit?: (event: AgentStoreEvent) => void;
}): AgentStorePersistence {
  const known = new Set(opts.knownWorkspaces);
  return {
    dataDir: () => opts.dataDir,
    state: () => undefined,
    states: () => [],
    hasWorkspace: (workspaceId) => known.has(workspaceId),
    thresholds: {},
    voiceAckGraceMs: opts.voiceAckGraceMs ?? 90_000,
    commentAckGraceMs: opts.commentAckGraceMs ?? 90_000,
    roster: () => undefined,
    agentStreamProbe: () => false,
    deliveryProbe: () => false,
    saveAttachments: () => {},
    listUntriaged: () => [],
    assignLead: () => {},
    emit: (event) => opts.onEmit?.(event),
  };
}
