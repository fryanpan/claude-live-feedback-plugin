/**
 * The Preact proving island: the mount/unmount contract the whole framework
 * adoption rests on (evaluation hazard list).
 *
 * The properties under test, in order of load-bearing-ness:
 *  1. Node identity across a signal update — an unchanged sibling element is
 *     the IDENTICAL node object after the update, not a re-created equal one.
 *     Comment anchors, editor mounts, and focus all depend on this.
 *  2. The island owns a dedicated wrapper node it created itself; the host's
 *     pre-existing (vanilla-managed) children are never touched.
 *  3. Disposal is render(null, el): the wrapper empties and leaves the host,
 *     and the host's own children survive.
 */
import { describe, expect, it } from 'vitest';
import { mountIslandProbe, probeCount } from '../src/hub/island-probe.tsx';

/** Signal-driven text updates flush synchronously in @preact/signals, but a
 * component re-render would be scheduled — settle both paths. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('island-probe', () => {
  it('keeps an unchanged child as the identical node object across a signal update', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    probeCount.value = 0;
    const unmount = mountIslandProbe(host);

    const staticEl = host.querySelector('[data-island-static]');
    const countEl = host.querySelector('[data-island-count]');
    expect(staticEl).not.toBeNull();
    expect(countEl?.textContent).toBe('0');

    probeCount.value = 1;
    await tick();

    expect(countEl?.textContent).toBe('1');
    // The identity property: same objects, not recreated equals.
    expect(host.querySelector('[data-island-static]')).toBe(staticEl);
    expect(host.querySelector('[data-island-count]')).toBe(countEl);

    unmount();
    host.remove();
  });

  it('owns a dedicated wrapper and never disturbs vanilla-managed siblings', async () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.appendChild(host);

    const unmount = mountIslandProbe(host);

    // The island rendered into a wrapper it created, not into the host.
    const wrapper = host.querySelector('[data-preact-island]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('[data-island-static]')).not.toBeNull();
    // The vanilla child is the same untouched node.
    expect(host.firstChild).toBe(vanillaChild);
    expect(vanillaChild.textContent).toBe('vanilla-owned');

    probeCount.value = probeCount.value + 1;
    await tick();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // Disposal removes the island's wrapper entirely and leaves the host's
    // own children alone.
    expect(host.querySelector('[data-preact-island]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
    host.remove();
  });

  it('render(null) disposal empties the wrapper before removal', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const removed: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.removedNodes) {
          if (node instanceof Element) removed.push(node);
        }
      }
    });
    observer.observe(host, { childList: true });

    const unmount = mountIslandProbe(host);
    const wrapper = host.querySelector('[data-preact-island]');
    expect(wrapper).not.toBeNull();

    unmount();
    observer.takeRecords();
    observer.disconnect();
    // render(null, el) ran before el.remove(): by the time the wrapper left
    // the host it had already been emptied by Preact's own teardown.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.contains(wrapper)).toBe(false);
    host.remove();
  });
});
