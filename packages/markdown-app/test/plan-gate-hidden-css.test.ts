/**
 * "There should not be an Approve Plan button in all docs — only in docs
 * that are plans." (Bryan, 2026-08-31)
 *
 * src/plan-gate.ts mounts the float on EVERY doc page and toggles
 * `approve.hidden`; on prod 0 of 588 docs carried a planState, yet the
 * button showed on all of them. The cause is the cascade, not the toggle:
 * `.plan-approve-float { display: inline-flex }` (class, specificity 0-1-0)
 * out-specifies the UA sheet's `[hidden] { display: none }`, so the `hidden`
 * attribute the code sets does nothing. `.plan-gate-error[hidden]` and
 * `.meeting-strip[hidden]` in the same stylesheet already guard against this
 * exact trap; the float did not.
 *
 * These are REAL cascade reads — happy-dom does no layout, but it runs the
 * cascade against an injected `<style>` and resolves `display`, which is all
 * this needs. The button is mounted through the real `mountPlanGate` against
 * the injected fetch seam, so the assertion sees the element the code
 * produces, not a hand-built stand-in. Nothing here greps the CSS source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { User } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountPlanGate } from '../src/plan-gate.ts';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };

let root: HTMLElement;
let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = CSS;
  document.head.appendChild(sheet);
  root = document.createElement('div');
  document.body.replaceChildren(root);
});
afterEach(() => {
  sheet.remove();
});

function mount(meta: { planState?: string }, canWrite: boolean) {
  return mountPlanGate({
    docId: 'd-css',
    root,
    user: JORDAN,
    canWrite,
    fetchJson: () => Promise.resolve({ meta, tasks: [] }),
  });
}

function floatDisplay(): string {
  const btn = document.querySelector<HTMLButtonElement>('.plan-approve-float');
  if (!btn) throw new Error('float not mounted');
  return getComputedStyle(btn).display;
}

describe('the Approve Plan float is actually invisible when hidden', () => {
  it('an ordinary doc (no planState) does not DISPLAY the button, not merely flag it hidden', async () => {
    const gate = mount({}, true);
    await gate.ready;
    expect(document.querySelector<HTMLElement>('.plan-approve-float')?.hidden).toBe(true);
    expect(floatDisplay()).toBe('none');
    gate.destroy();
  });

  it('a reader on a pending plan does not display it either', async () => {
    const gate = mount({ planState: 'pending' }, false);
    await gate.ready;
    expect(floatDisplay()).toBe('none');
    gate.destroy();
  });

  it('positive control: a writer on a pending plan DOES see it displayed', async () => {
    // Without this the test above could pass because the stylesheet failed
    // to attach at all (display would read '' or 'none' for every element).
    const gate = mount({ planState: 'pending' }, true);
    await gate.ready;
    expect(floatDisplay()).toBe('inline-flex');
    gate.destroy();
  });

  it('positive control: the cascade can see the sheet — an unguarded rule out-specifies [hidden]', () => {
    // Reproduces the defect through the same measurement: a class with a
    // bare `display` and no `[hidden]` guard stays displayed despite the
    // attribute. If happy-dom ever started applying UA `[hidden]` over an
    // author rule, this control fails and the assertions above are known to
    // prove nothing.
    const probe = document.createElement('style');
    probe.textContent = '.plan-gate-css-probe { display: inline-flex; }';
    document.head.appendChild(probe);
    const el = document.createElement('button');
    el.className = 'plan-gate-css-probe';
    el.hidden = true;
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('inline-flex');
    probe.remove();
    el.remove();
  });
});
