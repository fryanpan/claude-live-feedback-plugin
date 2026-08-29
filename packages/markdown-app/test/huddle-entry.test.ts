import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUDDLE_START_PARAM,
  applyHuddleCrumb,
  wantsHuddleStart,
  withoutHuddleStart,
} from '../src/huddle-entry.ts';

/**
 * How the editor knows it was opened BY the Board's "Start a planning huddle"
 * button — the one moment the mic should start without a press. The button's
 * click is the person's gesture; a full navigation does not carry it into
 * the editor, so the flag rides the URL and the editor honours it once.
 *
 * The "Huddle" crumb is a fact about the DOC (its meta), not about how it was
 * opened: it shows on every later visit too. All fixtures synthetic.
 */

describe('wantsHuddleStart', () => {
  it('is true only for the flag the Board sets', () => {
    expect(wantsHuddleStart(`?${HUDDLE_START_PARAM}=1`)).toBe(true);
    expect(wantsHuddleStart('?thread=t-abc1&huddle=1')).toBe(true);
    expect(wantsHuddleStart('')).toBe(false);
    expect(wantsHuddleStart('?huddle=0')).toBe(false);
    expect(wantsHuddleStart('?thread=t-abc1')).toBe(false);
  });
});

describe('withoutHuddleStart', () => {
  it('drops the flag and keeps everything else in the address', () => {
    expect(withoutHuddleStart('/workspaces/w-abc1/docs/d-abc1?huddle=1&thread=t-abc1#x')).toBe(
      '/workspaces/w-abc1/docs/d-abc1?thread=t-abc1#x',
    );
    expect(withoutHuddleStart('/workspaces/w-abc1/docs/d-abc1?huddle=1')).toBe(
      '/workspaces/w-abc1/docs/d-abc1',
    );
  });

  it('leaves an address without the flag alone', () => {
    expect(withoutHuddleStart('/workspaces/w-abc1/docs/d-abc1?thread=t-abc1')).toBe(
      '/workspaces/w-abc1/docs/d-abc1?thread=t-abc1',
    );
  });
});

describe('applyHuddleCrumb', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const crumb = () => {
    document.body.innerHTML =
      '<div class="doc-crumb"><a href="/" class="back-link">←</a><span class="doc-label">Editing:</span></div>';
    return document.querySelector('.doc-crumb .doc-label') as HTMLElement;
  };

  it('names the doc a huddle in the crumb, and takes it back for the next doc', () => {
    const label = crumb();
    applyHuddleCrumb(document, true);
    expect(label.textContent).toBe('Huddle');
    expect(label.classList.contains('doc-label-huddle')).toBe(true);
    // Navigation is in-place: the next doc must not inherit the word.
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Editing:');
    expect(label.classList.contains('doc-label-huddle')).toBe(false);
  });

  it('does nothing on a shell with no crumb', () => {
    document.body.innerHTML = '';
    expect(() => applyHuddleCrumb(document, true)).not.toThrow();
  });
});

/**
 * app.ts runs main() on import, so the mount that reads the flag is pinned by
 * source text (the same shape meeting-strip-css.test.ts uses for it).
 */
describe('the markdown mount honours the flag once', () => {
  const APP = readFileSync(resolve(import.meta.dirname, '../src/app.ts'), 'utf8');

  it('hands the strip an autoStart read from the address, then clears the flag', () => {
    const at = APP.indexOf('mountMeetingStrip({');
    expect(at, 'the strip mount went missing').toBeGreaterThan(0);
    const call = APP.slice(at, APP.indexOf('})', at));
    expect(call).toContain('autoStart:');
    expect(APP).toContain('wantsHuddleStart(location.search)');
    // A reload, or Back into this entry later, must not restart the mic.
    expect(APP).toContain('withoutHuddleStart(');
    expect(APP).toMatch(/history\.replaceState\([^)]*withoutHuddleStart/);
  });
});
