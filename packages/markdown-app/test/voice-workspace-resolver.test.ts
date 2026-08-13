import { describe, expect, it } from 'vitest';
import { createWorkspaceResolver } from '../src/voice-dock.ts';

/** All fixtures are synthetic — invented names, jordan@partner.example register. */

describe('createWorkspaceResolver', () => {
  it('caches an attached workspace instead of re-fetching', async () => {
    let calls = 0;
    const resolve = createWorkspaceResolver(async () => {
      calls++;
      return { hubWorkspaceId: 'search-revamp' };
    });
    expect(await resolve('rank-notes')).toBe('search-revamp');
    expect(await resolve('rank-notes')).toBe('search-revamp');
    expect(calls).toBe(1);
  });

  it('re-checks a doc that was not attached yet, so a later attach routes voice', async () => {
    // The bug: the first "not attached" answer was cached forever, so voice
    // stayed unroutable for the rest of the page load even after attach_doc.
    let attached = false;
    let calls = 0;
    const resolve = createWorkspaceResolver(async () => {
      calls++;
      return attached ? { hubWorkspaceId: 'search-revamp' } : {};
    });

    expect(await resolve('rank-notes')).toBeNull();
    attached = true;
    expect(await resolve('rank-notes')).toBe('search-revamp');
    expect(calls).toBe(2);
  });

  it('treats a failed lookup as unattached without caching it', async () => {
    let fail = true;
    const resolve = createWorkspaceResolver(async () => {
      if (fail) throw new Error('offline');
      return { hubWorkspaceId: 'search-revamp' };
    });
    expect(await resolve('rank-notes')).toBeNull();
    fail = false;
    expect(await resolve('rank-notes')).toBe('search-revamp');
  });
});
