import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/**
 * The discovery slot, exercised against a real filesystem under a throwaway
 * HOME — the sequence that actually bit prod on 2026-08-30, in order:
 *
 *   prod publishes            -> a peer resolves it
 *   staging starts and stops  -> a peer STILL resolves prod   (the bug)
 *   staging crashes           -> a peer STILL resolves prod   (the bug's twin)
 *
 * A test that only covers clean shutdown misses the crash path, which is the
 * one that leaves no cleanup running at all.
 */
import { describe, expect, test } from 'vitest';
import { publishDiscovery, readDiscovery, releaseDiscovery } from '../src/discovery-file.ts';
import { resolveDiscoveryFile } from '../src/machine-paths.ts';

/** What a peer's MCP does: resolve the file and read the port out of it. */
function peerResolvesPort(home: string): number | null {
  const path = resolveDiscoveryFile(home, existsSync);
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8')).port;
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'cw-discovery-'));
  return home;
}

describe('the discovery slot under two servers', () => {
  test('a stopping staging server leaves prod resolvable', () => {
    const home = freshHome();
    try {
      // Prod publishes. A peer can find it.
      const prod = publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => true });
      expect(prod).toBe('claimed');
      expect(peerResolvesPort(home)).toBe(8787);

      // Staging comes up on 8788 while prod is alive: it must not take the slot.
      const staging = publishDiscovery({ home, port: 8788, pid: 5555, isAlive: () => true });
      expect(staging).toBe('declined');
      expect(peerResolvesPort(home)).toBe(8787);

      // Staging stops and runs its cleanup. THIS is the line that broke prod.
      const released = releaseDiscovery({ home, ourPublishedPid: 5555 });
      expect(released).toBe('kept');
      expect(peerResolvesPort(home)).toBe(8787);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a crashing staging server leaves prod resolvable', () => {
    const home = freshHome();
    try {
      publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => true });
      publishDiscovery({ home, port: 8788, pid: 5555, isAlive: () => true });
      // A crash runs no cleanup at all — nothing to call. The entry survives
      // because staging never owned it, not because anything tidied up.
      expect(peerResolvesPort(home)).toBe(8787);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('prod releases the entry it wrote, so a real stop does not strand a dead port', () => {
    const home = freshHome();
    try {
      publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => true });
      expect(releaseDiscovery({ home, ourPublishedPid: 4242 })).toBe('released');
      expect(peerResolvesPort(home)).toBe(null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a restart reclaims its own slot under a new pid', () => {
    const home = freshHome();
    try {
      publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => false });
      expect(publishDiscovery({ home, port: 8787, pid: 7777, isAlive: () => false })).toBe(
        'claimed',
      );
      expect(readDiscovery(home)?.pid).toBe(7777);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a stale entry whose owner is gone does not squat the slot forever', () => {
    const home = freshHome();
    try {
      publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => true });
      // Prod is gone now; staging may take the slot rather than leave the
      // machine pointing at a port nobody serves.
      expect(publishDiscovery({ home, port: 8788, pid: 5555, isAlive: () => false })).toBe(
        'claimed',
      );
      expect(peerResolvesPort(home)).toBe(8788);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a corrupt entry is replaced rather than treated as an owner', () => {
    const home = freshHome();
    try {
      publishDiscovery({ home, port: 8787, pid: 4242, isAlive: () => true });
      const path = resolveDiscoveryFile(home, existsSync) as string;
      writeFileSync(path, 'not json{');
      expect(readDiscovery(home)).toBe(null);
      expect(publishDiscovery({ home, port: 8788, pid: 5555, isAlive: () => true })).toBe(
        'claimed',
      );
      expect(peerResolvesPort(home)).toBe(8788);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
