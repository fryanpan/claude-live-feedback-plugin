/**
 * The revocation list is what makes a never-expiring cookie safe to hand
 * out: the cookie validates cryptographically forever, and logout works by
 * writing the session's id here. These tests hold the properties that
 * matter: a revocation is durable (it survives a restart — a reboot must not
 * resurrect a logged-out session), and a corrupt file is moved aside rather
 * than silently emptied in place.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRevocations } from '../src/auth/session-revocations.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'session-revocations-test-'));
}

describe('revoking a session id', () => {
  it('is not revoked until somebody revokes it', () => {
    const store = new SessionRevocations({ dataDir: freshDir() });
    expect(store.isRevoked('sid-a')).toBe(false);
    store.revoke('sid-a');
    expect(store.isRevoked('sid-a')).toBe(true);
    // Only that one — logout ends a session, not an identity.
    expect(store.isRevoked('sid-b')).toBe(false);
  });

  it('is idempotent — a double logout is not an error', () => {
    const store = new SessionRevocations({ dataDir: freshDir() });
    store.revoke('sid-a');
    store.revoke('sid-a');
    expect(store.isRevoked('sid-a')).toBe(true);
  });

  it('survives a restart, because a reboot must not resurrect a logged-out session', () => {
    const dataDir = freshDir();
    new SessionRevocations({ dataDir }).revoke('sid-gone');
    const reloaded = new SessionRevocations({ dataDir });
    expect(reloaded.isRevoked('sid-gone')).toBe(true);
    expect(reloaded.loadError).toBeNull();
  });

  it('leaves no temp file behind — the write is rename-into-place', () => {
    const dataDir = freshDir();
    new SessionRevocations({ dataDir }).revoke('sid-a');
    const leftovers = readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(existsSync(join(dataDir, 'revoked-sessions.json'))).toBe(true);
  });

  it('moves a corrupt file aside and says so, rather than overwriting the evidence', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(path, 'not json{{{');
    const store = new SessionRevocations({ dataDir });
    expect(store.loadError).toContain('moved to');
    const aside = readdirSync(dataDir).find((f) => f.includes('corrupt'));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(dataDir, aside as string), 'utf8')).toBe('not json{{{');
    // The store still works from empty — and the header documents that this
    // fails OPEN for previously revoked ids; the roster watermark stays the
    // big hammer for "end everything now".
    store.revoke('sid-after');
    expect(store.isRevoked('sid-after')).toBe(true);
  });

  it('ignores junk entries in an otherwise readable file', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(
      path,
      JSON.stringify({ version: 1, revoked: { good: { at: 5 }, 7: 'nope', '': { at: 1 } } }),
    );
    const store = new SessionRevocations({ dataDir });
    expect(store.isRevoked('good')).toBe(true);
  });
});
