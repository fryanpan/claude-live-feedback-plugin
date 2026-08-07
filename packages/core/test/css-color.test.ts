/**
 * `cssColor` guards the one place a user-supplied color reaches a quoted HTML
 * attribute (packages/widget/src/widget.ts renders other people's comment
 * swatches with string-built markup). Share visitors already have their color
 * pinned to `#rrggbb` server-side; anything posted from the local surface does
 * not, so the widget validates at the sink.
 */
import { describe, expect, it } from 'vitest';
import { cssColor } from '../src/ui-shared.ts';

describe('cssColor', () => {
  it('passes through hex literals of every accepted length', () => {
    for (const c of ['#abc', '#ABC', '#a1b2c3', '#A1B2C3', '#a1b2c3d4']) {
      expect(cssColor(c)).toBe(c);
    }
  });

  it('replaces a value that would break out of a style attribute', () => {
    // The payload that motivated this: close the attribute, open an event
    // handler. If cssColor ever returns this verbatim, the widget emits
    // `<span class="swatch" style="background:" onmouseover="...">`.
    const attack = '"><img src=x onerror=alert(1)>';
    expect(cssColor(attack)).toBe('#888888');
    expect(cssColor(attack)).not.toContain('<');
    expect(cssColor(attack)).not.toContain('"');
  });

  it('rejects anything that is not a bare hex literal', () => {
    for (const c of ['red', 'url(javascript:alert(1))', 'rgb(1,2,3)', '#abc; x:y', '#ab cd']) {
      expect(cssColor(c)).toBe('#888888');
    }
  });

  it('lets through a hex length CSS will not render, which is fine', () => {
    // `#12345` is not a color CSS accepts (3/4/6/8 digits only) so the swatch
    // just goes unstyled. The contract here is "safe to interpolate", not
    // "renders" — and the regex matches the SPA's existing suggestColorStyle
    // check, so the two sinks agree.
    expect(cssColor('#12345')).toBe('#12345');
  });

  it('falls back for empty, undefined and null', () => {
    expect(cssColor(undefined)).toBe('#888888');
    expect(cssColor(null)).toBe('#888888');
    expect(cssColor('')).toBe('#888888');
  });

  it('honours a caller-supplied fallback', () => {
    expect(cssColor('nope', '#ff0000')).toBe('#ff0000');
  });
});
