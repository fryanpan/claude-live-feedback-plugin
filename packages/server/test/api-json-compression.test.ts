/**
 * JSON API responses are gzipped when the client asks for it.
 *
 * `GET /api/docs` was measured at 4,205,683 bytes with `content-encoding:
 * null` on 2026-08-21 — every byte of a 4 MB listing crossing the tailnet
 * uncompressed, on a route the review sidebar hits on every doc open. Nothing
 * in the server compressed anything: `j()` built a plain Response and the
 * per-request wrapper only added CORS.
 *
 * The rules under test are the ones that make this safe to apply to every JSON
 * route rather than to one path: only when the client advertises gzip, only
 * for JSON (never `text/event-stream`, whose body is a live stream), never
 * over a body that already carries a `content-encoding`, and never on a
 * payload small enough that the gzip header costs more than it saves.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMPRESS_MIN_BYTES, acceptsGzip, maybeCompress } from '../src/compress.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A JSON body comfortably over the threshold, and repetitive enough that
 *  gzip has something to do — the same shape as a real doc listing. */
const bigDocs = () => ({
  docs: Array.from({ length: 200 }, (_, i) => ({
    docId: `doc-${i}`,
    type: 'markdown',
    title: `A review document number ${i}`,
    reviewUrl: `http://localhost:8787/review/doc-${i}`,
  })),
});

const req = (accept: string | null) =>
  new Request('http://localhost/api/docs', {
    headers: accept === null ? {} : { 'accept-encoding': accept },
  });

describe('acceptsGzip', () => {
  it('reads gzip out of a real browser header', () => {
    expect(acceptsGzip('gzip, deflate, br, zstd')).toBe(true);
  });

  it('is false when the client never mentions gzip', () => {
    expect(acceptsGzip('br')).toBe(false);
    expect(acceptsGzip('')).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });

  it('honours a q=0 refusal, including one hidden behind a wildcard', () => {
    // `gzip;q=0` is how a client says "not this one" — treating the token's
    // mere presence as consent would send it an encoding it just refused.
    expect(acceptsGzip('gzip;q=0, deflate')).toBe(false);
    expect(acceptsGzip('*;q=0, gzip')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
  });

  it('ignores tokens that merely contain "gzip"', () => {
    expect(acceptsGzip('x-gzip-ish')).toBe(false);
  });
});

describe('maybeCompress', () => {
  it('gzips a large JSON body and says so', async () => {
    const original = JSON.stringify(bigDocs());
    const res = await maybeCompress(req('gzip'), json(bigDocs()));
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toBe('accept-encoding');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(original.length / 4);
    // The bytes must still BE the payload — a smaller response that no longer
    // round-trips is not a win.
    expect(new TextDecoder().decode(Bun.gunzipSync(bytes))).toBe(original);
  });

  it('leaves the body alone when the client did not ask for gzip', async () => {
    const res = await maybeCompress(req(null), json(bigDocs()));
    expect(res.headers.get('content-encoding')).toBeNull();
    // Vary is still correct: the reply DOES depend on Accept-Encoding, so a
    // cache that stored this uncompressed copy must not serve it to a client
    // that asked for gzip.
    expect(res.headers.get('vary')).toBe('accept-encoding');
    expect(await res.text()).toBe(JSON.stringify(bigDocs()));
  });

  it('leaves a body under the threshold alone', async () => {
    const small = { ok: true };
    expect(JSON.stringify(small).length).toBeLessThan(COMPRESS_MIN_BYTES);
    const res = await maybeCompress(req('gzip'), json(small));
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.json()).toEqual(small);
  });

  it('never touches a stream: text/event-stream passes straight through', async () => {
    // Buffering an SSE body to compress it would hold every event until the
    // stream ended — i.e. it would break the live channel outright.
    const sse = new Response(new ReadableStream(), {
      headers: { 'content-type': 'text/event-stream' },
    });
    const out = await maybeCompress(req('gzip'), sse);
    expect(out).toBe(sse);
  });

  it('never double-encodes a body that already declares an encoding', async () => {
    const already = json(bigDocs(), { 'content-encoding': 'br' });
    const out = await maybeCompress(req('gzip'), already);
    expect(out.headers.get('content-encoding')).toBe('br');
  });

  it('passes a bodyless response through untouched', async () => {
    const empty = new Response(null, { status: 204 });
    expect(await maybeCompress(req('gzip'), empty)).toBe(empty);
  });
});

describe('GET /api/docs over the wire', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'api-gzip-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    // Enough docs that the listing clears the threshold, as the real one does
    // by three orders of magnitude.
    for (let i = 0; i < 40; i++) {
      const p = join(dataDir, `f${i}.md`);
      writeFileSync(p, `# File ${i}\n\nBody.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
        body: JSON.stringify({ docId: `gz-doc-${i}`, type: 'markdown', sourceUrl: p }),
      });
      expect(r.status).toBe(200);
    }
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('ships the listing gzipped, and it still parses', async () => {
    const plain = await fetch(`${base}/api/docs`, {
      headers: { host: `localhost:${handle.port}`, 'accept-encoding': 'identity' },
    });
    const plainBytes = (await plain.arrayBuffer()).byteLength;
    // Positive control: without compression this route really is large, so
    // the shrink measured below is the header doing something.
    expect(plainBytes).toBeGreaterThan(COMPRESS_MIN_BYTES);

    const gz = await fetch(`${base}/api/docs`, {
      headers: { host: `localhost:${handle.port}`, 'accept-encoding': 'gzip' },
    });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    // Bun's fetch reports the transferred length here and still decodes the
    // body, so both halves of the claim are checkable from one response.
    expect(Number(gz.headers.get('content-length'))).toBeLessThan(plainBytes / 2);
    const docs = ((await gz.json()) as { docs: Array<{ docId: string }> }).docs;
    expect(docs.map((d) => d.docId)).toContain('gz-doc-39');
  });
});
