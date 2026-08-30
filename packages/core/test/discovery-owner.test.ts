/**
 * Who owns `~/.claude/claude-workspaces/server.json`.
 *
 * The bug this covers, hit live on 2026-08-30: the discovery path is built
 * from `$HOME` alone — no port, no data dir — so EVERY supervisor writes and
 * unlinks the same file. `bun run staging` on :8788 therefore deletes prod's
 * entry the moment it stops, and the failure is silent: prod keeps answering
 * 200 on 8787, launchd still reports the job running, and the only symptom is
 * every peer's MCP saying the server is not found.
 *
 * The rule these two functions encode: a server may publish only when the
 * entry is free or already its own, and may remove only an entry it wrote.
 * Where the two conflict, prefer leaving a STALE entry (which a reader can
 * see, and which the next honest start reclaims) over leaving none.
 */
import { describe, expect, test } from 'vitest';
import {
  type DiscoveryEntry,
  shouldClaimDiscovery,
  shouldReleaseDiscovery,
} from '../src/discovery-owner.ts';

const entry = (over: Partial<DiscoveryEntry> = {}): DiscoveryEntry => ({
  port: 8787,
  pid: 4242,
  startedAt: '2026-08-30T08:02:11Z',
  ...over,
});

const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe('shouldClaimDiscovery', () => {
  test('claims a free entry', () => {
    expect(shouldClaimDiscovery({ existing: null, ourPort: 8787, isAlive: alive([]) })).toBe(true);
  });

  test('reclaims its own port, so a prod restart still publishes', () => {
    // Same endpoint, new process: the old pid is gone and the entry is ours
    // to refresh. Refusing here would leave prod unresolvable after a restart.
    expect(
      shouldClaimDiscovery({
        existing: entry({ port: 8787, pid: 111 }),
        ourPort: 8787,
        isAlive: alive([]),
      }),
    ).toBe(true);
  });

  test('does NOT claim a live server on another port — staging must not take prod entry', () => {
    // This is the whole bug: :8788 publishing over prod's :8787 entry.
    expect(
      shouldClaimDiscovery({
        existing: entry({ port: 8787, pid: 4242 }),
        ourPort: 8788,
        isAlive: alive([4242]),
      }),
    ).toBe(false);
  });

  test('claims a stale entry whose owner is gone, so a dead port cannot squat', () => {
    // Prefer a resolvable entry over a permanently wrong one: if nobody is
    // behind :8787 any more, :8788 may publish.
    expect(
      shouldClaimDiscovery({
        existing: entry({ port: 8787, pid: 4242 }),
        ourPort: 8788,
        isAlive: alive([]),
      }),
    ).toBe(true);
  });
});

describe('shouldReleaseDiscovery', () => {
  test('releases the entry it wrote', () => {
    expect(shouldReleaseDiscovery({ existing: entry({ pid: 4242 }), ourPublishedPid: 4242 })).toBe(
      true,
    );
  });

  test('does NOT release an entry another server wrote', () => {
    // The staging supervisor stopping must leave prod's entry alone.
    expect(
      shouldReleaseDiscovery({ existing: entry({ port: 8787, pid: 4242 }), ourPublishedPid: 9999 }),
    ).toBe(false);
  });

  test('does not trip over a missing entry', () => {
    expect(shouldReleaseDiscovery({ existing: null, ourPublishedPid: 4242 })).toBe(false);
  });
});
