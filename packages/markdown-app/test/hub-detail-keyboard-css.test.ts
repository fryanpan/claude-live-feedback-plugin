import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The task panel ends ABOVE the on-screen keyboard, so its last control — the
 * Comment button — is reachable.
 *
 * Reported from an iPad: *"Comment button is hidden below the bottom of screen
 * … half of it is below the bottom of the task and I can't scroll far enough
 * to make it show up"*. Both halves of that sentence come from the same cause.
 * The panel's height is computed from `vh`, which counts the rows iOS covers
 * with the keyboard and — with a hardware keyboard attached — with the
 * shortcuts bar. So the panel's own box extends under that bar, the composer
 * is the last thing in it, and the panel is ALREADY scrolled to its end: there
 * is no scroll left to spend, which is exactly what "can't scroll far enough"
 * describes.
 *
 * The doc surface has never had this — `app.ts` publishes `--kb-bottom` from
 * the visual viewport and every bottom-docked element there rises by it. The
 * hub is a different entry point and called none of it, so the fix is to share
 * the wiring (see keyboard-inset.test.ts) and spend the variable here.
 *
 * happy-dom resolves no layout, so these are stylesheet properties. What a
 * browser has to confirm is the button's rect at 1180x820 with the keyboard up.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const HUB = readFileSync(resolve(SRC, 'hub/hub-app.ts'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every block for `selector`, in source order — the base rule and each
 *  media-query override are all matches, and the overrides are the ones that
 *  win on the devices this is about. */
function rules(selector: string): string[] {
  const re = new RegExp(
    `(?:^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():-]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'g',
  );
  const out: string[] = [];
  for (const m of declarationsOnly(CSS).matchAll(re)) out.push(m[1] ?? '');
  return out;
}

describe('the task panel clears the on-screen keyboard', () => {
  it('wires the keyboard inset from the hub entry, not only the doc app', () => {
    expect(HUB).toContain('wireKeyboardInset');
  });

  it('ends the modal overlay above the keyboard', () => {
    const base = rules('.hub-detail')[0] ?? '';
    expect(base).toMatch(/bottom:\s*var\(--kb-bottom, 0px\)/);
  });

  it('caps the panel against the overlay it sits in, not against the raw viewport', () => {
    // `min(92vh, 100%)` keeps today's 92vh everywhere the keyboard is down —
    // the overlay's content box IS 92vh then — and follows the overlay up
    // when it isn't. A bare `92vh` cannot: `vh` does not move.
    const base = rules('.hub-detail-panel')[0] ?? '';
    expect(base).toMatch(/max-height:\s*min\(92vh,\s*100%\)/);
  });

  it('stacks the keyboard on top of the phone bottom bar rather than replacing it', () => {
    // The ≤900 sheet already ends above the app's own bottom bar. The keyboard
    // is a SECOND thing over that row, so the two add.
    const phone = rules('.hub-detail').find((r) => r.includes('--hub-bottom-bar')) ?? '';
    expect(phone).toContain('--kb-bottom');
  });
});
