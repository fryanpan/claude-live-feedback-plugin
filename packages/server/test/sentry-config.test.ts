import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The Sentry half of the monitoring ask: the DSN lives in server config on
 * the box — NOT in this public repo — and reaches the browser through meta
 * tags in the served shells. The client only loads the Sentry SDK when the
 * shell emits the loader script, so an unconfigured install (every test,
 * every stranger's clone) ships zero Sentry bytes and makes zero external
 * requests.
 *
 * Four surfaces, not one. Until this suite grew, only `/workspaces/<id>`
 * carried the tag, so every transaction Sentry held was a board and "how
 * long does a doc take to open" had no answer at all. Each page type is
 * asserted separately and by NAME, because the whole point of the tag is to
 * group by it — a shell that carried the DSN but no page type would look
 * instrumented and still be uncomparable.
 *
 * Every DSN below is fictional and every fixture synthetic.
 */
const FAKE_DSN = 'https://examplekey@o0.ingest.sentry.io/0';
const FAKE_RELEASE = 'v9.9.9-12-gfeedface';

describe('the served shells carry the Sentry DSN and page type only when configured', () => {
  let withDsn: ServerHandle;
  let without: ServerHandle;
  let dirA: string;
  let dirB: string;
  let srcDir: string;
  let appDistA: string;
  let appDistB: string;
  let wsA: string;
  let wsB: string;
  let baseA: string;
  let baseB: string;

  const post = (base: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A stand-in for the built review app. These routes decide WHICH shell to
   *  serve and what to add to it, not what is in it. */
  function fakeAppDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sentry-dist-'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html>\n<html><head><title>app shell</title></head><body><div id="editor"></div></body></html>',
    );
    return dir;
  }

  async function seed(base: string): Promise<string> {
    const mk = await post(base, '/api/workspaces', { name: 'monitoring board' });
    const wsId = ((await mk.json()) as { workspace: { id: string } }).workspace.id;
    writeFileSync(join(srcDir, `${base.split(':').pop()}.md`), '# Doc\n\nBody.\n');
    await post(base, '/api/docs', {
      docId: 'a-doc',
      type: 'markdown',
      sourceUrl: join(srcDir, `${base.split(':').pop()}.md`),
      hubWorkspaceId: wsId,
    });
    const mockPath = join(srcDir, `${base.split(':').pop()}.html`);
    writeFileSync(
      mockPath,
      '<!doctype html><html><head><title>Mock</title></head><body>hi</body></html>',
    );
    await post(base, '/api/docs', {
      docId: 'a-mock',
      type: 'mockup',
      sourceUrl: mockPath,
      hubWorkspaceId: wsId,
    });
    return wsId;
  }

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'sentry-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'sentry-b-'));
    srcDir = mkdtempSync(join(tmpdir(), 'sentry-src-'));
    appDistA = fakeAppDist();
    appDistB = fakeAppDist();
    withDsn = createServer({
      port: 0,
      dataDir: dirA,
      markdownAppDistDir: appDistA,
      sentryDsn: FAKE_DSN,
      sentryRelease: FAKE_RELEASE,
    });
    without = createServer({ port: 0, dataDir: dirB, markdownAppDistDir: appDistB });
    baseA = `http://localhost:${withDsn.port}`;
    baseB = `http://localhost:${without.port}`;
    wsA = await seed(baseA);
    wsB = await seed(baseB);
  });

  afterAll(async () => {
    await withDsn.stop();
    await without.stop();
    for (const d of [dirA, dirB, srcDir, appDistA, appDistB]) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /** The four surfaces Bryan named — "home page, doc, mockup, board" — plus
   *  sign-in, which is a page a slow load could otherwise hide in. */
  const surfaces: Array<{ what: string; pageType: string; path: (ws: string) => string }> = [
    { what: 'the board', pageType: 'board', path: (ws) => `/workspaces/${ws}/home` },
    { what: 'a doc', pageType: 'doc', path: (ws) => `/workspaces/${ws}/docs/a-doc` },
    { what: 'a mockup', pageType: 'mockup', path: (ws) => `/workspaces/${ws}/mockups/a-mock` },
    { what: 'the landing page', pageType: 'landing', path: () => '/' },
    { what: 'the sign-in page', pageType: 'signin', path: () => '/signin' },
  ];

  for (const { what, pageType, path } of surfaces) {
    it(`configured: ${what} names the DSN, its page type, and the release`, async () => {
      const html = await (await fetch(`${baseA}${path(wsA)}`)).text();
      expect(html).toContain(`<meta name="sentry-dsn" content="${FAKE_DSN}" />`);
      expect(html).toContain(`<meta name="sentry-page-type" content="${pageType}" />`);
      expect(html).toContain(`<meta name="sentry-release" content="${FAKE_RELEASE}" />`);
      expect(html).toContain('<script type="module" src="/app/sentry.js"></script>');
    });

    it(`unconfigured: ${what} carries no Sentry anything`, async () => {
      const res = await fetch(`${baseB}${path(wsB)}`);
      const html = await res.text();
      // Positive control: the page actually rendered. Without it, "no sentry
      // tag" is satisfied by a 404 body just as well as by a working shell.
      expect(res.status).toBe(200);
      expect(html.length).toBeGreaterThan(20);
      expect(html).not.toContain('sentry');
      expect(html).not.toContain('/app/sentry.js');
    });
  }

  it('the mockup keeps its own content and its widget embed alongside the tags', async () => {
    const html = await (await fetch(`${baseA}/workspaces/${wsA}/mockups/a-mock`)).text();
    // The tags are additive: the page under review is still the page under
    // review, and the review scaffolding still gets injected.
    expect(html).toContain('hi');
    expect(html).toContain('claude-feedback-widget');
    expect(html).toContain('<meta name="sentry-page-type" content="mockup" />');
  });

  it('an unreleased deploy names no release rather than guessing one', async () => {
    // Dev and staging run straight from a checkout with no published
    // release, exactly as the server-side init already behaves.
    const dir = mkdtempSync(join(tmpdir(), 'sentry-c-'));
    const dist = fakeAppDist();
    const h = createServer({
      port: 0,
      dataDir: dir,
      markdownAppDistDir: dist,
      sentryDsn: FAKE_DSN,
    });
    try {
      const html = await (await fetch(`http://localhost:${h.port}/`)).text();
      expect(html).toContain(`<meta name="sentry-dsn" content="${FAKE_DSN}" />`);
      expect(html).not.toContain('sentry-release');
    } finally {
      await h.stop();
      rmSync(dir, { recursive: true, force: true });
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('the doc shell is served with an etag describing the bytes actually sent', async () => {
    // The shell is a built file rewritten on the way out. Serving the FILE's
    // hash beside a rewritten body would hand a browser a 304 for a document
    // it never received — so the two servers' etags for the same index.html
    // must differ, and each must match a re-fetch of its own.
    const a = await fetch(`${baseA}/workspaces/${wsA}/docs/a-doc`);
    const b = await fetch(`${baseB}/workspaces/${wsB}/docs/a-doc`);
    expect(a.headers.get('etag')).toBeTruthy();
    expect(b.headers.get('etag')).toBeTruthy();
    expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'));
    const again = await fetch(`${baseA}/workspaces/${wsA}/docs/a-doc`);
    expect(again.headers.get('etag')).toBe(a.headers.get('etag'));
  });
});
