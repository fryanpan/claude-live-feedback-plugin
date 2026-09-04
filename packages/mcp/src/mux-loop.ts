/**
 * ONE reconnecting SSE loop for this whole session, however many keys it
 * watches.
 *
 * WHY. `sse-loop.ts` runs one loop — one TCP socket — per watched key. A lead
 * session with 214 watches held 214 sockets, the fleet reached 332 against one
 * server, and on 2026-09-04 that exhausted the kernel's socket memory. The
 * supervisor read the resulting connect failures as an unbound server and
 * restarted it; every client then redialled every key at once on a fixed
 * 1.5s backoff, and did it twenty times over.
 *
 * So the fan-out moved to the server (`/events/agent/<agentId>`, see
 * `packages/server/src/sse-mux.ts`) and this is its client. N watches, one
 * loop, one socket.
 *
 * THREE THINGS THAT SURVIVED THE MOVE, deliberately:
 *
 *  - **Deliver, THEN commit the cursor.** A frame whose delivery threw must be
 *    re-presented on the next reconnect, not skipped past; see sse-cursor.ts
 *    for the loss the other order caused. Here the cursor is per key, so the
 *    commit is per key too.
 *  - **`open` is the honest answer to "is this stream up".** Every watcher
 *    record now mirrors ONE connection's state, because that is what they
 *    share; a tool that reports a subscription still branches on it rather
 *    than on the map's `has`.
 *  - **A reconnect drops the dedup window.** After a gap every held key may
 *    collide with a genuinely new event, so keeping the window is how a real
 *    comment gets silently swallowed.
 *
 * AND ONE THING THAT IS NEW: a 404 from the mux route means the server is
 * older than this bundle. That is a real state during a rollout — the plugin
 * cache and the server deploy move independently — so the loop reports it
 * once and the registry falls back to the per-key routes rather than
 * retrying a route that will never exist.
 */
import { reconnectDelayMs } from './backoff.ts';
import { formatMuxCursor } from './mux-cursor.ts';
import { frameMeta } from './sse-cursor.ts';
import { type LoopTimers, type Watcher, releaseBody, releaseReader } from './sse-loop.ts';

/** How long `ensureOpen` waits for a first connect outcome before answering
 *  `false`, so a wedged connect never stalls a tool call. Same budget the
 *  per-key starter used. */
const DEFAULT_CONNECT_CAP_MS = 3_000;

export interface MuxLoopDeps {
  /** The live watcher registry, shared with the registry. Every record's
   *  `open` mirrors this one connection. */
  watchers: Map<string, Watcher>;
  /** This session's identity — the agent whose watch set the server fans
   *  out. */
  agentId: string;
  resolveBaseUrl: () => string;
  /** Narrower than `typeof fetch` on purpose; see sse-loop.ts. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** What one delivered frame does; see frame-handler.ts. */
  handleFrame: (raw: string) => Promise<void>;
  /** Drop the dedup window — on a reconnect, on a delivered replay gap, and
   *  when a cursor had to be dropped for size. */
  resetDedup: () => void;
  log: (...args: unknown[]) => void;
  /** Injectable so a test does not wait out a real backoff. */
  sleep: (ms: number) => Promise<void>;
  timers: LoopTimers;
  /** Injectable so a test can pin the jitter draw. */
  random?: () => number;
  connectCapMs?: number;
}

export interface MuxLoop {
  /** Start the loop if it is not running, and answer whether the stream is
   *  actually connected. Safe to call once per watch — only the first call
   *  starts anything. */
  ensureOpen(): Promise<boolean>;
  /** Stop the loop. Called when the last watch goes away. */
  stop(): void;
  /** Whether the one stream is connected right now. */
  isOpen(): boolean;
  /** True once the server has answered 404 — this server predates the mux
   *  route and the caller must use the per-key routes. */
  unsupported(): boolean;
  /** How many loops are running: 0 or 1, ever. The test surface for "N
   *  watches, one socket". */
  loopCount(): number;
  /** Forget one key's replay position, because the watch is gone. */
  dropCursor(key: string): void;
  /** How many positions are held. The test surface for "an unwatched key
   *  stops costing anything". */
  cursorCount(): number;
}

/**
 * The most positions worth holding in memory.
 *
 * `formatMuxCursor` already bounds the WIRE at 6,000 bytes, which is a couple
 * of hundred entries; nothing beyond that can ever be presented. The map
 * itself was unbounded, so a long session that watched and unwatched its way
 * through thousands of docs kept a position for every one of them. Evicting
 * from the front drops the longest-quiet key, which is the same key the wire
 * budget would have dropped anyway.
 */
