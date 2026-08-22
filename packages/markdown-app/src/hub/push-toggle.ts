/**
 * The settings row that enrols this device for review-item notifications.
 *
 * Its real job is the unhappy paths. "The switch does nothing" has three
 * completely different causes — the browser has no Push API, the origin is
 * plain HTTP, or permission was denied once and cannot be re-prompted — and
 * they need three different actions from the person reading the row. So the
 * row never just greys out; it says which one it is.
 */

import {
  type PushAuthor,
  type PushStatus,
  disablePush,
  enablePush,
  readPushStatus,
} from '../push-client.ts';

export interface PushToggleDeps {
  toggle: HTMLInputElement;
  note: HTMLElement;
  author: () => PushAuthor;
  /** Seams, for tests. Production passes none of them. */
  readStatus?: () => Promise<PushStatus>;
  enable?: (author: PushAuthor) => Promise<{ ok: boolean; error?: string }>;
  disable?: () => Promise<void>;
}

export interface PushToggleHandle {
  /** Re-read the browser and server and repaint the row. */
  refresh(): Promise<void>;
  /** Resolves when any in-flight enable/disable has finished. Tests await it;
   *  nothing in the app needs to. */
  settled(): Promise<void>;
}

/** What the row says when it cannot be switched on. Each string names the
 *  thing the reader can actually change. */
function blockedNote(status: PushStatus): string | null {
  if (!status.supported) {
    // On iOS this is the common case and it is fixable: a plain Safari tab
    // has no PushManager, a Home Screen web app does. Saying "unsupported"
    // alone would read as a dead end when it is a two-tap setup step.
    return 'Add this page to your Home Screen first, or use a browser that supports notifications.';
  }
  if (!status.available) {
    return 'Only works on the https address for this server.';
  }
  if (status.permission === 'denied') {
    // The prompt cannot be shown again once denied — only site settings can
    // undo it, so pointing anywhere else wastes the reader's time.
    return 'Blocked. Allow notifications for this site in your browser settings.';
  }
  return null;
}

export function mountPushToggle(deps: PushToggleDeps): PushToggleHandle {
  const readStatus = deps.readStatus ?? readPushStatus;
  const enable = deps.enable ?? enablePush;
  const disable = deps.disable ?? disablePush;

  let inFlight: Promise<void> | null = null;

  function paint(opts: { checked: boolean; disabled: boolean; note: string }): void {
    deps.toggle.checked = opts.checked;
    deps.toggle.disabled = opts.disabled;
    deps.note.textContent = opts.note;
  }

  async function refresh(): Promise<void> {
    const status = await readStatus();
    const blocked = blockedNote(status);
    paint({
      checked: status.enabled,
      disabled: blocked !== null,
      note:
        blocked ?? (status.enabled ? "On — you'll be notified here when review items arrive." : ''),
    });
  }

  async function apply(wanted: boolean): Promise<void> {
    // Both directions can take a second (a permission prompt, a round trip to
    // a push service). Locking the control means the person cannot queue a
    // second subscribe behind the first, which races two registrations and
    // can leave the server holding an endpoint the browser has since dropped.
    deps.toggle.disabled = true;
    try {
      if (wanted) {
        const result = await enable(deps.author());
        if (!result.ok) {
          // Revert. A switch left on after a failed enrolment is a switch
          // that lies: nothing will arrive and the row looks configured.
          paint({
            checked: false,
            disabled: false,
            note: result.error ?? 'Could not turn notifications on.',
          });
          return;
        }
        paint({
          checked: true,
          disabled: false,
          note: "On — you'll be notified here when review items arrive.",
        });
        return;
      }
      await disable();
      paint({ checked: false, disabled: false, note: '' });
    } finally {
      inFlight = null;
    }
  }

  deps.toggle.addEventListener('change', () => {
    if (inFlight) return;
    inFlight = apply(deps.toggle.checked);
    void inFlight;
  });

  return {
    refresh,
    async settled() {
      await inFlight;
    },
  };
}
