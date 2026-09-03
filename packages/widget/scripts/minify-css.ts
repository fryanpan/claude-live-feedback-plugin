/**
 * Minify the widget's stylesheet on the way into the bundle.
 *
 * `styles.ts` holds the CSS in a template literal, and a JS minifier does not
 * look inside string contents — so every comment, newline and indent in that
 * literal used to ship inside the bundle. Minifying here keeps the source
 * readable and commented while the browser gets only what it needs. It is
 * worth about 1.7 KB raw / 340 bytes gzipped against a hard budget.
 *
 * `${...}` interpolations are lifted out before the rewrite and put back
 * afterwards, so nothing collapses whitespace or punctuation inside an
 * expression — `${STATUS_COLORS.open}` has to come through untouched.
 *
 * The transform is deliberately small rather than a full CSS parser. It is
 * safe for this stylesheet because it contains no `url(data:...)`, no quoted
 * `content:` string, and no descendant combinator followed by a pseudo-class
 * (`.a :first-child`), which is the one selector shape where dropping the
 * space around `:` would change meaning. `css-minify.test.ts` pins those.
 */
export function minifyCss(css: string): string {
  const holes: string[] = [];
  const masked = css.replace(/\$\{[^}]*\}/g, (m) => {
    holes.push(m);
    return `__CSSHOLE${holes.length - 1}__`;
  });
  const min = masked
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;\}/g, '}')
    .trim();
  return min.replace(/__CSSHOLE(\d+)__/g, (_m, i) => holes[Number(i)]);
}
