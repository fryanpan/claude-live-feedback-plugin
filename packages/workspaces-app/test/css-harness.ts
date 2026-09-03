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
 * ui:shot`): rendered geometry (`offsetHeight` is always 0), `:hover` /
 * `:focus-visible` / `:active`, `::before` / `::after`, `env()`, `@container`,
 * and `clamp()` / `min()` arithmetic, which come back unresolved.
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
 * Install the named sheets into `document.head` in the order given, which is
 * the order the page loads them — `tokens.css` first, then `styles.css`, then
 * `hub.css`. Order is load-bearing: two rules of equal specificity are
 * settled by which sheet came last, so a test that installs only `hub.css`
 * can see a rule win that the real page loses.
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
