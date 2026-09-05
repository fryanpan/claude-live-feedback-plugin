/**
 * The reconnect cursor of a MULTIPLEXED agent stream: one `Last-Event-ID`
 * value carrying a per-key position.
 *
 * WHY IT IS NOT JUST AN ID. On a per-key stream the cursor is a single wire
 * id and `replayAfter` anchors on it exactly. One stream carrying N keys has
 * N positions, and they cannot be collapsed into one: event ids are
 * `<boot>:<n>`, so two ids from the same process are ordered — but the moment
 * the server restarts, the boot nonce changes and nothing about the old ids
 * is comparable with the new ones. A single global cursor would therefore
 * report a gap on every quiet key after every deploy, which is exactly the
 * vacuous-gap wave `SseBus.lastEver` was written to end.
 *
 * So the client presents what it actually knows: the last id it DELIVERED on
 * each key it has heard anything on. A key with no entry gets no replay
 * attempted and no gap notice — identical to a per-key stream that has never
 * received a frame, which is the semantics this format is preserving rather
 * than inventing.
 *
 * WIRE FORMAT (v1):
 *
 *     mux1:<key>=<eventId>,<key>=<eventId>,...
 *
 * A watch key matches `agent-watches.ts`'s `KEY_RE` — letters, digits and
 * `_ . : ~ -` — and an event id is `<8 hex>:<counter>`. Neither can contain
 * `=` or `,`, so those two separators need no escaping, and splitting a pair
 * on its FIRST `=` is unambiguous.
 *
 * DUPLICATED, ON PURPOSE. The MCP bundle imports nothing from the server —
 * `packages/mcp/scripts/build.ts` bundles a standalone file and pulling
 * `@feedback/core` in would drag yjs into it — so the encoder lives at
 * `packages/mcp/src/mux-cursor.ts` and this is the decoder. The two are
 * pinned together by `packages/server/test/sse-mux.test.ts`, which imports
 * the client's formatter and parses its output here; change one and that
 * test fails rather than the fleet going quiet.
 */

export const MUX_CURSOR_PREFIX = 'mux1:';

/**
 * Parse a multiplexed cursor, or `undefined` when the value is absent or is
 * not one.
 *
 * A malformed PAIR is skipped rather than failing the whole cursor: dropping
 * one key's position costs that key its replay (it reconnects like a fresh
 * key), where rejecting the value costs every key its position at once.
 * Refusing the whole header is the failure that turns one bad entry into a
 * fleet-wide gap.
 */
export function parseMuxCursor(value: string | undefined): Map<string, string> | undefined {
  if (!value || !value.startsWith(MUX_CURSOR_PREFIX)) return undefined;
  const body = value.slice(MUX_CURSOR_PREFIX.length);
  const out = new Map<string, string>();
  if (body.length === 0) return out;
  for (const pair of body.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const id = pair.slice(eq + 1);
    if (key.length === 0 || id.length === 0) continue;
    out.set(key, id);
  }
  return out;
}

/** Whether a `Last-Event-ID` names a multiplexed cursor rather than a single
 *  wire id. Lets one route accept both shapes without guessing. */
export function isMuxCursor(value: string | undefined): boolean {
  return value?.startsWith(MUX_CURSOR_PREFIX) ?? false;
}
