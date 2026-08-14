/**
 * Who owns a task, decided once for every path that creates one.
 *
 * The store used to default `assignee` to the literal word "agent", so a
 * create that named nobody produced a task owned by a word rather than by
 * somebody: two agents in the same workspace could not tell their queues
 * apart, `next_tasks?assignee=<me>` matched nothing, and "who is doing this"
 * had no answer on the board. The caller almost always knows — it signs its
 * writes with an author — so resolve the owner from that, and refuse the
 * create when even that comes back generic.
 */

/** The old default. It names a category, not somebody, so it is not an owner. */
export const GENERIC_ASSIGNEE = 'agent';

export const ASSIGNEE_REQUIRED_ERROR = 'assignee-required';

/** Says how to satisfy the refusal — a gate that only blocks is a dead end. */
export const ASSIGNEE_REQUIRED_MESSAGE =
  "Name who owns this task: pass `assignee` (a person, an agent's name, or 'human'), " +
  'or identify yourself with `author`. An agent gets its name from FEEDBACK_AGENT_NAME ' +
  `in its launch environment — "${GENERIC_ASSIGNEE}" on its own is not an owner.`;

/**
 * The re-assign route's version of the same refusal. It gets its own wording
 * because there is no author to fall back on there: handing a task to the
 * caller because they typed the generic word would be a different action than
 * the one they asked for, so the only move left is to say who to name.
 */
export const ASSIGNEE_REQUIRED_HANDOVER_MESSAGE =
  "Name who takes this task: pass `assignee` (a person, an agent's name, or 'human'). " +
  'An agent gets its name from FEEDBACK_AGENT_NAME in its launch environment — ' +
  `"${GENERIC_ASSIGNEE}" on its own is not an owner.`;

/** The value a caller supplied, or nothing when it names nobody. */
function named(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase() === GENERIC_ASSIGNEE ? null : trimmed;
}

/**
 * The owner to record: an explicit assignee, else the caller's own identity,
 * else null — which every creation route turns into a 400 rather than a task
 * belonging to nobody.
 */
export function resolveAssignee(
  explicit: unknown,
  author: { name?: string } | undefined,
): string | null {
  return named(explicit) ?? named(author?.name);
}
