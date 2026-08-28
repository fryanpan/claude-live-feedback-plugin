/**
 * The widget popup-token routes: a dev-server embed borrows the identity a
 * browser proved to the workspace origin, and nothing more.
 *
 * The load-bearing security claims each get a test in BOTH directions:
 * a live session's token attributes comments (positive control), and the
 * same token is refused — not silently downgraded — after the session is
 * revoked, whether by logout (denylist) or by the roster watermark, or when
 * presented from any origin but the one it was minted for.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElementAnchor, type User, emailIdentityId } from '@feedback/core';
import { activityLogPath, resetOwnerIdentities } from '../src/activity.ts';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

/** An origin the policy treats as a dev server on this machine. */
const DEV_ORIGIN = 'http://127.0.0.1:5173';

const cleanups: Array<() => void | Promise<void>> = [];
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  resetOwnerIdentities();
});

function boot(options: { requireEmailAuth?: boolean; dataDir?: string } = {}): {
  base: string;
  dataDir: string;
  handle: ServerHandle;
} {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'widget-token-routes-'));
  const handle = createServer({ port: 0, dataDir, requireEmailAuth: options.requireEmailAuth });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { base: `http://localhost:${handle.port}`, dataDir, handle };
}

async function signIn(base: string, email: string): Promise<string> {
  const before = codes.length;
  const started = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(started.status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: codes[codes.length - 1] }),
  });
  expect(res.status).toBe(200);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

async function mintToken(
  base: string,
  cookie: string | null,
  origin: string = DEV_ORIGIN,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${base}/api/auth/widget-token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify({ origin }),
  });
}

/** Sign in and exchange the session for a widget token. */
async function signInAndMint(
  base: string,
  email: string,
): Promise<{ cookie: string; token: string }> {
  const cookie = await signIn(base, email);
  const res = await mintToken(base, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(typeof body.token).toBe('string');
  return { cookie, token: body.token };
}

/** A token-carrying request as the widget sends it: a cross-origin fetch
 *  from the dev server, so the browser stamps Origin on it. */
function bearer(token: string, origin: string | null = DEV_ORIGIN): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(origin === null ? {} : { origin }) };
}

