/**
 * The push feature as a browser meets it: the enrolment routes, and the
 * files that only work because of the PATH they answer at.
 *
 * The unit suites prove the crypto, the store and the send. What they cannot
 * prove is that any of it is reachable — and the reachability is the whole
 * risk here. A service worker served one directory too deep registers fine
 * and then silently cannot handle a click on a `/workspaces/…` link, which
 * looks exactly like a bug in the notification rather than in a route.
 *
 * Fixtures are synthetic; the "built client" is a temp dir of marker files.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '../src/push-crypto.ts';
import { SUBSCRIPTIONS_FILENAME } from '../src/push-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const trash: string[] = [];
let handle: ServerHandle | null = null;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trash.push(d);
  return d;
}

afterEach(async () => {
  await handle?.stop();
  handle = null;
  while (trash.length > 0) rmSync(trash.pop() as string, { recursive: true, force: true });
});

/** A markdown-app dist with the files the root aliases point at. */
function fakeClient(): string {
  const dir = tmp('lf-push-app-');
  writeFileSync(join(dir, 'app.js'), '//app\n');
  writeFileSync(join(dir, 'index.html'), '<!--shell-->\n');
  writeFileSync(join(dir, 'sw.js'), '/*service worker marker*/\n');
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Claude Workspaces"}\n');
  writeFileSync(join(dir, 'icon-192.png'), 'not-really-a-png');
  writeFileSync(join(dir, 'apple-touch-icon.png'), 'not-really-a-png');
  return dir;
}

async function start(opts: { client?: boolean; publicBaseUrl?: string } = {}) {
  const dataDir = tmp('lf-push-data-');
  const server = createServer({
    port: 0,
    dataDir,
    ...(opts.client === false ? {} : { markdownAppDistDir: fakeClient() }),
    // Push needs a secure origin to be meaningful; the default discovered
    // base is http://<host>:<port>, which is the disabled case.
    ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}),
  });
  handle = server;
  return { base: `http://localhost:${server.port}`, dataDir, port: server.port };
}

function subscription(endpoint = 'https://push.example.com/s/abc') {
  const p256dh = new Uint8Array(65);
  p256dh[0] = 0x04;
  crypto.getRandomValues(p256dh.subarray(1));
  return {
    endpoint,
    keys: {
      p256dh: b64urlEncode(p256dh),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

const AUTHOR = { id: 'u-bryan', name: 'Bryan' };

describe('GET /api/push/key', () => {
  it('offers a real VAPID public key on an https origin', async () => {
    const { base } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const body = (await (await fetch(`${base}/api/push/key`)).json()) as {
      available: boolean;
      publicKey?: string;
    };
    expect(body.available).toBe(true);
    // Uncompressed P-256 point, base64url — 65 bytes is 87 characters.
    expect(body.publicKey?.length).toBe(87);
    expect(body.publicKey?.startsWith('B')).toBe(true);
  });

  it('hands out the SAME key on a second call', async () => {
    const { base } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const first = (await (await fetch(`${base}/api/push/key`)).json()) as { publicKey: string };
    const second = (await (await fetch(`${base}/api/push/key`)).json()) as { publicKey: string };
    // A key that moved between page loads would invalidate the subscription
    // the previous load just made, and nothing would report it.
    expect(second.publicKey).toBe(first.publicKey);
  });

  it('says the origin is insecure rather than offering a key nothing can use', async () => {
    const { base } = await start();
    const body = (await (await fetch(`${base}/api/push/key`)).json()) as {
      available: boolean;
      reason?: string;
    };
    expect(body.available).toBe(false);
    expect(body.reason).toBe('insecure-origin');
  });
});

describe('POST /api/push/subscriptions', () => {
  it('persists an enrolment where a restarted server will find it', async () => {
    const { base, dataDir } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const sub = subscription();
    const res = await fetch(`${base}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AUTHOR, subscription: sub }),
    });
    expect(res.status).toBe(200);
    const onDisk = await Bun.file(join(dataDir, SUBSCRIPTIONS_FILENAME)).json();
    expect(Object.keys(onDisk.subscriptions)).toEqual([sub.endpoint]);
    expect(onDisk.subscriptions[sub.endpoint].userName).toBe('Bryan');
  });

  it('refuses a body with no subscription', async () => {
    const { base } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const res = await fetch(`${base}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AUTHOR }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an endpoint that is not https', async () => {
    const { base } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const res = await fetch(`${base}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: AUTHOR,
        subscription: subscription('http://push.example.com/s/abc'),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an unattributed enrolment', async () => {
    const { base } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const res = await fetch(`${base}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: subscription() }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/push/subscriptions', () => {
  it('soft-deletes: the row survives with a reason, out of the active set', async () => {
    const { base, dataDir } = await start({ publicBaseUrl: 'https://reviews.example.com' });
    const sub = subscription();
    await fetch(`${base}/api/push/subscriptions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AUTHOR, subscription: sub }),
    });
    const res = await fetch(`${base}/api/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(res.status).toBe(200);

    const onDisk = await Bun.file(join(dataDir, SUBSCRIPTIONS_FILENAME)).json();
    expect(onDisk.subscriptions[sub.endpoint].disabledAt).toBeGreaterThan(0);
    expect(onDisk.subscriptions[sub.endpoint].disabledReason).toBe('unsubscribed');
  });
});

describe('root-path web app files', () => {
  it('serves the service worker at /sw.js, not only under /app/', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/sw.js`);
    expect(res.status).toBe(200);
    // The scope of a worker cannot exceed the directory it came from. At
    // /app/sw.js it could never handle a click on /workspaces/… .
    expect(await res.text()).toContain('service worker marker');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('serves the manifest with the type a browser will install', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    // application/octet-stream here is why "Add to Home Screen" silently
    // produces a bookmark instead of a web app.
    expect(res.headers.get('content-type')).toBe('application/manifest+json');
  });

  it('serves the icons the manifest and iOS point at', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/icon-192.png`)).status).toBe(200);
    expect((await fetch(`${base}/apple-touch-icon.png`)).status).toBe(200);
  });

  it('404s a root path that is not on the alias list', async () => {
    // The positive control for the three above: the route is an allowlist,
    // not a pass-through of the whole dist directory to the root.
    const { base } = await start();
    expect((await fetch(`${base}/app.js`)).status).toBe(404);
    expect((await fetch(`${base}/index.html`)).status).toBe(404);
  });

  it('404s cleanly when no client has been built', async () => {
    const { base } = await start({ client: false });
    expect((await fetch(`${base}/sw.js`)).status).toBe(404);
  });
});

describe('web app shells', () => {
  it('links the manifest from the review shell', async () => {
    // Read at the source rather than over HTTP: this shell is a static file
    // the build copies, and the route only serves it for a doc that exists —
    // so a served-HTML assertion here would either need a fixture doc or
    // would quietly be checking the "doc not found" page instead.
    const html = await Bun.file(
      join(import.meta.dir, '..', '..', 'markdown-app', 'index.html'),
    ).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-touch-icon');
  });

  it('links the manifest from the landing page — the manifest start_url', async () => {
    const { base } = await start();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-touch-icon');
  });

  it('links the manifest from the hub shell', async () => {
    const { base } = await start();
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'push-hub', goal: 'Ship it.' }),
    });
    const { workspace } = (await created.json()) as { workspace: { id: string } };
    const html = await (await fetch(`${base}/workspaces/${workspace.id}`)).text();
    // Two shells, two hand-written heads — an install started from the board
    // has to produce the same web app as one started from a review doc.
    expect(html).toContain('rel="manifest"');
  });
});
