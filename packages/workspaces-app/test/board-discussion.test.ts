import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoardDiscussion, goalBodyDocId } from '../src/board/board-discussion.ts';
import { boardState } from './support/board-region-harness.ts';

/**
 * A row's comments live in its BODY doc — `task:<id>` for a task and for a
 * goal alike — so this is the ordinary thread API pointed at that doc.
 *
 * The invariant driven hardest here is the keying: `discussionTaskId` is
 * claimed BEFORE the fetch and re-checked after it, so a load that lands once
 * the reader has moved to another row paints nothing.
 */
function discussion(over: Partial<Parameters<typeof createBoardDiscussion>[0]> = {}) {
  const state = boardState();
  const renderDetail = vi.fn();
  const api = createBoardDiscussion({
    state,
    author: { id: 'u-1', name: 'Bryan', kind: 'known', color: '#000' },
    renderDetail,
    ...over,
  });
  return { state, renderDetail, ...api };
}

function serveThreads(threads: unknown, onRequest?: (url: string, init?: RequestInit) => void) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    onRequest?.(url, init);
    return Promise.resolve(
      new Response(JSON.stringify({ threads }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('goalBodyDocId', () => {
  it('prefers what the projection sent', () => {
    expect(goalBodyDocId({ id: 'g-1', bodyDocId: 'task:custom' })).toBe('task:custom');
  });

  it('derives the doc for a server that predates the goal-body projection', () => {
    // Without this the panel fetched `/api/docs//threads` and mounted an
    // editor on nothing.
    expect(goalBodyDocId({ id: 'g-1' })).toBe('task:g-1');
  });
});

describe('createBoardDiscussion', () => {
  it('reads a row’s comments out of its body doc', async () => {
    const seen: string[] = [];
    serveThreads(
      [
        {
          id: 'th-1',
          comments: [{ id: 'c-1', author: { name: 'Ada' }, text: 'Looks good', ts: 7 }],
        },
      ],
      (url) => seen.push(url),
    );
    const d = discussion();
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });
    expect(seen[0]).toBe('/api/docs/task%3At-1/threads');
    expect(d.state.discussion.threads[0]?.comments[0]).toMatchObject({
      id: 'c-1',
      author: 'Ada',
      text: 'Looks good',
      ts: 7,
    });
  });

  it('paints nothing when the reader moved to another row mid-flight', async () => {
    const d = discussion();
    serveThreads([{ id: 'th-late', comments: [] }]);
    const inFlight = d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });
    d.state.discussionTaskId = 't-2'; // the reader opened a different row
    await inFlight;
    expect(d.state.discussion.threads).toEqual([]);
  });

  it('claims the row before fetching, so a re-render cannot re-enter the load', async () => {
    const d = discussion();
    let claimedDuringFetch: string | null = null;
    serveThreads([], () => {
      claimedDuringFetch = d.state.discussionTaskId;
    });
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });
    expect(claimedDuringFetch).toBe('t-1');
  });

  it('blanks the pane for a fresh open, but never for a quiet reload', async () => {
    const d = discussion();
    serveThreads([{ id: 'th-1', comments: [] }]);
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });

    const loadingStates: boolean[] = [];
    d.renderDetail.mockImplementation(() => loadingStates.push(d.state.discussion.loading));
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' }, true);
    expect(loadingStates).toEqual([false]);

    loadingStates.length = 0;
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });
    expect(loadingStates[0]).toBe(true);
  });

  it('names an author the server left off rather than rendering a blank', async () => {
    serveThreads([{ id: 'th-1', comments: [{ text: 'anon' }] }]);
    const d = discussion();
    await d.loadDiscussion({ id: 't-1', bodyDocId: 'task:t-1' });
    expect(d.state.discussion.threads[0]?.comments[0]?.author).toBe('Someone');
  });

  it('opens a new subject thread when no thread was named', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    serveThreads([], (url, init) => {
      if (init?.method === 'POST') calls.push({ url, body: JSON.parse(String(init.body)) });
    });
    const d = discussion();
    const ok = await d.postRowComment({ id: 't-1', bodyDocId: 'task:t-1' }, 'first');
    expect(ok).toBe(true);
    expect(calls[0]?.url).toBe('/api/docs/task%3At-1/threads');
    expect(calls[0]?.body.anchor).toEqual({ kind: 'subject' });
  });

  it('replies onto the named thread instead', async () => {
    const calls: string[] = [];
    serveThreads([], (url, init) => {
      if (init?.method === 'POST') calls.push(url);
    });
    const d = discussion();
    await d.postRowComment({ id: 't-1', bodyDocId: 'task:t-1' }, 'more', 'th-9');
    expect(calls[0]).toBe('/api/docs/task%3At-1/threads/th-9/comments');
  });

  it('says no when the post failed, so the composer can keep the text', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const d = discussion();
    expect(await d.postRowComment({ id: 't-1', bodyDocId: 'task:t-1' }, 'lost?')).toBe(false);
  });
});