async function postComment(
  base: string,
  dataDir: string,
  docId: string,
  token?: string,
  origin: string | null = DEV_ORIGIN,
): Promise<Response> {
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
  const created = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(created.status).toBe(200);
  return await fetch(`${base}/api/docs/${docId}/threads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? bearer(token, origin) : {}),
    },
    body: JSON.stringify({ author: bryan, text: 'this needs more detail', anchor: fakeAnchor }),
  });
}

interface ActivityRow {
  type: string;
  actorId: string;
  actorName: string;
}

function commentRows(dataDir: string): ActivityRow[] {
  // A log that was never written is the "no comment landed" we assert on.
  if (!existsSync(activityLogPath(dataDir))) return [];
  return readFileSync(activityLogPath(dataDir), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ActivityRow)
    .filter((r) => r.type === 'comment');
}

describe('POST /api/auth/widget-token', () => {
  it('refuses without a signed-in session', async () => {
    const { base } = boot();
    const res = await mintToken(base, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_signed_in' });
  });

  it('mints for an allowed dev-server origin and names the user', async () => {
    const { base } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    const res = await mintToken(base, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      token: string;
      origin: string;
      user: { id: string };
    };
    expect(body.ok).toBe(true);
    expect(body.origin).toBe(DEV_ORIGIN);
    expect(body.user.id).toBe(emailIdentityId('reviewer@example.com'));
    // The token is not the cookie — a captured token must never double as one.
    expect(body.token.startsWith('wt1.')).toBe(true);
    expect((cookie.split('=')[1] ?? '').includes(body.token)).toBe(false);
  });

  it('refuses an origin the widget policy does not allow', async () => {
    // The popup would postMessage the token TO this origin; refusing here is
    // what keeps a malicious page from naming itself the recipient.
    const { base } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    const res = await mintToken(base, cookie, 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
  });

  it('refuses a cross-origin caller — minting is the popup page’s alone', async () => {
    const { base } = boot();
    const cookie = await signIn(base, 'reviewer@example.com');
    // A dev-server page calling the mint route directly: its Origin header
    // names the dev server, not us. (Its fetch could not carry the SameSite
    // cookie anyway; this pins the second, independent refusal.)
    const res = await mintToken(base, cookie, DEV_ORIGIN, { origin: DEV_ORIGIN });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'same_origin_only' });
  });
});

describe('GET /api/auth/widget-session', () => {
  it('answers not-authenticated with no token', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it('names the user for a live token', async () => {
    const { base } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: true,
      user: { id: emailIdentityId('reviewer@example.com') },
    });
  });

  it('401s a token that does not verify', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: { authorization: 'Bearer wt1.user-x.sid.1.99999999999999.forged' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'widget_token_invalid' });
  });

  it('ignores an Authorization header that is not a widget token', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: { authorization: 'Bearer something-else-entirely' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });
});

describe('comment attribution', () => {
  it('attributes a token-carrying comment to the verified identity, flag off', async () => {
    // Presenting the token is itself the opt-in: unlike the cookie rung
    // (which stays behind CW_REQUIRE_EMAIL_AUTH), a caller who volunteers a
    // verified token gets the verified attribution today.
    const { base, dataDir } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const res = await postComment(base, dataDir, 'token-doc', token);
    expect(res.status).toBe(200);
    const [row] = commentRows(dataDir);
    expect(row?.actorId).toBe(emailIdentityId('reviewer@example.com'));
    expect(row?.actorName).toBe('Reviewer');
  });

  it('control: the same comment with no token stays the claimed body', async () => {
    const { base, dataDir } = boot();
    await signInAndMint(base, 'reviewer@example.com');
    const res = await postComment(base, dataDir, 'anon-doc');
    expect(res.status).toBe(200);
    expect(commentRows(dataDir)[0]?.actorId).toBe('known-bryan');
  });

  it('refuses — not downgrades — a comment carrying an invalid token', async () => {
    const { base, dataDir } = boot();
    const res = await postComment(base, dataDir, 'forged-doc', 'wt1.user-x.sid.1.9.forged');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'widget_token_invalid' });
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('revocation kills the token', () => {
  it('logout revokes the session, and the token dies with it', async () => {
    const { base, dataDir } = boot();
    const { cookie, token } = await signInAndMint(base, 'reviewer@example.com');

    // Positive control first: the token works while the session lives.
    const alive = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(((await alive.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(200);

    const dead = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(dead.status).toBe(401);
    // And a write is refused outright, not attributed to anyone.
    const write = await postComment(base, dataDir, 'revoked-doc', token);
    expect(write.status).toBe(401);
    expect(commentRows(dataDir).length).toBe(0);
  });

  it('the roster watermark (denylist self-heal) refuses tokens minted before it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'widget-token-watermark-'));
    const first = boot({ dataDir });
    const { token } = await signInAndMint(first.base, 'reviewer@example.com');
    await first.handle.stop();

    // A corrupt denylist at boot fails closed, ends every session via the
    // sessionsValidFrom watermark, and restarts the list empty. A widget
    // token minted from a pre-bump session must die with it.
    writeFileSync(join(dataDir, 'revoked-sessions.json'), 'not json{');
    const second = createServer({ port: 0, dataDir });
    cleanups.push(async () => {
      await second.stop();
    });
    const base = `http://localhost:${second.port}`;
    const res = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(401);
  });
});

