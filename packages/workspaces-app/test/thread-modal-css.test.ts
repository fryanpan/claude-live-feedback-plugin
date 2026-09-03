import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The long-thread modal's geometry, read off the cascade rather than out of
 * the stylesheet's text.
 *
 * The screen it was designed for is an iPad in landscape — 1180x820, roughly
 * 750px usable — and its scarce axis is HEIGHT, not width. A dialog that
 * grows with its content is exactly the failure the balloon column already
 * had: the reply box lands below the fold, and reaching it scrolls the
 * DOCUMENT, which moves the thing being reached for.
 *
 * So: a cap under the viewport, and the scroll inside the body. Both are
 * measured here at the two viewports the project verifies, with `vh`
 * substituted against each — which is what the old regex over
 * `max-height: min(84vh, 720px)` could not do, since which half of that pair
 * binds depends on the screen.
 *
 * WHAT THIS FILE LOST, and it is the headline: the modal's WIDTH. It is
 * `min(760px, calc(100vw - 64px))`, and happy-dom returns '' for any `width`
 * built from `min()`/`calc()`/`var()` — so "far wider than the 300px column
 * it replaces, and still fits 1180px" is no longer assertable here at all,
 * nor is the phone's fallback. `bun run ui:shot` owns it; the PR body says
 * so. Everything that follows is a cap or a flag, which happy-dom does
 * resolve.
 */

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order — `renderHubShell`, packages/server/src/
  // shells.ts loads hub.css BEFORE styles.css. tokens.css stays out: the
  // served sheet is the vendored Open Props subset concatenated with
  // src/tokens.css, and the mapping layer alone resolves to nothing.
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
});

/** The number a `min(a, b)` computed value settles on. happy-dom substitutes
 *  `vh` against the current viewport but leaves the comparison unevaluated. */
function px(value: string): number {
  const inner = /^min\((.*)\)$/.exec(value.trim());
  const terms = inner?.[1] ? inner[1].split(',') : [value];
  return Math.min(...terms.map((t) => Number.parseFloat(t)));
}

const modalAt = (viewport: { width: number; height: number }) => {
  setViewport(viewport);
  return styleOf(attach('thread-modal'));
};

describe('the modal is sized for the tablet tier', () => {
  it('exists as its own rule rather than borrowing the phone sheet', () => {
    setViewport(IPAD);
    expect(styleOf(attach('thread-modal')).maxHeight).not.toBe('');
    expect(styleOf(attach('thread-modal-body')).overflowY).not.toBe('');
  });

  it('caps its height against the viewport, not against its content', () => {
    // Roughly 750px is usable once browser chrome is taken off an 820px
    // viewport. The dialog has to finish inside that, with its own scroll.
    expect(px(modalAt(IPAD).maxHeight)).toBeLessThan(750);
    // …and the cap FOLLOWS the viewport rather than sitting at a constant: a
    // shorter screen gets a shorter dialog. That is the half of the pair a
    // 1180x820 measurement alone cannot see, because the px ceiling is the
    // one that binds there.
    const short = px(modalAt({ width: 1180, height: 600 }).maxHeight);
    expect(short).toBeLessThan(px(modalAt(IPAD).maxHeight));
    expect(short).toBeLessThanOrEqual(0.88 * 600);
  });

  it('a phone would still fit — the caller is not the only guard', () => {
    // The chrome refuses to open this below 1100px, but a rule whose only
    // protection is a caller is a rule one refactor away from overflowing.
    expect(px(modalAt(PHONE).maxHeight)).toBeLessThan(PHONE.height);
  });

  it('scrolls inside the body, so the document behind it never moves', () => {
    setViewport(IPAD);
    const body = styleOf(attach('thread-modal-body'));
    expect(body.overflowY).toBe('auto');
    expect(body.overscrollBehavior).toBe('contain');
    // Without this the flex item's content floor pushes the dialog past its
    // own max-height and the scrollbar ends up on the page instead.
    expect(Number.parseFloat(body.minHeight)).toBe(0);
  });

  it('sits above the scrim, and the scrim above everything else on the page', () => {
    setViewport(IPAD);
    const modal = Number(styleOf(attach('thread-modal')).zIndex);
    const scrim = Number(styleOf(attach('thread-modal-scrim')).zIndex);
    expect(modal).toBeGreaterThan(scrim);
    expect(scrim).toBeGreaterThan(1000);
  });

  it('lets the decision options use the width, which is why they came here', () => {
    setViewport(IPAD);
    const body = attach('thread-modal-body');
    const options = attach('thread-item-options', { parent: body });
    expect(styleOf(options).flexDirection).toBe('row');
    expect(styleOf(options).flexWrap).toBe('wrap');
    // The dialog is the one surface with no ceiling on the row: it is sized
    // for reading a decision rather than for sitting beside prose, which is
    // what the 560px cap on the base rule is for. Control below.
    expect(styleOf(options).maxWidth).toBe('none');
    expect(styleOf(attach('thread-item-options')).maxWidth).toBe('560px');
  });

  it('drops the card’s own frame — no border inside a bordered dialog', () => {
    setViewport(IPAD);
    const inside = styleOf(attach('thread', { parent: attach('thread-modal-body') }));
    expect(Number.parseFloat(inside.borderTopWidth)).toBe(0);
    expect(inside.cursor).toBe('default');
    // Control: the same card OUTSIDE the dialog keeps its frame and its
    // pointer, so the two values above are the descendant rule's doing.
    const outside = styleOf(attach('thread'));
    expect(Number.parseFloat(outside.borderTopWidth) || 0).toBeGreaterThan(0);
    expect(outside.cursor).not.toBe('default');
  });
});

