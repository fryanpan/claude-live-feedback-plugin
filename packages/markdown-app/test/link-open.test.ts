import { describe, expect, it } from 'vitest';
import { resolveDocLink, safeLinkHref } from '../src/link-open.ts';

/**
 * Cmd/Ctrl+Click on a link opens it in a new tab. `safeLinkHref` is the pure
 * decision: given an anchor's href, return the URL to open, or null if there's
 * nothing safe to open. The security-relevant contract is that script-bearing
 * schemes never come back as openable.
 */
describe('safeLinkHref', () => {
  it('returns http(s) URLs unchanged', () => {
    expect(safeLinkHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeLinkHref('http://example.com')).toBe('http://example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(safeLinkHref('  https://example.com  ')).toBe('https://example.com');
  });

  it('allows mailto and tel', () => {
    expect(safeLinkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeLinkHref('tel:+15551234')).toBe('tel:+15551234');
  });

  it('allows relative and anchor links (permissive for non-script schemes)', () => {
    expect(safeLinkHref('/docs/x')).toBe('/docs/x');
    expect(safeLinkHref('#section')).toBe('#section');
  });

  it('blocks script-bearing schemes regardless of casing/whitespace', () => {
    expect(safeLinkHref('javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('  JavaScript:alert(1)')).toBeNull();
    expect(safeLinkHref('data:text/html,<script>')).toBeNull();
    expect(safeLinkHref('vbscript:msgbox')).toBeNull();
  });

  it('blocks script schemes obfuscated with control chars browsers strip', () => {
    // Browsers ignore embedded tabs/newlines/NULs when resolving the scheme,
    // so a contiguous-scheme denylist alone would be evadable.
    expect(safeLinkHref('java\tscript:alert(1)')).toBeNull();
    expect(safeLinkHref('java\nscript:alert(1)')).toBeNull();
    expect(safeLinkHref('\x00javascript:alert(1)')).toBeNull();
    expect(safeLinkHref('ja\rvascript:alert(1)')).toBeNull();
  });

  it('returns null for empty/missing hrefs', () => {
    expect(safeLinkHref('')).toBeNull();
    expect(safeLinkHref('   ')).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });
});

describe('resolveDocLink', () => {
  const ctx = { reviewId: 'rev-1', relPath: 'docs/main.md' };

  it('resolves a same-dir relative link to the sibling docId URL', () => {
    expect(resolveDocLink({ href: './research.md', ...ctx })).toBe(
      `/review/${encodeURIComponent('rev-1:docs~research.md')}`,
    );
    expect(resolveDocLink({ href: 'research.md', ...ctx })).toBe(
      `/review/${encodeURIComponent('rev-1:docs~research.md')}`,
    );
  });

  it('resolves ../ against the current doc directory', () => {
    expect(resolveDocLink({ href: '../README.md', ...ctx })).toBe(
      `/review/${encodeURIComponent('rev-1:README.md')}`,
    );
    expect(resolveDocLink({ href: 'sub/notes.md', ...ctx })).toBe(
      `/review/${encodeURIComponent('rev-1:docs~sub~notes.md')}`,
    );
  });

  it('drops query strings and anchors', () => {
    expect(resolveDocLink({ href: './research.md#section', ...ctx })).toBe(
      `/review/${encodeURIComponent('rev-1:docs~research.md')}`,
    );
  });

  it('returns null outside a workspace or for non-relative links', () => {
    expect(resolveDocLink({ href: './x.md', reviewId: '', relPath: '' })).toBeNull();
    expect(resolveDocLink({ href: 'https://x.com/a.md', ...ctx })).toBeNull();
    expect(resolveDocLink({ href: '/abs/path.md', ...ctx })).toBeNull();
    expect(resolveDocLink({ href: '#anchor-only', ...ctx })).toBeNull();
    expect(resolveDocLink({ href: 'mailto:x@y.com', ...ctx })).toBeNull();
  });

  it('refuses paths that escape the workspace root or embed the ~ separator', () => {
    expect(resolveDocLink({ href: '../../etc/passwd', ...ctx })).toBeNull();
    expect(resolveDocLink({ href: './weird~name.md', ...ctx })).toBeNull();
    expect(resolveDocLink({ href: '%zz-bad-escape.md', ...ctx })).toBeNull();
  });
});
