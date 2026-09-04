/**
 * The float dock (src/float-dock.ts) and its stylesheet: the ROW pins to the
 * pane and the floats sit in it. Two things that would regress silently:
 *
 *  1. a float that positions itself again (`position: absolute` on
 *     `.plan-float`) would stack both buttons on the pane's centre;
 *  2. the Review float's `hidden` must still win the cascade — the same trap
 *     plan-gate-hidden-css.test.ts guards for Make Plan, now on a second
 *     element that shares the class.
 *
 * Real cascade reads against the injected sheet; happy-dom does no layout
 * but resolves `display` and `position`, which is all this needs.
 */
import type { User } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountReviewFloat } from '../src/review-float.ts';
import { installSheets } from './css-harness.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

let root: HTMLElement;
let removeSheets = () => {};
beforeEach(() => {
  removeSheets = installSheets('styles.css', 'doc.css');
  root = document.createElement('div');
  document.body.replaceChildren(root);
});
afterEach(() => {
  removeSheets();
});

function mount(meta: { huddle?: boolean }, canWrite: boolean) {
  return mountReviewFloat({
    docId: 'd-css',
    root,
    user: JORDAN,
    canWrite,
    fetchJson: () => Promise.resolve({ meta }),
  });
}

describe('the float dock', () => {
  it('the dock is the positioned row; a float inside it does not position itself', async () => {
    const float = mount({ huddle: true }, true);
    await float.ready;
    const dock = document.querySelector<HTMLElement>('.doc-floats');
    const btn = document.querySelector<HTMLElement>('.review-float');
    expect(dock && btn && dock.contains(btn)).toBe(true);
    expect(getComputedStyle(dock!).position).toBe('absolute');
    expect(getComputedStyle(dock!).display).toBe('flex');
    expect(getComputedStyle(btn!).position).not.toBe('absolute');
    expect(getComputedStyle(btn!).display).toBe('inline-flex');
    float.destroy();
  });

  it('an ordinary doc does not DISPLAY the Review float, not merely flag it hidden', async () => {
    const float = mount({}, true);
    await float.ready;
    const btn = document.querySelector<HTMLElement>('.review-float');
    expect(btn?.hidden).toBe(true);
    expect(getComputedStyle(btn!).display).toBe('none');
    float.destroy();
  });

  it('positive control: the cascade can see the sheet — an unguarded rule out-specifies [hidden]', () => {
    const probe = document.createElement('style');
    probe.textContent = '.float-dock-css-probe { display: inline-flex; }';
    document.head.appendChild(probe);
    const el = document.createElement('button');
    el.className = 'float-dock-css-probe';
    el.hidden = true;
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('inline-flex');
    probe.remove();
    el.remove();
  });
});
