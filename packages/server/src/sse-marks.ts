/**
 * What the SSE replay buffer remembers across a restart: for each channel, the
 * newest wire id each AUDIENCE on it saw — the newest broadcast, plus the
 * frames addressed to one agent that came after it.
 *
 * That one id per channel is the whole difference between a deploy that is
 * silent and a deploy that tells every subscriber to refetch. Event ids carry
 * a per-process boot nonce (`event-id.ts`), so after a restart every cursor a
 * session presents is from an epoch this process never issued — and with only
 * the in-memory buffer to consult, `replayAfter` cannot tell "you are exactly
 * up to date" from "you are behind by an unknown amount". It said the second,
 * for every channel, on every restart. Measured 2026-08-21: waves of
 * `replay.gap` across a session's whole watch set, every one of them followed
 * by a refetch that found nothing.
 *
 * With the marks it can answer honestly. A cursor equal to a channel's final
 * pre-shutdown id missed nothing — nothing was broadcast after it, and nothing
 * is broadcast while the process is down.
 *
 * ## Trusted only across a CLEAN shutdown, and that is the safety argument
 *
 * The failure that matters is not a spurious gap — it is a stale mark read as
 * current, which tells a subscriber "nothing was missed" about events that
 * were. That happens whenever the file stops short of the real history, which
 * is exactly what a crash leaves behind.
 *
 * So the file carries an `open` flag written at two moments: `claimReplayMarks`
 * re-stamps it open as it reads, `saveReplayMarks` closes it on the way out. A
 * process that never reaches its shutdown path leaves it open, and the next
 * boot discards the marks and falls back to the old behaviour — one gap per
 * stream, conservative and correct. Marks are therefore written once per
 * process lifetime, at shutdown, and never on the broadcast path.
 *
 * Size: one short string per channel ever broadcast on, carried forward across
 * restarts — so strictly fewer entries than there are `.ydoc` files sitting
 * beside it in the same data dir, and no cap is worth the recency bookkeeping
 * it would need.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One channel's marks.
 *
 * The bare string is the whole record for the overwhelmingly common channel —
 * broadcasts only — and it is also the shape every file written before
 * addressed marks existed carries, so an old file reads without a migration.
 * The object form appears only once a channel has an addressed frame with no
 * broadcast after it: `broadcast` is the newest id everyone saw, and
 * `addressedAfter` maps an addressee to the newest frame addressed to IT since
 * that broadcast. A broadcast is visible to every subscriber, so it retires
 * every addressed mark older than itself — which is why no ordering has to be
 * written down, and why this map cannot grow without bound.
 */
export type ReplayMark = string | { broadcast?: string; addressedAfter?: Record<string, string> };

/** channel → the newest wire id each audience on it saw. */
export type ReplayMarks = Record<string, ReplayMark>;

type MarksFile = { open?: boolean; marks?: unknown };

/**
 * Keep only what this module promises to hand back. A mark that survives here
 * is asserted to a subscriber as "you missed nothing", so anything malformed
 * is dropped rather than guessed at: the cost of dropping one is a single gap
 * notice, and the cost of trusting a bad one is events reported as delivered.
 */
function sanitizeMark(value: unknown): ReplayMark | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { broadcast?: unknown; addressedAfter?: unknown };
  const out: { broadcast?: string; addressedAfter?: Record<string, string> } = {};
  if (typeof raw.broadcast === 'string' && raw.broadcast.length > 0) out.broadcast = raw.broadcast;
  if (raw.addressedAfter && typeof raw.addressedAfter === 'object') {
    const addressed: Record<string, string> = {};
    for (const [agent, id] of Object.entries(raw.addressedAfter as Record<string, unknown>)) {
      if (agent.length > 0 && typeof id === 'string' && id.length > 0) addressed[agent] = id;
    }
    if (Object.keys(addressed).length > 0) out.addressedAfter = addressed;
  }
  if (out.broadcast === undefined && out.addressedAfter === undefined) return undefined;
  return out;
}

export function replayMarksPath(dataDir: string): string {
  return join(dataDir, 'sse-replay-marks.json');
}

function write(dataDir: string, body: MarksFile): void {
  try {
    writeFileSync(replayMarksPath(dataDir), JSON.stringify(body));
  } catch {
    // A data dir that cannot be written is a real problem, but not this
    // module's to report — the cost here is one gap per stream at the next
    // boot, which is where this feature started.
  }
}

/**
 * Read the marks a previous process left, and immediately re-stamp the file as
 * open so THIS process's exit is self-reporting.
 *
 * Returns `{}` for every uncertainty — no file, unparseable file, or a file
 * still flagged open by a process that died. Never throws.
 */
export function claimReplayMarks(dataDir: string): ReplayMarks {
  let recovered: ReplayMarks = {};
  try {
    const parsed = JSON.parse(readFileSync(replayMarksPath(dataDir), 'utf8')) as MarksFile;
    if (parsed.open !== true && parsed.marks && typeof parsed.marks === 'object') {
      for (const [channel, mark] of Object.entries(parsed.marks as Record<string, unknown>)) {
        const clean = sanitizeMark(mark);
        if (clean !== undefined) recovered[channel] = clean;
      }
    }
  } catch {
    recovered = {};
  }
  // Written even when nothing was recovered: the flag is about THIS process's
  // exit, not about what it found.
  write(dataDir, { open: true, marks: recovered });
  return recovered;
}

/** Record the marks and close the file — the clean-shutdown half of the pair. */
export function saveReplayMarks(dataDir: string, marks: ReplayMarks): void {
  write(dataDir, { open: false, marks });
}
