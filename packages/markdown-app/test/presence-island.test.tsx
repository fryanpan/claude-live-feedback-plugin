/**
 * The presence strip as a Preact island — the circle cluster and the drift
 * notices that `renderPresence` used to rebuild from scratch on every paint.
 *
 * Three families of properties under test:
 *
 *  1. The island contract: an unchanged participant survives a signal update
 *     as the IDENTICAL node object, disposal is render(null, el), and the
 *     island owns a wrapper rather than the host.
 *
 *  2. The defect the migration exists for, in the form it takes HERE. A
 *     circle carries a 550ms long-press and the strip repaints under it — on
 *     awareness updates, on SSE agent refreshes, on a 30s tick. When the node
 *     was rebuilt mid-press, the `pointerup` meant to cancel the follow
 *     arrived on a replacement whose disarm closure knew nothing about the
 *     armed timer, and the follow fired anyway. Pinned below.
 *
 *  3. Behavior parity with the vanilla renderer: circles with initials, the
 *     four-slot clamp and its "+N", liveness classes, following, the
 *     long-form chip, and both drift notices. These are the renderPresence
 *     tests from hub-render.test.ts, re-aimed at the island.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DriftNotice,
  type PresenceChip,
  clientDriftNotice,
  pluginDriftNotice,
} from '../src/hub/hub-model.ts';
import {
  type PresenceHandlers,
  driftData,
  mountDriftIsland,
  mountPresenceIsland,
  presenceData,
} from '../src/hub/presence-island.tsx';

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Comfortably past the 550ms long-press threshold. */
const LONG_ENOUGH = 700;

const person = (name: string, over: Partial<PresenceChip> = {}): PresenceChip => ({
  key: `p-${name}`,
  label: name,
  kind: 'person',
  where: 'hub',
  title: `${name} · in hub · just now`,
  docId: 'doc-1',
  ...over,
});

const agent = (id: string, over: Partial<PresenceChip> = {}): PresenceChip => ({
  key: `a-${id}`,
  label: id,
  kind: 'agent',
  where: 'active',
  title: `${id} · active · last tool call just now`,
  state: 'active',
  ...over,
});

const noop = (): PresenceHandlers => ({ onTap: vi.fn(), onLongPress: vi.fn() });

let dispose: Array<() => void> = [];
afterEach(() => {
  for (const d of dispose) d();
  dispose = [];
  document.body.replaceChildren();
  vi.useRealTimers();
});

function mountPeople(
  chips: PresenceChip[],
  handlers: PresenceHandlers = noop(),
  opts: { compact?: boolean; followedKey?: string | null } = {},
) {
  const host = document.createElement('div');
  host.className = 'hub-presence hub-people';
  document.body.appendChild(host);
  presenceData.value = { chips, followedKey: opts.followedKey ?? null };
  dispose.push(mountPresenceIsland(host, handlers, { compact: opts.compact ?? true }));
  return { host, handlers };
}

function mountDrift(notices: Array<DriftNotice | null>) {
  const host = document.createElement('div');
  host.className = 'hub-presence';
  document.body.appendChild(host);
  driftData.value = notices;
  dispose.push(mountDriftIsland(host));
  return { host };
}

