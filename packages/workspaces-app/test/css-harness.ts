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
 * needs. They exist to INSTALL the sheets into the test document, and
 * `TEXT` is module-private on purpose: no function here returns CSS text, so
 * no test can reach a stylesheet's source through this module and assert on
 * it. Export that map and the hole is open again.
 *
 * Be exact about why the audit does not count these four, because it is no
 * longer an accident. `scripts/test-audit.ts` now follows a test's imports:
 * a module that reads source is assumed to hand that text to its importers,
 * and every one of them counts. This module claims the exemption with the
 * marker line above `TEXT` below.
 *
 * The marker does not buy the exemption on its own, and this paragraph is
 * proof of why it must not: the check reads a marker only on a line holding
 * nothing else, so prose like this one cannot exempt anything. Beyond the
 * marker the check requires that every export here carry an explicit type or
 * return annotation, and that none of those annotations name `string`. Add
 * `export function sheetText(): string`, or an export with no annotation at
 * all, and the exemption lapses and all forty-six importers start counting.
 * The private map and the audit now say the same thing, and the audit can
 * check it.
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
export type SheetName =
  | 'tokens.css'
  | 'styles.css'
  | 'doc.css'
  | 'board.css'
  | 'signin.css'
  | 'settings.css';

// audit: no-text
//
// The line above is the marker, and it has to stay a line of its own. Nothing
// here returns CSS text: `TEXT` is module-private and every export hands back
// a computed style, an element or a cleanup, so `scripts/test-audit.ts` does
// not count this module's importers as source readers. Export a string from
// this file, or an unannotated value of any kind, and that exemption lapses.
const TEXT: Record<SheetName, string> = {
  'tokens.css': readFileSync(resolve(SRC, 'tokens.css'), 'utf8'),
  'styles.css': readFileSync(resolve(SRC, 'styles.css'), 'utf8'),
  'doc.css': readFileSync(resolve(SRC, 'doc.css'), 'utf8'),
  'board.css': readFileSync(resolve(SRC, 'board.css'), 'utf8'),
  'signin.css': readFileSync(resolve(SRC, 'signin.css'), 'utf8'),
  'settings.css': readFileSync(resolve(SRC, 'settings.css'), 'utf8'),
};

/**
 * Install the named sheets into `document.head` in the order given.
 *
 * Give them the order the PAGE gives them. The review editor links
 * `styles.css`, then `doc.css`, then `tokens.css`
 * (`packages/workspaces-app/index.html`); `renderBoardShell` links `board.css`,
 * then `styles.css`, then `tokens.css`; `renderSigninShell` links
 * `styles.css`, then `signin.css`, then `tokens.css`, and
 * `renderSettingsShell` links `styles.css`, then `settings.css`, then
 * `tokens.css` (`packages/server/src/shells.ts`). Order is load-bearing and
 * neither page's is arbitrary: the board block used to sit a twelfth of the
 * way into `styles.css`, so loading `board.css` LAST would reverse about thirty
 * equal-specificity ties the product does not reverse, and `doc.css` was
 * interleaved through `styles.css`, so loading it FIRST reverses twenty. A
 * test that installs a pair the other way round can watch a rule win that
 * loses in the browser.
 *
 * A test about an editor-only surface — the file tree, the format bar, the
 * meeting strip, the diff nav, the thread modal, the inline cards — needs
 * BOTH `'styles.css', 'doc.css'`: the tokens and the shared chrome are in
 * the first and the surface is in the second.
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

/** A window size the media queries are evaluated against. */
export type Viewport = { width: number; height: number };

/**
 * The two viewports this project verifies — docs/product/design-mobile.md.
 *
 * Annotated rather than `as const` because the audit's exemption for this
 * module requires every export to say its own type: an inferred one is no
 * evidence that nothing here hands back stylesheet text.
 */
export const IPAD: Viewport = { width: 1180, height: 820 };
export const PHONE: Viewport = { width: 430, height: 932 };

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
export function setViewport({ width, height }: Viewport): void {
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
