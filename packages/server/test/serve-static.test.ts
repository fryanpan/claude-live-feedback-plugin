import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStaticUnder } from '../src/server.ts';

/**
 * `/app/*` and `/demos/*` build their path out of the request URL. That was
 * safe by accident — `new URL()` collapses `..` before the router sees it —
 * but nothing asserted it, and the host is now publicly reachable.
 */
describe('serveStaticUnder', () => {
  const root = mkdtempSync(join(tmpdir(), 'static-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'static-outside-'));
  writeFileSync(join(root, 'ok.txt'), 'served');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'deep.txt'), 'deep');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');

  it('serves a file inside the root', async () => {
    const r = serveStaticUnder(root, join(root, 'ok.txt'));
    expect(r).not.toBeNull();
    expect(await r?.text()).toBe('served');
  });

  it('serves a nested file', async () => {
    const r = serveStaticUnder(root, join(root, 'nested', 'deep.txt'));
    expect(await r?.text()).toBe('deep');
  });

  it('refuses a traversal out of the root', () => {
    expect(serveStaticUnder(root, join(root, '..', 'etc-passwd'))).toBeNull();
    expect(serveStaticUnder(root, join(outside, 'secret.txt'))).toBeNull();
    expect(serveStaticUnder(root, '/etc/hosts')).toBeNull();
  });

  it('refuses a deep traversal that lands back near the root', () => {
    // The classic near-miss: a sibling directory whose name STARTS with the
    // root's, which a naive startsWith check would wave through.
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'x.txt'), 'NOPE');
    try {
      expect(serveStaticUnder(root, join(sibling, 'x.txt'))).toBeNull();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a symlink that escapes the root', () => {
    // path.resolve is LEXICAL, so a string-prefix check waves this straight
    // through — the containment has to resolve the link. No try/catch around
    // the assertion: a swallowed expect is a test that can never fail, which
    // is exactly how this one first "passed".
    const link = join(root, 'escape');
    symlinkSync(outside, link);
    try {
      expect(serveStaticUnder(root, join(link, 'secret.txt'))).toBeNull();
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('serves through a symlink that stays INSIDE the root', () => {
    const link = join(root, 'inner-link');
    symlinkSync(join(root, 'nested'), link);
    try {
      expect(serveStaticUnder(root, join(link, 'deep.txt'))).not.toBeNull();
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('returns null for a file that simply is not there', () => {
    expect(serveStaticUnder(root, join(root, 'missing.txt'))).toBeNull();
  });
});
