import { describe, expect, it } from 'vitest';
import { IOS_ACCESSORY, keyboardInset, wireKeyboardInset } from '../src/keyboard-inset.ts';

/**
 * The bottom inset the on-screen keyboard takes, as a number anything docked
 * to the bottom of the window can be lifted by.
 *
 * It lived inside `app.ts` as a private function, which is why the HUB never
 * had it: the board, Home and the task panel are a different entry point, and
 * a fix written into the doc app's setup reaches none of them. Extracted so
 * both entries can call the same wiring, and so the arithmetic — the part
 * that is wrong in a way no rendering test would catch — can be asserted
 * directly.
 */
describe('the keyboard inset', () => {
  it('is zero when the browser reports no visual viewport', () => {
    expect(keyboardInset(820, null)).toBe(0);
  });

  it('is zero while the visual viewport still fills the window', () => {
    expect(keyboardInset(820, { height: 820, offsetTop: 0 })).toBe(0);
  });

  it('adds the iOS form-accessory bar on top of the keyboard itself', () => {
    // visualViewport.height excludes the keyboard but NOT the ^ v Done bar
    // iOS floats above it, so a control lifted by the raw difference still
    // sits under that bar.
    expect(keyboardInset(820, { height: 500, offsetTop: 0 })).toBe(320 + IOS_ACCESSORY);
  });

  it('counts a viewport that was scrolled up out of the window', () => {
    expect(keyboardInset(820, { height: 500, offsetTop: 20 })).toBe(300 + IOS_ACCESSORY);
  });

  it('never goes negative when the viewport reports taller than the window', () => {
    expect(keyboardInset(820, { height: 900, offsetTop: 0 })).toBe(0);
  });

  it('publishes what it computed as --kb-bottom, so CSS can read it', () => {
    (window as unknown as { visualViewport: unknown }).visualViewport = {
      height: 500,
      offsetTop: 0,
      addEventListener: () => {},
    };
    Object.defineProperty(window, 'innerHeight', { value: 820, configurable: true });
    wireKeyboardInset();
    expect(document.documentElement.style.getPropertyValue('--kb-bottom')).toBe(
      `${320 + IOS_ACCESSORY}px`,
    );
  });
});
