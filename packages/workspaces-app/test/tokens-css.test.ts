import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PROPS_FILES } from '../src/tokens-manifest.ts';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The Open Props trial layer.
 *
 * `/app/tokens.css` is built by concatenating the vendored Open Props subset
 * (tokens-manifest.ts) with the mapping layer in `src/tokens.css`. These
 * tests pin the ways that composition can silently rot, and they pin them by
 * INSTALLING the same concatenation the build produces and reading what the
 * tokens compute to — because every one of these failures is silent by
 * definition:
 *
 *  1. the mapping references an Open Props var whose file was dropped from
 *     the manifest — the var() falls back to nothing and the token computes
 *     to the guaranteed-invalid initial value, with no build error anywhere.
 *     A text comparison of "names defined" against "names read" is a model of
 *     that; the computed value IS it;
 *  2. the shells load tokens.css AFTER styles.css — both define the same
 *     `:root` custom properties at equal specificity, so document order is
 *     the only thing that lets the trial layer win. Asserted as "the trial
 *     value is the one an element gets", which is what the order is FOR.
 *     (Removing the link is the designed way to revert the whole trial.)
 *
 * Dropped in the conversion, and named here so it is not mistaken for
 * covered: the check that `src/tokens.css` invents no token name styles.css
 * neither defines nor reads. That is a comparison of two files' text with no
 * observable consequence — a token nothing reads computes fine — so there is
 * nothing to measure. Its neighbouring half survives in a different form
 * below: the remapped names really are the ones the app's own rules read.
 */

const pkgRoot = resolve(import.meta.dirname, '..');
const INDEX = readFileSync(join(pkgRoot, 'index.html'), 'utf8');

// Resolve exactly the way scripts/build.ts does: from this package's root,
// where the open-props dependency is declared.
const req = createRequire(join(pkgRoot, 'package.json'));

/** One vendored Open Props file's text, resolved from the installed package.
 *  This is the app's DEPENDENCY, not its own stylesheet — `css-harness.ts` is
 *  still the only place that reads a file under `src/`. */
const vendored = (file: string): string => readFileSync(req.resolve(`open-props/${file}`), 'utf8');

/** The whole vendored subset, in manifest order — the first half of what
 *  `scripts/build.ts` writes to `dist/tokens.css`. */
const openProps = (): string => OPEN_PROPS_FILES.map(vendored).join('\n');

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
  document.body.replaceChildren();
});

/**
 * Install `/app/tokens.css` as the build produces it: the vendored subset,
 * then the mapping layer. A LOCAL helper rather than a harness sheet, because
 * the served file does not exist in `src/` — it is a concatenation, and
 * installing `src/tokens.css` alone is the exact failure mode (1) above.
 */
function installBuiltTokens(): void {
  const node = document.createElement('style');
  node.setAttribute('data-sheet', 'open-props (vendored)');
  node.textContent = openProps();
  document.head.appendChild(node);
  cleanups.push(() => node.remove());
  cleanups.push(installSheets('tokens.css'));
}

/** Install the sheets a page loads, in that page's order. */
function installApp(...names: Parameters<typeof installSheets>): void {
  cleanups.push(installSheets(...names));
}

/**
 * What a token computes to, read through a property that USES it.
 *
 * `getComputedStyle(el).getPropertyValue('--fg')` is no good here: happy-dom
 * hands back the declaration's own text and does not follow the `var()` chain
 * inside it, so a mapping that resolves to nothing and one that resolves to a
 * colour are indistinguishable at that seam. Substituting the token into a
 * real property is the seam that DOES resolve — and it is also the thing the
 * app cares about, since a token exists to be spent.
 *
 * `border-radius` and `box-shadow` are used for the non-colour tokens, and
 * `border-radius` for the "resolves to nothing" control, because neither
 * inherits: an unresolved value reads as '' rather than as the body's.
 */
function token(name: string, prop: 'color' | 'border-radius' | 'box-shadow' = 'color'): string {
  const probe = document.createElement('style');
  probe.textContent = `.token-probe { ${prop}: var(${name}); }`;
  document.head.appendChild(probe);
  const style = styleOf(attach('token-probe'));
  const read =
    prop === 'color'
      ? style.color
      : prop === 'border-radius'
        ? style.borderRadius
        : style.boxShadow;
  probe.remove();
  return read.trim();
}

/** The 14 names the mapping layer is supposed to re-point, each with the
 *  property it is spent through. */
