/**
 * What the SSE replay buffer remembers across a restart: for each channel, the
 * wire id of the newest event this server ever broadcast on it.
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

/** channel → wire id of the newest event broadcast on it. */
export type ReplayMarks = Record<string, string>;

type MarksFile = { open?: boolean; marks?: unknown };

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
      for (const [channel, id] of Object.entries(parsed.marks as Record<string, unknown>)) {
        if (typeof id === 'string' && id.length > 0) recovered[channel] = id;
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
