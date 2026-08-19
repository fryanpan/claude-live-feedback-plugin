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
 *
 * The second half of the same question is WHAT KIND of somebody. `assignee`
 * is a display name, and a display name cannot be pattern-matched into a
 * person or an agent without being wrong for somebody — silently, and in the
 * direction that inflates the one strip built to stay short. So the kind is
 * DECLARED (`declaredAssigneeKind`) and read back with the workspace's own
 * agent roster as the standing evidence (`resolveOwnerKind`).
 */
import { agentIdCandidates } from '@feedback/core';
import { classifyActor } from './activity.ts';

/** The old default. It names a category, not somebody, so it is not an owner. */
export const GENERIC_ASSIGNEE = 'agent';

/** The reserved owner meaning "a person, unnamed". Predates named owners and
 *  stays the spelling everything else keys on. */
export const HUMAN_ASSIGNEE = 'human';

export const ASSIGNEE_REQUIRED_ERROR = 'assignee-required';

/** Says how to satisfy the refusal — a gate that only blocks is a dead end. */
export const ASSIGNEE_REQUIRED_MESSAGE =
  "Name who owns this task: pass `assignee` (a person, an agent's name, or 'human'), " +
  'or identify yourself with `author`. An agent gets its name from CW_AGENT_NAME ' +
  `in its launch environment — "${GENERIC_ASSIGNEE}" on its own is not an owner.`;

/**
 * The re-assign route's version of the same refusal. It gets its own wording
 * because there is no author to fall back on there: handing a task to the
 * caller because they typed the generic word would be a different action than
 * the one they asked for, so the only move left is to say who to name.
 */
export const ASSIGNEE_REQUIRED_HANDOVER_MESSAGE =
  "Name who takes this task: pass `assignee` (a person, an agent's name, or 'human'). " +
  'An agent gets its name from CW_AGENT_NAME in its launch environment — ' +
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

// ── Is the owner a person or an agent? ─────────────────────────────────────

/**
 * What the board can say about who holds a task.
 *
 * `unknown` is a real answer and NOT a synonym for "probably a person". A
 * named owner nobody has declared and no attachment vouches for is exactly
 * that: unknown. Collapsing it into either real value is how a whole
 * population goes invisible — the same reading that made "no plugin version
 * reported" mean "behind" rather than "unknown".
 */
export type OwnerKind = 'person' | 'agent' | 'unknown';

/** The two values a caller may DECLARE. `unknown` is never declarable: it is
 *  what the absence of a declaration reads as, so accepting it as input would
 *  give one state two spellings. */
export type DeclaredOwnerKind = 'person' | 'agent';

/** A caller-supplied kind, case-folded, or nothing. Same forgiveness
 *  `classifyActor` applies to `kind` — a hand-populated `'Person'` matching
 *  nothing would fall through to the default and misfile a caller who did
 *  say what it was. */
export function statedOwnerKind(value: unknown): DeclaredOwnerKind | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'person' || v === 'agent' ? v : undefined;
}

export const BAD_ASSIGNEE_KIND_ERROR = 'bad-assignee-kind';

/** Says how to satisfy the refusal, and names the confusion that causes it. */
export const BAD_ASSIGNEE_KIND_MESSAGE =
  "`assigneeKind` must be 'person' or 'agent'. It says what the owner IS, which is not " +
  "the same vocabulary as `assignee` — 'human' is a valid assignee and not a valid kind.";

/**
 * A caller-supplied `assigneeKind`, or a refusal.
 *
 * Silently dropping a value the caller DID send is the worst of the three
 * options here: the request answers 200, the row lands undeclared, the board
 * draws "not recorded", and nothing anywhere says why. The likeliest mistake
 * is `assigneeKind: 'human'`, because `assignee: 'human'` is the canonical
 * spelling of the field right next to it — so the one plausible typo is
 * exactly the one that has to be caught. Same treatment `parseNeeds` gets,
 * for the same reason.
 */
export function parseAssigneeKind(
  raw: unknown,
): { ok: true; assigneeKind?: DeclaredOwnerKind } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  const stated = statedOwnerKind(raw);
  return stated ? { ok: true, assigneeKind: stated } : { ok: false };
}

/**
 * The kind to STORE when a task is created or handed over.
 *
 * Two sources, and no name matching in either. An explicit `assigneeKind`
 * from the caller wins — the caller assigning work to a person is the one
 * party that knows they are one. Otherwise, an owner who IS the caller is
 * classified by `classifyActor`: an agent filing its own work has declared
 * itself an agent by signing the write, and that is the same predicate the
 * reply-reopen rule uses rather than a second one that would drift from it.
 *
 * Returns undefined for a hand-over to somebody else with nothing declared —
 * which is the point: on re-assign that CLEARS the previous owner's kind,
 * because inheriting it would silently label the new owner as whatever the
 * old one was.
 */
export function declaredAssigneeKind(
  assignee: string,
  explicitKind: unknown,
  author: { id: string; name: string; kind?: string } | undefined,
): DeclaredOwnerKind | undefined {
  const stated = statedOwnerKind(explicitKind);
  if (stated) return stated;
  if (!author) return undefined;
  if (author.name.trim().toLowerCase() !== assignee.trim().toLowerCase()) return undefined;
  return classifyActor(author);
}

