import { beforeEach, describe, expect, it } from 'vitest';
import { applyBackLink, backLinkFor } from '../src/back-link.ts';

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
