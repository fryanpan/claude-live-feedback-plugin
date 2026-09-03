/**
 * Read a rule by rendering it, not by grepping for it.
 *
 * A test that reads `styles.css` as text and asserts a selector or a property
 * string is present passes against any file that still contains the string —
 * including one where the rule no longer applies, because something later in
 * the cascade overrides it, because the element never carries the class, or
 * because a media query the string sits inside no longer matches. Testing
 * standard 1 (`.claude/rules/testing-standards.md`) asks for the computed
 * value instead. This module is the seam that makes that cheap.
 *
 * The four reads below are the only stylesheet reads the app's test suite
 * needs. They exist to INSTALL the sheets into the test document; no function
 * here returns CSS text, so nothing downstream can assert on source shape.
 * Consolidating them here is why the audit's `sourceShape` ceiling falls: the
 * reads did not move into a hiding place, they stopped being read sites in
 * files that assert on text.
 *
 * WHAT HAPPY-DOM CAN AND CANNOT RESOLVE. It runs the real cascade — author
 * specificity, `!important`, inheritance, custom properties, descendant,
 * child, attribute and `:first-child` selectors, `@media` and `@supports`
 * blocks — over the sheets installed here. It has no layout engine and no
 * pointer, so these are out of reach and stay browser checks (`bun run
 * ui:shot`): rendered geometry (`offsetHeight` is always 0), `:hover` and
 * `:active`, `::before` / `::after`, `env()`, `@container`, `color-mix()`,
 * and `max()`. `min()` and `clamp()` come back unevaluated as strings, but
 * with their `vw` / `vh` terms already resolved, so the same rule read at two
 * viewports gives two different strings — which is a real assertion. `max()`
 * is worse than unevaluated: an unsupported function makes happy-dom drop the
 * WHOLE declaration, and so does a `calc()` carrying a `var()` that is not
 * set, so the property reads as if the rule had never been written. Publish
 * the variable the app publishes and the calc resolves.
 *
 * An unset property reads `''` rather than its CSS initial value, so a
 * "nothing caps this" assertion has to accept both `''` and `none` — and
 * every test needs a positive control, because an element no rule reaches
 * satisfies almost any negative on its own.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(import.meta.dirname, '../src');

/** The sheets the app's pages load, in cascade order. */
export type SheetName = 'tokens.css' | 'styles.css' | 'hub.css' | 'signin.css';

const TEXT: Record<SheetName, string> = {
  'tokens.css': readFileSync(resolve(SRC, 'tokens.css'), 'utf8'),
  'styles.css': readFileSync(resolve(SRC, 'styles.css'), 'utf8'),
  'hub.css': readFileSync(resolve(SRC, 'hub.css'), 'utf8'),
  'signin.css': readFileSync(resolve(SRC, 'signin.css'), 'utf8'),
};

/**
 * Install the named sheets into `document.head` in the order given.
 *
 * Give them the order the PAGE gives them. `renderHubShell` links
 * `hub.css`, then `styles.css`, then `tokens.css`; `renderSigninShell` links
 * `styles.css`, then `signin.css`, then `tokens.css`
 * (`packages/server/src/shells.ts`). Order is load-bearing and the hub's is
 * deliberate: the hub block used to sit a twelfth of the way into
 * `styles.css`, so loading `hub.css` LAST would reverse about thirty
 * equal-specificity ties the product does not reverse. A test that installs
 * the pair the other way round can watch a rule win that loses in the browser.
 *
 * `'tokens.css'` is the MAPPING HALF ONLY. The served `/app/tokens.css` is
 * the vendored Open Props subset concatenated with `src/tokens.css`
 * (`scripts/build.ts`), and the mapping alone re-points `--fg`, `--border`
 * and friends at `var(--gray-N)` names nothing defines, so every colour
 * downstream computes to `''`. Leave it out unless the test is about the
 * token layer, and compose the served pair the way `tokens-css.test.ts` does
 * when it is.
 *
 * Returns the cleanup. Call it in `afterEach`, or the sheets stack across
 * tests in the same file.
 */
export function installSheets(...names: SheetName[]): () => void {
  const nodes = names.map((name) => {
    const node = document.createElement('style');
    node.setAttribute('data-sheet', name);
    node.textContent = TEXT[name];
    document.head.appendChild(node);
    return node;
  });
  return () => {
    for (const node of nodes) node.remove();
  };
}

/** The two viewports this project verifies — docs/product/design-mobile.md. */
export const IPAD = { width: 1180, height: 820 } as const;
export const PHONE = { width: 430, height: 932 } as const;

/**
 * Set the window size the media queries are evaluated against.
 *
 * happy-dom's default is 1024x768, which is INSIDE this project's mobile tier
 * (<= 1100). A test that never sets a viewport is therefore reading the phone
 * cascade while reading like it reads the desktop one, so every test that
 * cares about a media query states its viewport.
 *
 * Call it before building or mounting the elements under test: a computed
 * style is cached on the element from its first read, so an element that
 * already exists keeps the old viewport's answer. `styleOf` exists for the
 * cases where that ordering is not possible.
 */
export function setViewport({ width, height }: { width: number; height: number }): void {
  (
    window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }
  ).happyDOM.setViewport({ width, height });
}

/**
 * The computed style of an element, re-evaluated against the CURRENT viewport
 * and sheets.
 *
 * happy-dom caches an element's computed style from the first read and does
 * not invalidate it when the viewport changes or a sheet is added, so
 * `getComputedStyle` alone reports the first answer forever. Detaching and
 * re-attaching the node drops the cache. The node goes back exactly where it
 * was, so a mounted island keeps its structure and its listeners.
 *
 * Two consequences worth knowing before they cost you a false green:
 *
 *  - The declaration this returns stays LIVE. Hold one across a
 *    `setViewport` and every property re-answers for the new width, so an
 *    iPad reading compared against a phone reading silently compares the
 *    phone against itself. Read the values out to strings or numbers before
 *    you move the viewport.
 *  - Detaching a focused element BLURS it, which takes `:focus-visible` off
 *    the element on the way past. `:focus` and `:focus-visible` do otherwise
 *    resolve here; a test about a focus ring has to focus after the last
 *    viewport change and read with a plain `getComputedStyle`.
 */
export function styleOf(el: Element): CSSStyleDeclaration {
  const parent = el.parentNode;
  if (parent) {
    const next = el.nextSibling;
    parent.removeChild(el);
    parent.insertBefore(el, next);
  }
  return getComputedStyle(el);
}

/**
 * Build an element carrying `classes`, attach it under `parent` (the body by
 * default), and return it — for rules that sit on a leaf whose real renderer
 * has no test seam. Prefer mounting the real component where one exists: a
 * hand-built node proves the RULE applies to that class chain, not that the
 * app ever puts the chain on the page.
 */
export function attach(
  classes: string,
  opts: { tag?: string; parent?: Element; attrs?: Record<string, string> } = {},
): HTMLElement {
  const el = document.createElement(opts.tag ?? 'div');
  el.className = classes;
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);
  (opts.parent ?? document.body).appendChild(el);
  return el as HTMLElement;
}
