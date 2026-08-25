/**
 * One channel message per event, however many SSE streams carried it.
 *
 * A doc's thread events now reach its own channel, its `ws~<setId>`
 * channel, AND every `ws~<board>` whose `workspace.docIds` holds it. That is
 * deliberate — it is what lets a lead declare itself once and receive
 * everything filed on the board afterwards, with no per-doc subscribe. The
 * cost is that an agent holding two of those streams (created the diff
 * review AND leads the board holding it) receives each frame twice. This
 * collapses that back to one. It also fixes a wart that predates the fan-out:
 * an agent watching both a task body doc and its board was already
 * double-delivered.
 *
 * WHY IT FAILS OPEN, AND WHY THAT IS THE WHOLE DESIGN. A dropped frame is
 * silence, and an agent cannot tell silence from "nobody commented" — the
 * exact failure class this ticket exists to close. A dedup that
 * over-suppresses would reintroduce it in a harder-to-see form, so every
 * ambiguity here resolves towards forwarding: an extra copy is a visible
 * annoyance, a missing one is invisible.
 *
 * WHAT IDENTIFIES AN EVENT. In order:
 *
 *  1. `eid` — a process-unique id the server stamps in `broadcastToRoom`
 *     before the fan-out, so every channel carrying one broadcast carries the
 *     same string and no two broadcasts ever share one. This is the only key
 *     that is correct by construction, and it is what a current server sends.
 *  2. `${event}#${docId}#${seq}` — the fallback for a server older than that
 *     stamp (a new bundle against an un-restarted box is normal here).
 *     `rooms.ts` bumps a PER-ROOM monotonic `seq` on every thread and
 *     suggestion event, so within one room `seq` separates two real events
 *     and across rooms it collides freely — hence `docId`, and hence `seq`
 *     alone is not a key at all.
 *
 * WHY THE FALLBACK NEEDS A WINDOW. `room.seq` is a field on the in-memory
 * room, initialised to 0 by `getOrCreate` and never persisted into the
 * `.ydoc`. Every server start — a deploy, a `bun --watch` reload — rebuilds
 * every room counting from 1 again, while this process lives for days. So
 * that key is unique only WITHIN a server epoch, and a set that outlived the
 * epoch would swallow the first real comment on every doc it had already
 * heard from. Two things bound it: `reset()`, called whenever an SSE loop
 * RECONNECTS (which is what a server restart looks like from in here), and a
 * wall-clock TTL for the cases a reconnect does not cover — a room destroyed
 * and rebuilt under a live server (`delete_workspace` then re-create with the
 * same id). The two copies of one broadcast arrive milliseconds apart, so a
 * window of seconds is already enormous for the job it has to do.
 *
 * Anything the key cannot positively identify is forwarded: no `eid`, no
 * numeric `seq`, no docId, not an object. Every hub `task.*` / `decision.*` /
 * `voice.*` event is in that category — none carry a `seq`, each
 * rides exactly one channel, and two can be byte-identical and both real (two
 * voice notes with the same text). For those there is no duplicate to
 * suppress and a collision would be a true drop.
 */

/** Keys retained. Two channels deliver a frame within milliseconds of each
 *  other, so the window only has to outlive that skew; a few hundred keys is
 *  already orders of magnitude more than needed and costs a few KB in a
 *  process that lives for days. */
const DEFAULT_LIMIT = 512;

/** How long a key can suppress. Same reasoning as the count bound, in the
 *  other unit — and it is the one that makes a stale `seq` key harmless
 *  rather than fatal when no reconnect was observed. */
const DEFAULT_TTL_MS = 30_000;

export interface FrameDedup {
  /** True to emit a channel message, false when this exact event was already
   *  forwarded. */
  shouldForward(event: string, payload: unknown): boolean;
  /**
   * Forget everything seen so far.
   *
   * Called when an SSE loop reconnects. A reconnect means the stream broke,
   * and the overwhelmingly common reason is that the server restarted — which
   * reset every room's `seq` to 0, making every key held here able to collide
   * with a genuinely new event. Dropping the window costs at most a duplicate
   * (both copies of an in-flight broadcast get forwarded); keeping it costs a
   * comment nobody ever hears about.
   */
  reset(): void;
}

/**
 * Build the dedup for one MCP process.
 *
 * Stateful; one per process, called from `handleFrame` before
 * `emitChannelMessage`. A per-loop instance would see nothing — the whole
 * point is catching a frame the OTHER stream already delivered.
 */
export function createFrameDedup(opts?: {
  limit?: number;
  ttlMs?: number;
  now?: () => number;
}): FrameDedup {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;
  // Insertion-ordered, which is what makes eviction oldest-first without a
  // second structure to keep in step. Value is the moment it was inserted.
  const seen = new Map<string, number>();

  function shouldForward(event: string, payload: unknown): boolean {
    const key = frameKey(event, payload);
    if (key === undefined) return true; // unidentifiable → forward, never drop
    const t = now();
    const at = seen.get(key);
    if (at !== undefined && t - at < ttlMs) return false;
    // Re-insert rather than update, so an expired key moves back to the young
    // end of the eviction order instead of sitting at the old one.
    seen.delete(key);
    seen.set(key, t);
    // Bounded so a session running for days cannot grow this without limit.
    // A key evicted early is forwarded again — over-delivery, the safe
    // direction — and cannot happen in practice at this window size.
    while (seen.size > limit) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
    return true;
  }

  return { shouldForward, reset: () => seen.clear() };
}

/** The identity of one delivered event, or undefined when the frame does not
 *  carry enough to be identified. */
function frameKey(event: string, payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as { docId?: unknown; seq?: unknown; eid?: unknown };
  // The server's own id when it sends one: unique across restarts by
  // construction, so it needs no docId and no window to be safe.
  if (typeof p.eid === 'string' && p.eid !== '') return `eid#${p.eid}`;
  if (typeof p.seq !== 'number' || !Number.isFinite(p.seq)) return undefined;
  if (typeof p.docId !== 'string' || p.docId === '') return undefined;
  return `${event}#${p.docId}#${p.seq}`;
}
