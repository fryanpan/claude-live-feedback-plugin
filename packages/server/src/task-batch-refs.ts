/**
 * Dependencies BETWEEN rows of one batch.
 *
 * `after` has always been able to name a task id you already hold. Inside a
 * batch you hold none of them — the ids are minted as the rows land — so
 * until now a burst with any internal ordering needed a second call
 * (`set_task_dependencies`) after the fact. Pushing every create through the
 * batch makes that gap louder, not quieter, so a row can now name another row
 * of the SAME batch.
 *
 * Two spellings, one meaning:
 *   - a number, or `"#<digits>"` — the 0-based index of a row in this batch;
 *   - `"#<key>"` — the `key` another row of this batch declared.
 * Anything else is an existing task id, exactly as before.
 *
 * ## Why the sigil is required
 *
 * Without it, `after: ["seed"]` would need a precedence rule between "a key
 * in this batch" and "a task id". A field that is sometimes caller-authored
 * and sometimes derived is this repo's most reliable bug generator, and the
 * failure mode here is the silent one: `openBlockers` skips an `after` id it
 * cannot resolve, so a mis-resolved edge does not error, it just never
 * blocks. With the sigil, resolution is total — a `#` entry is batch-local
 * and nothing else, an entry without one is an id and nothing else.
 *
 * Everything that could make a reference ambiguous is refused where the key
 * is DECLARED rather than at each site that reads it: one refusal, one
 * message, and no reachable-only-in-the-field branch.
 *
 * ## Why backwards only
 *
 * Rows are created in the order given, so a row can only depend on a row
 * ABOVE it. A forward reference is refused rather than wired up in a second
 * pass, because the second pass has to answer "the row you depend on failed,
 * so you now exist with no edge" — and a task carrying a dependency that
 * never blocks it is precisely what `unknown-after` was added to prevent.
 * The same reasoning is why a reference to a row that FAILED fails this row
 * too, instead of quietly dropping the edge.
 */

/** Marks a reference as batch-local. Not part of the key it precedes. */
export const BATCH_REF_SIGIL = '#';

export const BAD_BATCH_KEY_ERROR = 'bad-batch-key';
export const DUPLICATE_BATCH_KEY_ERROR = 'duplicate-batch-key';
export const UNKNOWN_BATCH_REF_ERROR = 'unknown-batch-ref';
export const FORWARD_BATCH_REF_ERROR = 'forward-batch-ref';
export const BATCH_DEP_ROW_FAILED_ERROR = 'batch-dep-row-failed';

export interface BatchKeyIndex {
  /** Declared key → the row index that declared it. */
  keyToIndex: Map<string, number>;
  /** Row index → the refusal that row's own `key` earned. */
  keyErrors: Map<number, { error: string; message: string }>;
}

export interface BatchRefContext {
  keyToIndex: ReadonlyMap<string, number>;
  /**
   * Row index → the id that row was created with. A row index BELOW the one
   * being resolved and absent from here is a row that failed, which is the
   * only way this map can have a hole.
   */
  idByIndex: ReadonlyMap<number, string>;
  rowCount: number;
}

export type RowRefsResult =
  | { ok: true; after?: string[]; afterEnforce?: string[] }
  | { ok: false; error: string; message: string };

const DIGITS = /^\d+$/;

/**
 * Read every row's `key` once, up front.
 *
 * A key is refused when it could be read as something other than a label:
 * empty or blank (names nothing), sigil-prefixed (`#seed` would have to be
 * referenced as `##seed`), or all digits (`"12"` would be indistinguishable
 * from index 12 at every reference site). The first row to claim a key keeps
 * it; a later duplicate is refused, because refusing both would punish the
 * row that was fine and there is no way to know which one the caller meant.
 */
export function indexBatchKeys(rows: readonly unknown[]): BatchKeyIndex {
  const keyToIndex = new Map<string, number>();
  const keyErrors = new Map<number, { error: string; message: string }>();
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) continue;
    const raw = (row as { key?: unknown }).key;
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      keyErrors.set(index, {
        error: BAD_BATCH_KEY_ERROR,
        message: '`key` must be a non-empty string — it is the label other rows reference.',
      });
      continue;
    }
    const key = raw.trim();
    if (key.startsWith(BATCH_REF_SIGIL)) {
      keyErrors.set(index, {
        error: BAD_BATCH_KEY_ERROR,
        message: `\`key\` must not start with "${BATCH_REF_SIGIL}" — that is the reference sigil, not part of the key. Declare "${key.slice(BATCH_REF_SIGIL.length)}" and reference it as "${key}".`,
      });
      continue;
    }
    if (DIGITS.test(key)) {
      keyErrors.set(index, {
        error: BAD_BATCH_KEY_ERROR,
        message: `\`key\` must not be all digits — "${BATCH_REF_SIGIL}${key}" already means row index ${key}. Use a word.`,
      });
      continue;
    }
    const claimed = keyToIndex.get(key);
    if (claimed !== undefined) {
      keyErrors.set(index, {
        error: DUPLICATE_BATCH_KEY_ERROR,
        message: `key "${key}" is already declared by row ${claimed}. Keys must be unique within a batch.`,
      });
      continue;
    }
    keyToIndex.set(key, index);
  }
  return { keyToIndex, keyErrors };
}

