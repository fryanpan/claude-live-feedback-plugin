import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The mic is drawn the way the rest of the chrome is drawn.
 *
 * From the #250 fresh-eyes pass: the glyph was `🎙` — a colour emoji at 19px
 * in the system font stack — while every nav icon beside it is a stroked
 * 24×24 SVG on `currentColor`. It achieved "distinct" and read as unfinished,
 * on the one control Bryan reaches for most. Two more emoji mics were on the
 * same screen: the capture composer's `🎤` and the review doc's own `🎙`.
 *
 * The focus half of that pass was reported as a MISSING ring and is not one.
 * Measured 2026-08-21 in headless Chrome, ten Tab presses from the top of a
 * board: `#hub-mic` matched `:focus-visible` and the UA drew
 * `outline: auto 1px rgb(0, 95, 204)`. What the rule below changes is the
 * COLOUR — the platform blue for the accent every other focusable here uses.
 * Written down because a test that asserts a ring exists would pass on main
 * just as happily, and would say nothing about why the rule was added.
 *
 * These are stylesheet and markup facts; how the glyph reads at 430px and on
 * the rail is in the PR body, with screenshots.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const ICONS = readFileSync(resolve(SRC, 'icons.ts'), 'utf8');
const HUB_APP = readFileSync(resolve(SRC, 'hub/hub-app.ts'), 'utf8');
const HUB_RENDER = readFileSync(resolve(SRC, 'hub/hub-render.ts'), 'utf8');
const VOICE_DOCK = readFileSync(resolve(SRC, 'voice-dock.ts'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(declarationsOnly(CSS));
  return at?.[2] ?? '';
}

/** Every mic-bearing module, and the string each one mounts. */
const MOUNTS: ReadonlyArray<[string, string]> = [
  ['the board’s docked mic (hub-app.ts)', HUB_APP],
  ['the capture composer’s mic (hub-render.ts)', HUB_RENDER],
  ['the review doc’s mic (voice-dock.ts)', VOICE_DOCK],
];

describe('the mic wears the nav’s icon convention', () => {
  it('draws it as a stroked, currentColor SVG like every other glyph', () => {
    expect(ICONS, 'icons.ts lost MIC_ICON').toMatch(/export const MIC_ICON\s*=/);
    const icon = /export const MIC_ICON\s*=\s*`([^`]*)`/.exec(ICONS)?.[1] ?? '';
    expect(icon).toContain('<svg');
    // The vocabulary, via the shared attribute strings rather than a hand copy
    // of them — a second copy is how one glyph keeps a stroke width the others
    // have moved off.
    expect(icon).toContain('${SVG}');
    expect(icon).toContain('${SVG_ENDS}');
    expect(ICONS).toMatch(/stroke="currentColor"/);
    expect(ICONS).toMatch(/fill="none"/);
    expect(ICONS).toMatch(/viewBox="0 0 24 24"/);
  });

  it('is the single source all three mics mount', () => {
    for (const [where, src] of MOUNTS) {
      expect(src, `${where} does not use MIC_ICON`).toContain('MIC_ICON');
      expect(src, `${where} still imports nothing from icons.ts`).toMatch(
        /from '\.\.?\/(\.\.\/)?icons\.ts'/,
      );
    }
  });

  it('leaves no emoji mic anywhere in the app source', () => {
    // Positive control first: this sweep really is reading the files that used
    // to hold them, and really can see a glyph in them.
    for (const [where, src] of MOUNTS) {
      expect(src, `${where} is not the module that mounts a mic`).toMatch(
        /voice-mic|hub-quick-mic|doc-mic/,
      );
      expect(src, `${where} still ships an emoji mic`).not.toMatch(/\u{1F399}|\u{1F3A4}/u);
    }
  });

  it('sizes the glyph as a box, because a font-size no longer scales it', () => {
    // `.voice-mic` carried `font-size: 19px` and `.hub-quick-mic` carried 16px
    // to size an emoji. An SVG ignores both, so leaving them set is how the
    // next reader concludes the glyph is still text.
    expect(rule('.voice-mic')).not.toMatch(/font-size/);
    expect(rule('.hub-quick-mic')).not.toMatch(/font-size/);
    for (const sel of ['.voice-mic svg', '.hub-quick-mic svg']) {
      const box = rule(sel);
      expect(box, `${sel} has no rule, so the glyph sizes itself`).not.toBe('');
      expect(box).toMatch(/width:\s*\d+px/);
      expect(box).toMatch(/height:\s*\d+px/);
    }
  });
});

describe('the mic focuses in the same colour as its neighbours', () => {
  it('states the accent ring the rest of the chrome states', () => {
    const focus = rule('.voice-mic:focus-visible');
    expect(focus, 'the mic has no focus-visible rule').not.toBe('');
    expect(focus).toMatch(/outline:\s*2px solid var\(--accent/);
    // Positive control: this really is the shape the siblings use, read from
    // the stylesheet rather than from memory of the ticket.
    expect(rule('.doc-switcher:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent/);
    expect(rule('.thread-caret:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent/);
  });

  it('rings on keyboard focus only, not on the press-and-hold', () => {
    // The gesture IS a press. A `:focus` ring would stay behind after every
    // utterance on a surface whose whole point is that talking is cheap.
    expect(declarationsOnly(CSS)).not.toMatch(/\.voice-mic:focus\s*\{/);
  });
});
