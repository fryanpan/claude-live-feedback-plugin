/**
 * Row projection for `list_tasks` — MCP-handler-side only, on purpose.
 *
 * A real board's `list_tasks` came back at 122KB because every row hauled
 * reviews (quotes and answers), infoRequests, options, and evidence whether
 * or not the caller wanted them — enough to overflow a tool-result cap.
 * The REST route is deliberately untouched: an old bundle keeps calling it
 * forever and must keep reading the same shape. The trim happens here, in
 * the layer that ships WITH the caller.
 */

/**
 * With no `fields` (or an empty list), the historical default: drop `body`
 * and `transitions`, keep everything else, add `transitionCount`. With
 * `fields`, each row carries exactly the picked keys — `id` always included
 * so a row stays addressable, keys the row lacks omitted rather than null.
 * `transitionCount` is computed on demand, and an explicit pick of a heavy
 * field (even `body`) is honored: projection filters, it does not censor.
 *
 * Generic rather than an indexed type: the caller's row type (TaskPayload)
 * is a plain interface with no index signature.
 */
export function projectTaskRows<T extends { transitions?: unknown[] }>(
  tasks: T[],
  fields?: string[],
): Array<Record<string, unknown>> {
  const rows = tasks as Array<T & Record<string, unknown>>;
  if (!fields || fields.length === 0) {
    return rows.map(({ body: _body, transitions, ...rest }) => ({
      ...rest,
      transitionCount: transitions?.length ?? 0,
    }));
  }
  const picked = new Set(['id', ...fields]);
  return rows.map((t) => {
    const row: Record<string, unknown> = {};
    for (const key of picked) {
      if (key === 'transitionCount') {
        row.transitionCount = t.transitions?.length ?? 0;
      } else if (key in t) {
        row[key] = t[key];
      }
    }
    return row;
  });
}
