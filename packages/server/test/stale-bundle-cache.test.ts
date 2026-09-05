/**
 * A reload cannot return the bundle the tab is already running.
 *
 * Reported by Bryan on an iPad: "New version available" appeared, he tapped
 * Reload, and the banner came straight back. The banner was right. The tab
 * really was still on the old build after the reload, and the reason is that
 * nothing the server sent could make it otherwise: every entry bundle lived at
 * a PERMANENT url (`/app/board.js`), so whether a reload picked up new bytes was
 * a decision only the browser's cache made. `Cache-Control: no-cache` asks for
 * revalidation; it does not compel it. And the shell naming those urls went
 * out with no cache directives and no validator at all, which makes it
 * heuristically cacheable — the browser picks its own freshness lifetime for
 * the one document that decides which bundles the page loads.
 *
 * The fix removes the browser from the decision, and this suite is that chain
 * in four links:
 *
 *   1. the shell is `no-store`, so a reload always re-fetches it;
 *   2. every asset the shell names is content-addressed;
 *   3. changing an asset changes the url the shell names;
 *   4. so after a deploy the reload asks for urls no cache has ever held.
 *
 * Link 3 is the one that carries the others. A test that only checked for a
 * hash-shaped filename would pass against a build that stamped the same hash
 * forever, so the assertions below compare the url BEFORE and AFTER a
 * simulated redeploy rather than matching a shape.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashedAssetName } from '@feedback/core/asset-manifest';
import { type ServerHandle, createServer } from '../src/server.ts';

/** Every `/app/...` url an HTML document references. */
function appRefs(html: string): string[] {
  return [...html.matchAll(/(?:src|href)="(\/app\/[^"]+)"/g)].map((m) => m[1] as string);
}

