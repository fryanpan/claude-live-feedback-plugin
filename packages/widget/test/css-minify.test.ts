import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { minifyCss } from '../scripts/minify-css.ts';

/**
 * The build minifies the widget stylesheet into the bundle, because a JS
 * minifier will not look inside a template literal and the widget ships under
 * a hard gzipped budget. A wrong rewrite here is invisible to the tests that
 * import `widgetStyles` — they get the string after the template has already
 * been evaluated — and shows up only as broken styling on a host page.
 *
 * So these drive the transform directly, and the second block drives it over
 * the same input the build plugin gives it: the RAW source text of the
 * literal, `${STATUS_COLORS.open}` and all. That is the reason for reading
 * the file rather than importing the module — an imported `widgetStyles` has
 * no interpolations left in it to preserve.
 */

const stylesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles.ts'),
  'utf8',
);
const rawCss = stylesSource.match(/export const widgetStyles = `([\s\S]*?)`;/)?.[1];

describe('minifyCss', () => {
  it('drops comments, newlines and indentation', () => {
    expect(minifyCss('/* note */\n.a {\n  color: red;\n}\n')).toBe('.a{color:red}');
  });

  it('keeps the descendant combinator between two selectors', () => {
    expect(minifyCss('.a .b { color: red; }')).toBe('.a .b{color:red}');
  });

  it('keeps the space inside calc(), where it is an operator', () => {
    expect(minifyCss('.a { width: calc(100% - 12px); }')).toBe('.a{width:calc(100% - 12px)}');
  });

  it('keeps a comma-separated font stack readable to the parser', () => {
    expect(minifyCss('.a { font-family: Segoe UI, system-ui, sans-serif; }')).toBe(
      '.a{font-family:Segoe UI,system-ui,sans-serif}',
    );
  });

  it('leaves a ${} interpolation byte-for-byte alone', () => {
    expect(minifyCss('.a { background: ${STATUS_COLORS.open}; }')).toBe(
      '.a{background:${STATUS_COLORS.open}}',
    );
  });

  it('does not collapse whitespace or punctuation inside an interpolation', () => {
    expect(minifyCss('.a { color: ${pick(a, b) > 1 ? x : y}; }')).toContain(
      '${pick(a, b) > 1 ? x : y}',
    );
  });

  it('is idempotent', () => {
    const once = minifyCss('/* c */\n.a {\n  color: red;\n}\n.b .c { width: calc(1px + 2px); }');
    expect(minifyCss(once)).toBe(once);
  });

  describe('over the stylesheet the build actually feeds it', () => {
    it('found the literal to test', () => {
      expect(rawCss).toBeTypeOf('string');
    });

    it('preserves every interpolation the source declares', () => {
      const source = rawCss?.match(/\$\{[^}]*\}/g) ?? [];
      expect(source.length).toBeGreaterThan(0);
      expect(minifyCss(rawCss as string).match(/\$\{[^}]*\}/g)).toEqual(source);
    });

    it('preserves every selector block', () => {
      const braces = (s: string) => (s.match(/\{/g) ?? []).length;
      // `${...}` contributes an opening brace of its own; count only rule blocks.
      const rules = (s: string) => braces(s) - (s.match(/\$\{/g) ?? []).length;
      expect(rules(minifyCss(rawCss as string))).toBe(rules(rawCss as string));
    });

    it('preserves every declaration', () => {
      const decls = (s: string) => (s.match(/[a-z-]+\s*:\s*[^;{}]+/g) ?? []).length;
      expect(decls(minifyCss(rawCss as string))).toBe(decls(rawCss as string));
    });

    it('gets meaningfully smaller', () => {
      const min = minifyCss(rawCss as string);
      expect(min.length).toBeLessThan((rawCss as string).length * 0.9);
    });

    it('leaves no minifier sentinel behind', () => {
      expect(minifyCss(rawCss as string)).not.toContain('__CSSHOLE');
    });
  });
});
