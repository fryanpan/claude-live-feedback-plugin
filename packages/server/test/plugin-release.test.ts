import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentsBehind,
  compareSemver,
  moduleDir,
  readReleasedPluginVersion,
} from '../src/plugin-release';

describe('compareSemver', () => {
  test('orders by number, not by string', () => {
    // The whole reason this function exists. Lexically '0.1.9' > '0.1.26',
    // and every peer sitting eleven versions back would have read as current.
    expect(compareSemver('0.1.9', '0.1.26')).toBe(-1);
    expect(compareSemver('0.1.26', '0.1.9')).toBe(1);
    expect(compareSemver('0.1.26', '0.1.26')).toBe(0);
  });

  test('compares the leading components first', () => {
    expect(compareSemver('0.2.0', '0.1.99')).toBe(1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
  });

  test('a missing component is zero, so 0.1 is older than 0.1.1', () => {
    expect(compareSemver('0.1', '0.1.1')).toBe(-1);
    expect(compareSemver('0.1', '0.1.0')).toBe(0);
  });

  test('unparseable input sorts as oldest rather than throwing', () => {
    // A garbage version must not crash the board. Oldest is the safe
    // direction: it can only ever prompt someone to update.
    expect(compareSemver('nonsense', '0.1.0')).toBe(-1);
    expect(compareSemver('0.1.0', '')).toBe(1);
  });
});

describe('readReleasedPluginVersion', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'lf-release-'));

  test('reads the plugin manifest the deploy source would install', () => {
    const dir = root();
    mkdirSync(join(dir, 'packages/plugin/.claude-plugin'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/plugin/.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'live-feedback', version: '0.1.42' }),
    );
    expect(readReleasedPluginVersion(dir)).toBe('0.1.42');
  });

  test('returns null rather than throwing when there is no manifest', () => {
    expect(readReleasedPluginVersion(root())).toBeNull();
  });

  test('returns null on a manifest that is not readable as a version', () => {
    const dir = root();
    mkdirSync(join(dir, 'packages/plugin/.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, 'packages/plugin/.claude-plugin/plugin.json'), '{ not json');
    expect(readReleasedPluginVersion(dir)).toBeNull();
  });
});

describe('agentsBehind', () => {
  const local = (agentId: string, pluginVersion?: string) => ({
    agentId,
    runtime: 'claude-code-local' as const,
    ...(pluginVersion !== undefined ? { pluginVersion } : {}),
  });

  test('names the sessions running an older bundle than the one on disk', () => {
    const behind = agentsBehind('0.1.26', [local('a', '0.1.12'), local('b', '0.1.26')]);
    expect(behind.map((x) => x.agentId)).toEqual(['a']);
    expect(behind[0]?.pluginVersion).toBe('0.1.12');
  });

  test('a session that reports no version at all is behind', () => {
    // It cannot report one: the field ships in the same release that reads
    // it. Silence therefore means "older than this feature", which is the
    // exact state the whole fleet is in right now.
    const behind = agentsBehind('0.1.26', [local('a')]);
    expect(behind.map((x) => x.agentId)).toEqual(['a']);
    expect(behind[0]?.pluginVersion).toBeUndefined();
  });

  test('a session AHEAD of the deploy source is not behind', () => {
    // Real case: an agent launched against a working tree while the checkout
    // this server runs from has not pulled yet. Nagging it to downgrade is
    // worse than saying nothing.
    expect(agentsBehind('0.1.26', [local('a', '0.1.30')])).toEqual([]);
  });

  test('only the local Claude Code runtime is asked about a plugin', () => {
    // A webhook has no plugin cache to update, so it can never be behind and
    // must not appear in a count of things someone can fix.
    const behind = agentsBehind('0.1.26', [
      { agentId: 'hook', runtime: 'webhook' },
      { agentId: 'cloud', runtime: 'managed-agent' },
      local('session', '0.1.12'),
    ]);
    expect(behind.map((x) => x.agentId)).toEqual(['session']);
  });

  test('no released version means no claim about anyone', () => {
    // The manifest is unreadable — we do not know what current IS, so
    // reporting drift would be inventing it.
    expect(agentsBehind(null, [local('a', '0.1.12')])).toEqual([]);
  });
});

describe('moduleDir', () => {
  test('decodes a percent-escaped path', () => {
    // `new URL(u).pathname` keeps the escapes, so a checkout under a
    // directory with a space resolves to a path that does not exist —
    // readReleasedPluginVersion then returns null and the whole drift signal
    // switches itself off, silently. This machine's checkout has no spaces,
    // which is exactly why it would never have been noticed here.
    expect(moduleDir('file:///Users/sam/My%20Code/repo/packages/server/src/x.ts')).toBe(
      '/Users/sam/My Code/repo/packages/server/src',
    );
  });

  test('handles an ordinary path unchanged (positive control)', () => {
    expect(moduleDir('file:///srv/repo/packages/server/src/x.ts')).toBe(
      '/srv/repo/packages/server/src',
    );
  });

  test('the no-argument read finds this repo, whatever its path', () => {
    // The end the escape bug actually breaks.
    expect(readReleasedPluginVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
