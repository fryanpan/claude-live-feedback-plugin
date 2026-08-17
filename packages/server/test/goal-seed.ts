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

/** Seed straight into the store. Throws on refusal — a seed that silently
 *  did nothing is how a suite ends up asserting against an empty board. */
export function seedGoals(
  store: TaskStore,
  workspaceId: string,
  spec: SeedGoalSpec[],
  actor: { id: string; name: string; kind?: string },
): GoalIds {
  const res = store.setGoalList(
    workspaceId,
    entriesFor(spec) as Parameters<TaskStore['setGoalList']>[1],
    { actor },
  );
  if (!res.ok) throw new Error(`seedGoals: setGoalList refused with ${res.error}`);
  return zip(spec, res.created);
}

/** Seed over the real route, for suites that drive HTTP. */
export async function seedGoalsOverHttp(
  base: string,
  workspaceId: string,
  spec: SeedGoalSpec[],
  author: { id: string; name: string; kind?: string },
): Promise<GoalIds> {
  const res = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goals: entriesFor(spec), author }),
  });
  if (!res.ok) throw new Error(`seedGoalsOverHttp: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { created: Array<{ id: string }> };
  return zip(spec, body.created);
}
