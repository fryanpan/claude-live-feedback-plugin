import { describe, expect, it } from 'vitest';
import { contextMatches, hasContext } from '../src/anchor/context.ts';

describe('hasContext', () => {
  it('returns false for empty / undefined / null', () => {
    expect(hasContext(undefined)).toBe(false);
    expect(hasContext(null)).toBe(false);
    expect(hasContext({})).toBe(false);
  });

  it('returns true if url or view is set', () => {
    expect(hasContext({ url: '/a' })).toBe(true);
    expect(hasContext({ view: 'modal=x' })).toBe(true);
  });
});

describe('contextMatches', () => {
  it('legacy anchors (no context) match everywhere', () => {
    expect(contextMatches(undefined, { url: '/anywhere' })).toBe(true);
    expect(contextMatches(null, { url: '/anywhere', view: 'modal=x' })).toBe(true);
  });

  it('blocks when urls differ', () => {
    expect(contextMatches({ url: '/home' }, { url: '/pricing' })).toBe(false);
  });

  it('passes when urls match', () => {
    expect(contextMatches({ url: '/pricing' }, { url: '/pricing' })).toBe(true);
  });

  it('blocks when anchor has a view but current does not', () => {
    expect(contextMatches({ view: 'modal=x' }, { url: '/a' })).toBe(false);
  });

  it('blocks when views differ', () => {
    expect(contextMatches({ url: '/a', view: 'modal=x' }, { url: '/a', view: 'modal=y' })).toBe(
      false,
    );
  });

  it('passes when both fields match', () => {
    expect(contextMatches({ url: '/a', view: 'modal=x' }, { url: '/a', view: 'modal=x' })).toBe(
      true,
    );
  });

  it('ignores current.view if anchor.view is unset', () => {
    // You're sitting in a modal; the anchor was made on the base page
    // with no view declared. Pin still shows — the anchor doesn't care
    // about dynamic state.
    expect(contextMatches({ url: '/a' }, { url: '/a', view: 'modal=x' })).toBe(true);
  });
});
