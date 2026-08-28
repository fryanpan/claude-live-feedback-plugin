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
});