const CORE = [
  ['--fg', 'color'],
  ['--bg-panel', 'color'],
  ['--bg-hover', 'color'],
  ['--border', 'color'],
  ['--border-strong', 'color'],
  ['--accent', 'color'],
  ['--orange', 'color'],
  ['--red', 'color'],
  ['--green', 'color'],
  ['--green-strong', 'color'],
  ['--red-strong', 'color'],
  ['--radius', 'border-radius'],
  ['--shadow', 'box-shadow'],
  ['--shadow-lg', 'box-shadow'],
] as const;

describe('open-props vendored subset (tokens-manifest.ts)', () => {
  it('every manifest file resolves from the installed package', () => {
    expect(OPEN_PROPS_FILES.length).toBeGreaterThan(0);
    for (const file of OPEN_PROPS_FILES) {
      expect(vendored(file), file).toContain('--');
    }
  });
});

describe('tokens.css mapping layer', () => {
  it('resolves every core token against the vendored subset alone', () => {
    // The whole trial layer, with NOTHING else installed: if the mapping
    // reads a scale whose file left the manifest, the token computes to the
    // empty string here and the app silently loses that colour.
    installBuiltTokens();
    setViewport(IPAD);
    for (const [name, prop] of CORE) {
      expect(token(name, prop), `${name} resolves to nothing`).not.toBe('');
    }
    // …and to real values, not to the literal `var(...)` text.
    expect(token('--fg')).toMatch(/^#|^rgb/);
    expect(token('--radius', 'border-radius')).toMatch(/px$/);
  });

  it('positive control: a token that reads a var nobody ships resolves to nothing', () => {
    // Without this the test above passes on any environment that returns a
    // non-empty string for every custom property — which is exactly what an
    // unresolved `var()` must NOT do, and is the whole failure being guarded.
    installBuiltTokens();
    setViewport(IPAD);
    const probe = document.createElement('style');
    probe.textContent = ':root { --tokens-css-probe: var(--gray-not-vendored); }';
    document.head.appendChild(probe);
    expect(token('--tokens-css-probe', 'border-radius')).toBe('');
    probe.remove();
    // And a token that reads a var that IS shipped resolves, in the same pass.
    expect(token('--fg')).not.toBe('');
  });

  it('wins over the base palette, which is what the link order is for', () => {
    // Both files define the same `:root` names at equal specificity, so
    // document order decides. The shells load styles.css first and tokens.css
    // after; installed that way, an element gets the TRIAL value.
    installApp('styles.css');
    installBuiltTokens();
    setViewport(IPAD);
    const trial = token('--fg');
    expect(trial).toBe(token('--gray-9'));
    // Control: the base palette really is different, and really is what the
    // page gets without the trial layer. Otherwise "the trial won" is
    // unfalsifiable.
    for (const c of cleanups.reverse()) c();
    cleanups = [];
    installApp('styles.css');
    const base = token('--fg');
    expect(base).not.toBe('');
    expect(base).not.toBe(trial);
  });

  it('re-points names the app’s own rules actually read', () => {
    // The other half of the retired "invents no new name" check, from the
    // side that can be observed: a remapped token has to reach real elements,
    // or the mapping is a private dictionary. Two call sites, two sheets.
    installApp('board.css', 'styles.css');
    installBuiltTokens();
    setViewport(IPAD);
    expect(styleOf(attach('board-btn', { tag: 'button' })).borderTopColor).toBe(token('--border'));
    expect(styleOf(attach('voice-indicator')).color).toBe(token('--fg'));
    expect(token('--fg')).toBe(token('--gray-9'));
  });
});

describe('shell link order', () => {
  it('index.html links styles.css first, then tokens.css', () => {
    // The one thing no cascade measurement can reach: which order the SHELL
    // asks for. The test above proves the order is load-bearing; this proves
    // the page ships it. (index.html is a shell, not a stylesheet — the
    // harness owns every `src/*.css` read.)
    const styles = INDEX.indexOf('/app/styles.css');
    const tokens = INDEX.indexOf('/app/tokens.css');
    expect(styles).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(-1);
    expect(tokens).toBeGreaterThan(styles);
  });

  it('links doc.css between the shared base and the token layer', () => {
    // Same argument, one file later. `doc.css` carries the editor-only
    // surfaces and used to sit interleaved through `styles.css`: after it,
    // every equal-specificity tie lands where it landed before; before it,
    // twenty change hands (test/doc-css.test.ts reads two of them at 430px).
    // And tokens.css still has to be last of the three.
    const styles = INDEX.indexOf('/app/styles.css');
    const doc = INDEX.indexOf('/app/doc.css');
    const tokens = INDEX.indexOf('/app/tokens.css');
    expect(doc).toBeGreaterThan(-1);
    expect(doc).toBeGreaterThan(styles);
    expect(tokens).toBeGreaterThan(doc);
  });
});
