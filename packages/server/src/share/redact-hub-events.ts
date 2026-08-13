/**
 * Visitor redaction for hub events riding the workspace SSE feed.
 *
 * The ws:<id> board room enforces the §3.3 visitor contract via projectTask
 * (no body snapshot, transition actors as display names only). The SSE feed
 * broadcasts the RAW store events — full Task objects and TaskActor records
 * with ids — so without this, granting a visitor the feed (§3.12 commit 8)
 * would leak through the second door exactly the way DocMeta once did
 * (redact the REST payload, forget the long-lived transport; see
 * docs/process/learnings.md, "Anything in the Yjs doc is readable...").
 *
 * Pure and total: unknown events pass through untouched, so this can sit in
 * every visitor stream's write path without a maintained event list. Only
 * hub-shaped events (task.* / decision.* / workspace.* / agent.* /
 * triage.*) are rewritten, and only two fields carry ids: `actor`
 * (TaskActor) and `task` (a full Task).
 */
import { projectTask } from '../task-projection.ts';
import type { Task } from '../tasks.ts';

const HUB_EVENT = /^(task|decision|workspace|agent|triage|voice)\./;

/** `{id, name, kind}` → `{name, kind}` — the §3.3 display-only actor. */
function displayActor(actor: unknown): unknown {
  if (typeof actor !== 'object' || actor === null) return actor;
  const a = actor as Record<string, unknown>;
  return {
    ...(a.name !== undefined ? { name: a.name } : {}),
    ...(a.kind !== undefined ? { kind: a.kind } : {}),
  };
}

/** Does this look like a full Task (the one payload field that carries one)? */
function isTaskShape(value: unknown): value is Task {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Record<string, unknown>).transitions) &&
    typeof (value as Record<string, unknown>).id === 'string'
  );
}

/**
 * The payload a share visitor's SSE stream may carry. Returns the input
 * object itself when nothing needs redacting, so owner streams (which never
 * call this) and untouched events pay nothing.
 */
export function redactHubEventForVisitor<T extends { event: string }>(payload: T): T {
  if (!HUB_EVENT.test(payload.event)) return payload;
  const p = payload as unknown as { event: string } & Record<string, unknown>;
  const out: { event: string } & Record<string, unknown> = { ...p };
  if (p.actor !== undefined) out.actor = displayActor(p.actor);
  if (isTaskShape(p.task)) out.task = projectTask(p.task);
  return out as unknown as T;
}