describe('the modal hides the way the rest of the app hides', () => {
  it('is not on the list of elements that override display:none', () => {
    // `.hidden` is `display: none !important`; a handful of animated surfaces
    // undo that so their transition still renders. This one is not animated,
    // so if it ever joined that list it would sit invisible over the page —
    // and this now measures the cascade's verdict rather than the source
    // window after the `.hidden` rule.
    setViewport(IPAD);
    expect(styleOf(attach('thread-modal hidden')).display).toBe('none');
    // Control: an element that DOES override it reads differently in the same
    // pass, so `none` above is the absence of an override and not the absence
    // of the `.hidden` rule itself.
    expect(styleOf(attach('pointer-pill hidden')).display).toBe('inline-flex');
  });
});

/**
 * "The mic yields to an open card" is retired, and this is what replaced it.
 *
 * The mic used to stand down whenever a comment card opened at ≤1100px,
 * because it was a `position: fixed` launcher in the bottom-left corner and a
 * card at that width spans the screen — its reply box reached the same corner.
 * The mic is docked in the topbar now, where no card can reach it, so the
 * stand-down bought nothing and cost hold-to-talk while reading the comment
 * you want to answer.
 *
 * Asserted rather than deleted: a mitigation coming back would be silent, and
 * so would the dock quietly reverting to a float and leaving the reader with
 * neither the hide nor a mic out of the way.
 */
describe('the mic no longer stands down under an open card', () => {
  it('has no thread-card-open hide left anywhere', () => {
    setViewport(PHONE);
    const mic = attach('voice-mic', { tag: 'button' });
    const free = styleOf(mic).display;
    document.body.className = 'thread-card-open';
    expect(styleOf(mic).display).toBe(free);
    // Positive control: a rule keyed on that body class WOULD be visible to
    // this measurement — so the equality above is the rule's absence and not
    // the body class going unread.
    const probe = document.createElement('style');
    probe.textContent = 'body.thread-card-open .voice-mic { display: none !important; }';
    document.head.appendChild(probe);
    expect(styleOf(mic).display).toBe('none');
    probe.remove();
  });

  it('the doc surface has no hold-to-talk mic left at all', () => {
    // The reason the hide is safe to drop got stronger: the top-bar overhaul
    // retired the doc's hold-to-talk mic entirely (the Record Audio button
    // owns everything audio on that screen), so there is no doc mic for a
    // card to cover. The hub's docked mic (`.hub-nav-dock`) stays.
    setViewport(IPAD);
    const loose = styleOf(attach('voice-mic', { tag: 'button' })).position;
    expect(loose).toBe('fixed');
    // A mic under the retired doc dock is styled by nothing — it is still the
    // loose FAB, because `.doc-nav-dock` reaches it with no rule at all.
    const inDocDock = attach('voice-mic', {
      tag: 'button',
      parent: attach('doc-nav-dock'),
    });
    expect(styleOf(inDocDock).position).toBe('fixed');
    // Control: the hub's dock DOES take the mic out of the fixed layer, so the
    // line above is the absence of `.doc-nav-dock` rules and not of the sheet.
    const inHubDock = attach('voice-mic', {
      tag: 'button',
      parent: attach('hub-nav-dock'),
    });
    expect(styleOf(inHubDock).position).toBe('static');
  });
});
