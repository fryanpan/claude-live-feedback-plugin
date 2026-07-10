import { describe, expect, it } from 'vitest';
import { safeLinkHref } from '../src/link-open.ts';

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

  it('returns null for empty/missing hrefs', () => {
    expect(safeLinkHref('')).toBeNull();
    expect(safeLinkHref('   ')).toBeNull();
    expect(safeLinkHref(null)).toBeNull();
    expect(safeLinkHref(undefined)).toBeNull();
  });
});
