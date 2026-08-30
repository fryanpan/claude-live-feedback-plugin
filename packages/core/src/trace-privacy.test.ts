import { describe, expect, it } from 'vitest';
import {
  routePatternForSpan,
  scrubBrowserEvent,
  scrubEventForPrivacy,
  scrubSpanName,
} from './trace-privacy.ts';

/**
 * The browser sends events now, and a browser event carries the hazards
 * through doors the server's own floors never had to cover: the page URL is
 * `request.url`, a fetch span's `description` IS the URL, and a navigation
 * breadcrumb's `from`/`to` are raw paths. All three can hold a `docId`, and a
 * `docId` is often a bound file's relative PATH — the exact thing the rule
 * says must never leave the machine.
 *
 * Every fixture below is a synthetic event shaped like a real one, with a
 * needle chosen so the assertion CAN fail: a filename nothing else in the
 * payload would produce.
 */
const NEEDLE = 'quarterly-comp-review.md';

describe('span names reduce to route patterns', () => {
  it('drops a doc id that is a file path, method and all', () => {
    expect(scrubSpanName(`GET /workspaces/w-AbCdEfGhIj/docs/${NEEDLE}`)).toBe(
      'GET /workspaces/:id/docs/:id',
    );
  });

  it('drops it from a bare path too', () => {
    expect(scrubSpanName(`/api/docs/${NEEDLE}/threads`)).toBe('/api/docs/:id/threads');
  });

  it('drops the query string outright rather than patterning over it', () => {
    // A query is the part of a URL most likely to carry a title or a token,
    // and no span name needs it.
    expect(scrubSpanName(`/review/${NEEDLE}?q=salary%20bands`)).toBe('/review/:id');
  });

  it('handles an absolute URL, which is the shape a fetch span uses', () => {
    expect(scrubSpanName(`GET https://example.test/api/docs/${NEEDLE}/content`)).toBe(
      'GET /api/docs/:id/content',
    );
  });

  it('leaves a name that is not a path alone', () => {
    // Positive control on the OTHER side: this rewrites known-safe shapes, it
    // does not mangle everything it is handed.
    expect(scrubSpanName('ui.click')).toBe('ui.click');
    expect(scrubSpanName('Largest Contentful Paint')).toBe('Largest Contentful Paint');
  });

  it('an unknown route still degrades to all-:id, never to the raw path', () => {
    expect(routePatternForSpan(`/nothing/like/a/route/${NEEDLE}`)).toBe('/:id/:id/:id/:id/:id');
  });
});

describe('a browser transaction event, scrubbed', () => {
  function pageloadEvent(): Record<string, unknown> {
    return {
      type: 'transaction',
      transaction: `/workspaces/w-AbCdEfGhIj/docs/${NEEDLE}`,
      tags: { page_type: 'doc' },
      request: { url: `https://example.test/workspaces/w-AbCdEfGhIj/docs/${NEEDLE}?walk=1` },
      spans: [
        {
          op: 'http.client',
          description: `GET /api/docs/${NEEDLE}/content`,
          data: { 'http.url': `https://example.test/api/docs/${NEEDLE}/content` },
        },
      ],
      breadcrumbs: [
        {
          category: 'navigation',
          data: {
            from: `/workspaces/w-AbCdEfGhIj/docs/${NEEDLE}`,
            to: '/workspaces/w-AbCdEfGhIj/home',
          },
        },
      ],
      measurements: { ms_to_boot: { value: 412, unit: 'millisecond' } },
    };
  }

  it('carries no trace of the file name anywhere in the payload', () => {
    const raw = pageloadEvent();
    // Negative control that can fail: prove the needle IS in the input.
    expect(JSON.stringify(raw)).toContain(NEEDLE);
    const out = JSON.stringify(scrubBrowserEvent(raw));
    expect(out).not.toContain(NEEDLE);
  });

  it('keeps the shapes, counts and timings that make it worth sending', () => {
    const out = scrubBrowserEvent(pageloadEvent()) as Record<string, unknown>;
    expect(out.transaction).toBe('/workspaces/:id/docs/:id');
    expect((out.tags as Record<string, string>).page_type).toBe('doc');
    expect(
      ((out.measurements as Record<string, { value: number }>).ms_to_boot as { value: number })
        .value,
    ).toBe(412);
    const span = (out.spans as Array<Record<string, unknown>>)[0];
    expect(span?.description).toBe('GET /api/docs/:id/content');
    expect(span?.op).toBe('http.client');
    // The URL-named attribute is dropped by the key floor, not by the name
    // pass — both have to be running for this event to be safe.
    expect((span?.data as Record<string, unknown>)['http.url']).toBe('[scrubbed]');
    expect((out.request as Record<string, unknown>).url).toBe('[scrubbed]');
  });

  it('renames the navigation breadcrumb rather than dropping the breadcrumb', () => {
    const out = scrubBrowserEvent(pageloadEvent()) as Record<string, unknown>;
    const crumb = (out.breadcrumbs as Array<Record<string, unknown>>)[0];
    expect(crumb?.category).toBe('navigation');
    expect((crumb?.data as Record<string, string>).from).toBe('/workspaces/:id/docs/:id');
    expect((crumb?.data as Record<string, string>).to).toBe('/workspaces/:id/home');
  });

  it('still redacts a minted id in an ordinary message, as the server floor did', () => {
    const out = scrubBrowserEvent({
      message: 'could not load task t-AbCdEfGhIjKl',
    }) as Record<string, unknown>;
    expect(out.message).toBe('could not load task [id]');
  });

  it('leaves an error stack frame filename readable — it is our own source', () => {
    // Positive control for the deliberate NON-scrub: an absolute path into
    // our own tree is what a debugging agent needs, and the key floor is
    // key-targeted precisely so it survives.
    const out = scrubEventForPrivacy({
      exception: {
        values: [{ stacktrace: { frames: [{ filename: '/app/src/hub/hub-app.ts', lineno: 12 }] } }],
      },
    }) as { exception: { values: Array<{ stacktrace: { frames: Array<{ filename: string }> } }> } };
    expect(out.exception.values[0]?.stacktrace.frames[0]?.filename).toBe('/app/src/hub/hub-app.ts');
  });
});
