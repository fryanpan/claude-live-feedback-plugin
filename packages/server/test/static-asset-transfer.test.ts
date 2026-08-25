/**
 * Static assets are compressed, and a repeat load can be answered with a 304.
 *
 * The board shell is a ~1 KB HTML page that then pulls its CSS and JS. Those
 * two files, plus the widget bundle, were the largest thing this server sent
 * anyone — and they went out raw: no `content-encoding`, and `cache-control:
 * no-cache` with NEITHER an `etag` nor a `last-modified` to revalidate
 * against. Those two facts compound rather than merely coexisting. `no-cache`
 * does not mean "do not store", it means "revalidate before use" — but a
 * revalidation needs a validator, and with none present the only answer the
 * server can give is the whole body again. So every board load re-sent every
 * byte, and none of the bytes were compressed.
 *
 * That is invisible on a desktop beside the server and dominates the load on a
 * phone or tablet over a slow link, which is exactly where the board is read.
 *
 * The compression gate stays an allowlist rather than becoming a `text/*`
 * sweep. The hazard it exists to prevent is buffering a LIVE stream in order
 * to compress it, which would hold every event until the stream closed; this
 * server's only streaming body is SSE, and the last test here pins that
 * `text/event-stream` is still excluded. Adding a type to the list is a claim
 * that bodies of that type are finite, and css/js/svg/html are.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/** Comfortably over COMPRESS_MIN_BYTES, and repetitive enough that a failure
 *  to compress is unmistakable rather than marginal. */
const CSS_BODY = '.a{color:#123456;padding:4px}\n'.repeat(400);
const JS_BODY = 'export const value = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa";\n'.repeat(400);

describe('static assets are compressed and revalidatable', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let distDir: string;
  let base: string;

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}`, ...headers } });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'static-transfer-data-'));
    distDir = mkdtempSync(join(tmpdir(), 'static-transfer-dist-'));
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'styles.css'), CSS_BODY);
    writeFileSync(join(distDir, 'hub.js'), JS_BODY);

    handle = createServer({ port: 0, dataDir, markdownAppDistDir: distDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(distDir, { recursive: true, force: true });
  });

  it('gzips CSS and JS for a client that asks', async () => {
    for (const [path, raw] of [
      ['/app/styles.css', CSS_BODY],
      ['/app/hub.js', JS_BODY],
    ] as const) {
      // Positive control: without the header the full body still arrives, so
      // "smaller when asked" below is a claim about encoding and not about a
      // route that started answering with nothing.
      const plain = await get(path);
      expect(plain.status).toBe(200);
      expect(await plain.text()).toBe(raw);

      const zipped = await get(path, { 'accept-encoding': 'gzip' });
      expect(zipped.status).toBe(200);
      expect(zipped.headers.get('content-encoding')).toBe('gzip');
      // A shared cache that stored one of these must not hand it to a client
      // that asked for the other.
      expect(zipped.headers.get('vary')).toBe('accept-encoding');
      // fetch decodes transparently, so assert on the wire length the server
      // committed to rather than on the body it hands back.
      const wire = Number(zipped.headers.get('content-length'));
      expect(wire).toBeGreaterThan(0);
      expect(wire).toBeLessThan(raw.length / 2);
      // Decoded, it is still byte-for-byte the file.
      expect(await zipped.text()).toBe(raw);
    }
  });

  it('offers an etag and answers a matching revalidation with 304', async () => {
    const first = await get('/app/styles.css');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    // `no-cache` is kept deliberately — the fleet redeploys often and a stale
    // bundle is worse than a revalidation. The etag is what makes that
    // revalidation cheap instead of a full re-send.
    expect(first.headers.get('cache-control')).toBe('no-cache');

    const revalidated = await get('/app/styles.css', { 'if-none-match': etag as string });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');

    // A validator that never matches would be worse than none: it would look
    // correct here while re-sending every body in production. Pin that a
    // DIFFERENT etag still gets the whole file.
    const stale = await get('/app/styles.css', { 'if-none-match': '"not-the-one"' });
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe(CSS_BODY);
  });

  it('gives a changed file a different etag', async () => {
    const before = await get('/app/hub.js');
    const beforeTag = before.headers.get('etag');
    expect(beforeTag).toBeTruthy();

    // A redeploy rewrites the file in place. If the etag did not move, every
    // client holding the old one would be told 304 and keep running the old
    // bundle — the silent-stale-deploy failure this server already knows well.
    writeFileSync(join(distDir, 'hub.js'), `${JS_BODY}// changed\n`);

    const after = await get('/app/hub.js');
    expect(after.headers.get('etag')).not.toBe(beforeTag);
    const stillMatched = await get('/app/hub.js', { 'if-none-match': beforeTag as string });
    expect(stillMatched.status).toBe(200);
  });

  it('still refuses to compress an event stream', async () => {
    // The whole reason the allowlist is an allowlist. Buffering this to gzip
    // it would hold every event until the stream closed.
    const { COMPRESSIBLE_FOR_TEST } = await import('../src/compress.ts');
    expect(COMPRESSIBLE_FOR_TEST.test('text/event-stream')).toBe(false);
    expect(COMPRESSIBLE_FOR_TEST.test('text/css; charset=utf-8')).toBe(true);
    expect(COMPRESSIBLE_FOR_TEST.test('application/javascript; charset=utf-8')).toBe(true);
  });
});
