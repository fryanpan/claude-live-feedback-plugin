import { describe, expect, it } from 'vitest';
import {
  agentIdForName,
  emailDisplayName,
  emailIdentityId,
  isEmailLike,
  normalizeEmail,
} from '../src/identity.ts';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('strips the angle brackets a mail client pastes', () => {
    expect(normalizeEmail('<alice@example.com>')).toBe('alice@example.com');
  });

  it('leaves an already-canonical address alone', () => {
    expect(normalizeEmail('alice@example.com')).toBe('alice@example.com');
  });
});

describe('isEmailLike', () => {
  it('accepts an ordinary address', () => {
    expect(isEmailLike('alice@example.com')).toBe(true);
    expect(isEmailLike('alice+reviews@mail.example.co.uk')).toBe(true);
  });

  it('refuses what cannot be delivered to', () => {
    for (const bad of [
      '',
      '   ',
      'alice',
      'alice@',
      '@example.com',
      'alice@example',
      'alice example.com',
      'alice@exa mple.com',
      'ali\nce@example.com',
      `${'a'.repeat(320)}@example.com`,
    ]) {
      expect(isEmailLike(bad)).toBe(false);
    }
  });
});

describe('emailIdentityId', () => {
  it('is stable for the same address', () => {
    expect(emailIdentityId('alice@example.com')).toBe(emailIdentityId('alice@example.com'));
  });

  it('is stable across the spellings normalizeEmail folds together', () => {
    const canonical = emailIdentityId('alice@example.com');
    expect(emailIdentityId('  Alice@Example.com  ')).toBe(canonical);
    expect(emailIdentityId('<ALICE@EXAMPLE.COM>')).toBe(canonical);
  });

  it('separates addresses that differ anywhere', () => {
    const ids = new Set(
      [
        'alice@example.com',
        'alicf@example.com',
        'alice@example.net',
        'alice+1@example.com',
        'bob@example.com',
        'alice@sub.example.com',
      ].map(emailIdentityId),
    );
    expect(ids.size).toBe(6);
  });

  it('lands in its own namespace — never an agent id, a known id, or a guest id', () => {
    const id = emailIdentityId('alice@example.com');
    expect(id.startsWith('user-')).toBe(true);
    expect(id).not.toBe(agentIdForName('alice@example.com'));
    for (const prefix of ['agent-', 'known-', 'guest-', 'anon-']) {
      expect(id.startsWith(prefix)).toBe(false);
    }
  });

  it('does not carry the address in readable form', () => {
    // The id travels into shared docs and share-visitor payloads, so it must
    // not be a mailing list for anyone who can read a comment.
    const id = emailIdentityId('alice@example.com');
    expect(id).not.toContain('alice');
    expect(id).not.toContain('example');
  });

  it('is url- and filename-safe', () => {
    expect(emailIdentityId('a.b+c@example.com')).toMatch(/^user-[a-z0-9]+$/);
  });
});

describe('emailDisplayName', () => {
  it('reads the local part as words', () => {
    expect(emailDisplayName('alice@example.com')).toBe('Alice');
    expect(emailDisplayName('alice.smith@example.com')).toBe('Alice Smith');
    expect(emailDisplayName('alice_smith-jones@example.com')).toBe('Alice Smith Jones');
  });

  it('drops a plus-address tag', () => {
    expect(emailDisplayName('alice+reviews@example.com')).toBe('Alice');
  });

  it('falls back to the whole address when there is no usable local part', () => {
    expect(emailDisplayName('@example.com')).toBe('@example.com');
  });
});
