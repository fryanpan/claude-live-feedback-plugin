/**
 * The external base URL every human-facing link is built on.
 *
 * Why this exists: prod is moving behind `tailscale serve`, which terminates
 * TLS on `https://<tailnet-name>` and proxies to this process on loopback.
 * From in here that is invisible — the socket is plain http — so the server
 * cannot discover its own external origin and the operator declares it.
 *
 * The failure this guards against is quiet. Without the override every
 * `reviewUrl` keeps rendering `http://<host>:<port>`: a real, reachable,
 * working URL that happens to be the INSECURE origin, which is the one place
 * the browser refuses the microphone. The TLS deploy would look done and
 * voice would still be dead, because the links point past the frontend.
 *
 * Two layers on purpose. The predicate tests are cheap and cover the
 * rejections; the route test is the one that proves a link a caller actually
 * receives changed, since `withReviewUrl` is reached through the route table
 * and nothing type-checks that wiring (docs/process/learnings.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePublicBaseUrl } from '../src/public-host.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('normalizePublicBaseUrl', () => {
  it('treats unset / blank as "no override"', () => {
    expect(normalizePublicBaseUrl(undefined)).toBeNull();
    expect(normalizePublicBaseUrl(null)).toBeNull();
    expect(normalizePublicBaseUrl('')).toBeNull();
    expect(normalizePublicBaseUrl('   ')).toBeNull();
  });

  it('accepts an https origin and drops the default port', () => {
    // The shape prod will actually be given. 443 must NOT survive into the
    // string, or every emitted link carries a redundant `:443`.
    expect(normalizePublicBaseUrl('https://host.example.ts.net')).toBe(
      'https://host.example.ts.net',
    );
    expect(normalizePublicBaseUrl('https://host.example.ts.net:443')).toBe(
      'https://host.example.ts.net',
    );
  });

  it('keeps an explicit non-default port', () => {
    expect(normalizePublicBaseUrl('https://host.example.ts.net:8443')).toBe(
      'https://host.example.ts.net:8443',
    );
  });

  it('tolerates a trailing slash and uppercase host', () => {
    // Both are what a human pastes out of a browser bar. Callers concatenate
    // `${base}/review/...`, so a surviving slash would build a double slash.
    expect(normalizePublicBaseUrl('https://Host.Example.TS.net/')).toBe(
      'https://host.example.ts.net',
    );
  });

  it('still allows plain http — a frontend is not always TLS', () => {
    expect(normalizePublicBaseUrl('http://host.example:8787')).toBe('http://host.example:8787');
  });

  describe('refuses, rather than silently falling back', () => {
    // Each of these would otherwise produce links that are subtly wrong on a
    // server that started fine, which is the failure mode worth paying a
    // boot-time crash to avoid.
    const bad: Array<[string, string]> = [
      ['not a URL at all', 'host.example.ts.net'],
      ['a non-browser scheme', 'ftp://host.example'],
      ['a path (routes mount at the root)', 'https://host.example/feedback'],
      ['a query string', 'https://host.example?a=1'],
      ['a fragment', 'https://host.example#x'],
      ['embedded credentials', 'https://user:pw@host.example'],
    ];
    for (const [why, value] of bad) {
      it(`rejects ${why}`, () => {
        expect(() => normalizePublicBaseUrl(value)).toThrow(/CW_PUBLIC_BASE_URL is invalid/);
      });
    }
  });
});

describe('the override reaches the links the route table hands out', () => {
  let handle: ServerHandle;
  let dataDir: string;
  const PUBLIC = 'https://host.example.ts.net';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'public-base-url-'));
    const docPath = join(dataDir, 'notes.md');
    writeFileSync(docPath, '# Notes\n\nBody.\n');
    handle = createServer({ port: 0, dataDir, publicBaseUrl: PUBLIC });
    await fetch(`http://localhost:${handle.port}/api/docs`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'doc-1', type: 'markdown', sourceUrl: docPath }),
    });
  });

  afterAll(() => {
    handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const reviewUrlOf = async (): Promise<string> => {
    const res = await fetch(`http://localhost:${handle.port}/api/docs/doc-1`, {
      headers: { host: `localhost:${handle.port}` },
    });
    const body = (await res.json()) as { meta?: { reviewUrl?: string } };
    // Assert the field is THERE before asserting anything about its content —
    // otherwise "does not contain localhost" passes on `undefined`, which is
    // the vacuous-negative shape this repo keeps rediscovering.
    const url = body.meta?.reviewUrl;
    expect(typeof url).toBe('string');
    return url as string;
  };

  it('builds reviewUrl on the declared origin', async () => {
    // The ORIGIN is what this file is about; the path after it belongs to the
    // addressing scheme and is pinned in workspace-resource-routes.test.ts. A
    // doc is addressed under the workspace holding it, so asserting one exact
    // string here would fail every time that scheme moves, for a reason that
    // has nothing to do with the override.
    const url = await reviewUrlOf();
    expect(url.startsWith(`${PUBLIC}/`)).toBe(true);
    expect(url.endsWith('/docs/doc-1')).toBe(true);
  });

  it('leaves no trace of the loopback origin it is actually served on', async () => {
    // The assertion that would have caught a half-applied override: it is not
    // enough that the URL parses or contains the new host — the OLD one must
    // be gone, port and all.
    const reviewUrl = await reviewUrlOf();
    expect(reviewUrl).not.toContain('localhost');
    expect(reviewUrl).not.toContain(String(handle.port));
    expect(reviewUrl.startsWith('https://')).toBe(true);
  });
});

describe('without an override the server still describes itself', () => {
  // The positive control for the pair above: prove these assertions can come
  // out the other way, so "no localhost in the URL" means the override did
  // it rather than the field being empty or the route being missing.
  let handle: ServerHandle;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'public-base-url-default-'));
    const docPath = join(dataDir, 'notes.md');
    writeFileSync(docPath, '# Notes\n\nBody.\n');
    handle = createServer({ port: 0, dataDir });
    await fetch(`http://localhost:${handle.port}/api/docs`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'doc-1', type: 'markdown', sourceUrl: docPath }),
    });
  });

  afterAll(() => {
    handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('falls back to a plain-http URL carrying the listening port', async () => {
    const res = await fetch(`http://localhost:${handle.port}/api/docs/doc-1`, {
      headers: { host: `localhost:${handle.port}` },
    });
    const body = (await res.json()) as { meta?: { reviewUrl?: string } };
    const reviewUrl = body.meta?.reviewUrl;
    expect(typeof reviewUrl).toBe('string');
    expect((reviewUrl as string).startsWith('http://')).toBe(true);
    expect(reviewUrl).toContain(String(handle.port));
    expect((reviewUrl as string).endsWith('/docs/doc-1')).toBe(true);
  });
});
