import { afterEach, describe, expect, it, vi } from 'vitest';
import { postLoadReport } from '../src/board/board-load-report.ts';

/**
 * The board's own load beacon: one line per page load, so "the board was slow
 * on the iPad" is a recorded fact with phase attribution rather than a memory.
 *
 * Driven rather than read: what matters is what a report CONTAINS — which
 * phases it names, and what the network actually moved — and that a recorder
 * never breaks the page it measures.
 */
function captureFetch(): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve(new Response('{}'));
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postLoadReport', () => {
  it('posts both phases to the board’s load-reports route', () => {
    const f = captureFetch();
    postLoadReport({ workspaceId: 'w 1', msToBoot: 120, msToFirstProjection: 900, sentry: null });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe('/workspaces/w%201/load-reports');
    expect(f.calls[0]?.body.msToBoot).toBe(120);
    expect(f.calls[0]?.body.msToFirstProjection).toBe(900);
  });

  it('reports boot-only when the ydoc never synced, rather than reporting nothing', () => {
    // That slow load is the one most worth recording, so the fallback must
    // still produce a line — with the missing phase absent, not zero.
    const f = captureFetch();
    postLoadReport({ workspaceId: 'w-1', msToBoot: 120, msToFirstProjection: null, sentry: null });
    expect(f.calls[0]?.body.msToBoot).toBe(120);
    expect('msToFirstProjection' in (f.calls[0]?.body ?? {})).toBe(false);
  });

  it('includes what the network moved, so "big" and "far" are distinguishable', () => {
    const f = captureFetch();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { transferSize: 100, decodedBodySize: 400 },
      { transferSize: 25, decodedBodySize: 60 },
    ] as never);
    postLoadReport({ workspaceId: 'w-1', msToBoot: 1, msToFirstProjection: 2, sentry: null });
    expect(f.calls[0]?.body.resourceCount).toBe(2);
    expect(f.calls[0]?.body.transferBytes).toBe(125);
    expect(f.calls[0]?.body.decodedBytes).toBe(460);
  });

  it('stamps the same numbers on the pageload trace', () => {
    captureFetch();
    const setMeasurement = vi.fn();
    postLoadReport({
      workspaceId: 'w-1',
      msToBoot: 120,
      msToFirstProjection: 900,
      sentry: { setMeasurement },
    });
    expect(setMeasurement).toHaveBeenCalledWith('ms_to_boot', 120, 'millisecond');
    expect(setMeasurement).toHaveBeenCalledWith('ms_to_first_projection', 900, 'millisecond');
  });

  it('never breaks the page it measures', () => {
    // Both halves are hostile here: the trace throws, and the POST rejects.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const sentry = {
      setMeasurement: () => {
        throw new Error('SDK gone');
      },
    };
    expect(() =>
      postLoadReport({ workspaceId: 'w-1', msToBoot: 1, msToFirstProjection: 2, sentry }),
    ).not.toThrow();
  });
});
