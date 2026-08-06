import { describe, expect, it } from 'bun:test';
import {
  classifyHost,
  isTrustedLocalHost,
  normalizeHost,
  shareScopeAllows,
} from '../src/middleware/host-guard.ts';

const LOCAL = {
  tailscaleHost: 'mac-mini.tailb53801.ts.net',
  lanHosts: ['mac-mini.local', '192.168.50.227'],
};

describe('normalizeHost', () => {
  it('lowercases and strips the port', () => {
    expect(normalizeHost('Mac-Mini.Local:8787')).toBe('mac-mini.local');
    expect(normalizeHost('localhost:8787')).toBe('localhost');
  });

  it('handles bracketed IPv6 with and without a port', () => {
    expect(normalizeHost('[::1]:8787')).toBe('::1');
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('is empty for a missing header', () => {
    expect(normalizeHost(null)).toBe('');
    expect(normalizeHost(undefined)).toBe('');
  });
});

describe('isTrustedLocalHost', () => {
  it('trusts loopback and the machine’s own tailnet / LAN names', () => {
    for (const h of [
      'localhost:8787',
      '127.0.0.1:8787',
      '[::1]:8787',
      'mac-mini.tailb53801.ts.net',
      'mac-mini.local:8787',
      '192.168.50.227:8787',
    ]) {
      expect(isTrustedLocalHost(h, LOCAL), h).toBe(true);
    }
  });

  it('does NOT trust a public tunnel hostname — the whole point of the fix', () => {
    for (const h of [
      'share-2026-08-05-a3f.tunnel.example.com',
      'anything.tunnel.example.com',
      'example.com',
    ]) {
      expect(isTrustedLocalHost(h, LOCAL), h).toBe(false);
    }
  });

  it('refuses a missing Host header', () => {
    expect(isTrustedLocalHost(null, LOCAL)).toBe(false);
    expect(isTrustedLocalHost('', LOCAL)).toBe(false);
  });

  it('matches exactly — a lookalike suffix/prefix must not pass', () => {
    expect(isTrustedLocalHost('evil-mac-mini.local', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('mac-mini.local.attacker.com', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('mac-mini.tailb53801.ts.net.evil.com', LOCAL)).toBe(false);
  });

  it('trusts private IPv4 ranges (LAN + tailnet CGNAT) but not public IPs', () => {
    expect(isTrustedLocalHost('10.0.0.4', LOCAL)).toBe(true);
    expect(isTrustedLocalHost('172.16.3.9', LOCAL)).toBe(true);
    expect(isTrustedLocalHost('100.101.102.103', LOCAL)).toBe(true);
    expect(isTrustedLocalHost('8.8.8.8', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('172.32.0.1', LOCAL)).toBe(false);
    expect(isTrustedLocalHost('999.1.1.1', LOCAL)).toBe(false);
  });
});

describe('classifyHost', () => {
  const lookupShare = (h: string) => (h === 'share-abc.tunnel.example.com' ? 'shared-doc' : null);

  it('local → no gate', () => {
    expect(classifyHost('localhost:8787', { ...LOCAL, lookupShare })).toEqual({ kind: 'local' });
  });

  it('active share host → gate + the doc it is scoped to', () => {
    expect(classifyHost('share-abc.tunnel.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'share',
      docId: 'shared-doc',
    });
  });

  it('unknown host → DENY (previously this fell through to the open API)', () => {
    expect(classifyHost('anything.tunnel.example.com', { ...LOCAL, lookupShare })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
    expect(classifyHost(null, { ...LOCAL, lookupShare })).toEqual({
      kind: 'deny',
      reason: 'unknown_host',
    });
  });
});

describe('shareScopeAllows', () => {
  const DOC = 'auth-rfc';

  it('allows the app shell and assets', () => {
    expect(shareScopeAllows('/app/app.js', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/app/styles.css', 'GET', DOC)).toBe(true);
    expect(shareScopeAllows('/favicon.ico', 'GET', DOC)).toBe(true);
  });

  it('allows the shared doc’s own surfaces', () => {
    expect(shareScopeAllows(`/review/${DOC}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/y/${DOC}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/events/${DOC}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC}`, 'GET', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC}/threads`, 'POST', DOC)).toBe(true);
    expect(shareScopeAllows(`/api/docs/${DOC}/threads/t1/comments`, 'POST', DOC)).toBe(true);
  });

  it('matches a percent-encoded docId (workspace members encode `:` and `~`)', () => {
    const member = 'rev-1:docs~main.md';
    expect(shareScopeAllows(`/review/${encodeURIComponent(member)}`, 'GET', member)).toBe(true);
    expect(
      shareScopeAllows(`/api/docs/${encodeURIComponent(member)}/threads`, 'POST', member),
    ).toBe(true);
  });

  it('BLOCKS other docs', () => {
    expect(shareScopeAllows('/review/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/y/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs/other-doc/threads', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/events/other-doc', 'GET', DOC)).toBe(false);
  });

  it('BLOCKS doc enumeration and workspace/diff creation', () => {
    expect(shareScopeAllows('/api/docs', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/docs', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/workspaces', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/diffs', 'POST', DOC)).toBe(false);
  });

  it('BLOCKS the share admin surface — a visitor must not mint or revoke shares', () => {
    expect(shareScopeAllows('/api/share', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/share/doc', 'POST', DOC)).toBe(false);
    expect(shareScopeAllows('/api/share/abc123', 'DELETE', DOC)).toBe(false);
  });

  it('BLOCKS mockups, demos, and anything unlisted (closed by default)', () => {
    expect(shareScopeAllows('/demos/whatever/index.html', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/mockup/some-doc', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/api/webhooks/log', 'GET', DOC)).toBe(false);
    expect(shareScopeAllows('/some/route/added/later', 'GET', DOC)).toBe(false);
  });

  it('is not fooled by a prefix that merely starts with the shared id', () => {
    expect(shareScopeAllows(`/review/${DOC}-other`, 'GET', DOC)).toBe(false);
    expect(shareScopeAllows(`/api/docs/${DOC}-other/threads`, 'GET', DOC)).toBe(false);
  });
});
