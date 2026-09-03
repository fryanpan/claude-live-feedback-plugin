import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The readout has to hold a 100-word status brief and stay readable.
 *
 * Bryan, 2026-08-29: *"If I ask for a brief status update, that should be
 * able to show me a 100 word message."* The strip was sized for a sentence:
 * `width: max-content` under `min(92vw, 840px)`, no height rule at all. A
 * hundred words at 14px/1.4 is ~5 lines at 840px and ~11 at a phone's 395px
 * — fine as prose, but with no ceiling a longer ack could climb off the top
 * of a 750px-tall iPad viewport, and the box needs to scroll rather than
 * grow. These are stylesheet facts; how the long form READS at 1180x820 and
 * 430px is stated in the PR body as not visually verified.
 */
const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function rule(selector: string): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(CSS);
  return at?.[2] ?? '';
}

describe('the long-ack form of the readout', () => {
  const long = rule('.voice-indicator--long');

  it('exists, in the VOICE section rather than appended at EOF', () => {
    expect(long, 'no .voice-indicator--long rule').not.toBe('');
    const voiceBanner = CSS.indexOf('.voice-mic {');
    const formatBar = CSS.indexOf('.format-bar');
    const at = CSS.indexOf('.voice-indicator--long');
    expect(at).toBeGreaterThan(voiceBanner);
    expect(formatBar === -1 || at < formatBar).toBe(true);
  });

  it('caps its height against the short axis and scrolls inside', () => {
    const maxH = /max-height:\s*([^;]+);/.exec(long)?.[1] ?? '';
    // A pair, like the width: a vh cap for the phone and the iPad (~750px
    // usable), and a px ceiling so a 4K screen does not get a wall of text.
    expect(maxH).toMatch(/min\(\s*\d+vh\s*,\s*\d+px\s*\)/);
    const vh = Number(/(\d+)vh/.exec(maxH)?.[1]);
    expect(vh).toBeLessThanOrEqual(45);
    expect(vh).toBeGreaterThanOrEqual(30);
    expect(long).toMatch(/overflow-y:\s*auto/);
  });

  it('wraps as prose — a 100-word ack is a paragraph, not a line', () => {
    expect(long).toMatch(/white-space:\s*normal/);
  });
});
