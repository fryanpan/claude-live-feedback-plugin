import { describe, expect, it } from 'vitest';
import { sidebarEntriesFor } from '../src/hub/hub-sidebar.ts';

/** All fixtures are synthetic — invented names, jordan@partner.example register. */

/** A fetcher over a fixed URL→payload map; unknown urls resolve to null the
 *  way the hub's own fetchJson does on a non-ok response. */
function fetcherOver(routes: Record<string, unknown>): (url: string) => Promise<unknown> {
  return async (url: string) => routes[url] ?? null;
}

describe('sidebarEntriesFor — a plain doc room', () => {
  const routes = {
    '/api/docs/search-revamp-plan': { meta: { title: 'Search revamp plan' } },
    '/api/docs/search-revamp-plan/threads?status=open': {
      threads: [{ id: 't-1', comments: [{ text: 'Can we cut the second pass?' }] }],
    },
  };

  it('links to the doc and lists its own threads', async () => {
    const { docs, threads } = await sidebarEntriesFor('search-revamp-plan', fetcherOver(routes));
    expect(docs).toEqual([
      {
        docId: 'search-revamp-plan',
        label: 'Search revamp plan',
        url: '/review/search-revamp-plan',
      },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.url).toBe('/review/search-revamp-plan');
    expect(threads[0]?.label).toBe('Can we cut the second pass?');
  });
});

describe('sidebarEntriesFor — an attached grouping id (diff review / folder bind)', () => {
  // The grouping id has NO doc room of its own: /api/docs/<id> misses, and
  // /review/<id> would render the 404 page. Its members live under the
  // workspace endpoints.
  const routes = {
    '/api/workspaces/search-revamp/tree': {
      workspaceId: 'search-revamp',
      totalOpen: 2,
      tree: {
        type: 'dir',
        name: '',
        openCount: 2,
        children: [
          {
            type: 'dir',
            name: 'src',
            openCount: 2,
            children: [
              {
                type: 'file',
                docId: 'search-revamp:src/rank.ts',
                name: 'rank.ts',
                relPath: 'src/rank.ts',
                fileType: 'diff',
                openCount: 2,
                threadCount: 2,
              },
            ],
          },
        ],
      },
    },
    '/api/workspaces/search-revamp/threads?status=open': {
      workspaceId: 'search-revamp',
      threads: [
        {
          id: 't-9',
          docId: 'search-revamp:src/rank.ts',
          comments: [{ text: 'This tiebreak looks backwards.' }],
        },
      ],
    },
  };

  it('links to a real member, never to the grouping id', async () => {
    const { docs } = await sidebarEntriesFor('search-revamp', fetcherOver(routes));
    expect(docs).toHaveLength(1);
    // The bug: url was `/review/search-revamp`, which 404s.
    expect(docs[0]?.url).toBe('/review/search-revamp%3Asrc%2Frank.ts');
    expect(docs[0]?.label).toBe('search-revamp');
  });

  it('lists the member threads the per-doc query could never see', async () => {
    const { threads } = await sidebarEntriesFor('search-revamp', fetcherOver(routes));
    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadId).toBe('t-9');
    expect(threads[0]?.label).toBe('This tiebreak looks backwards.');
    // Each thread points at ITS member doc, not at the grouping id.
    expect(threads[0]?.url).toBe('/review/search-revamp%3Asrc%2Frank.ts');
  });

  it('still lists the workspace when its tree has no members yet', async () => {
    const { docs, threads } = await sidebarEntriesFor(
      'search-revamp',
      fetcherOver({ '/api/workspaces/search-revamp/threads?status=open': { threads: [] } }),
    );
    expect(docs).toEqual([
      { docId: 'search-revamp', label: 'search-revamp', url: '/workspaces/search-revamp' },
    ]);
    expect(threads).toEqual([]);
  });
});