/** One `after` / `afterEnforce` entry → a real task id, or the refusal it earns. */
function resolveEntry(
  entry: unknown,
  field: string,
  index: number,
  ctx: BatchRefContext,
): { ok: true; id: string } | { ok: false; error: string; message: string } {
  let target: number | undefined;

  if (typeof entry === 'number') {
    target = entry;
  } else if (typeof entry === 'string' && entry.startsWith(BATCH_REF_SIGIL)) {
    const label = entry.slice(BATCH_REF_SIGIL.length);
    if (DIGITS.test(label)) {
      target = Number(label);
    } else {
      const found = ctx.keyToIndex.get(label);
      if (found === undefined) {
        return {
          ok: false,
          error: UNKNOWN_BATCH_REF_ERROR,
          message: `\`${field}\` names "${entry}", but no row in this batch declares key "${label}". Give that row \`key: "${label}"\`, or name a task id you already hold.`,
        };
      }
      target = found;
    }
  } else if (typeof entry === 'string') {
    // No sigil: an id the caller already holds. The store is the gate for
    // whether it exists.
    return { ok: true, id: entry };
  } else {
    return {
      ok: false,
      error: UNKNOWN_BATCH_REF_ERROR,
      message: `\`${field}\` takes task ids, row indexes, or "${BATCH_REF_SIGIL}<key>" references — not ${typeof entry}.`,
    };
  }

  if (!Number.isInteger(target) || target < 0 || target >= ctx.rowCount) {
    return {
      ok: false,
      error: UNKNOWN_BATCH_REF_ERROR,
      message: `\`${field}\` names row ${target}, but this batch has rows 0..${ctx.rowCount - 1}.`,
    };
  }
  if (target >= index) {
    return {
      ok: false,
      error: FORWARD_BATCH_REF_ERROR,
      message: `\`${field}\` names row ${target}, which is not above row ${index}. Rows are created in the order given, so a row can only depend on a row above it — reorder the batch.`,
    };
  }
  const id = ctx.idByIndex.get(target);
  if (id === undefined) {
    return {
      ok: false,
      error: BATCH_DEP_ROW_FAILED_ERROR,
      message: `\`${field}\` names row ${target}, which did not land — see its entry in \`failures\`. This row was not created either, because a task whose dependency is missing would never actually be blocked by it.`,
    };
  }
  return { ok: true, id };
}

function resolveField(
  raw: unknown,
  field: string,
  index: number,
  ctx: BatchRefContext,
): { ok: true; ids?: string[] } | { ok: false; error: string; message: string } {
  // A non-array is not this module's business — `parseTaskCreate` decides
  // what an `after` that isn't a list means, and answering it twice is how
  // two layers come to disagree.
  if (!Array.isArray(raw)) return { ok: true };
  const ids: string[] = [];
  for (const entry of raw) {
    const res = resolveEntry(entry, field, index, ctx);
    if (!res.ok) return res;
    ids.push(res.id);
  }
  return { ok: true, ids };
}

/**
 * A batch row's `after` / `afterEnforce` with every batch-local reference
 * replaced by the id it names, or the single refusal that row earned.
 *
 * Both fields go through the same map deliberately: `afterEnforce` must be a
 * subset of `after`, and resolving them apart would let one spelling come out
 * as two different strings and fail a check the caller had satisfied.
 */
export function resolveRowRefs(row: unknown, index: number, ctx: BatchRefContext): RowRefsResult {
  if (typeof row !== 'object' || row === null) return { ok: true };
  const r = row as { after?: unknown; afterEnforce?: unknown };
  const after = resolveField(r.after, 'after', index, ctx);
  if (!after.ok) return after;
  const enforce = resolveField(r.afterEnforce, 'afterEnforce', index, ctx);
  if (!enforce.ok) return enforce;
  return {
    ok: true,
    ...(after.ids !== undefined ? { after: after.ids } : {}),
    ...(enforce.ids !== undefined ? { afterEnforce: enforce.ids } : {}),
  };
}