describe('presence island contract', () => {
  it('keeps an unchanged participant as the IDENTICAL node object when another changes', async () => {
    const { host } = mountPeople([person('Ana Reyes'), agent('task-list-ux')]);
    const circles = host.querySelectorAll('.hub-presence-circle');
    expect(circles).toHaveLength(2);
    const anasCircle = circles[0] as HTMLElement;

    // The agent's liveness moves — the commonest real update on this strip.
    presenceData.value = {
      chips: [
        person('Ana Reyes'),
        agent('task-list-ux', {
          state: 'unresponsive',
          title: 'task-list-ux · process up, agent unresponsive · last tool call 40m ago',
        }),
      ],
      followedKey: null,
    };
    await tick();

    const after = host.querySelectorAll('.hub-presence-circle');
    expect(after[1]?.classList.contains('hub-presence-unresponsive')).toBe(true);
    // The identity property the migration exists for: same object, not a
    // recreated equal.
    expect(after[0]).toBe(anasCircle);
  });

  it('keeps the node when only the person’s own reading changes', async () => {
    // The 30s tick rewrites every title ("just now" → "40s ago") and nothing
    // else. Under the vanilla renderer that alone rebuilt the whole strip.
    const { host } = mountPeople([person('Ana Reyes'), person('Ben Ito')]);
    const [a, b] = [...host.querySelectorAll('.hub-presence-circle')];

    presenceData.value = {
      chips: [
        person('Ana Reyes', { title: 'Ana Reyes · in hub · 40s ago' }),
        person('Ben Ito', { title: 'Ben Ito · in hub · 40s ago' }),
      ],
      followedKey: null,
    };
    await tick();

    const after = host.querySelectorAll('.hub-presence-circle');
    expect(after[0]).toBe(a);
    expect(after[1]).toBe(b);
    expect(after[0]?.getAttribute('title')).toBe('Ana Reyes · in hub · 40s ago');
  });

  it('a focused circle keeps focus across a signal update', async () => {
    const { host } = mountPeople([person('Ana Reyes'), person('Ben Ito')]);
    const ben = host.querySelectorAll('.hub-presence-circle')[1] as HTMLButtonElement;
    ben.focus();
    expect(document.activeElement).toBe(ben);

    presenceData.value = {
      chips: [person('Ana Reyes', { title: 'Ana Reyes · in doc-2 · just now' }), person('Ben Ito')],
      followedKey: null,
    };
    await tick();
    expect(document.activeElement).toBe(ben);
  });

  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.appendChild(host);

    presenceData.value = { chips: [person('Ana Reyes')], followedKey: null };
    const unmount = mountPresenceIsland(host, noop(), { compact: true });

    const wrapper = host.querySelector('[data-preact-island="presence"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-presence-circle')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // render(null, el) ran before el.remove(): teardown, not bare removal.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="presence"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so circles stay direct flex items', () => {
    // happy-dom does no layout, so this is pinned at the rule level: without
    // `display: contents` the whole strip becomes ONE flex item and the
    // 430px fit, the gap and `.hub-drift`'s own-line rule all stop applying.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-presence\s*>\s*\[data-preact-island\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display'); // positive control: found the rule
    expect(rule).toMatch(/display:\s*contents/);
  });
});

