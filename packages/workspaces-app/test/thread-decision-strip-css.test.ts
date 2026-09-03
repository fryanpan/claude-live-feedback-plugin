import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The settled item's DECISION strip — the layout half, which no DOM test can
 * see because happy-dom resolves no layout and evaluates no media query.
 *
 * The strip exists because the outcome used to be a fragment of a sentence
 * ("Answered by Cara: “AssemblyAI — go with what we prototyped”"), so the one
 * thing a person opens a settled item to read had no visual home. The
 * approved mock gives it a label beside the words at reading width, and
 * stacks the label ABOVE the words at a phone's — where a label and a
 * sentence on one line leave the sentence wrapping under a hanging label.
 *
 * Asserted here so deleting either half goes red rather than merely looking
 * different; how it actually reads at 1180 and 430 is checked in a browser.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** The phone breakpoint this strip stacks at. Named once — a stale copy of
 *  the number would silently search nothing and pass. */
const PHONE = '(max-width: 640px)';

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule. `within` scopes the search to a media block's text,
 *  because the same selector is styled differently at each breakpoint and a
 *  file-wide search would return whichever came first. */
function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** Every `@media` block matching this query, concatenated, braces balanced by
 *  counting — the stylesheet carries more than one block per breakpoint, and
 *  taking the first would search the wrong few hundred lines. */
function media(query: string): string {
  const css = declarationsOnly(CSS);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start, i));
        from = i;
        break;
      }
    }
    if (from <= start) break;
  }
  return out.join('\n');
}

describe('the settled item’s decision strip', () => {
  it('puts the label beside the words at reading width', () => {
    const strip = rule('.thread-decision-strip');
    expect(strip).toMatch(/display:\s*flex/);
    // Baseline, not centre: a one-word label against three lines of outcome
    // centres to the middle of the paragraph and reads as unattached.
    expect(strip).toMatch(/align-items:\s*baseline/);
    // Row is flex's default, so the absence of a column here is the claim.
    expect(strip).not.toMatch(/flex-direction:\s*column/);
  });

  it('keeps the label a label — uppercase, and never shrinking to fit', () => {
    const label = rule('.thread-decision-label');
    expect(label).toMatch(/text-transform:\s*uppercase/);
    // `flex: 0 0 auto` is what stops the label wrapping mid-word to give the
    // outcome room, which is the failure that makes a strip look broken.
    expect(label).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it('stacks the label above the words at 430px', () => {
    const phone = media(PHONE);
    // Positive control: the block really was found and really is being read.
    expect(phone, `no ${PHONE} block found in the stylesheet`).not.toBe('');
    const stacked = rule('.thread-decision-strip', phone);
    expect(stacked, `.thread-decision-strip is not restyled at ${PHONE}`).not.toBe('');
    expect(stacked).toMatch(/flex-direction:\s*column/);
  });

  it('lets a long outcome break rather than widening the card', () => {
    // A pasted identifier or URL in a free-text answer is the case that
    // overflows a fixed-width margin rail.
    expect(rule('.thread-answer-words')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
