import { describe, expect, it } from 'vitest';
import {
  ENV_RENAMES,
  type EnvLike,
  legacyEnvName,
  positiveEnvDuration,
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

  it('renames only the old feedback-era spellings and nothing else', () => {
    for (const [old] of ENV_RENAMES) {
      expect(old.startsWith('FEEDBACK_') || old.startsWith('LIVE_FEEDBACK_')).toBe(true);
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
      'LIVE_FEEDBACK_SUMMARY_API_KEY',
    ]) {
      expect(olds.has(name)).toBe(true);
    }
  });
});

describe('legacyEnvName', () => {
  it('answers the old spelling of a renamed variable', () => {
    expect(legacyEnvName('CW_BASE_URL')).toBe('FEEDBACK_BASE_URL');
    expect(legacyEnvName('CW_AGENT_NAME')).toBe('FEEDBACK_AGENT_NAME');
  });

  it('answers undefined for a name that was never renamed', () => {
    expect(legacyEnvName('CW_SOMETHING_NEW')).toBeUndefined();
  });
});

describe('readRenamedEnv', () => {
  it('reads the new name', () => {
    expect(readRenamedEnv({ CW_AUTHOR: 'bryan' }, 'CW_AUTHOR')).toBe('bryan');
  });

  it('still reads the old name, so a straggler launch config keeps working', () => {
    expect(readRenamedEnv({ FEEDBACK_AUTHOR: 'bryan' }, 'CW_AUTHOR')).toBe('bryan');
  });

  it('prefers the new name when both are set', () => {
    const env: EnvLike = { CW_AUTHOR: 'new', FEEDBACK_AUTHOR: 'old' };
    expect(readRenamedEnv(env, 'CW_AUTHOR')).toBe('new');
  });

  it('is undefined when neither is set', () => {
    expect(readRenamedEnv({}, 'CW_AUTHOR')).toBeUndefined();
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
    expect(readRenamedEnv({ CW_BASE_URL: '', FEEDBACK_BASE_URL: '/real' }, 'CW_BASE_URL')).toBe(
      '/real',
    );
    expect(readRenamedEnv({ CW_BASE_URL: '   ', FEEDBACK_BASE_URL: '/real' }, 'CW_BASE_URL')).toBe(
      '/real',
    );
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
    const c = renamedEnvConflicts({ CW_AUTHOR: 'new', FEEDBACK_AUTHOR: 'old' });
    expect(c).toEqual([{ current: 'CW_AUTHOR', legacy: 'FEEDBACK_AUTHOR' }]);
  });

  it('stays quiet when the two spellings agree', () => {
    expect(renamedEnvConflicts({ CW_AUTHOR: 'same', FEEDBACK_AUTHOR: 'same' })).toEqual([]);
  });

  it('stays quiet when only one spelling is set', () => {
    expect(renamedEnvConflicts({ FEEDBACK_AUTHOR: 'old' })).toEqual([]);
    expect(renamedEnvConflicts({ CW_AUTHOR: 'new' })).toEqual([]);
  });

  it('reports every conflicting variable, not just the first', () => {
    const c = renamedEnvConflicts({
      CW_AUTHOR: 'new',
      FEEDBACK_AUTHOR: 'old',
      CW_BASE_URL: '/a',
      FEEDBACK_BASE_URL: '/b',
    });
    expect(c.map((x) => x.current).sort()).toEqual(['CW_AUTHOR', 'CW_BASE_URL']);
  });
});

describe('positiveEnvDuration', () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it('converts the operator-facing unit into milliseconds', () => {
    expect(positiveEnvDuration({ CW_X: '20' }, 'CW_X', MIN)).toBe(20 * MIN);
    expect(positiveEnvDuration({ CW_X: '4' }, 'CW_X', HOUR)).toBe(4 * HOUR);
  });

  it('accepts a fractional value, so a sub-unit window is reachable', () => {
    expect(positiveEnvDuration({ CW_X: '0.5' }, 'CW_X', HOUR)).toBe(30 * MIN);
  });

  it('falls back to the default when the variable is unset or blank', () => {
    expect(positiveEnvDuration({}, 'CW_X', MIN)).toBeUndefined();
    expect(positiveEnvDuration({ CW_X: '' }, 'CW_X', MIN)).toBeUndefined();
    expect(positiveEnvDuration({ CW_X: '   ' }, 'CW_X', MIN)).toBeUndefined();
  });

  // A zero window would fire on every tick and a negative one is meaningless.
  // Both fall back rather than disabling the feature or hammering it.
  it('falls back rather than honouring a non-positive or unreadable value', () => {
    expect(positiveEnvDuration({ CW_X: '0' }, 'CW_X', MIN)).toBeUndefined();
    expect(positiveEnvDuration({ CW_X: '-5' }, 'CW_X', MIN)).toBeUndefined();
    expect(positiveEnvDuration({ CW_X: 'soon' }, 'CW_X', MIN)).toBeUndefined();
    expect(positiveEnvDuration({ CW_X: 'Infinity' }, 'CW_X', MIN)).toBeUndefined();
  });

  // Any surviving renamed pair proves the point: the duration read goes
  // through readRenamedEnv rather than reaching into `env` itself.
  it('reads the legacy spelling too, like every other env read here', () => {
    expect(positiveEnvDuration({ FEEDBACK_AUTHOR: '7' }, 'CW_AUTHOR', MIN)).toBe(7 * MIN);
  });
});