export const MUX_CURSOR_MAX_KEYS = 512;

interface MuxRuntime {
  controller: AbortController | null;
  running: boolean;
  open: boolean;
  unsupported: boolean;
  /**
   * Per-key positions in advance order — `Map` moves a re-set key to the END,
   * so the oldest position is first and the newest last. `formatMuxCursor`
   * spends its byte budget newest-first, so the encode reverses this once per
   * reconnect rather than reordering the map on every frame.
   */
  cursors: Map<string, string>;
  starting: Promise<boolean> | null;
}

/** The route this session's one stream lives at. */
export function muxPath(agentId: string): string {
  return `/events/agent/${encodeURIComponent(agentId)}`;
}

export function createMuxLoop(deps: MuxLoopDeps): MuxLoop {
  const rt: MuxRuntime = {
    controller: null,
    running: false,
    open: false,
    unsupported: false,
    cursors: new Map(),
    starting: null,
  };
  return {
    ensureOpen: () => ensureOpen(deps, rt),
    stop: () => stop(deps, rt),
    isOpen: () => rt.open,
    unsupported: () => rt.unsupported,
    loopCount: () => (rt.running ? 1 : 0),
    dropCursor: (key) => {
      rt.cursors.delete(key);
    },
    cursorCount: () => rt.cursors.size,
  };
}

function stop(deps: MuxLoopDeps, rt: MuxRuntime): void {
  rt.controller?.abort();
  rt.controller = null;
  rt.running = false;
  rt.starting = null;
  // Through `setOpen`, not by writing `rt.open`: every watcher record mirrors
  // this one connection, and a record left reading `open: true` after the
  // stream is gone is exactly the false subscription claim the flag exists to
  // prevent.
  setOpen(deps, rt, false);
}

function ensureOpen(deps: MuxLoopDeps, rt: MuxRuntime): Promise<boolean> {
  if (rt.unsupported) return Promise.resolve(false);
  // Already up: answer from the live flag rather than opening a second
  // connection. This is the branch every watch after the first takes, and it
  // is the whole "N watches, one socket" property.
  if (rt.running) return rt.starting ?? Promise.resolve(rt.open);
  rt.running = true;
  const controller = new AbortController();
  rt.controller = controller;
  const started = new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (open: boolean) => {
      if (settled) return;
      settled = true;
      deps.timers.clear(cap);
      resolve(open);
    };
    const cap = deps.timers.set(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, deps.connectCapMs ?? DEFAULT_CONNECT_CAP_MS);
    void runMuxLoop(deps, rt, controller.signal, settle).catch((err) => {
      deps.log('[claude-workspaces-mcp] mux loop crashed:', err);
      rt.running = false;
      rt.open = false;
      settle(false);
    });
  });
  rt.starting = started;
  void started.then(() => {
    if (rt.starting === started) rt.starting = null;
  });
  return started;
}

/** Every watcher record shares this one connection, so they share its state. */
function setOpen(deps: MuxLoopDeps, rt: MuxRuntime, open: boolean): void {
  rt.open = open;
  for (const w of deps.watchers.values()) w.open = open;
}