describe('a reload cannot return the old bundle', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let dist: string;
  let base: string;
  let wsId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /**
   * Writes a dist the way the real build does: the plain name, the
   * content-addressed copy, and a manifest naming the pairing. Called twice
   * per test — the second call IS the redeploy.
   */
  const publish = (bodies: Record<string, string>): Record<string, string> => {
    const manifest: Record<string, string> = {};
    for (const [name, body] of Object.entries(bodies)) {
      const emitted = hashedAssetName(name, body);
      writeFileSync(join(dist, name), body);
      writeFileSync(join(dist, emitted), body);
      manifest[name] = emitted;
    }
    writeFileSync(join(dist, 'asset-manifest.json'), JSON.stringify(manifest));
    // The doc shell is a built file, so the BUILD is what rewrites its refs.
    // Reproduced here rather than imported so the test states what it expects
    // the build to have produced.
    writeFileSync(
      join(dist, 'index.html'),
      `<!doctype html><html><head><link rel="stylesheet" href="/app/${manifest['styles.css']}" /></head>` +
        `<body><script type="module" src="/app/${manifest['app.js']}"></script></body></html>`,
    );
    return manifest;
  };

  const v = (n: number): Record<string, string> => ({
    'app.js': `export const build = ${n};\n`,
    'board.js': `export const board = ${n};\n`,
    'landing.js': `export const landing = ${n};\n`,
    'signin.js': `export const signin = ${n};\n`,
    'styles.css': `body{--v:${n}}\n`,
    'board.css': `.board{--v:${n}}\n`,
    'signin.css': `.signin-card{--v:${n}}\n`,
    'tokens.css': `:root{--t:${n}}\n`,
  });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'stale-cache-data-'));
    dist = mkdtempSync(join(tmpdir(), 'stale-cache-dist-'));
    publish(v(1));
    // emailCodeSignIn: the server's own emailed-code sign-in is off by default now
    // that every browser-facing hostname sits behind Cloudflare Access. These tests
    // are about that flow, so they ask for it explicitly.
    handle = createServer({ port: 0, dataDir, markdownAppDistDir: dist, emailCodeSignIn: true });
    base = `http://localhost:${handle.port}`;
    const ws = await local('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cache-board', goal: 'Serve it fresh.' }),
    });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterEach(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
  });

  // ── Link 1: the shell is never stored ─────────────────────────────────────

  it('serves every HTML shell no-store', async () => {
    // The shell names the bundle urls, so a browser holding an old copy loads
    // the bundles IT names and there is no later request in which to notice.
    // Served with NO cache directives, as these were, a browser assigns its
    // own heuristic lifetime — which is the failure, not a hypothetical.
    for (const path of ['/', `/workspaces/${wsId}`, '/signin']) {
      const res = await local(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  // ── Link 2: the shell names only content-addressed urls ───────────────────

  it('names no permanent bundle url from any shell', async () => {
    const board = await local(`/workspaces/${wsId}`);
    const refs = appRefs(await board.text());

    // Positive control on the extractor: a shell that referenced nothing
    // would satisfy "no permanent url" vacuously, and this whole suite would
    // pass against a blank page.
    expect(refs.length).toBeGreaterThan(0);

    const manifest = JSON.parse(await (await local('/app/asset-manifest.json')).text()) as Record<
      string,
      string
    >;
    const hashed = new Set(Object.values(manifest).map((n) => `/app/${n}`));
    for (const ref of refs) expect(hashed.has(ref)).toBe(true);
    // Said the other way round, against the exact urls that used to be here.
    for (const permanent of [
      '/app/board.js',
      '/app/styles.css',
      '/app/board.css',
      '/app/signin.css',
      '/app/tokens.css',
    ]) {
      expect(refs).not.toContain(permanent);
    }
  });

  // ── Link 3: new bytes, new url ───────────────────────────────────────────

  it('names a DIFFERENT url after a deploy that changed the bundle', async () => {
    const before = appRefs(await (await local(`/workspaces/${wsId}`)).text());

    publish(v(2));

    const after = appRefs(await (await local(`/workspaces/${wsId}`)).text());
    expect(after.length).toBe(before.length);
    // Not one url survives the deploy — so a cache holding every one of them
    // has nothing that can answer the reload. This is the assertion the bug
    // failed: every url used to survive every deploy.
    for (const ref of after) expect(before).not.toContain(ref);
  });

  it('keeps the SAME url across a deploy that changed nothing', async () => {
    // The other direction, and the reason the id is a content hash rather
    // than a clock: prod rebuilds the client on every restart, and a url that
    // moved each time would evict a multi-megabyte bundle from every cache
    // for nothing — and set the stale banner off on every plain restart.
    const before = appRefs(await (await local(`/workspaces/${wsId}`)).text());
    publish(v(1));
    const after = appRefs(await (await local(`/workspaces/${wsId}`)).text());
    expect(after).toEqual(before);
  });

  // ── Link 4: what those urls are served with ──────────────────────────────

  it('serves a content-addressed asset immutable, and a permanent name not', async () => {
    const manifest = JSON.parse(await (await local('/app/asset-manifest.json')).text()) as Record<
      string,
      string
    >;

    const hashed = await local(`/app/${manifest['board.js']}`);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // The plain copy is still emitted and still served, because a shell a
    // browser cached BEFORE this change asks for it — a 404 there would be a
    // blank page, which is worse than the banner. It keeps `no-cache`:
    // `immutable` on a name whose bytes can change would be the original bug
    // with the revalidation removed.
    const permanent = await local('/app/board.js');
    expect(permanent.status).toBe(200);
    expect(permanent.headers.get('cache-control')).toBe('no-cache');
  });

  it('never lets BUILD_INFO.txt be stored', async () => {
    // The stale check reads this to learn the truth. A cached copy of it is
    // the check lying to itself: the tab would compare its own build id
    // against a remembered answer and conclude it was current.
    writeFileSync(join(dist, 'BUILD_INFO.txt'), 'built abc123\n');
    const res = await local('/app/BUILD_INFO.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // ── The fallback that keeps an old dist working ──────────────────────────

  it('falls back to the permanent names when the dist has no manifest', async () => {
    // A server pointed at a dist built before hashing landed — and a dev
    // build mid-rebuild. It must serve a working page, which means the plain
    // names, which is exactly what it did before.
    rmSync(join(dist, 'asset-manifest.json'));
    const refs = appRefs(await (await local(`/workspaces/${wsId}`)).text());
    expect(refs).toContain('/app/board.js');
    expect(refs).toContain('/app/styles.css');
  });
});
