import { describe, expect, test } from 'bun:test';
import {
  type KeychainRunner,
  keychainLookups,
  readKeychainPassword,
} from '../src/share/keychain.ts';

/** A fake `security` that knows one entry under one account. */
function keychainWith(
  account: string | null,
  secret: string,
): { run: KeychainRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: KeychainRunner = (args) => {
    calls.push(args);
    const a = args.indexOf('-a');
    const asked = a >= 0 ? args[a + 1] : null;
    const hit = account === null ? true : asked === null || asked === account;
    return hit ? { status: 0, stdout: `${secret}\n` } : { status: 44, stdout: '' };
  };
  return { run, calls };
}

describe('readKeychainPassword', () => {
  const service = 'test-service-not-real';
  const envVar = 'TEST_SERVICE_NOT_REAL';

  test('lookup order is this account first, then any account', () => {
    expect(keychainLookups('svc', 'me')).toEqual([
      ['find-generic-password', '-a', 'me', '-s', 'svc', '-w'],
      ['find-generic-password', '-s', 'svc', '-w'],
    ]);
    expect(keychainLookups('svc', undefined)).toEqual([
      ['find-generic-password', '-s', 'svc', '-w'],
    ]);
  });

  test('an entry stored under a different account is still found by service', () => {
    const prev = process.env.USER;
    process.env.USER = 'someone';
    delete process.env[envVar];
    try {
      const fake = keychainWith('claude-workspaces', 'sekrit');
      expect(readKeychainPassword(service, fake.run)).toBe('sekrit');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]).toContain('-a');
      expect(fake.calls[1]).not.toContain('-a');
    } finally {
      process.env.USER = prev;
    }
  });

  test('the account-scoped entry wins without a second lookup', () => {
    const prev = process.env.USER;
    process.env.USER = 'me';
    delete process.env[envVar];
    try {
      const fake = keychainWith('me', 'mine');
      expect(readKeychainPassword(service, fake.run)).toBe('mine');
      expect(fake.calls).toHaveLength(1);
    } finally {
      process.env.USER = prev;
    }
  });

  test('no entry anywhere throws the install hint', () => {
    delete process.env[envVar];
    const missing: KeychainRunner = () => ({ status: 44, stdout: '' });
    expect(() => readKeychainPassword(service, missing)).toThrow(/add-generic-password/);
  });

  test('the env override short-circuits the Keychain entirely', () => {
    process.env[envVar] = 'from-env';
    try {
      const fake = keychainWith('me', 'unused');
      expect(readKeychainPassword(service, fake.run)).toBe('from-env');
      expect(fake.calls).toHaveLength(0);
    } finally {
      delete process.env[envVar];
    }
  });
});