async function runMuxLoop(
  deps: MuxLoopDeps,
  rt: MuxRuntime,
  signal: AbortSignal,
  onFirstAttempt: (open: boolean) => void,
): Promise<void> {
  const path = muxPath(deps.agentId);
  /** Consecutive failed attempts — reset the moment a connect succeeds, so a
   *  long-lived stream that blips once redials in the first window rather
   *  than in the window its whole history earned. */
  let attempt = 0;
  while (!signal.aborted) {
    try {
      // Reversed: the map is oldest-advanced first, and when the budget
      // runs out the key that should lose its position is the one that has
      // been quiet longest, not the one mid-conversation.
      const { value, dropped } = formatMuxCursor([...rt.cursors].reverse());
      if (dropped.length > 0) {
        // A dropped position is a key reconnecting as though it had never
        // received a frame: no replay, and no gap notice on its behalf. Say
        // so, and drop the dedup window for the same reason a real gap does.
        deps.log(
          `[claude-workspaces-mcp] mux cursor over budget — ${dropped.length} key(s) reconnect without a position`,
        );
        deps.resetDedup();
      }
      const res = await deps.fetch(`${deps.resolveBaseUrl()}${path}`, {
        signal,
        ...(value ? { headers: { 'Last-Event-ID': value } } : {}),
      });
      if (res.status === 404) {
        // This server predates the route. Not a transient failure and not
        // worth a retry loop: say so once and let the registry fall back.
        await releaseBody(res);
        rt.unsupported = true;
        rt.running = false;
        setOpen(deps, rt, false);
        onFirstAttempt(false);
        deps.log(
          '[claude-workspaces-mcp] server has no multiplexed event route — falling back to one stream per watch',
        );
        return;
      }
      const live = res.ok && res.body !== null;
      setOpen(deps, rt, live);
      onFirstAttempt(live);
      if (!live) {
        // Hand the body back before throwing. An un-consumed, un-cancelled
        // response body holds its connection on the platform side, and a
        // retrying loop that skips this leaks one protocol control block per
        // attempt — see the constants in sse-loop.ts for what that cost.
        await releaseBody(res);
        throw new Error(`sse ${path} → ${res.status}`);
      }
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      /**
       * Frames read on THIS connection, including the `:ok` preamble and the
       * keepalive comments.
       *
       * The attempt counter used to reset the moment headers came back 200,
       * which reads as health and is not: a server that accepts a connection
       * and immediately closes it answers 200 every time, so the backoff
       * would never grow and the client would redial it forever at the base
       * window. More than one frame means the stream outlived its own
       * preamble — in practice a keepalive, so about fifteen seconds of a
       * working connection — and that is the thing worth resetting on.
       */
      let framesRead = 0;
      try {
        while (!signal.aborted) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(chunk, { stream: true });
          // Split on blank-line boundaries per SSE framing.
          let sep = buf.indexOf('\n\n');
          while (sep >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            framesRead += 1;
            // Reset here rather than after the read loop: a long-lived stream
            // that finally throws is still a stream that was working, and a
            // reset that only ran on a clean end-of-stream would never fire
            // for it.
            if (framesRead > 1) attempt = 0;
            await deliverThenCommitMux(frame, deps.handleFrame, rt.cursors, deps.resetDedup);
            sep = buf.indexOf('\n\n');
          }
        }
      } finally {
        // Abort, throw or clean end — the reader goes back either way, so the
        // platform can reclaim the connection.
        await releaseReader(reader);
      }
    } catch (err) {
      setOpen(deps, rt, false);
      onFirstAttempt(false);
      if (signal.aborted) break;
      deps.log('[claude-workspaces-mcp] mux sse error, retrying:', err);
    }
    if (signal.aborted) break;
    // A clean end-of-stream lands here too, and it is just as much "not
    // connected" as a throw is.
    setOpen(deps, rt, false);
    attempt += 1;
    await deps.sleep(reconnectDelayMs(attempt, deps.random));
    if (signal.aborted) break;
    // A reconnect is what a server restart looks like from in here, and a
    // restart rebuilds every room with `seq` back at 0 — so every key the
    // dedup holds can now collide with a genuinely NEW event and silently
    // swallow it. Drop the window.
    deps.resetDedup();
  }
  rt.running = false;
  setOpen(deps, rt, false);
  onFirstAttempt(false);
}

/** The watch key a multiplexed frame arrived on, as the server tagged it.
 *  Opaque to this process: the server stores canonical doc ids and a caller
 *  may have watched by an alias, so this is a cursor key and nothing else. */
export function frameWatchKey(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as { watchKey?: unknown };
      return typeof parsed.watchKey === 'string' ? parsed.watchKey : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Deliver one multiplexed frame, THEN commit its effect on that key's cursor.
 *
 * The per-key counterpart of `deliverThenCommit`, and the ordering is
 * load-bearing for the same reason: a frame whose delivery threw leaves the
 * cursor where it was, so the reconnect re-presents the old id and the server
 * replays the frame rather than skipping it.
 *
 * A delivered `replay.gap` clears THAT KEY's cursor only — presenting the
 * stale id again would just buy another gap notice — and drops the dedup
 * window, which is process-wide because the window is.
 */
export async function deliverThenCommitMux(
  frame: string,
  deliver: (frame: string) => Promise<void>,
  cursors: Map<string, string>,
  onGap: () => void,
): Promise<void> {
  await deliver(frame);
  const meta = frameMeta(frame);
  const key = frameWatchKey(frame);
  if (key === undefined) return;
  if (meta.event === 'replay.gap') {
    cursors.delete(key);
    onGap();
    return;
  }
  if (meta.id === undefined) return;
  // Delete-then-set moves the key to the end, so the map stays in advance
  // order and the encoder's budget can be spent on the busiest keys.
  cursors.delete(key);
  cursors.set(key, meta.id);
  // Bound the map. Front-first eviction drops the longest-quiet key, which is
  // the one the wire budget would have dropped on the next reconnect anyway.
  while (cursors.size > MUX_CURSOR_MAX_KEYS) {
    const oldest = cursors.keys().next();
    if (oldest.done) break;
    cursors.delete(oldest.value);
  }
}
