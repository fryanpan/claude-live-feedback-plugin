import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HUDDLE_MODE_PARAM,
  HUDDLE_START_PARAM,
  applyHuddleCrumb,
  applyReadingCrumb,
  huddleCaptureMode,
  resetReadingCrumbForTest,
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

describe('huddleCaptureMode', () => {
  it('is solo unless the Board said this one is a conversation', () => {
    expect(huddleCaptureMode(`?huddle=1&${HUDDLE_MODE_PARAM}=conversation`)).toBe('conversation');
    expect(huddleCaptureMode('?huddle=1&mode=solo')).toBe('solo');
    // Anything unreadable is solo, not a guess that spends: the mode buys
    // diarization, and the fallback should be the one that buys nothing.
    expect(huddleCaptureMode('?huddle=1&mode=room')).toBe('solo');
    expect(huddleCaptureMode('?huddle=1')).toBe('solo');
    expect(huddleCaptureMode('')).toBe('solo');
  });
});

describe('withoutHuddleStart', () => {
  it('drops the flag and keeps everything else in the address', () => {
    expect(withoutHuddleStart('/workspaces/w-abc1/docs/d-abc1?huddle=1&thread=t-abc1#x')).toBe(
      '/workspaces/w-abc1/docs/d-abc1?thread=t-abc1#x',
    );
    // The mode is the other half of the same one-shot gesture: left behind,
    // a reload would be a conversation nobody asked for.
    expect(
      withoutHuddleStart('/workspaces/w-abc1/docs/d-abc1?huddle=1&mode=conversation&thread=t-abc1'),
    ).toBe('/workspaces/w-abc1/docs/d-abc1?thread=t-abc1');
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
    resetReadingCrumbForTest();
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

  it('says Reading to a browser that may not write, and KEEPS saying it', () => {
    // The bug this is for: the crumb is rewritten unconditionally on every
    // in-place navigation, so setting the word once was undone by the next
    // one and the surface went back to announcing "Editing:" to somebody who
    // could not edit.
    const label = crumb();
    applyReadingCrumb(document);
    expect(label.textContent).toBe('Reading:');
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Reading:');
  });

  it('still names a huddle a huddle — that word is about the doc', () => {
    const label = crumb();
    applyReadingCrumb(document);
    applyHuddleCrumb(document, true);
    expect(label.textContent).toBe('Huddle');
    // And back to Reading, not to Editing, on the next ordinary doc.
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Reading:');
  });

  it('says Editing to everyone else', () => {
    // The control: without this, "Reading:" would also be what a signed-in
    // editor sees, which is the same bug pointing the other way.
    const label = crumb();
    applyHuddleCrumb(document, false);
    expect(label.textContent).toBe('Editing:');
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
    // And what it listens for, from the same address.
    expect(call).toContain('mode:');
    expect(APP).toContain('wantsHuddleStart(location.search)');
    expect(APP).toContain('huddleCaptureMode(location.search)');
    // A reload, or Back into this entry later, must not restart the mic.
    expect(APP).toContain('withoutHuddleStart(');
    expect(APP).toMatch(/history\.replaceState\([^)]*withoutHuddleStart/);
  });
});
