import { describe, expect, it } from 'vitest';
import {
  ENV_RENAMES,
  type EnvLike,
  legacyEnvName,
  readRenamedEnv,
  renamedEnvConflicts,
} from '../src/env-names.ts';

describe('ENV_RENAMES', () => {
  it('maps every old name to exactly one new name, and never twice', () => {
    const olds = ENV_RENAMES.map(([o]) => o);
    const news = ENV_RENAMES.map(([, n]) => n);
    expect(new Set(olds).size).toBe(olds.length);
    expect(new Set(news).size).toBe(news.length);
  });

  it('gives every variable the one CW_ prefix', () => {
    for (const [, next] of ENV_RENAMES) expect(next.startsWith('CW_')).toBe(true);
  });

  it('renames the two old prefixes and nothing else', () => {
    for (const [old] of ENV_RENAMES) {
      expect(
        old.startsWith('LF_') || old.startsWith('FEEDBACK_') || old.startsWith('LIVE_FEEDBACK_'),
      ).toBe(true);
    }
  });

  it('covers the names the server and MCP actually read', () => {
    // A positive control on the table itself: a mapping that quietly lost an
    // entry would leave that variable with no fallback at all, which is the
    // silent break this whole file exists to prevent.
    const olds = new Set(ENV_RENAMES.map(([o]) => o));
    for (const name of [
      'FEEDBACK_BASE_URL',
      'FEEDBACK_AGENT_NAME',
      'FEEDBACK_AUTHOR',
      'LF_CLIENT_ROOT',
      'LF_PUBLIC_BASE_URL',
      'LF_SUMMARIES',
      'LF_SHARING_DISABLED',
      'LF_CLAUDE_BIN',
      'LIVE_FEEDBACK_SUMMARY_API_KEY',
    ]) {
      expect(olds.has(name)).toBe(true);
    }
  });
});

describe('legacyEnvName', () => {
  it('answers the old spelling of a renamed variable', () => {
    expect(legacyEnvName('CW_SUMMARIES')).toBe('LF_SUMMARIES');
    expect(legacyEnvName('CW_AGENT_NAME')).toBe('FEEDBACK_AGENT_NAME');
  });

  it('answers undefined for a name that was never renamed', () => {
    expect(legacyEnvName('CW_SOMETHING_NEW')).toBeUndefined();
  });
});

describe('readRenamedEnv', () => {
  it('reads the new name', () => {
    expect(readRenamedEnv({ CW_SUMMARIES: '0' }, 'CW_SUMMARIES')).toBe('0');
  });

  it('still reads the old name, so a straggler launch config keeps working', () => {
    expect(readRenamedEnv({ LF_SUMMARIES: '0' }, 'CW_SUMMARIES')).toBe('0');
  });

  it('prefers the new name when both are set', () => {
    const env: EnvLike = { CW_SUMMARIES: '1', LF_SUMMARIES: '0' };
    expect(readRenamedEnv(env, 'CW_SUMMARIES')).toBe('1');
  });

  it('is undefined when neither is set', () => {
    expect(readRenamedEnv({}, 'CW_SUMMARIES')).toBeUndefined();
  });

  /**
   * One-directional on purpose. Every call site already treats these as
   * trim-and-test, and shells export empty variables by accident far more
   * often than anyone deliberately blanks one — so an empty NEW variable must
   * not be able to mask a real OLD one. The failure this shape can produce is
   * "the old value kept working", which is the direction the whole fallback
   * exists to fail in.
   */
  it('does not let an empty new name mask a real old value', () => {
    expect(readRenamedEnv({ CW_CLIENT_ROOT: '', LF_CLIENT_ROOT: '/real' }, 'CW_CLIENT_ROOT')).toBe(
      '/real',
    );
    expect(
      readRenamedEnv({ CW_CLIENT_ROOT: '   ', LF_CLIENT_ROOT: '/real' }, 'CW_CLIENT_ROOT'),
    ).toBe('/real');
  });

  it('returns the value unmodified — trimming is the caller’s business', () => {
    expect(readRenamedEnv({ CW_CLIENT_ROOT: '  /padded  ' }, 'CW_CLIENT_ROOT')).toBe('  /padded  ');
  });

  it('reads a name that was never renamed straight through', () => {
    expect(readRenamedEnv({ CW_BRAND_NEW: 'x' }, 'CW_BRAND_NEW')).toBe('x');
    expect(readRenamedEnv({}, 'CW_BRAND_NEW')).toBeUndefined();
  });
});

describe('renamedEnvConflicts', () => {
  it('names a variable set to two different values under both spellings', () => {
    const c = renamedEnvConflicts({ CW_SUMMARIES: '1', LF_SUMMARIES: '0' });
    expect(c).toEqual([{ current: 'CW_SUMMARIES', legacy: 'LF_SUMMARIES' }]);
  });

  it('stays quiet when the two spellings agree', () => {
    expect(renamedEnvConflicts({ CW_SUMMARIES: '0', LF_SUMMARIES: '0' })).toEqual([]);
  });

  it('stays quiet when only one spelling is set', () => {
    expect(renamedEnvConflicts({ LF_SUMMARIES: '0' })).toEqual([]);
    expect(renamedEnvConflicts({ CW_SUMMARIES: '0' })).toEqual([]);
  });

  it('reports every conflicting variable, not just the first', () => {
    const c = renamedEnvConflicts({
      CW_SUMMARIES: '1',
      LF_SUMMARIES: '0',
      CW_CLIENT_ROOT: '/a',
      LF_CLIENT_ROOT: '/b',
    });
    expect(c.map((x) => x.current).sort()).toEqual(['CW_CLIENT_ROOT', 'CW_SUMMARIES']);
  });
});