describe('the denylist failing closed at runtime', () => {
  it('refuses every token once the denylist is deleted out from under a running server', async () => {
    // Boot-time corruption is covered by the watermark test above; this is
    // the OTHER failed-closed path — the file vanishing while the server
    // runs — which no watermark bump heals. With the list gone nothing can
    // tell a live session from a logged-out one, so every token reads as
    // revoked. Load-bearing check: `isRevoked` itself answers true while
    // failed closed; the explicit `failedClosed()` guard ahead of it in
    // widgetTokenIdentityFor is belt-and-braces (see its comment).
    const { base, dataDir } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const alive = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(alive.status).toBe(200);

    rmSync(join(dataDir, 'revoked-sessions.json'));

    const dead = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(dead.status).toBe(401);
    const write = await postComment(base, dataDir, 'denylist-gone-doc', token);
    expect(write.status).toBe(401);
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('an archived identity', () => {
  it('cannot use its token, even when the row carries no session watermark', async () => {
    // `archive()` bumps sessionsValidFrom, so through the API the watermark
    // alone would refuse the token. The roster is also a file people edit:
    // a row hand-marked `archived` with its watermark left at 0 is exactly
    // the case the status check catches on its own. Remove that check and
    // this token works again.
    const dataDir = mkdtempSync(join(tmpdir(), 'widget-token-archived-'));
    const first = boot({ dataDir });
    const { token } = await signInAndMint(first.base, 'reviewer@example.com');
    const alive = await fetch(`${first.base}/api/auth/widget-session`, {
      headers: bearer(token),
    });
    expect(alive.status).toBe(200);
    await first.handle.stop();

    const rosterPath = join(dataDir, 'identities.json');
    const roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as {
      identities: Record<string, { status: string; sessionsValidFrom: number }>;
    };
    const row = roster.identities[emailIdentityId('reviewer@example.com')];
    expect(row).toBeTruthy();
    (row as { status: string }).status = 'archived';
    (row as { sessionsValidFrom: number }).sessionsValidFrom = 0;
    writeFileSync(rosterPath, JSON.stringify(roster));

    const second = createServer({ port: 0, dataDir });
    cleanups.push(async () => {
      await second.stop();
    });
    const base = `http://localhost:${second.port}`;
    const res = await fetch(`${base}/api/auth/widget-session`, { headers: bearer(token) });
    expect(res.status).toBe(401);
  });
});

describe('the token is bound to the origin it was minted for', () => {
  // The mint route hands the token to one server-validated page origin, and
  // every use must come from that page: the browser stamps Origin on each
  // cross-origin fetch the widget makes, and nothing else can forge it. A
  // token lifted out of a dev server's localStorage is worthless from curl,
  // from another origin, or from an opaque (`null`) one.
  it('accepts the token from the origin it was minted for (positive control)', async () => {
    const { base, dataDir } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const probe = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token, DEV_ORIGIN),
    });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const write = await postComment(base, dataDir, 'bound-doc', token, DEV_ORIGIN);
    expect(write.status).toBe(200);
    expect(commentRows(dataDir)[0]?.actorId).toBe(emailIdentityId('reviewer@example.com'));
  });

  it.each([
    ['another allowed origin', 'http://localhost:3000'],
    ['no Origin header at all (curl, a server-side replay)', null],
    ['an opaque origin', 'null'],
  ])('refuses the token presented from %s', async (_label, origin) => {
    const { base, dataDir } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const probe = await fetch(`${base}/api/auth/widget-session`, {
      headers: bearer(token, origin),
    });
    expect(probe.status).toBe(401);
    expect(await probe.json()).toEqual({ error: 'widget_token_invalid' });
    const write = await postComment(base, dataDir, 'unbound-doc', token, origin);
    // An opaque-origin write is refused one wall earlier, by the browser-
    // origin policy (403); the probe above is what pins the token gate.
    expect([401, 403]).toContain(write.status);
    expect(commentRows(dataDir).length).toBe(0);
  });
});

describe('the token is narrower than the session', () => {
  it('does not make /api/auth/session report signed-in', async () => {
    const { base } = boot();
    const { token } = await signInAndMint(base, 'reviewer@example.com');
    const res = await fetch(`${base}/api/auth/session`, {
      headers: bearer(token),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});

describe('GET /widget-auth (the popup page)', () => {
  it('serves the handshake page, never inside a frame', async () => {
    const { base } = boot();
    const res = await fetch(`${base}/widget-auth`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    // Framing would let a same-site page mint silently, with no visible
    // popup. The flow is popup-only.
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
