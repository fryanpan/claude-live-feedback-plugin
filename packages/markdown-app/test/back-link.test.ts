import { beforeEach, describe, expect, it } from 'vitest';
import { applyBackLink, backLinkFor, returnItemFrom } from '../src/back-link.ts';

/**
 * The topbar `←` used to be a static `href="/"` — the machine-wide landing
 * page. Opened from a board, a doc's back arrow has to return to THAT board.
 *
 * `/` stays as the fallback, and it is a real one rather than a placeholder:
 * a doc with no board is still reachable, and sending its arrow nowhere would
 * be worse than sending it to the index.
 */
describe('backLinkFor', () => {
  it('points at the board and names it', () => {
    expect(backLinkFor({ workspaceId: 'w-abc', name: 'search-revamp' })).toEqual({
      href: '/workspaces/w-abc',
      label: 'Back to search-revamp',
    });
  });

  it('falls back to the machine-wide index when there is no board', () => {
    // Positive control lives in the case above: this `/` means "resolved to
    // nothing", not "the function returns a constant".
    expect(backLinkFor(null)).toEqual({ href: '/', label: 'Back to all review docs' });
    expect(backLinkFor(undefined)).toEqual({ href: '/', label: 'Back to all review docs' });
  });

  it('encodes an id that would otherwise break the path', () => {
    // Ids are server-minted and tame today, but this builds a URL from data
    // and an un-encoded `/` or `?` would silently retarget the link.
    expect(backLinkFor({ workspaceId: 'w a/b?c', name: 'x' }).href).toBe(
      '/workspaces/w%20a%2Fb%3Fc',
    );
  });

  it('treats a board with no usable id as no board', () => {
    // The field is optional on the wire; a half-populated object must not
    // produce `/workspaces/undefined`.
    expect(backLinkFor({ workspaceId: '', name: 'nameless' }).href).toBe('/');
  });

  it('falls back to the id when the board has no name', () => {
    expect(backLinkFor({ workspaceId: 'w-abc', name: '' }).label).toBe('Back to w-abc');
  });
});

describe('applyBackLink', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="doc-crumb"><a href="/" class="back-link" title="All review docs" aria-label="Back to all review docs">←</a></div>';
  });

  const link = () => document.querySelector('.doc-crumb .back-link') as HTMLAnchorElement;

  it('retargets the arrow and says where it goes', () => {
    applyBackLink(document, { workspaceId: 'w-abc', name: 'search-revamp' });
    expect(link().getAttribute('href')).toBe('/workspaces/w-abc');
    // The arrow is icon-only at phone width (the crumb has no room for a
    // board name beside the file path), so the destination is only speakable
    // through the label — which is also what a screen reader reads.
    expect(link().getAttribute('aria-label')).toBe('Back to search-revamp');
    expect(link().getAttribute('title')).toBe('Back to search-revamp');
  });

  it('restores the index target when the next doc has no board', () => {
    // Navigation is in-place: the shell is reused, so a stale board target
    // would survive onto a doc that has none.
    applyBackLink(document, { workspaceId: 'w-abc', name: 'search-revamp' });
    expect(link().getAttribute('href')).toBe('/workspaces/w-abc'); // presence first
    applyBackLink(document, null);
    expect(link().getAttribute('href')).toBe('/');
    expect(link().getAttribute('aria-label')).toBe('Back to all review docs');
  });

  it('does nothing when the shell has no back link', () => {
    document.body.innerHTML = '<div class="doc-crumb"></div>';
    expect(() => applyBackLink(document, { workspaceId: 'w-abc', name: 'n' })).not.toThrow();
  });
});

/**
 * Returning to the QUEUE, not just the board.
 *
 * A doc opened from the review walkthrough is a detour inside a sitting: the
 * reader has five items to get through and the doc is item three. An arrow
 * that lands on the bare board makes them re-open the walkthrough and find
 * their place again, five times over.
 *
 * The doc page cannot infer this — it has no referrer (see the module note).
 * So the walkthrough stamps its position on the link it mints (`?item=`), and
 * the arrow honours it. A doc reached any other way — pasted link, sidebar,
 * a board row — carries no stamp and keeps the plain board target, so a
 * visitor is never dropped into a queue they were never in.
 */
describe('backLinkFor with a return position', () => {
  it('returns to the queue the link was minted from', () => {
    expect(
      backLinkFor({ workspaceId: 'w-abc', name: 'search-revamp' }, 'doc-thread:d-1:th-1'),
    ).toEqual({
      href: '/workspaces/w-abc/home?item=doc-thread%3Ad-1%3Ath-1',
      label: 'Back to search-revamp',
    });
  });

  it('an unstamped link keeps the plain board target', () => {
    const plain = { href: '/workspaces/w-abc', label: 'Back to search-revamp' };
    expect(backLinkFor({ workspaceId: 'w-abc', name: 'search-revamp' }, null)).toEqual(plain);
    expect(backLinkFor({ workspaceId: 'w-abc', name: 'search-revamp' }, '')).toEqual(plain);
  });

  it('a stamp without a board is still the index — a queue needs a board to live on', () => {
    expect(backLinkFor(null, 'doc-thread:d-1:th-1').href).toBe('/');
  });

  it('encodes a stamp that would otherwise escape the URL it is written into', () => {
    // The stamp arrives from the address bar, so it is reader-supplied. An
    // un-encoded `/` would turn a same-origin path into `//host` — a link off
    // this site wearing the back arrow's clothes.
    expect(backLinkFor({ workspaceId: 'w-a', name: 'n' }, '/evil.example/x').href).toBe(
      '/workspaces/w-a/home?item=%2Fevil.example%2Fx',
    );
    expect(backLinkFor({ workspaceId: 'w-a', name: 'n' }, 'a&b=c#d').href).toBe(
      '/workspaces/w-a/home?item=a%26b%3Dc%23d',
    );
  });
});

describe('returnItemFrom', () => {
  it('reads the stamp the walkthrough wrote', () => {
    expect(returnItemFrom('?thread=th-1&item=doc-thread%3Ad-1%3Ath-1')).toBe('doc-thread:d-1:th-1');
  });

  it('is null on a plain doc URL', () => {
    expect(returnItemFrom('?thread=th-1')).toBe(null);
    expect(returnItemFrom('')).toBe(null);
  });

  it('an empty stamp is no stamp', () => {
    expect(returnItemFrom('?item=')).toBe(null);
  });
});

describe('applyBackLink carries the return position', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="doc-crumb"><a href="/" class="back-link">←</a></div>';
  });
  const link = () => document.querySelector('.doc-crumb .back-link') as HTMLAnchorElement;

  it('stamps the queue position onto the arrow', () => {
    applyBackLink(document, { workspaceId: 'w-abc', name: 'n' }, 'doc-thread:d-1:th-1');
    expect(link().getAttribute('href')).toBe('/workspaces/w-abc/home?item=doc-thread%3Ad-1%3Ath-1');
  });

  it('clears a previous doc’s position — the shell outlives the mount', () => {
    applyBackLink(document, { workspaceId: 'w-abc', name: 'n' }, 'doc-thread:d-1:th-1');
    expect(link().getAttribute('href')).toContain('item='); // presence first
    applyBackLink(document, { workspaceId: 'w-abc', name: 'n' });
    expect(link().getAttribute('href')).toBe('/workspaces/w-abc');
  });
});
