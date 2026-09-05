/**
 * The settings field for how many builders this board's lead may dispatch at
 * once.
 *
 * Bryan, by voice: "add support for limiting parallelism in the workspace."
 * `register_dispatch` already enforces the cap server-side (see
 * `dispatch-registry.ts` / the settings route in `server.ts`); this is where
 * the owner reads and changes the number, and where the board says how many
 * of it are already spent — the same "read what you're being judged/limited
 * against" reasoning as `review-criteria.ts` next door, and its own module
 * for the same reason: what the field does on a failed read, an out-of-range
 * value, and a stale in-use count while the panel sits open is worth pinning
 * outside `board-app`'s `main()`.
 */

import { timeAgo } from './board-presence-model.ts';

export interface ParallelismCap {
  value: number;
  /** True while this board has never set its own — the field is showing the
   *  shipped default, and saying so is the point. */
  isDefault: boolean;
  /** How many of `value`'s slots are open dispatches right now. Absent means
   *  the read did not carry one (an older server) — the note omits the "in
   *  use" half rather than claiming zero. */
  inUse?: number;
  /** Who last moved the cap and when. Absent until somebody has — and then
   *  the note says nothing about it, because an unmoved cap has no story. */
  lastChange?: { actorName: string; ts: number; from: number; to: number };
}

export interface ParallelismCapDeps {
  box: HTMLInputElement;
  note: HTMLElement;
  save: HTMLButtonElement;
  useDefault: HTMLButtonElement;
  /** Read the board's cap. `null` is a failed read, never a made-up number. */
  read: () => Promise<ParallelismCap | null>;
  /** Write it. `null` restores the shipped default. Resolves false when the
   *  write was refused (out of range), and the field keeps the reader's own
   *  typed value so a rejected edit is not silently discarded. */
  write: (value: number | null) => Promise<boolean>;
  /** The board's one-line report. */
  toast: (message: string) => void;
}

export interface ParallelismCapHandle {
  /** Re-read and repaint. Called every time the panel opens. */
  refresh(): Promise<void>;
  /** Resolves when any in-flight write has finished. Tests await it. */
  settled(): Promise<void>;
}

/** What the note under the field says. States the in-use count whenever the
 *  read carried one, because "2 of 2" is the fact a lead is about to hit a
 *  refusal over — silence here is the same silence the nudge exists to end. */
export function parallelismCapNote(cap: ParallelismCap, now = Date.now()): string {
  const spent = cap.inUse !== undefined ? `${cap.inUse} of ${cap.value} in use. ` : '';
  // Who moved it and when — essential, and only once it has moved (Bryan:
  // "a moved cap is never a mystery"; no chip for one nobody touched).
  const by = cap.lastChange
    ? `set by ${cap.lastChange.actorName} ${timeAgo(cap.lastChange.ts, now)}`
    : '';
  if (cap.isDefault) {
    return by
      ? `${spent}Back on the default, ${by}.`
      : `${spent}The default — how many builders your dispatches may run at once. Edit it to change the limit.`;
  }
  return by ? `${spent}Cap ${cap.value}, ${by}.` : `${spent}Edited for this board.`;
}

export function mountParallelismCap(deps: ParallelismCapDeps): ParallelismCapHandle {
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const cap = await deps.read();
    if (!cap) {
      // Disabled, not zero. A failed read that a reader then saves would
      // write a made-up number over the board's real cap.
      deps.box.disabled = true;
      deps.save.disabled = true;
      deps.useDefault.disabled = true;
      deps.note.textContent = 'Could not read the cap — reopen this panel to try again.';
      return;
    }
    deps.box.disabled = false;
    deps.save.disabled = false;
    deps.useDefault.disabled = false;
    deps.box.value = String(cap.value);
    deps.note.textContent = parallelismCapNote(cap);
  }

  async function write(value: number | null): Promise<void> {
    const ok = await deps.write(value);
    if (!ok) {
      deps.toast('Could not save the parallelism cap');
      return;
    }
    // Re-read rather than trusting what we sent: the server is what decides
    // the effective value (and the in-use count), the same reasoning
    // review-criteria.ts uses for a restore-to-default.
    await refresh();
    deps.toast(value === null ? 'Parallelism cap back to the default' : 'Parallelism cap saved');
  }

  function run(value: number | null): void {
    inFlight = write(value).finally(() => {
      inFlight = null;
    });
  }

  deps.save.addEventListener('click', () => {
    const raw = deps.box.value.trim();
    const parsed = Number(raw);
    if (raw === '' || !Number.isInteger(parsed) || parsed < 1) {
      deps.toast('Parallelism cap must be a whole number of at least 1');
      return;
    }
    run(parsed);
  });
  deps.useDefault.addEventListener('click', () => run(null));

  return {
    refresh,
    settled: async () => {
      await inFlight;
    },
  };
}
