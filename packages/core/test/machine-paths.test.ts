import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_DIR_CURRENT,
  DISCOVERY_DIR_LEGACY,
  discoveryCandidates,
  resolveDiscoveryFile,
} from '../src/machine-paths.ts';

const HOME = '/Users/tester';
const CURRENT = `${HOME}/.claude/claude-workspaces/server.json`;
const LEGACY = `${HOME}/.claude/live-feedback/server.json`;

function only(...present: string[]) {
  const set = new Set(present);
  return (p: string) => set.has(p);
}

describe('discoveryCandidates', () => {
  it('offers the new path first and the old one after it', () => {
    expect(discoveryCandidates(HOME)).toEqual([CURRENT, LEGACY]);
  });

  it('names the two directories the migration script moves between', () => {
    expect(DISCOVERY_DIR_CURRENT).toBe('claude-workspaces');
    expect(DISCOVERY_DIR_LEGACY).toBe('live-feedback');
  });
});

describe('resolveDiscoveryFile', () => {
  it('finds the new path', () => {
    expect(resolveDiscoveryFile(HOME, only(CURRENT))).toBe(CURRENT);
  });

  /**
   * The load-bearing case. The flag day has two independent events — the
   * server restarts (and starts writing the new path) and each session
   * respawns its MCP child — and nothing orders them. A child that comes up
   * first would otherwise find no discovery file at all and throw, which
   * reads to its agent as "the server is down". One extra existsSync buys
   * that away, so this fallback is permanent rather than transitional.
   */
  it('still finds the old path, so a child that respawns early keeps working', () => {
    expect(resolveDiscoveryFile(HOME, only(LEGACY))).toBe(LEGACY);
  });

  it('prefers the new path when both exist', () => {
    expect(resolveDiscoveryFile(HOME, only(CURRENT, LEGACY))).toBe(CURRENT);
  });

  it('answers undefined when neither exists', () => {
    expect(resolveDiscoveryFile(HOME, only())).toBeUndefined();
  });
});
