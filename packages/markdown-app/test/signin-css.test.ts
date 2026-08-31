import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The sign-in page's layout promises, pinned where happy-dom cannot see them.
 *
 * The mockup's two hard viewport constraints: every state fits iPad
 * landscape's ~750px usable height without scrolling (the card is a single
 * short column, centered), and the six code boxes plus their gaps fit 430px
 * minus page padding (46px boxes shrink to 40px under 480px:
 * 6×40 + 5×6 = 270px, well inside 430 − 32 of padding). How it LOOKS at
 * 1180x820 and 430px is a browser check; see the PR report.
 */

const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, css: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\})\\s*${selector.replace(/[.#+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(css);
  return at?.[2] ?? '';
}

describe('sign-in page css', () => {
  it('centers a fluid card that can never exceed the mockup width', () => {
    const body = rule('.signin-body');
    expect(body).toContain('display: flex');
    expect(body).toContain('justify-content: center');
    expect(body).toContain('min-height: 100dvh');
    expect(rule('.signin-card')).toContain('width: min(380px, 100%)');
  });

  it('sizes the code boxes per the mockup and shrinks them under 480px', () => {
    const box = rule('.signin-code input');
    expect(box).toContain('width: 46px');
    expect(box).toContain('height: 56px');
    // More than one 480px block exists; pin the one that shrinks the boxes.
    const media = [
      ...declarationsOnly(CSS).matchAll(/@media \(max-width: 480px\) \{([\s\S]*?)\n\}/g),
    ].find((m) => m[1]?.includes('.signin-code'));
    expect(media).toBeDefined();
    const narrow = rule('.signin-code input', media?.[1] ?? '');
    expect(narrow).toContain('width: 40px');
    expect(narrow).toContain('height: 50px');
  });

  it('keeps inputs at 16px so iOS Safari does not zoom on focus', () => {
    expect(rule('.signin-form input[type="email"],\n.signin-form input[type="text"]')).toContain(
      'font-size: 16px',
    );
  });

  it('is filed in a banner section, not appended at EOF', () => {
    const at = CSS.indexOf('SIGN-IN PAGE');
    expect(at).toBeGreaterThan(0);
    // Another section banner follows it — the section is not the file's tail.
    expect(CSS.indexOf('=================', at + 40)).toBeGreaterThan(at);
  });

  it('gives the hub identity chip a popover anchored like the settings panel', () => {
    const chipMenu = rule('.hub-me-menu');
    expect(chipMenu).toContain('position: absolute');
    expect(chipMenu).toContain('right: 0');
  });

  it('keeps the identity chip at the 36px tap-target floor (design-mobile.md)', () => {
    // The chip is the sole sign-in entry point, and it is tapped on an iPad.
    const chip = rule('.hub-me');
    expect(chip).toContain('width: 36px');
    expect(chip).toContain('height: 36px');
  });

  it('makes the read-only notice a layout row, not an overlay', () => {
    // It shipped as one `position: fixed` box offset by the doc topbar's
    // measured height. On the board there is no `#topbar` to measure, so the
    // fallback constant put it on the action row and "Start a planning
    // huddle" could not be clicked at all; at 430px on the doc it covered the
    // H1 and the format bar. A fixed box over a page covers something at some
    // width — taking space is the fix, not finding a band that looks free.
    const bar = rule('.signin-bar');
    expect(bar).not.toContain('position: fixed');
    expect(bar).toContain('display: flex');
    // The doc shell declares its own rows, so the bar's row has to be
    // declared too — otherwise it lands inside the topbar's 48px and clips.
    expect(rule('body.signin-gated #shell')).toContain('grid-template-rows: auto 48px 1fr');
    // The fallback for a surface with no header still floats, and docks to
    // the bottom rather than to the band the doc title lives in.
    const floating = rule('.signin-bar--floating');
    expect(floating).toContain('position: fixed');
    expect(floating).toContain('bottom:');
    expect(floating).not.toContain('top:');
  });

  it('makes a control the write gate disabled LOOK disabled', () => {
    // Both gated toggles were pixel-identical to the live control beside
    // them: opacity 1, cursor pointer. A `title` is not the substitute — the
    // primary device here is an iPad, where nothing hovers.
    for (const sel of ['.icon-btn:disabled', '.hub-btn:disabled']) {
      const disabled = rule(sel);
      expect(disabled).toContain('opacity: 0.35');
      expect(disabled).toContain('cursor: default');
    }
    // And does not light up under a pointer, which is where the convention
    // at `.comment-nav:disabled` stops and these two needed more.
    expect(rule('.icon-btn:disabled:hover')).toContain('background:');
    expect(rule('.icon-btn:disabled[aria-pressed="true"]')).toContain('background: var(--bg)');
  });
});
