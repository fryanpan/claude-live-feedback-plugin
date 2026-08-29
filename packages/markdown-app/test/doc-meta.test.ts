import { afterEach, describe, expect, it } from 'vitest';
import { fetchDocMeta } from '../src/doc-meta.ts';

/**
 * The wire → `DocMeta` mapping, tested at the layer that hand-copies fields.
 *
 * This is the layer "the route layer silently drops params" is about, pointed
 * the other way: the router's own tests inject `fetchMeta`, so a field the real
 * reader forgets to copy is invisible to every one of them. `backTo` in
 * particular is easy to lose because it sits at the TOP LEVEL of the payload
 * while everything else this function reads is under `meta` — and the near-miss
 * name `meta.workspaceId` is a different thing entirely (the grouping id of a
 * diff review, not the board that holds it).
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve one JSON body to any request; record what was asked for. */
function serve(body: unknown, ok = true): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return {
      ok,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { urls };
}

describe('fetchDocMeta', () => {
  it('carries the board through from the top level of the payload', async () => {
    const seen = serve({
      meta: { type: 'diff', relPath: 'src/a.ts', workspaceId: 'review-123' },
      backTo: { workspaceId: 'w-abc', name: 'search-revamp' },
    });
    const meta = await fetchDocMeta('d1');
    expect(seen.urls[0]).toBe('/api/docs/d1');
    // Presence of the neighbouring fields, so "backTo arrived" is not the only
    // thing this run proves — a mapping that returned the fallback object would
    // otherwise satisfy nothing but the absence cases below.
    expect(meta.docType).toBe('diff');
    expect(meta.relPath).toBe('src/a.ts');
    // The grouping id and the board are DIFFERENT values, and the test says so.
    expect(meta.workspaceId).toBe('review-123');
    expect(meta.backTo).toEqual({ workspaceId: 'w-abc', name: 'search-revamp' });
  });

  it('reports no board when the server names none', async () => {
    serve({ meta: { type: 'markdown', relPath: 'plan.md' } });
    const meta = await fetchDocMeta('d2');
    expect(meta.relPath).toBe('plan.md'); // control: the payload was read
    expect(meta.backTo).toBeUndefined();
  });

  it('treats a board with no id as no board', async () => {
    // The field is optional on the wire; a half-populated object must not
    // become a link to `/workspaces/undefined`.
    serve({ meta: { type: 'markdown' }, backTo: { name: 'nameless' } });
    expect((await fetchDocMeta('d3')).backTo).toBeUndefined();
  });

  it('accepts a board the server did not name', async () => {
    // A board with an empty name is still reachable, and `backLinkFor` falls
    // back to showing the id — dropping the whole target here would send the
    // arrow to the machine index instead.
    serve({ meta: { type: 'markdown' }, backTo: { workspaceId: 'w-abc' } });
    expect((await fetchDocMeta('d4')).backTo).toEqual({ workspaceId: 'w-abc', name: '' });
  });

  it('falls back to a markdown doc with no board when the read fails', async () => {
    serve({ meta: { type: 'code' }, backTo: { workspaceId: 'w-abc', name: 'x' } }, false);
    const meta = await fetchDocMeta('d5');
    expect(meta.docType).toBe('markdown');
    expect(meta.backTo).toBeUndefined();
  });
  it('carries the huddle flag, and reads its absence as an ordinary doc', async () => {
    serve({ meta: { type: 'markdown', relPath: 'huddles/d-abc1.md', huddle: true } });
    const huddle = await fetchDocMeta('d6');
    expect(huddle.relPath).toBe('huddles/d-abc1.md'); // control: the payload was read
    expect(huddle.huddle).toBe(true);
    serve({ meta: { type: 'markdown', relPath: 'plan.md' } });
    expect((await fetchDocMeta('d7')).huddle).toBeUndefined();
  });
});
