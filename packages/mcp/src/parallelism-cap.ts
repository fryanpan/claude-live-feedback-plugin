/**
 * Argument check for `set_parallelism_cap`.
 *
 * The route refuses a bad cap too, but as a 400 the tool relays as a thrown
 * route error — a status and a path, not a sentence about what to send.
 * Checking here means the refusal names what arrived and what was wanted,
 * and no request is made for a value that could never land. Only the SHAPE
 * is judged here: the range (the floor is one, the ceiling the server's
 * PARALLELISM_CAP_MAX) belongs to the server, which is the one that knows it.
 */
export type CapArg = { ok: true; cap: number } | { ok: false; error: string };

export function parseCapArg(raw: unknown): CapArg {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    return { ok: true, cap: raw };
  }
  const shown = typeof raw === 'string' ? JSON.stringify(raw) : String(raw);
  return {
    ok: false,
    error: `cap must be a positive integer — the most builders the board may have dispatched at once (got ${shown}). Pass a number of 1 or more, not a string.`,
  };
}
