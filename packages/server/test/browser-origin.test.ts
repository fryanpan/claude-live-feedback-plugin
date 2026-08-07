import { describe, expect, it } from 'bun:test';
import {
  LOOPBACK_HOSTS,
  corsHeadersFor,
  isAllowedBrowserOrigin,
} from '../src/middleware/browser-origin.ts';

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
const SELF = `http://${HOST}`;
// What the server folds together for the LOCAL surface: loopback plus this
// machine's own names. See policyFor in server.ts.
const LOCAL_NAMES = [
  ...LOOPBACK_HOSTS,
  'mac-mini.example.ts.net',
  'mac-mini.local',
  '192.168.1.42',
];

const allow = (origin: string | null, extra: string[] = [], self = SELF) =>
  isAllowedBrowserOrigin(origin, {
    requestOrigin: self,
    localHostnames: LOCAL_NAMES,
    allowedOrigins: extra,
  });

describe('isAllowedBrowserOrigin', () => {
  it('allows the review app itself (same origin)', () => {
    expect(allow(SELF)).toBe(true);
  });

  it('compares the SCHEME too — http and https are different origins', () => {
    // Only matters for a hostname that isn't one of ours: for our own names
    // the rule below allows either scheme deliberately. A share host served
    // over https must not trust a plain-http page on the same name.
    const shareSelf = 'https://share.example.com';
    const p = { requestOrigin: shareSelf, localHostnames: [], allowedOrigins: [] };
    expect(isAllowedBrowserOrigin('https://share.example.com', p)).toBe(true);
    expect(isAllowedBrowserOrigin('http://share.example.com', p)).toBe(false);
  });

  it('allows a dev server on any of THIS machine’s own hostnames', () => {
    // The widget is embedded in a dev server that may be reached over the
    // tailnet or the LAN, not just loopback — pointing back at this server.
    // Those names resolve only to this machine, so a remote attacker's page
    // cannot be served from them. Any port: dev servers pick their own.
    expect(allow('http://mac-mini.example.ts.net:3000')).toBe(true);
    expect(allow('http://mac-mini.local:4321')).toBe(true);
    expect(allow('http://192.168.1.42:5173')).toBe(true);
    expect(allow('https://mac-mini.local:3000')).toBe(true);
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

  it('refuses a lookalike of a local hostname', () => {
    expect(allow('http://mac-mini.local.evil.example.com')).toBe(false);
    expect(allow('http://evil-mac-mini.local')).toBe(false);
    expect(allow('http://192.168.1.42.evil.example.com')).toBe(false);
  });

  it('does not trust private IPs wholesale — only the ones we enumerated', () => {
    // Origin is attacker-controlled text. Trusting 192.168/16 as a class
    // would let any page claim to be on the LAN.
    expect(allow('http://192.168.1.99:3000')).toBe(false);
    expect(allow('http://10.0.0.5:3000')).toBe(false);
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
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(h?.['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(JSON.stringify(h)).not.toContain('*');
  });

  it('varies on Origin so a proxy cannot serve one origin’s response to another', () => {
    const h = corsHeadersFor('http://localhost:3000', {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(h?.vary).toBe('Origin');
  });

  it('grants nothing to a disallowed origin, so the browser blocks the read', () => {
    const h = corsHeadersFor('https://evil.example.com', {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(h?.['access-control-allow-origin']).toBeUndefined();
    // ...but the reply still varies by origin, or a shared cache could store
    // this header-less response and replay it to an origin we DO allow.
    expect(h?.vary).toBe('Origin');
  });

  it('returns nothing when there is no Origin — CORS headers are meaningless there', () => {
    expect(
      corsHeadersFor(null, {
        requestOrigin: SELF,
        localHostnames: LOCAL_NAMES,
        allowedOrigins: [],
      }),
    ).toBeNull();
  });

  it('grants Private Network Access ONLY to an explicitly configured origin', () => {
    // Chromium preflights a public origin reaching a private address with
    // `Access-Control-Request-Private-Network` and fails the request without
    // this header — so the cross-machine ALLOWED_ORIGINS flow needs it. It is
    // a grant for a public site to reach into the private network, so it is
    // deliberately NOT extended to the automatic allowances.
    const configured = corsHeadersFor('https://mockups.example.com', {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: ['https://mockups.example.com'],
    });
    expect(configured?.['access-control-allow-private-network']).toBe('true');

    const loopback = corsHeadersFor('http://localhost:3000', {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(loopback?.['access-control-allow-private-network']).toBeUndefined();

    const sameOrigin = corsHeadersFor(SELF, {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(sameOrigin?.['access-control-allow-private-network']).toBeUndefined();
  });

  it('never grants credentials cross-origin', () => {
    // The share session is a cookie. The review app is served from the same
    // origin it talks to, so credentialed cross-origin requests are never
    // needed — and granting them would hand a visitor's session to any
    // allowed origin.
    const h = corsHeadersFor('http://localhost:3000', {
      requestOrigin: SELF,
      localHostnames: LOCAL_NAMES,
      allowedOrigins: [],
    });
    expect(h?.['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('the public share surface is same-origin only', () => {
  /**
   * The dev-server allowances (loopback, this machine's hostnames,
   * ALLOWED_ORIGINS) exist for the LOCAL surface, where nothing is
   * cookie-authenticated. A share host is different: the visitor holds a
   * `SameSite=Lax` session cookie, and CORS does not govern websockets at all
   * — so an allowlisted origin that happens to be same-SITE with the share
   * host would carry that cookie into `/y/<docId>` and read and write the doc
   * as a logged-in visitor. (The REST path is already blocked, because we
   * never send Access-Control-Allow-Credentials and a credentialed JSON POST
   * fails its preflight — but the socket has no such protection.)
   *
   * A share visitor loads the app FROM the share host, so same-origin is all
   * they ever need.
   */
  const sharePolicy = {
    requestOrigin: 'https://feedback.example.com',
    localHostnames: [],
    allowedOrigins: [],
  };

  it('allows the share host itself', () => {
    expect(isAllowedBrowserOrigin('https://feedback.example.com', sharePolicy)).toBe(true);
  });

  it('refuses a same-site sibling that would carry the session cookie', () => {
    expect(isAllowedBrowserOrigin('https://mockups.example.com', sharePolicy)).toBe(false);
  });

  it('refuses loopback on the share surface', () => {
    expect(isAllowedBrowserOrigin('http://localhost:3000', sharePolicy)).toBe(false);
  });
});
