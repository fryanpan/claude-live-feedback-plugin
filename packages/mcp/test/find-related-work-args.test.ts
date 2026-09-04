/**
 * `find_related_work` on the wire.
 *
 * The verb is a READ whose whole payload is a query string, so the failure it
 * can have is the one `share_verb_args` documents from the other direction: a
 * key the handler forgets to put on the URL never reaches the server, and the
 * server answers 200 to a narrower question than the caller asked. `docId` is
 * the key that matters here — without it no link relation is scored, so the
 * goal that owns the conversation silently stops coming back.
 *
 * These are wire facts, so this file drives the COMMITTED bundle against a
 * recording stub rather than slicing the source. A grep for a route literal
 * passes over a deleted handler; this does not.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

let mcp: BundleHarness;

const ANSWER = {
  workspaceId: 'w-1',
  query: 'meeting notes plan',
  considered: 5,
  matches: [
    {
      kind: 'goal',
      id: 'g-notes',
      title: 'Bryan can read meeting notes that are worth keeping',
      score: 0.62,
      reason: 'Goal: title shares meeting, note',
      matchedTerms: ['meeting', 'note'],
      linked: false,
      url: '/workspaces/w-1?goal=g-notes',
    },
  ],
};

beforeAll(async () => {
  mcp = await startBundle((req) => (req.path.endsWith('/related-work') ? ANSWER : undefined));
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('find_related_work', () => {
  it('POSITIVE CONTROL: the running bundle declares the tool', () => {
    expect(mcp.tool('find_related_work')).toBeDefined();
    expect(mcp.tool('find_related_work_nope')).toBeUndefined();
  });

  it('requires a workspaceId and the request text', () => {
    const schema = mcp.tool('find_related_work')?.inputSchema;
    expect(schema?.required).toEqual(['workspaceId', 'text']);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      'docId',
      'limit',
      'text',
      'workspaceId',
    ]);
  });

  it('GETs the board route with the request text as ?q=', async () => {
    const res = await mcp.call('find_related_work', {
      workspaceId: 'w-1',
      text: 'Write a plan for the meeting notes UX',
    });
    expect(res.isError).toBe(false);
    const sent = res.sent.find((r) => r.path.endsWith('/related-work'));
    expect(sent?.method).toBe('GET');
    expect(sent?.path).toBe('/api/workspaces/w-1/related-work');
    expect(sent?.query.get('q')).toBe('Write a plan for the meeting notes UX');
  });

  it('puts docId and limit on the URL, not only in its own arguments', async () => {
    const res = await mcp.call('find_related_work', {
      workspaceId: 'w-1',
      text: 'meeting notes',
      docId: 'd-huddle',
      limit: 3,
    });
    const sent = res.sent.find((r) => r.path.endsWith('/related-work'));
    expect(sent?.query.get('docId')).toBe('d-huddle');
    expect(sent?.query.get('limit')).toBe('3');
  });

  it('omits the optional keys entirely when the caller passes none', async () => {
    const res = await mcp.call('find_related_work', { workspaceId: 'w-1', text: 'meeting notes' });
    const sent = res.sent.find((r) => r.path.endsWith('/related-work'));
    expect(sent?.query.has('docId')).toBe(false);
    expect(sent?.query.has('limit')).toBe(false);
  });

  it('escapes a board id rather than splicing it into the path', async () => {
    const res = await mcp.call('find_related_work', { workspaceId: 'w/1 2', text: 'notes' });
    const sent = res.sent.find((r) => r.path.includes('related-work'));
    expect(sent?.path).toBe('/api/workspaces/w%2F1%202/related-work');
  });

  it('refuses an empty request without calling the server', async () => {
    const res = await mcp.call('find_related_work', { workspaceId: 'w-1', text: '   ' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('text is required');
    expect(res.sent.filter((r) => r.path.endsWith('/related-work'))).toEqual([]);
  });

  it('carries the matches through, with the branch the caller has to take', async () => {
    const res = await mcp.call('find_related_work', { workspaceId: 'w-1', text: 'meeting notes' });
    const body = res.json as { considered: number; matches: unknown[]; next: string };
    expect(body.matches).toEqual(ANSWER.matches);
    // `considered` is what makes an empty answer readable, so it must survive
    // the hop rather than being dropped as server bookkeeping.
    expect(body.considered).toBe(5);
    expect(body.next).toContain('review item');
  });
});
