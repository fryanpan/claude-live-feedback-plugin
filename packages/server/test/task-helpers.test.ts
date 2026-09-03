/**
 * Unit coverage for the pure per-store helpers with no state of their own —
 * per testing-standards rule 4 ("every new server module ships with a unit
 * test"). Both functions are exercised indirectly through `hydrateTasksFromDisk`
 * in `task-persistence.test.ts`; this file checks their own contract in
 * isolation, including the shapes that contract explicitly has to handle
 * (multi-level nesting, non-runtime strings).
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { flattenNestedGoals, isAttachmentRuntime } from '../src/task-helpers.ts';

describe('isAttachmentRuntime', () => {
  it('accepts every known runtime', () => {
    expect(isAttachmentRuntime('claude-code-local')).toBe(true);
    expect(isAttachmentRuntime('managed-agent')).toBe(true);
    expect(isAttachmentRuntime('webhook')).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isAttachmentRuntime('not-a-runtime')).toBe(false);
    expect(isAttachmentRuntime(undefined)).toBe(false);
    expect(isAttachmentRuntime(42)).toBe(false);
    expect(isAttachmentRuntime(null)).toBe(false);
  });
});

describe('flattenNestedGoals', () => {
  it('passes an already-flat list through unchanged', () => {
    const flat = flattenNestedGoals([
      { id: 'g-1', title: 'One' },
      { id: 'g-2', title: 'Two', dueAt: 5_000 },
    ]);
    expect(flat).toEqual([
      { id: 'g-1', title: 'One' },
      { id: 'g-2', title: 'Two', dueAt: 5_000 },
    ]);
  });

  it('splices a subgoal directly after its parent', () => {
    const flat = flattenNestedGoals([
      { id: 'g-parent', title: 'Parent', subgoals: [{ id: 'g-child', title: 'Child' }] },
      { id: 'g-other', title: 'Other' },
    ]);
    expect(flat.map((g) => g.id)).toEqual(['g-parent', 'g-child', 'g-other']);
  });

  it('recurses more than one level deep', () => {
    const flat = flattenNestedGoals([
      {
        id: 'g-1',
        title: 'One',
        subgoals: [
          {
            id: 'g-1-1',
            title: 'One One',
            subgoals: [{ id: 'g-1-1-1', title: 'One One One' }],
          },
        ],
      },
    ]);
    expect(flat.map((g) => g.id)).toEqual(['g-1', 'g-1-1', 'g-1-1-1']);
  });

  it('drops the subgoals key itself from the flattened rows', () => {
    const flat = flattenNestedGoals([
      { id: 'g-1', title: 'One', subgoals: [{ id: 'g-2', title: 'Two' }] },
    ]);
    expect(flat[0]).not.toHaveProperty('subgoals');
    expect(flat).toHaveLength(2);
  });
});