describe('presence island — a repaint under a live press', () => {
  it('does not fire the follow when the press was released across a repaint', async () => {
    // THE defect, in the form it took here. Vanilla rebuilt every circle on
    // every paint, so a repaint between pointerdown and pointerup left the
    // armed timer pointing at a node the reader was no longer touching: the
    // pointerup landed on the REPLACEMENT, whose disarm closure knew nothing
    // about the running timer, and the follow fired on a released press.
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Ana Reyes'), person('Ben Ito')], handlers);
    const ana = host.querySelectorAll('.hub-presence-circle')[0] as HTMLButtonElement;

    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(200);

    // A 30s tick / awareness update lands mid-press.
    presenceData.value = {
      chips: [person('Ana Reyes'), person('Ben Ito', { title: 'Ben Ito · in doc-9 · just now' })],
      followedKey: null,
    };
    await vi.advanceTimersByTimeAsync(0);

    // The release goes to whatever node is under the finger NOW — which is
    // the whole point: it must be the same node that armed the timer. (Asking
    // the DOM rather than reusing `ana` is what makes this a regression test;
    // dispatching on the captured reference would pass even against a
    // renderer that had replaced the node the reader is touching.)
    const underTheFinger = host.querySelectorAll('.hub-presence-circle')[0] as HTMLButtonElement;
    expect(underTheFinger).toBe(ana);
    underTheFinger.dispatchEvent(new Event('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(LONG_ENOUGH);
    expect(handlers.onLongPress).not.toHaveBeenCalled();
  });

  it('still follows when the press is genuinely held through a repaint', async () => {
    // The positive control for the case above: the repaint must not swallow
    // a real long-press either.
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Ana Reyes')], handlers);
    const ana = host.querySelector('.hub-presence-circle') as HTMLButtonElement;

    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    presenceData.value = {
      chips: [person('Ana Reyes', { title: 'Ana Reyes · in hub · 40s ago' })],
      followedKey: null,
    };
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(LONG_ENOUGH);

    expect(handlers.onLongPress).toHaveBeenCalledTimes(1);
    // …and the click that follows a completed long-press must not ALSO jump.
    ana.dispatchEvent(new Event('click', { bubbles: true }));
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('a cancelled press disarms — one scroll must not wedge the strip', () => {
    vi.useFakeTimers();
    const handlers = noop();
    const { host } = mountPeople([person('Ana Reyes')], handlers);
    const ana = host.querySelector('.hub-presence-circle') as HTMLButtonElement;
    ana.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    ana.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    vi.advanceTimersByTime(LONG_ENOUGH);
    expect(handlers.onLongPress).not.toHaveBeenCalled();
  });
});

describe('presence island — compact circle mode (the top-right cluster)', () => {
  it('renders circles with initials, keeping the full detail in title and aria-label', () => {
    const { host } = mountPeople([person('Ana Reyes'), agent('task-list-ux')]);
    const circles = host.querySelectorAll('.hub-presence-circle');
    expect(circles.length).toBe(2);
    // No long-form chip anywhere in compact mode…
    expect(host.querySelector('.hub-presence-chip')).toBeNull();
    const [p, a] = [...circles];
    expect(p?.querySelector('.hub-presence-initials')?.textContent).toBe('AR');
    expect(p?.getAttribute('title')).toBe('Ana Reyes · in hub · just now');
    expect(p?.getAttribute('aria-label')).toBe('Ana Reyes · in hub · just now');
    // …and the agent circle keeps the kind class the styling keys off.
    expect(a?.classList.contains('hub-presence-agent')).toBe(true);
    expect(a?.querySelector('.hub-presence-initials')?.textContent).toBe('TL');
  });

  it('renders the long form when compact is off — the name and the surface, spelled out', () => {
    // Positive control for the assertion above: the same chip, long-form.
    const { host } = mountPeople([person('Ana Reyes')], noop(), { compact: false });
    const chip = host.querySelector('.hub-presence-chip');
    expect(chip?.textContent).toContain('Ana Reyes');
    expect(chip?.querySelector('.hub-presence-where')?.textContent).toBe('hub');
    // The name is visible here, so it is not repeated into an aria-label.
    expect(chip?.getAttribute('aria-label')).toBeNull();
    expect(host.querySelector('.hub-presence-circle')).toBeNull();
  });

  it('keeps tap, liveness state, and following on a circle', () => {
    const chip = agent('quill', { state: 'unresponsive' });
    const handlers = noop();
    const { host } = mountPeople([chip], handlers, { followedKey: chip.key });
    const el = host.querySelector<HTMLButtonElement>('.hub-presence-circle');
    expect(el?.classList.contains('hub-presence-unresponsive')).toBe(true);
    expect(el?.classList.contains('hub-following')).toBe(true);
    expect(el?.getAttribute('title')).toContain('following — long-press to stop');
    el?.click();
    expect(handlers.onTap).toHaveBeenCalledWith(chip);
  });

  it('clamps at four: five people render as three circles plus a "+2" that names the rest', () => {
    const chips = ['Ana', 'Ben', 'Cam', 'Dee', 'Eli'].map((n) => person(n));
    const handlers = noop();
    const overflowed: PresenceChip[][] = [];
    const { host } = mountPeople(chips, { ...handlers, onOverflow: (h) => overflowed.push(h) });
    expect(host.querySelectorAll('.hub-presence-circle').length).toBe(4); // 3 + the slot
    const more = host.querySelector<HTMLButtonElement>('.hub-presence-more');
    expect(more?.textContent).toBe('+2');
    expect(more?.getAttribute('title')).toBe('Dee, Eli');
    expect(more?.getAttribute('aria-label')).toBe('2 more: Dee, Eli');
    more?.click();
    expect(overflowed).toEqual([[chips[3], chips[4]]]);
  });

  it('exactly four renders four circles and no overflow slot — the cap is a footprint', () => {
    const { host } = mountPeople(['Ana', 'Ben', 'Cam', 'Dee'].map((n) => person(n)));
    expect(host.querySelectorAll('.hub-presence-circle').length).toBe(4);
    expect(host.querySelector('.hub-presence-more')).toBeNull();
  });

  it('hides the host when nobody is here, and unhides when somebody arrives', async () => {
    const { host } = mountPeople([]);
    expect(host.classList.contains('hidden')).toBe(true);

    presenceData.value = { chips: [person('Ana Reyes')], followedKey: null };
    await tick();
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelectorAll('.hub-presence-circle').length).toBe(1);
  });
});

describe('presence island — plugin drift', () => {
  const drift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the notice even when nobody is present to draw a chip for', () => {
    // An away session draws no chip, and an away session is exactly the one
    // most likely to be stranded on an old bundle. Hiding the region on
    // "no chips" would hide the drift with it.
    const { host } = mountDrift([drift()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.hub-drift');
    expect(note?.textContent).toContain('older plugin than 0.1.26');
    expect(note?.textContent).toContain('agent-quill 0.1.12');
    expect(note?.textContent).toContain(
      'command claude plugin update claude-workspaces@claude-workspaces',
    );
  });

  it('renders nothing when there is no notice at all', async () => {
    // Positive control: the same island WITH a notice puts a .hub-drift in,
    // so this absence means the notice is what drives it.
    const { host } = mountDrift([drift()]);
    expect(host.querySelector('.hub-drift')).not.toBeNull();

    driftData.value = [null];
    await tick();
    expect(host.querySelector('.hub-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('renders the clear reading quietly, and the alarm loudly', async () => {
    // A coverage line is on the board permanently. If it wore the alarm's
    // styling it would teach everyone to skim past the alarm — so the class
    // has to differ, and both halves are asserted in the same pass so
    // neither is a claim about a world the other does not inhabit.
    const { host } = mountDrift([pluginDriftNotice({ version: '0.1.40', behind: [], checked: 1 })]);
    const quiet = host.querySelector('.hub-drift');
    expect(quiet?.classList.contains('hub-drift-quiet')).toBe(true);
    expect(quiet?.textContent).toContain('No attached session is behind 0.1.40 (1 checked)');
    expect(quiet?.textContent).toContain('a peer that never attached is absent here');

    driftData.value = [drift()];
    await tick();
    expect(host.querySelector('.hub-drift')?.classList.contains('hub-drift-quiet')).toBe(false);
  });

  it('a board nobody has attached to does not render as all-clear', () => {
    // The defect, in the surface: an empty `behind` list used to render as
    // nothing, and nothing reads exactly like clearance.
    const { host } = mountDrift([pluginDriftNotice({ version: '0.1.40', behind: [], checked: 0 })]);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.hub-drift')?.textContent).toContain(
      'no session has attached to this board',
    );
  });
});

describe('presence island — client release drift', () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const stale = () =>
    clientDriftNotice(
      {
        releaseId: '20260813T014455123Z-000003',
        publishedAt: now - 72 * 60 * 60 * 1000,
        ageMs: 72 * 60 * 60 * 1000,
        sourceRef: 'a1b2c3d',
        consecutiveFailures: 2,
        failingSince: now - 10 * 60 * 60 * 1000,
        lastError: 'client release: markdownApp bundle is incomplete — app.js missing',
        stale: true,
      },
      now,
    );
  const pluginDrift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the stale-client notice on a board with nobody present', () => {
    // Nobody being present is not a reason to hide it — it is about every
    // browser that loads this board, including the one reading it now.
    const { host } = mountDrift([stale()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.hub-drift');
    expect(note?.textContent).toContain('3d ago');
    expect(note?.textContent).toContain('app.js missing');
    expect(note?.textContent).toContain('restart');
  });

  it('shows both drifts at once — they are different problems', () => {
    // The agents being behind on the plugin and the browser being behind on
    // the client are independent failures with different fixes; one must not
    // hide the other.
    const { host } = mountDrift([pluginDrift(), stale()]);
    const notes = [...host.querySelectorAll('.hub-drift')];
    expect(notes.length).toBe(2);
    expect(notes[0]?.textContent).toContain('older plugin than 0.1.26');
    expect(notes[1]?.textContent).toContain('published 3d ago');
  });

  it('a slot going quiet leaves the other notice’s node alone', async () => {
    // Notices are keyed on their SLOT — 0 is always the plugin reading and 1
    // always the client's — so a fixed plugin does not rebuild the client
    // note sitting beside it.
    const { host } = mountDrift([pluginDrift(), stale()]);
    const clientNote = host.querySelectorAll('.hub-drift')[1] as HTMLElement;

    driftData.value = [null, stale()];
    await tick();
    const after = host.querySelectorAll('.hub-drift');
    expect(after.length).toBe(1);
    expect(after[0]).toBe(clientNote);
  });

  it('draws nothing when neither drift is real', async () => {
    // Positive control first, so the absence below means something.
    const { host } = mountDrift([stale()]);
    expect(host.querySelector('.hub-drift')).not.toBeNull();

    driftData.value = [null, null];
    await tick();
    expect(host.querySelector('.hub-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });
});
