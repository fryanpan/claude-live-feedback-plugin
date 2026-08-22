/**
 * The settings row that turns notifications on for this device.
 *
 * The behaviour worth pinning is what it says when it CANNOT be turned on —
 * unsupported browser, insecure origin, permission already denied. Those are
 * three different problems with one symptom ("the switch does nothing"), and
 * the row is the only place a person finds out which one they have.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPushToggle } from '../src/hub/push-toggle.ts';

const AUTHOR = { id: 'u-bryan', name: 'Bryan' };

function dom() {
  document.body.innerHTML = `
    <label class="hub-settings-row hub-settings-row--push" for="hub-push-toggle">
      <span class="hub-settings-label">Notify me on this device
        <small id="hub-push-note" class="hub-settings-note"></small>
      </span>
      <input type="checkbox" id="hub-push-toggle" class="hub-check" />
    </label>`;
  return {
    toggle: document.getElementById('hub-push-toggle') as HTMLInputElement,
    note: document.getElementById('hub-push-note') as HTMLElement,
  };
}

const SUPPORTED = {
  supported: true,
  available: true,
  permission: 'default' as const,
  enabled: false,
};

function mount(
  overrides: {
    status?: unknown;
    enable?: ReturnType<typeof vi.fn>;
    disable?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const nodes = dom();
  const enable = overrides.enable ?? vi.fn(async () => ({ ok: true }));
  const disable = overrides.disable ?? vi.fn(async () => undefined);
  const handle = mountPushToggle({
    ...nodes,
    author: () => AUTHOR,
    readStatus: async () => (overrides.status ?? SUPPORTED) as never,
    enable: enable as never,
    disable: disable as never,
  });
  return { ...nodes, enable, disable, handle };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('rendering the current state', () => {
  it('offers the switch when push is available and unenrolled', async () => {
    const { toggle, note, handle } = mount();
    await handle.refresh();
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(note.textContent).toBe('');
  });

  it('shows the switch ON when this device is already enrolled', async () => {
    const { toggle, note, handle } = mount({
      status: { ...SUPPORTED, permission: 'granted', enabled: true },
    });
    await handle.refresh();
    expect(toggle.checked).toBe(true);
    expect(note.textContent).toMatch(/on/i);
  });

  it('disables and explains on a browser without push', async () => {
    const { toggle, note, handle } = mount({
      status: { supported: false, available: false, permission: 'unsupported', enabled: false },
    });
    await handle.refresh();
    expect(toggle.disabled).toBe(true);
    // On an iPhone this is the "add it to your Home Screen first" case, and
    // it is by far the most likely one Bryan will hit.
    expect(note.textContent).toMatch(/home screen/i);
  });

  it('disables and names the ORIGIN problem, not the browser', async () => {
    const { toggle, note, handle } = mount({
      status: {
        supported: true,
        available: false,
        permission: 'default',
        enabled: false,
        reason: 'insecure-origin',
      },
    });
    await handle.refresh();
    expect(toggle.disabled).toBe(true);
    expect(note.textContent).toMatch(/https/i);
    // Saying "not supported" here would send someone to change browsers over
    // a URL problem.
    expect(note.textContent).not.toMatch(/browser/i);
  });

  it('disables and points at browser settings when permission is denied', async () => {
    const { toggle, note, handle } = mount({
      status: { ...SUPPORTED, permission: 'denied' },
    });
    await handle.refresh();
    expect(toggle.disabled).toBe(true);
    // The prompt cannot be re-shown once denied; only site settings can undo
    // it, so the row has to say where to go.
    expect(note.textContent).toMatch(/settings/i);
  });
});

describe('turning it on', () => {
  it('enrols this device and reports it', async () => {
    const { toggle, note, enable, handle } = mount();
    await handle.refresh();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await handle.settled();

    expect(enable).toHaveBeenCalledWith(AUTHOR);
    expect(toggle.checked).toBe(true);
    expect(note.textContent).toMatch(/on/i);
  });

  it('puts the switch BACK and says why when enrolment fails', async () => {
    const enable = vi.fn(async () => ({ ok: false, error: 'Notification permission was denied.' }));
    const { toggle, note, handle } = mount({ enable });
    await handle.refresh();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await handle.settled();

    // A switch that stays on after a failed enrolment is a switch that lies:
    // nothing will ever arrive and it looks configured.
    expect(toggle.checked).toBe(false);
    expect(note.textContent).toMatch(/denied/i);
  });

  it('ignores a second toggle while the first is still in flight', async () => {
    // Held in an object rather than a `let`: the assignment happens inside the
    // executor callback, which control-flow analysis cannot see, so a bare
    // `let` stays narrowed to `null` and the release call fails to typecheck.
    const gate: { release: (() => void) | null } = { release: null };
    const enable = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          gate.release = () => resolve({ ok: true });
        }),
    );
    const { toggle, handle } = mount({ enable });
    await handle.refresh();

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    toggle.dispatchEvent(new Event('change'));
    gate.release?.();
    await handle.settled();

    // Double-firing `subscribe()` races two registrations against one another
    // and can leave the server holding an endpoint the browser has dropped.
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe('turning it off', () => {
  it('unenrols this device', async () => {
    const { toggle, note, disable, handle } = mount({
      status: { ...SUPPORTED, permission: 'granted', enabled: true },
    });
    await handle.refresh();
    expect(toggle.checked).toBe(true);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await handle.settled();

    expect(disable).toHaveBeenCalled();
    expect(toggle.checked).toBe(false);
    expect(note.textContent).toBe('');
  });
});
