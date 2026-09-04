/**
 * The client half of the multiplexed reconnect cursor — see
 * `packages/server/src/mux-cursor.ts` for the wire format and for why one
 * stream carrying N keys cannot present a single wire id.
 *
 * Duplicated rather than shared because the MCP bundle imports nothing
 * outside `packages/mcp/src` (the build produces one standalone file, and
 * reaching into `@feedback/core` would drag yjs into it). The two halves are
 * pinned together by `packages/server/test/sse-mux.test.ts`, which imports
 * THIS formatter and parses its output with the server's decoder.
 */

export const MUX_CURSOR_PREFIX = 'mux1:';

/**
 * A header this long is refused by some HTTP stacks long before it is useful,
 * and a lead session can legitimately hold hundreds of keys. 6 KB is roughly
 * 200 entries at the sizes this fleet actually produces (a ~15-char key plus
 * a ~13-char id plus two separators), and sits well under the 16 KB most
 * servers allow for the whole header block.
 */
export const MUX_CURSOR_MAX_BYTES = 6_000;

export interface FormattedMuxCursor {
  /** The header value, or undefined when there is nothing to present. */
  value: string | undefined;
  /** Keys whose position did not fit and was left out. They reconnect as
   *  though they had never received a frame — no replay, no gap notice — so
   *  the caller drops its dedup window, exactly as it does on a real gap. */
  dropped: string[];
}

/**
 * Encode the per-key positions, newest-first, into one `Last-Event-ID`.
 *
 * `cursors` is iterated in ITS OWN order and the caller is expected to keep
 * it most-recently-advanced first, because the budget below drops from the
 * tail: when something has to go, it should be the key that has been quiet
 * longest, not the one mid-conversation.
 */
export function formatMuxCursor(
  cursors: Iterable<[string, string]>,
  maxBytes: number = MUX_CURSOR_MAX_BYTES,
): FormattedMuxCursor {
  const parts: string[] = [];
  const dropped: string[] = [];
  let length = MUX_CURSOR_PREFIX.length;
  for (const [key, id] of cursors) {
    if (key.length === 0 || id.length === 0) continue;
    const pair = `${key}=${id}`;
    const cost = pair.length + (parts.length > 0 ? 1 : 0);
    if (length + cost > maxBytes) {
      dropped.push(key);
      continue;
    }
    parts.push(pair);
    length += cost;
  }
  return {
    value: parts.length > 0 ? `${MUX_CURSOR_PREFIX}${parts.join(',')}` : undefined,
    dropped,
  };
}
