import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireEditViewport } from '../src/edit-viewport.ts';

/**
 * The wiring's LIFECYCLE. What it measures needs a browser and is verified in
 * one; what a test can hold it to is that it does not accumulate listeners on
 * a viewport that outlives every document.
 *
 * Found by review, not by a failure: each focus change armed a
 * `visualViewport` resize listener that only detached from inside its own
 * callback, so a focus change superseded before its 500ms settle left its
 * closure attached — over a torn-down editor, once the mount had gone.
 */

interface Stub {
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
  count: () => number;
  fire: (type: string) => void;
  /** Raise (px > 0) or drop (0) the on-screen keyboard, as the browser would:
   *  the visual viewport shrinks and announces it. */
  keyboard: (px: number) => void;
}

function installViewport(height: number): Stub {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const vv = {
    height,
    offsetTop: 0,
    addEventListener(type: string, h: EventListenerOrEventListenerObject) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(h);
    },
    removeEventListener(type: string, h: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(h);
    },
  };
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  const fire = (type: string) => {
    for (const h of Array.from(listeners.get(type) ?? []))
      typeof h === 'function' ? h(new Event(type)) : h.handleEvent(new Event(type));
  };
  return {
    listeners,
    count: () => listeners.get('resize')?.size ?? 0,
    fire,
    keyboard: (px) => {
      vv.height = window.innerHeight - px;
      fire('resize');
    },
  };
}

/** Phone width, so `(max-width: 720px)` matches — the yield is gated on it and
 *  a test at the default 1024px would exercise nothing. */
function narrowViewport(): void {
  const hd = (window as unknown as { happyDOM?: { setViewport(v: { width: number }): void } })
    .happyDOM;
  if (hd?.setViewport) hd.setViewport({ width: 430 });
  else Object.defineProperty(window, 'innerWidth', { value: 430, configurable: true });
}

function mount() {
  document.body.innerHTML = `
    <div id="editor" style="overflow:auto"><div id="prose"></div></div>
    <div id="meeting-strip"></div>`;
  const editorEl = document.getElementById('editor') as HTMLElement;
  const prose = document.getElementById('prose') as HTMLElement;
  // happy-dom does not derive isContentEditable from the attribute.
  Object.defineProperty(prose, 'isContentEditable', { value: true });
  prose.tabIndex = 0;
  const cleanups: Array<() => void> = [];
  const off: Array<() => void> = [];
  const api = wireEditViewport({
    roots: () => [editorEl],
    scroller: () => editorEl,
    strip: () => document.getElementById('meeting-strip'),
    caretRect: () => ({ top: 10, bottom: 30 }),
    listen: (t, type, h, o) => {
      t.addEventListener(type, h, o);
      off.push(() => t.removeEventListener(type, h, o));
    },
    onCleanup: (fn) => cleanups.push(fn),
  });
  return {
    api,
    prose,
    dispose: () => {
      for (let i = cleanups.length - 1; i >= 0; i--) cleanups[i]();
      for (const f of off) f();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete document.body.dataset.editViewport;
});

describe('wireEditViewport lifecycle', () => {
  it('arms at most one keyboard-settle listener however fast focus moves', async () => {
    vi.useFakeTimers();
    narrowViewport();
    const vp = installViewport(window.innerHeight);
    const m = mount();
    const base = vp.count(); // the always-on resize listener
    for (let i = 0; i < 5; i++) {
      m.prose.blur();
      m.prose.focus();
      await vi.advanceTimersByTimeAsync(1);
    }
    // The positive control: focus really did land in the editor, so a settle
    // listener really was armed. Without it a count of `base` would pass this
    // for the wrong reason.
    expect(document.activeElement).toBe(m.prose);
    expect(vp.count()).toBe(base + 1);
    m.dispose();
  });

  it('detaches the pending settle listener when the mount goes away', async () => {
    vi.useFakeTimers();
    narrowViewport();
    const vp = installViewport(window.innerHeight);
    const m = mount();
    m.prose.focus();
    await vi.advanceTimersByTimeAsync(1);
    expect(vp.count(), 'nothing was armed, so this proves nothing').toBe(2);
    m.dispose();
    expect(vp.count()).toBe(0);
    // Nothing left that a later resize could call against a dead mount.
    expect(() => vp.fire('resize')).not.toThrow();
  });

  it('gives the strip its row back when the keyboard goes down under kept focus', async () => {
    // iOS "Done" on the form-accessory bar dismisses the keyboard and can
    // LEAVE FOCUS on the field. Keying the yield on focus alone stranded the
    // strip hidden with no keyboard on screen and the whole editor height
    // free — and Start is the only way into a meeting, so it was unreachable
    // until the reviewer thought to tap outside the document.
    vi.useFakeTimers();
    narrowViewport();
    const vp = installViewport(window.innerHeight);
    const m = mount();
    m.prose.focus();
    vp.keyboard(336);
    await vi.advanceTimersByTimeAsync(600);
    // The positive control: it really did yield first.
    expect(document.body.dataset.editViewport).toBe('hidden');

    vp.keyboard(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(document.activeElement, 'focus must be RETAINED for this case').toBe(m.prose);
    expect(document.body.dataset.editViewport).toBeUndefined();
    m.dispose();
  });

  it('yields again when the keyboard comes back with focus never lost', async () => {
    vi.useFakeTimers();
    narrowViewport();
    const vp = installViewport(window.innerHeight);
    const m = mount();
    m.prose.focus();
    vp.keyboard(336);
    await vi.advanceTimersByTimeAsync(600);
    vp.keyboard(0);
    await vi.advanceTimersByTimeAsync(600);
    vp.keyboard(336);
    await vi.advanceTimersByTimeAsync(600);
    expect(document.body.dataset.editViewport).toBe('hidden');
    m.dispose();
  });

  it('publishes no mode on cleanup, so the next document keeps its strip', async () => {
    vi.useFakeTimers();
    narrowViewport();
    installViewport(window.innerHeight);
    const m = mount();
    document.body.dataset.editViewport = 'hidden';
    m.dispose();
    expect(document.body.dataset.editViewport).toBeUndefined();
  });
});
