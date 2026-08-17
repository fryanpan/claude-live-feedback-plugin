/**
 * Batch-local dependency references, at the layer that decides them.
 *
 * The route test (`task-batch.test.ts`) proves the wiring; this proves the
 * decisions — which is the half where a wrong answer is silent. An `after`
 * edge that resolves to nothing does not error at the store, it just never
 * blocks: `openBlockers` skips ids it cannot resolve. So every refusal here
 * is one-directional by design — it can only turn a would-be missing edge
 * into a named 400.
 *
 * All fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import {
  BAD_BATCH_KEY_ERROR,
  BATCH_DEP_ROW_FAILED_ERROR,
  DUPLICATE_BATCH_KEY_ERROR,
  FORWARD_BATCH_REF_ERROR,
  UNKNOWN_BATCH_REF_ERROR,
  indexBatchKeys,
  resolveRowRefs,
} from '../src/task-batch-refs.ts';

/** The context a batch has once `n` rows have all landed with tidy ids. */
function ctxWithLanded(rows: unknown[], landed: number[]) {
  const { keyToIndex } = indexBatchKeys(rows);
  return {
    keyToIndex,
    idByIndex: new Map(landed.map((i) => [i, `t-row${i}`])),
    rowCount: rows.length,
  };
}

describe('indexBatchKeys', () => {
  it('indexes the rows that declare a key and leaves the rest alone', () => {
    const rows = [{ title: 'A', key: 'seed' }, { title: 'B' }, { title: 'C', key: 'index' }];
    const { keyToIndex, keyErrors } = indexBatchKeys(rows);
    expect(keyToIndex.get('seed')).toBe(0);
    expect(keyToIndex.get('index')).toBe(2);
    expect(keyToIndex.size).toBe(2);
    expect(keyErrors.size).toBe(0);
  });

  it('refuses a duplicate key on the SECOND row, keeping the first usable', () => {
    // Refusing both would punish the row that was fine, and the caller cannot
    // tell which of two identical labels it meant.
    const rows = [
      { title: 'A', key: 'seed' },
      { title: 'B', key: 'seed' },
    ];
    const { keyToIndex, keyErrors } = indexBatchKeys(rows);
    expect(keyToIndex.get('seed')).toBe(0);
    expect(keyErrors.get(1)?.error).toBe(DUPLICATE_BATCH_KEY_ERROR);
    expect(keyErrors.has(0)).toBe(false);
  });

  it('refuses keys that could be read as something else, at declaration', () => {
    // Each of these would otherwise become an ambiguity at every REFERENCE
    // site rather than once, here.
    const rows = [
      { title: 'A', key: '' },
      { title: 'B', key: '   ' },
      { title: 'C', key: '#seed' }, // the sigil is not part of the key
      { title: 'D', key: '12' }, // would collide with the index spelling `#12`
      { title: 'E', key: 7 },
    ];
    const { keyErrors, keyToIndex } = indexBatchKeys(rows);
    expect([...keyErrors.keys()]).toEqual([0, 1, 2, 3, 4]);
    for (const i of [0, 1, 2, 3, 4]) {
      expect(keyErrors.get(i)?.error).toBe(BAD_BATCH_KEY_ERROR);
    }
    expect(keyToIndex.size).toBe(0);
  });

  it('is unbothered by rows that are not objects', () => {
    const { keyErrors, keyToIndex } = indexBatchKeys([null, 'nope', 42, { title: 'A' }]);
    expect(keyErrors.size).toBe(0);
    expect(keyToIndex.size).toBe(0);
  });
});

