/**
 * One channel message per event, however many SSE streams carried it.
 *
 * A doc's thread events now reach its own channel, its `ws~<grouping>`
 * channel, AND every `ws~<board>` whose `workspace.docIds` holds it. That is
 * deliberate — it is what lets a lead declare itself once and receive
 * everything filed on the board afterwards, with no per-doc subscribe. The
 * cost is that an agent holding two of those streams (created the diff
 * review AND leads the board holding it) receives each frame twice. This
 * collapses that back to one. It also fixes a wart that predates the fan-out:
 * an agent watching both a task body doc and its board was already
 * double-delivered.
 *
 * WHY THIS KEY. `rooms.ts` bumps a PER-ROOM monotonic `seq` on every thread
 * and suggestion event (`fireEvent`, `fireSuggestionEvent`) before handing
 * the payload to `broadcastToRoom`, which fans the SAME object out to every
 * channel. So within one room `seq` separates two real events, and across
 * rooms it collides freely — `docId` is in the key for that reason, and
 * `seq` alone would not be a key at all. `event` joins them because a
 * `thread.replied` and a `thread.resolved` are distinct deliveries.
 *
 * WHY IT FAILS OPEN. A dropped frame is silence, and an agent cannot tell
 * silence from "nobody commented" — that is the exact failure class this
 * ticket exists to close, so a dedup that over-suppresses would reintroduce
 * it in a harder-to-see form. Anything the key cannot positively identify is
 * therefore forwarded: no numeric `seq`, no docId, not an object. Every hub
 * `task.*` / `decision.*` / `voice.*` / `triage.*` event is in that category
 * — none carry a `seq`, each rides exactly one channel, and two of them can
 * be byte-identical and both real (two voice notes with the same text). For
 * those there is no duplicate to suppress and a collision would be a true
 * drop.
 */

/** Keys retained. Two channels deliver a frame within milliseconds of each
 *  other, so the window only has to outlive that skew; a few hundred keys is
 *  already orders of magnitude more than needed and costs a few KB in a
 *  process that lives for days. */
const DEFAULT_LIMIT = 512;

/**
 * Build the dedup predicate for one MCP process.
 *
 * @returns `shouldForward(event, payload)` — true to emit a channel message,
 *   false when this exact event was already forwarded. Stateful; one per
 *   process, called from `handleFrame` before `emitChannelMessage`.
 */
export function createFrameDedup(
  limit: number = DEFAULT_LIMIT,
): (event: string, payload: unknown) => boolean {
  // Insertion-ordered, which is what makes eviction oldest-first without a
  // second structure to keep in step.
  const seen = new Set<string>();

  return function shouldForward(event: string, payload: unknown): boolean {
    const key = frameKey(event, payload);
    if (key === undefined) return true; // unidentifiable → forward, never drop
    if (seen.has(key)) return false;
    seen.add(key);
    // Bounded so a session running for days cannot grow this without limit.
    // A key evicted early is forwarded again — over-delivery, the safe
    // direction — and cannot happen in practice at this window size.
    while (seen.size > limit) {
      const oldest = seen.values().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    return true;
  };
}

/** The identity of one delivered event, or undefined when the frame does not
 *  carry enough to be identified. */
function frameKey(event: string, payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { docId?: unknown; seq?: unknown };
  if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) return undefined;
  if (typeof p.docId !== 'string' || p.docId === '') return undefined;
  return `${event}#${p.docId}#${p.seq}`;
}