/**
 * "Is this display name one of the workspace's attached agents?"
 *
 * A task records its owner as a DISPLAY NAME (`Live Feedback`); an
 * attachment records an identity ID (`agent-live-feedback` by default, or
 * whatever the attaching session passed — `quick-build` and the display name
 * itself both occur in the field). Comparing the two directly matches almost
 * nothing, which is how the roster half of `resolveOwnerKind` came to be
 * dead in production while every fixture that attached under the display
 * name passed. `agentIdCandidates` is the shared derivation, so the id the
 * MCP process mints and the id the board looks for cannot drift apart.
 */
export function attachedAgentTest(agentIds: Iterable<string>): (name: string) => boolean {
  const resolve = attachedAgentResolver(Array.from(agentIds, (agentId) => ({ agentId })));
  return (name: string) => resolve(name) !== undefined;
}

/**
 * WHICH attachment an owner name belongs to — the same match
 * `attachedAgentTest` makes, keeping the answer instead of discarding it.
 *
 * The boolean version can say an owner is an attached agent but not which
 * session that is, so everything the attachment knows — when it last
 * heartbeat, when it was last seen working, what bundle it runs — stops at
 * the board's edge. Expressed as one function with the predicate defined in
 * terms of it, because two matchers over the same roster are two things that
 * can disagree, and this file already carries the scar of a roster half that
 * silently matched nothing.
 *
 * Generic over the attachment so this module stays free of `tasks.ts` (which
 * imports it — the dependency only runs one way) and so the caller decides
 * what to expose. It returns the record as-is: redaction of host-machine
 * fields belongs to whoever serves it, not to the matcher.
 *
 * The RESERVED owners never resolve, whatever the roster holds. `agent` is
 * the value every session with no configured name collapses into and `human`
 * means "a person, unnamed" — both are shared or anonymous by construction,
 * so a match on them names an arbitrary session rather than the one that did
 * the work. `resolveOwnerKind` already returns before its roster check for
 * exactly these two, so this adds no new behaviour there; it puts the rule in
 * the one place every future caller inherits it, rather than trusting each to
 * re-derive it. Guessing wrong here is worse than saying nothing: an owner
 * with no answer reads as unknown, an owner with the wrong one reads as fact.
 */
export function attachedAgentResolver<T extends { agentId: string }>(
  attachments: Iterable<T>,
): (name: string) => T | undefined {
  const roster = new Map<string, T>();
  for (const att of attachments) {
    const key = att.agentId.trim().toLowerCase();
    // First wins: a roster carrying one agent under two spellings should
    // resolve to one session, not to whichever happened to be enumerated last.
    if (key !== '' && !roster.has(key)) roster.set(key, att);
  }
  if (roster.size === 0) return () => undefined;
  return (name: string) => {
    const key = name.trim().toLowerCase();
    if (key === GENERIC_ASSIGNEE || key === HUMAN_ASSIGNEE) return undefined;
    for (const candidate of agentIdCandidates(name)) {
      const hit = roster.get(candidate);
      if (hit) return hit;
    }
    return undefined;
  };
}

/**
 * What the surface should say this owner is.
 *
 * Ordering mirrors `classifyActor`'s: every AGENT signal is checked before
 * every person signal, so contradictory input resolves to `agent`. The
 * direction is deliberate and it is the one the blocker band needs — a
 * person filed as an agent drops one row out of a view, whereas an agent
 * filed as a person puts every agent-owned blocker into the strip built to
 * be short, which is the inflation the band's other rules exist to prevent.
 * It is also the answer to "an agent whose display name collides with a
 * person's": the attachment is the agent's own standing declaration and it
 * outranks anyone else's claim about that name.
 *
 * `isAttachedAgent` is the workspace's live agent roster. Reading it here
 * rather than only at write time is the migration: every task already on a
 * board, created long before this field existed, resolves correctly the
 * moment its owner is attached — no backfill, and nothing to remember.
 */
export function resolveOwnerKind(
  assignee: string,
  stored: DeclaredOwnerKind | undefined,
  isAttachedAgent: (name: string) => boolean,
): OwnerKind {
  const name = assignee.trim();
  // Nobody holds it: the bare category word, or no owner at all. Not the
  // same question as person-or-agent, and answering it either way would put
  // an unowned task in a band that means "somebody is on this".
  if (name === '' || name.toLowerCase() === GENERIC_ASSIGNEE) return 'unknown';
  // The other reserved word, decided in the same breath and for the same
  // reason: `human` MEANS "a person, unnamed". It is not a display name that
  // might turn out to belong to an agent, so the agent-signals-first rule
  // below does not apply to it — that rule exists to settle a NAME two
  // parties could each plausibly claim. Below the roster check, an
  // `assigneeKind: 'agent'` on the reserved owner resolved to `agent`, which
  // dropped it out of every person-owned surface and disagreed with the
  // client's own reading of the same literal.
  if (name.toLowerCase() === HUMAN_ASSIGNEE) return 'person';
  if (isAttachedAgent(name)) return 'agent';
  if (stored === 'agent') return 'agent';
  if (stored === 'person') return 'person';
  return 'unknown';
}
