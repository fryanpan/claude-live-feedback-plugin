/**
 * Malformed percent-escapes in a path.
 *
 * What has to hold, and what each check would fail on:
 *
 *  - A BAD ESCAPE IS THE CALLER'S ERROR, NOT THE SERVER'S. `a%zzb` answers
 *    400. Before the front-door guard, two shapes answered 500 with a
 *    `URIError` thrown inside the route that decoded the segment — the board
 *    page and one prompt. Remove the guard and both go back to 500.
 *  - THE GUARD IS NOT A BLANKET REFUSAL. A legitimately encoded `%` (`%25`)
 *    and ordinary ids still route normally. Reject on the presence of `%`
 *    rather than on whether it decodes, and these controls fail.
 *  - IT COVERS ROUTES NOBODY CONVERTED. The two 500s were in different
 *    modules that each decode directly; the check sits ahead of both rather
 *    than inside either, so a route added later is covered without being
 *    changed.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePathParam, malformedPathSegment } from '../src/path-params.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('the path-parameter decoder', () => {
  it('names the segment that cannot be decoded', () => {
    expect(malformedPathSegment('/workspaces/a%zzb')).toBe('a%zzb');
    expect(malformedPathSegment('/workspaces/w-1/docs/b%')).toBe('b%');
  });

  it('passes a path whose escapes are all well formed', () => {
    expect(malformedPathSegment('/workspaces/w-1/docs/d-2')).toBeUndefined();
    // `%25` is an encoded percent sign — valid, and it must not be refused.
    expect(malformedPathSegment('/workspaces/w-1/docs/a%25b')).toBeUndefined();
    expect(malformedPathSegment('/')).toBeUndefined();
  });

  it('decodes one parameter, answering undefined rather than throwing', () => {
    expect(decodePathParam('a%25b')).toBe('a%b');
    expect(decodePathParam('plain')).toBe('plain');
    expect(decodePathParam('a%zzb')).toBeUndefined();
  });
});

describe('a malformed escape over HTTP', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-path-params-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The two shapes measured answering 500 before the guard existed. They are
  // in different modules, which is the point: neither was converted, and the
  // front-door check covers both.
  for (const path of ['/workspaces/a%zzb', '/api/prompts/a%zzb']) {
    it(`answers 400 rather than 500 for ${path}`, async () => {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('bad-path');
    });
  }

  // Controls: the guard must not refuse paths it has no business refusing.
  it('leaves well-formed addresses alone', async () => {
    const encoded = await fetch(`${base}/api/prompts/a%25b`);
    expect(encoded.status).not.toBe(400);
    const real = await fetch(`${base}/api/prompts`);
    expect(real.status).toBe(200);
  });
});
