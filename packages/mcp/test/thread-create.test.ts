/**
 * Which endpoint `create_thread` calls, and why omitting `find` is not the
 * same as passing an empty one.
 *
 * mcp.ts is a bundle entry point and exports nothing, so the routing decision
 * lives in its own module to be testable at all.
 */
import { describe, expect, it } from 'vitest';
import { threadCreateRequest } from '../src/thread-create.ts';

const AUTHOR = { id: 'agent-hub', name: 'Hub Agent', kind: 'known' as const, color: '#888888' };

describe('threadCreateRequest', () => {
  it('anchors to the found text when find is given', () => {
    const r = threadCreateRequest(
      { docId: 'd-1', find: 'the second paragraph', text: 'why?' },
      AUTHOR,
    );
    expect(r.path).toBe('/api/docs/d-1/threads/by_find');
    expect(r.body).toMatchObject({ find: 'the second paragraph', text: 'why?', author: AUTHOR });
  });

  it('passes disambiguation through untouched, and omits what was not given', () => {
    const r = threadCreateRequest(
      { docId: 'd-1', find: 'x', text: 't', contextBefore: 'before', occurrence: 3 },
      AUTHOR,
    );
    expect(r.body).toMatchObject({ contextBefore: 'before', occurrence: 3 });
    expect('contextAfter' in r.body).toBe(false);
  });

  // The reason this module exists: a task's discussion is about the task, and
  // a fresh task's description is empty, so there is nothing to find.
  it('opens a thread on the subject when find is omitted', () => {
    const r = threadCreateRequest({ docId: 'task:t-9', text: 'is this still the plan?' }, AUTHOR);
    expect(r.path).toBe('/api/docs/task%3At-9/threads');
    expect(r.body).toEqual({
      author: AUTHOR,
      text: 'is this still the plan?',
      anchor: { kind: 'subject' },
    });
  });

  // Omitting find is a choice; computing an empty one is an accident. Routing
  // `find: ''` to the subject endpoint would turn "my variable came out
  // empty" into a silently doc-wide comment, so it keeps going to by_find,
  // which answers 400.
  it('does NOT treat an empty find as a subject thread', () => {
    expect(threadCreateRequest({ docId: 'd-1', find: '', text: 't' }, AUTHOR).path).toBe(
      '/api/docs/d-1/threads/by_find',
    );
  });

  it('encodes the docId in both branches', () => {
    expect(threadCreateRequest({ docId: 'a b/c', find: 'x', text: 't' }, AUTHOR).path).toBe(
      '/api/docs/a%20b%2Fc/threads/by_find',
    );
    expect(threadCreateRequest({ docId: 'a b/c', text: 't' }, AUTHOR).path).toBe(
      '/api/docs/a%20b%2Fc/threads',
    );
  });
});
