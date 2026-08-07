import { describe, expect, it } from 'bun:test';
import { isReservedName, sanitizeVisitorAuthor } from '../src/share/visitor-identity.ts';

const CTX = { shareKey: 'share-abc' };

describe('sanitizeVisitorAuthor', () => {
  it('refuses an id that claims to be a known user', () => {
    const u = sanitizeVisitorAuthor(
      { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
      CTX,
    );
    expect(u.id).toStartWith('guest-');
    expect(u.id).not.toContain('bryan');
    expect(u.kind).toBe('anon');
  });

  it('refuses a reserved display name and falls back to an animal', () => {
    for (const name of ['Bryan', 'bryan', '  BRYAN  ', 'Agent', 'Claude', 'admin']) {
      const u = sanitizeVisitorAuthor({ id: 'x', name }, CTX);
      expect(u.name).toMatch(/^Anonymous [A-Z][a-z]+$/);
    }
  });

  it('keeps a name the visitor is allowed to use', () => {
    expect(sanitizeVisitorAuthor({ id: 'x', name: 'Casey' }, CTX).name).toBe('Casey');
  });

  it('gives an unnamed visitor a stable animal name', () => {
    const a = sanitizeVisitorAuthor({ id: 'browser-1' }, CTX);
    const b = sanitizeVisitorAuthor({ id: 'browser-1' }, CTX);
    expect(a.name).toMatch(/^Anonymous [A-Z][a-z]+$/);
    expect(b.name).toBe(a.name);
    expect(b.id).toBe(a.id);
  });

  it('scopes ids per share — the same browser on two links is two guests', () => {
    const a = sanitizeVisitorAuthor({ id: 'browser-1' }, { shareKey: 'share-a' });
    const b = sanitizeVisitorAuthor({ id: 'browser-1' }, { shareKey: 'share-b' });
    expect(a.id).not.toBe(b.id);
  });

  it('separates two different browsers on the same share', () => {
    const a = sanitizeVisitorAuthor({ id: 'browser-1' }, CTX);
    const b = sanitizeVisitorAuthor({ id: 'browser-2' }, CTX);
    expect(a.id).not.toBe(b.id);
  });

  it('survives junk without throwing', () => {
    for (const junk of [undefined, null, 'a string', 42, [], { id: 5, name: {} }]) {
      const u = sanitizeVisitorAuthor(junk, CTX);
      expect(u.id).toStartWith('guest-');
      expect(u.kind).toBe('anon');
      expect(u.name.length).toBeGreaterThan(0);
      expect(u.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('caps an absurd display name', () => {
    const u = sanitizeVisitorAuthor({ id: 'x', name: 'z'.repeat(5000) }, CTX);
    expect(u.name.length).toBeLessThanOrEqual(40);
  });

  it('rejects a malformed color rather than echoing it into the DOM', () => {
    const u = sanitizeVisitorAuthor({ id: 'x', color: 'javascript:alert(1)' }, CTX);
    expect(u.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps a well-formed color the visitor picked', () => {
    expect(sanitizeVisitorAuthor({ id: 'x', color: '#a1b2c3' }, CTX).color).toBe('#a1b2c3');
  });

  it('never returns kind known, even for a perfectly ordinary author', () => {
    expect(sanitizeVisitorAuthor({ id: 'x', name: 'Casey', kind: 'known' }, CTX).kind).toBe('anon');
  });
});

describe('isReservedName', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(isReservedName(' BrYaN ')).toBe(true);
    expect(isReservedName('Casey')).toBe(false);
  });
});
