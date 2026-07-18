import { describe, expect, it, vi } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';

describe('MountScope', () => {
  it('aborts its signal on dispose', () => {
    const s = new MountScope();
    expect(s.signal.aborted).toBe(false);
    s.dispose();
    expect(s.signal.aborted).toBe(true);
    expect(s.disposed).toBe(true);
  });

  it('runs cleanups in LIFO order', () => {
    const s = new MountScope();
    const order: number[] = [];
    s.onCleanup(() => order.push(1));
    s.onCleanup(() => order.push(2));
    s.dispose();
    expect(order).toEqual([2, 1]);
  });

  it('is idempotent — a second dispose runs nothing again', () => {
    const s = new MountScope();
    const fn = vi.fn();
    s.onCleanup(fn);
    s.dispose();
    s.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs a cleanup immediately if registered after dispose', () => {
    // A late async callback that registers teardown must not leak.
    const s = new MountScope();
    s.dispose();
    const fn = vi.fn();
    s.onCleanup(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('removes a listener registered via listen() on dispose', () => {
    const s = new MountScope();
    const el = document.createElement('div');
    const fn = vi.fn();
    s.listen(el, 'click', fn);
    el.dispatchEvent(new Event('click'));
    expect(fn).toHaveBeenCalledTimes(1);
    s.dispose();
    el.dispatchEvent(new Event('click'));
    expect(fn).toHaveBeenCalledTimes(1); // no new call
  });

  it('listen() is a no-op after dispose', () => {
    const s = new MountScope();
    s.dispose();
    const el = document.createElement('div');
    const fn = vi.fn();
    s.listen(el, 'click', fn);
    el.dispatchEvent(new Event('click'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('exposes an AbortSignal that aborts on dispose (for fetch/lib use)', () => {
    const s = new MountScope();
    expect(s.signal.aborted).toBe(false);
    s.dispose();
    expect(s.signal.aborted).toBe(true);
  });

  it('keeps running later cleanups even if one throws', () => {
    const s = new MountScope();
    const after = vi.fn();
    s.onCleanup(() => after());
    s.onCleanup(() => {
      throw new Error('boom');
    });
    expect(() => s.dispose()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
