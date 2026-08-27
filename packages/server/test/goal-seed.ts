/**
 * Seeding a board's goals now that goal ids are GENERATED.
 *
 * A test can no longer say "give me a goal called `g-launch`" — the store
 * mints an opaque id and refuses an id it does not already hold, which is the
 * whole point of the scheme. So a test names its bands with its own labels,
 * seeds them through the real create path, and reads back the map from label
 * to minted id. Everything downstream that used to hard-code `'g-launch'`
 * uses `G.launch` instead, which is the same assertion with the id no longer
 * pretending to be knowable in advance.
 *
 * Both flavours exist because both layers are tested: the store directly, and
 * the same seed over HTTP. Neither takes an id — a helper that could supply
 * one would be a backdoor around the exact refusal these suites verify.
 */
import type { TaskStore } from '../src/tasks.ts';

export interface SeedGoalSpec {
  /** The test's own stable label for this band — what used to be its id. */
  key: string;
  title: string;
  dueAt?: number;
  /** One level, same as the board (§3.2). */
  subgoals?: SeedGoalSpec[];
}

/** label → the id the server minted for it. */
export type GoalIds = Record<string, string>;

/** Keys in the order `setGoalList` reports created rows: each entry, then its
 *  subgoals, in list order. */
function keysInCreatedOrder(spec: SeedGoalSpec[]): string[] {
  const out: string[] = [];
  for (const g of spec) {
    out.push(g.key);
    for (const s of g.subgoals ?? []) out.push(s.key);
  }
  return out;
}

function entriesFor(spec: SeedGoalSpec[]): unknown[] {
  return spec.map((g) => ({
    title: g.title,
    ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
    ...(g.subgoals !== undefined
      ? {
          subgoals: g.subgoals.map((s) => ({
            title: s.title,
            ...(s.dueAt !== undefined ? { dueAt: s.dueAt } : {}),
          })),
        }
      : {}),
  }));
}

function zip(spec: SeedGoalSpec[], created: Array<{ id: string }>): GoalIds {
  const keys = keysInCreatedOrder(spec);
  if (keys.length !== created.length) {
    throw new Error(`seedGoals: asked for ${keys.length} goals, got ${created.length} back`);
  }
  const ids: GoalIds = {};
  keys.forEach((key, i) => {
    ids[key] = (created[i] as { id: string }).id;
  });
  return ids;
}

/**
 * Whether the seeded bands come back ACTIVE.
 *
 * A goal created through `setGoalList` now lands in `triage`, and a triage
 * band dispatches nothing under it. Almost every suite that seeds goals is
 * asking for "a board with working bands" as a premise and then asserting
 * something else entirely — ordering, blockers, presence — so the default
 * here activates them. Without it those suites would all fail for a reason
 * none of them is about, and the fix would be the same three lines copied
 * into sixteen files.
 *
 * `leaveInTriage: true` opts out, for the suites where the triage state IS
 * the subject. Tests that assert the MINT default itself must not use this
 * helper at all — a seed that quietly moves the row is no witness to where
 * the row started. Those call `setGoalList` directly
 * (`goal-triage-default.test.ts`).
 */
export interface SeedGoalOpts {
  leaveInTriage?: boolean;
}

/** Seed straight into the store. Throws on refusal — a seed that silently
 *  did nothing is how a suite ends up asserting against an empty board. */
export function seedGoals(
  store: TaskStore,
  workspaceId: string,
  spec: SeedGoalSpec[],
  actor: { id: string; name: string; kind?: string },
  opts: SeedGoalOpts = {},
): GoalIds {
  const res = store.setGoalList(
    workspaceId,
    entriesFor(spec) as Parameters<TaskStore['setGoalList']>[1],
    { actor },
  );
  if (!res.ok) throw new Error(`seedGoals: setGoalList refused with ${res.error}`);
  const ids = zip(spec, res.created);
  if (!opts.leaveInTriage) {
    for (const id of Object.values(ids)) {
      const moved = store.transition(id, 'todo', { actor });
      // Throws rather than ignoring: a seed whose activation silently failed
      // hands the suite a triage band it believes is active, and every
      // downstream assertion then fails somewhere far from the cause.
      if (!moved.ok) throw new Error(`seedGoals: could not activate ${id} — ${moved.error}`);
    }
  }
  return ids;
}

/** Seed over the real route, for suites that drive HTTP. */
export async function seedGoalsOverHttp(
  base: string,
  workspaceId: string,
  spec: SeedGoalSpec[],
  author: { id: string; name: string; kind?: string },
  opts: SeedGoalOpts = {},
): Promise<GoalIds> {
  const res = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goals: entriesFor(spec), author }),
  });
  if (!res.ok) throw new Error(`seedGoalsOverHttp: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { created: Array<{ id: string }> };
  const ids = zip(spec, body.created);
  if (!opts.leaveInTriage) {
    for (const id of Object.values(ids)) {
      const moved = await fetch(`${base}/api/tasks/${encodeURIComponent(id)}/transition`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'todo', author }),
      });
      if (!moved.ok) {
        throw new Error(`seedGoalsOverHttp: could not activate ${id} — ${moved.status}`);
      }
    }
  }
  return ids;
}
