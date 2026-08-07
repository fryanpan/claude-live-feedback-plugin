import { describe, expect, it } from 'bun:test';
import { corsHeadersFor, isAllowedBrowserOrigin } from '../src/middleware/browser-origin.ts';

/**
 * Every JSON response used to carry `Access-Control-Allow-Origin: *`, and the
 * websocket upgrade checked no Origin at all. Since the tailnet/loopback host
 * needs no credentials, that meant ANY page the user visited could read every
 * doc on the server, write to it, and — via `POST /api/docs` with an arbitrary
 * `sourceUrl` — read any file on the machine. Verified before the fix: a
 * cross-origin `fetch` returned the full doc list, and a socket sent with
 * `Origin: https://evil.example.com` synced a real document's contents.
 *
 * CORS is the browser's job to enforce, so the fix is to stop volunteering
 * permission: reflect a specific allowed origin or send nothing at all.
 */

const HOST = 'mac-mini.example.ts.net:8787';

const allow = (origin: string | null, extra: string[] = []) =>
  isAllowedBrowserOrigin(origin, { requestHost: HOST, allowedOrigins: extra });

describe('isAllowedBrowserOrigin', () => {
  it('allows the review app itself (same origin)', () => {
    expect(allow(`http://${HOST}`)).toBe(true);
    expect(allow(`https://${HOST}`)).toBe(true);
  });

  it('allows a loopback dev server — that is the widget’s whole use case', () => {
    // The widget is injected into a dev site and calls the server
    // cross-origin. An attacker's page cannot be served from loopback, so
    // this stays meaningfully narrower than "*".
    expect(allow('http://localhost:3000')).toBe(true);
    expect(allow('http://127.0.0.1:5173')).toBe(true);
    expect(allow('http://[::1]:8080')).toBe(true);
  });

  it('REFUSES an arbitrary public origin', () => {
    expect(allow('https://evil.example.com')).toBe(false);
    expect(allow('http://attacker.test')).toBe(false);
  });

  it('refuses a lookalike of a loopback host', () => {
    // The classic near-miss: a hostname that merely CONTAINS the safe one.
    expect(allow('http://localhost.evil.example.com')).toBe(false);
    expect(allow('http://notlocalhost')).toBe(false);
    expect(allow('http://127.0.0.1.evil.example.com')).toBe(false);
  });

  it('refuses a lookalike of the server’s own host', () => {
    expect(allow(`http://${HOST}.evil.example.com`)).toBe(false);
    expect(allow(`http://evil-${HOST}`)).toBe(false);
  });

  it('refuses the opaque `null` origin (file://, sandboxed iframe)', () => {
    expect(allow('null')).toBe(false);
  });

  it('refuses a malformed origin rather than guessing', () => {
    expect(allow('not a url')).toBe(false);
    expect(allow('')).toBe(false);
  });

  it('honours an explicitly configured origin', () => {
    expect(allow('https://mockups.example.com', ['https://mockups.example.com'])).toBe(true);
    // Configuration is exact — it does not widen to siblings.
    expect(allow('https://other.example.com', ['https://mockups.example.com'])).toBe(false);
  });

  it('treats an absent Origin as a non-browser client', () => {
    // curl, the MCP child, agent HTTP calls. Browsers always send Origin on a
    // cross-origin fetch and on every websocket handshake, so "absent" is not
    // a bypass a page can arrange for itself.
    expect(allow(null)).toBe(true);
  });
});

describe('corsHeadersFor', () => {
  it('reflects one specific origin and never a wildcard', () => {
    const h = corsHeadersFor('http://localhost:3000', {
      requestHost: HOST,
      allowedOrigins: [],
    });
    expect(h?.['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(JSON.stringify(h)).not.toContain('*');
  });

  it('varies on Origin so a proxy cannot serve one origin’s response to another', () => {
    const h = corsHeadersFor('http://localhost:3000', { requestHost: HOST, allowedOrigins: [] });
    expect(h?.vary).toBe('Origin');
  });

  it('returns nothing for a disallowed origin, so the browser blocks the read', () => {
    expect(
      corsHeadersFor('https://evil.example.com', { requestHost: HOST, allowedOrigins: [] }),
    ).toBeNull();
  });

  it('returns nothing when there is no Origin — CORS headers are meaningless there', () => {
    expect(corsHeadersFor(null, { requestHost: HOST, allowedOrigins: [] })).toBeNull();
  });

  it('never grants credentials cross-origin', () => {
    // The share session is a cookie. The review app is served from the same
    // origin it talks to, so credentialed cross-origin requests are never
    // needed — and granting them would hand a visitor's session to any
    // allowed origin.
    const h = corsHeadersFor('http://localhost:3000', { requestHost: HOST, allowedOrigins: [] });
    expect(h?.['access-control-allow-credentials']).toBeUndefined();
  });
});
