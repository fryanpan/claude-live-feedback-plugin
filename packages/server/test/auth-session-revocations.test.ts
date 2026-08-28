/**
 * The revocation list is what makes a never-expiring cookie safe to hand
 * out: the cookie validates cryptographically forever, and logout works by
 * writing the session's id here. These tests hold the properties that
 * matter: a revocation is durable (it survives a restart — a reboot must not
 * resurrect a logged-out session), and a denylist that exists but cannot be
 * read fails CLOSED — every session refused, the broken file left in place —
 * while a file that simply is not there yet is an ordinary first boot.
 */
import { describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('a denylist that fails to load fails CLOSED (Bryan, 2026-08-28)', () => {
  it('a corrupt file refuses EVERY session, not just the listed ones', () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, 'revoked-sessions.json'), 'not json{{{');
    const store = new SessionRevocations({ dataDir });
    expect(store.loadError).toBeTruthy();
    // Any id at all — the store cannot prove a session was never revoked,
    // so it refuses all of them.
    expect(store.isRevoked('sid-never-seen')).toBe(true);
    expect(store.isRevoked('sid-another')).toBe(true);
  });

  it('an unreadable file (permissions) refuses every session too', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(path, JSON.stringify({ version: 1, revoked: {} }));
    chmodSync(path, 0o000);
    try {
      const store = new SessionRevocations({ dataDir });
      expect(store.loadError).toBeTruthy();
      expect(store.isRevoked('sid-any')).toBe(true);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it('leaves the broken file exactly where it is, so the NEXT boot stays closed too', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(path, 'not json{{{');
    new SessionRevocations({ dataDir });
    // Not moved aside, not overwritten — the file is both the evidence and
    // the signal. A restart must not silently reopen with an empty list.
    expect(readFileSync(path, 'utf8')).toBe('not json{{{');
    expect(readdirSync(dataDir)).toEqual(['revoked-sessions.json']);
    const rebooted = new SessionRevocations({ dataDir });
    expect(rebooted.loadError).toBeTruthy();
    expect(rebooted.isRevoked('sid-any')).toBe(true);
  });

  it('revoke() while failed never writes — the evidence must survive', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(path, 'not json{{{');
    const store = new SessionRevocations({ dataDir });
    store.revoke('sid-logout-during-outage');
    // A save here would rename a fresh file over the broken one — destroying
    // the evidence AND letting the next boot load clean with only this one
    // id. The session is already refused (everything is), so nothing is lost.
    expect(readFileSync(path, 'utf8')).toBe('not json{{{');
  });

  it('a MISSING file is an ordinary first boot, not a failure — and is created eagerly', () => {
    const dataDir = freshDir();
    const store = new SessionRevocations({ dataDir });
    expect(store.loadError).toBeNull();
    // Eager creation is what makes later ABSENCE meaningful: from this
    // moment on, no file means somebody deleted the denylist.
    expect(existsSync(join(dataDir, 'revoked-sessions.json'))).toBe(true);
    // Positive control for the fail-closed tests above: the same probe id
    // that a failed store refuses, a clean store accepts.
    expect(store.isRevoked('sid-never-seen')).toBe(false);
    // And the store is fully functional — revocations persist.
    store.revoke('sid-a');
    expect(store.isRevoked('sid-a')).toBe(true);
  });

  it('a file DELETED at runtime fails closed too, and revoke() does not recreate it', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    const store = new SessionRevocations({ dataDir });
    store.revoke('sid-a');
    expect(store.isRevoked('sid-never-seen')).toBe(false);
    rmSync(path);
    // The boot path guarantees the file exists, so its absence now means
    // the denylist was deleted out from under a running server.
    expect(store.failedClosed()).toBe(true);
    expect(store.isRevoked('sid-never-seen')).toBe(true);
    // A logout during that state must not write a near-empty file back —
    // that would silently reopen the store minus everything it forgot.
    store.revoke('sid-b');
    expect(existsSync(path)).toBe(false);
  });
});

describe('resetAfterWatermarkBump — the self-heal after a failed load', () => {
  it('archives the broken file and reopens the store empty', () => {
    const dataDir = freshDir();
    const path = join(dataDir, 'revoked-sessions.json');
    writeFileSync(path, 'not json{{{');
    const store = new SessionRevocations({ dataDir });
    expect(store.failedClosed()).toBe(true);
    expect(store.resetAfterWatermarkBump()).toBe(true);
    // The evidence survives, moved aside...
    const aside = readdirSync(dataDir).find((f) => f.includes('corrupt'));
    expect(aside).toBeTruthy();
    expect(readFileSync(join(dataDir, aside as string), 'utf8')).toBe('not json{{{');
    // ...and the store is open and functional again: the caller has already
    // ended every outstanding session via the roster watermark, so an empty
    // list resurrects nothing.
    expect(store.failedClosed()).toBe(false);
    expect(store.isRevoked('sid-any')).toBe(false);
    store.revoke('sid-new');
    expect(new SessionRevocations({ dataDir }).isRevoked('sid-new')).toBe(true);
  });

  it('is a no-op on a healthy store', () => {
    const dataDir = freshDir();
    const store = new SessionRevocations({ dataDir });
    store.revoke('sid-a');
    expect(store.resetAfterWatermarkBump()).toBe(true);
    expect(store.isRevoked('sid-a')).toBe(true);
    expect(readdirSync(dataDir).filter((f) => f.includes('corrupt'))).toEqual([]);
  });
});