describe('resolveRowRefs', () => {
  const rows = [{ title: 'A', key: 'seed' }, { title: 'B' }, { title: 'C' }];

  it('leaves a row with no dependencies untouched', () => {
    const res = resolveRowRefs({ title: 'C' }, 2, ctxWithLanded(rows, [0, 1]));
    expect(res).toEqual({ ok: true });
  });

  it('passes an existing task id straight through', () => {
    // No sigil means "an id you already hold" — the behaviour that predates
    // batch-local refs, unchanged.
    const res = resolveRowRefs(
      { title: 'C', after: ['t-alreadyHeld'] },
      2,
      ctxWithLanded(rows, [0, 1]),
    );
    expect(res).toEqual({ ok: true, after: ['t-alreadyHeld'] });
  });

  it('resolves a key reference and a numeric index to the row that landed', () => {
    const ctx = ctxWithLanded(rows, [0, 1]);
    expect(resolveRowRefs({ after: ['#seed'] }, 2, ctx)).toEqual({ ok: true, after: ['t-row0'] });
    expect(resolveRowRefs({ after: [1] }, 2, ctx)).toEqual({ ok: true, after: ['t-row1'] });
    expect(resolveRowRefs({ after: ['#1'] }, 2, ctx)).toEqual({ ok: true, after: ['t-row1'] });
  });

  it('resolves afterEnforce through the same map, so the subset rule survives', () => {
    // afterEnforce must be a SUBSET of after or the store refuses the row.
    // Resolving them apart would make `["#seed"]` in both arrays come out as
    // two different strings and fail a check the caller satisfied.
    const res = resolveRowRefs(
      { after: ['#seed'], afterEnforce: ['#seed'] },
      2,
      ctxWithLanded(rows, [0, 1]),
    );
    expect(res).toEqual({ ok: true, after: ['t-row0'], afterEnforce: ['t-row0'] });
  });

  it('refuses a forward reference — including a row pointing at itself', () => {
    const ctx = ctxWithLanded(rows, [0, 1]);
    // Rows are created in order, so a later row does not exist yet. Refusing
    // beats creating the task with the edge silently missing.
    const forward = resolveRowRefs({ after: [2] }, 1, ctx);
    expect(forward).toMatchObject({ ok: false, error: FORWARD_BATCH_REF_ERROR });
    const self = resolveRowRefs({ after: [1] }, 1, ctx);
    expect(self).toMatchObject({ ok: false, error: FORWARD_BATCH_REF_ERROR });
    // The message has to say which way round the rule goes, or the caller
    // reorders at random.
    expect((forward as { message: string }).message).toContain('above');
  });

  it('refuses an index outside the batch and a key nothing declared', () => {
    const ctx = ctxWithLanded(rows, [0, 1]);
    expect(resolveRowRefs({ after: [9] }, 2, ctx)).toMatchObject({
      ok: false,
      error: UNKNOWN_BATCH_REF_ERROR,
    });
    expect(resolveRowRefs({ after: [-1] }, 2, ctx)).toMatchObject({
      ok: false,
      error: UNKNOWN_BATCH_REF_ERROR,
    });
    expect(resolveRowRefs({ after: [1.5] }, 2, ctx)).toMatchObject({
      ok: false,
      error: UNKNOWN_BATCH_REF_ERROR,
    });
    const missing = resolveRowRefs({ after: ['#nosuchkey'] }, 2, ctx);
    expect(missing).toMatchObject({ ok: false, error: UNKNOWN_BATCH_REF_ERROR });
    expect((missing as { message: string }).message).toContain('nosuchkey');
  });

  it('refuses a row whose dependency row FAILED, rather than dropping the edge', () => {
    // This is the case the whole module exists for. Row 0 did not land, so
    // `#seed` names nothing — and a task created here would declare a
    // dependency that never blocks it.
    const ctx = ctxWithLanded(rows, [1]); // row 0 failed
    const res = resolveRowRefs({ after: ['#seed'] }, 2, ctx);
    expect(res).toMatchObject({ ok: false, error: BATCH_DEP_ROW_FAILED_ERROR });
    expect((res as { message: string }).message).toContain('0');
  });

  it('ignores an `after` that is not an array — the body parser owns that', () => {
    const res = resolveRowRefs({ after: 'nope' }, 2, ctxWithLanded(rows, [0, 1]));
    expect(res).toEqual({ ok: true });
  });
});
