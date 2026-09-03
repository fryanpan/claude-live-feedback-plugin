/**
 * The Preact proving island — the first .tsx in the app, deliberately tiny
 * and invisible. It exists to hold the mount/unmount contract every later
 * island follows (from the framework evaluation's hazard list):
 *
 *  - the island OWNS a dedicated wrapper node it creates itself. It never
 *    renders into an element vanilla code also writes to — Preact assumes it
 *    owns every child of its container, and a vanilla innerHTML pass over a
 *    live island corrupts the vdom's view of the DOM.
 *  - disposal is render(null, el) — that runs effect/ref teardown; plain
 *    node removal would not.
 *  - vanilla code must never wipe a container HOLDING a live island; the
 *    unmount function returned here is the only correct way out.
 *
 * The wrapper is hidden: mounted in the real hub shell so the contract runs
 * in production, without taking over any real pane yet.
 */
import { signal } from '@preact/signals';
import { render } from 'preact';

/** Module-level so tests (and the console) can drive an update through the
 * signal graph rather than a re-mount. */
export const probeCount = signal(0);

function IslandProbe() {
  // The count span's child is the SIGNAL itself, not `.value`: signals
  // rendered as JSX children bind the text node directly, so an update
  // rewrites that one text node and no element is re-created — the node
  // identity property the whole migration rests on.
  return (
    <div data-island-root>
      <span data-island-static>preact-island-probe</span>
      <span data-island-count>{probeCount}</span>
    </div>
  );
}

/**
 * Mounts the probe into a wrapper it appends to `host`; returns the
 * disposer. The wrapper — not the host — is Preact's container, so the
 * host's other children stay vanilla-owned.
 */
export function mountIslandProbe(host: HTMLElement): () => void {
  const el = document.createElement('div');
  el.hidden = true;
  el.setAttribute('data-preact-island', 'probe');
  host.appendChild(el);
  render(<IslandProbe />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
