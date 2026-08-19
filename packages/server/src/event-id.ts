/**
 * A globally unique id for one broadcast — the thing `seq` is not.
 *
 * `room.seq` is a monotonic counter on the in-memory room, initialised to 0
 * by `Rooms.getOrCreate` and never written into the `.ydoc`. It separates two
 * events WITHIN one server epoch and nothing more: every restart (a deploy, a
 * `bun --watch` reload) rebuilds every room counting from 1 again, and a room
 * destroyed and re-created under a live server does the same. A subscriber
 * that outlives the server — the MCP child lives for a whole Claude Code
 * session, days — therefore cannot use `seq` to tell "the second copy of one
 * broadcast" from "a new comment that happens to be this room's first since
 * the restart". It has to guess, and both guesses are wrong somewhere:
 * suppress and a real comment is silently swallowed, forward and every
 * multi-channel delivery is doubled.
 *
 * So the server answers instead. `boot` is random per PROCESS, `n` is
 * monotonic within it, and `broadcastToRoom` stamps one id per broadcast
 * before the fan-out — so every channel carrying that broadcast carries the
 * same string, and no two broadcasts anywhere ever share one.
 *
 * Its own module (rather than a pair of `let`s in rooms.ts) so a test can
 * prove the process-scoped half: two subprocesses importing this must not
 * agree on `boot`, and nothing that boots a whole server can show that.
 */

/** Random per process. 8 hex chars is ~4 billion — collisions across two
 *  server lifetimes on one box are not a hazard worth more bytes. */
const BOOT = Math.floor(Math.random() * 0xffffffff)
  .toString(16)
  .padStart(8, '0');

let counter = 0;

/** The boot nonce this process stamps into every event id. Exported for the
 *  test that proves it differs across processes. */
export function bootNonce(): string {
  return BOOT;
}

export function newEventId(): string {
  counter += 1;
  return `${BOOT}:${counter}`;
}
