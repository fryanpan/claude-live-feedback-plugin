/**
 * The presence strip as a Preact island — who is here (the top-right circle
 * cluster) and the drift notices in the settings panel, both of which the
 * vanilla `renderPresence` used to build by wiping its container and
 * rebuilding every node.
 *
 * This is the pane the migration was actually about. A presence circle is a
 * live control with a 550ms long-press on it, and the strip repaints on every
 * awareness update, every SSE agent refresh and a 30s tick — so a repaint
 * routinely landed in the middle of a press. Rebuilding the node mid-press
 * left the timer armed against a button the reader was no longer touching:
 * the `pointerup` that should have cancelled the follow arrived on a REPLACED
 * node, whose own disarm closure knew nothing about the running timer. The
 * tap that was meant to press the button destroyed it.
 *
 * Keyed rows fix that at the root. `PresenceChip.key` is the participant
 * (`p-<name>` / `a-<agentId>`), not the array index and not the Yjs
 * `clientId` — `clientId` is minted per connection, so it changes on every
 * reload and cannot name a person; it is only ever used to fold one person's
 * several tabs into one row (`foldTabs` in hub-model). An unchanged
 * participant therefore keeps the IDENTICAL DOM node across a signal update,
 * and the press it is holding survives with it.
 *
 * The bridge is one-directional, as in the Home review island: the vanilla
 * `renderPresenceRegion` still owns awareness, the agent list and the drift
 * readings, and writes them into `presenceData` / `driftData`. The island
 * only reads. Handlers are bound once at mount.
 */
import { signal } from '@preact/signals';
import { type ComponentChildren, Fragment, render } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { type DriftNotice, type PresenceChip, initialsOf, presenceHue } from './hub-model.ts';

export interface PresenceHandlers {
  /** Tap a chip to jump to where they are. */
  onTap: (chip: PresenceChip) => void;
  /** Long-press to follow — your view navigates when theirs does. */
  onLongPress: (chip: PresenceChip) => void;
  /** Tap the "+N" overflow circle — hand back the people it stands for, so
   *  the caller can name them (a title attribute alone is unreachable from a
   *  touch screen). */
  onOverflow?: (hidden: PresenceChip[]) => void;
}

const LONG_PRESS_MS = 550;

/** Compact mode caps the strip at this many circles; past it the last slot
 *  becomes a "+N" that names the rest. Chosen so the cluster's worst case
 *  (4 × 28px + gaps ≈ 124px) still leaves the workspace name room at 430px. */
const MAX_CIRCLES = 4;

export interface PresenceData {
  chips: PresenceChip[];
  followedKey: string | null;
}

/** Who is here. The one write target the vanilla loader has for the strip. */
export const presenceData = signal<PresenceData>({ chips: [], followedKey: null });

/**
 * What is running where. A LIST, because "what is running where" has two
 * independent answers: the agents' plugin bundles and the browser's own
 * client. They fail separately and are fixed separately, so neither may hide
 * the other — and a slot may be empty, which is why the nulls travel rather
 * than being filtered upstream (the slot is what keys the note).
 */
export const driftData = signal<ReadonlyArray<DriftNotice | null | undefined>>([]);

/**
 * One person or agent. A button with a press gesture on it, which is why it
 * is a component and not inline JSX: the press state has to live somewhere
 * that survives a re-render, and a ref inside the row does exactly that while
 * the row keeps its node.
 */
function PresenceButton(props: {
  chip: PresenceChip;
  compact: boolean;
  followed: boolean;
  handlers: PresenceHandlers;
}) {
  const { chip, compact, followed, handlers } = props;
  // A long-press follows; a tap jumps. The press has TWO endings —
  // pointercancel is the common one on mobile — and both must disarm the
  // timer or one scroll wedges the strip.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const disarm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // A press outliving its row would follow somebody who has left the strip.
  // Only reachable on a real removal now that the row is keyed, but a timer
  // with nothing left to act on is still a timer to clear.
  useEffect(() => disarm, []);

  const base = compact ? 'hub-presence-circle' : 'hub-presence-chip';
  return (
    <button
      type="button"
      class={`${base} hub-presence-${chip.kind}${chip.state ? ` hub-presence-${chip.state}` : ''}${
        followed ? ' hub-following' : ''
      }`}
      title={followed ? `${chip.title} · following — long-press to stop` : chip.title}
      // The circle drops the visible name, so it must be announced — the
      // title alone is read weakly or not at all depending on the reader.
      // The long-form chip shows the name, so it needs no second copy.
      aria-label={compact ? chip.title : undefined}
      style={compact ? { background: `hsl(${presenceHue(chip.label)}, 45%, 45%)` } : undefined}
      onPointerDown={() => {
        longFired.current = false;
        disarm();
        timer.current = setTimeout(() => {
          longFired.current = true;
          handlers.onLongPress(chip);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={disarm}
      onPointerCancel={disarm}
      onPointerLeave={disarm}
      onClick={() => {
        if (!longFired.current) handlers.onTap(chip);
      }}
    >
      {compact ? (
        <span class="hub-presence-initials">{initialsOf(chip.label)}</span>
      ) : (
        <Fragment>
          <span class="hub-presence-name">{chip.label}</span>
          <span class="hub-presence-where">{chip.where}</span>
        </Fragment>
      )}
    </button>
  );
}

/** The "+N" circle. Its names have to reach a touch screen, where a title
 *  attribute never shows — hence the callback as well as the tooltip. */
function OverflowCircle(props: { hidden: PresenceChip[]; handlers: PresenceHandlers }) {
  const names = props.hidden.map((c) => c.label).join(', ');
  return (
    <button
      type="button"
      class="hub-presence-circle hub-presence-more"
      title={names}
      aria-label={`${props.hidden.length} more: ${names}`}
      onClick={() => props.handlers.onOverflow?.(props.hidden)}
    >
      {`+${props.hidden.length}`}
    </button>
  );
}

/**
 * An empty region must not sit in the header taking a gap's worth of room, so
 * the `hidden` class is toggled on the HOST rather than rendered — the host
 * is the flex container the shell built and the CSS targets, and the island
 * only ever owns its wrapper's children. A class is not a child, so this
 * writes nothing Preact believes it owns.
 */
function useHostVisibility(host: HTMLElement, empty: boolean): void {
  useLayoutEffect(() => {
    host.classList.toggle('hidden', empty);
  }, [host, empty]);
}

function PresenceStrip(props: {
  host: HTMLElement;
  handlers: PresenceHandlers;
  compact: boolean;
}) {
  const { chips, followedKey } = presenceData.value;
  useHostVisibility(props.host, chips.length === 0);
  // Clamp BEFORE the map, so the overflow circle replaces the fourth chip
  // rather than following it — the cap is a footprint, not a count.
  const overflowing = props.compact && chips.length > MAX_CIRCLES;
  const visible = overflowing ? chips.slice(0, MAX_CIRCLES - 1) : chips;
  const hidden = overflowing ? chips.slice(MAX_CIRCLES - 1) : [];
  return (
    <Fragment>
      {visible.map((chip) => (
        <PresenceButton
          key={chip.key}
          chip={chip}
          compact={props.compact}
          followed={followedKey === chip.key}
          handlers={props.handlers}
        />
      ))}
      {hidden.length > 0 && <OverflowCircle hidden={hidden} handlers={props.handlers} />}
    </Fragment>
  );
}

/** The reading each slot of `driftData` carries, in the order the loader
 *  writes them. A notice's identity is WHICH READING it is, not where it
 *  landed in a filtered list — so a fixed plugin going quiet leaves the client
 *  notice beside it as the same node. */
const DRIFT_SLOTS = ['plugin', 'client'] as const;
const driftSlotId = (slot: number): string => DRIFT_SLOTS[slot] ?? `slot-${slot}`;

function DriftStrip(props: { host: HTMLElement }) {
  const notes = driftData.value
    .map((notice, slot) => ({ id: driftSlotId(slot), notice }))
    .filter((s): s is { id: string; notice: DriftNotice } => Boolean(s.notice));
  useHostVisibility(props.host, notes.length === 0);
  return (
    <Fragment>
      {notes.map(({ id, notice }) => (
        <div
          key={id}
          // A coverage line is always on the board, so it gets the quiet
          // treatment. Styling it like the alarm would train people to skim
          // past the alarm.
          class={notice.kind === 'coverage' ? 'hub-drift hub-drift-quiet' : 'hub-drift'}
        >
          <span class="hub-drift-head">{notice.headline}</span>
          <span class="hub-drift-who">{notice.detail}</span>
          <span class="hub-drift-fix">{notice.fix}</span>
        </div>
      ))}
    </Fragment>
  );
}

/** The island contract, as the probe proved it: the wrapper — not the host —
 *  is Preact's container, disposal is render(null, el), and no vanilla code
 *  may replaceChildren/innerHTML a container holding a live island. The
 *  wrapper is `display: contents` so the strip's buttons stay direct flex
 *  items of the host, which is what the `.hub-presence` layout is written
 *  against. */
function mountInto(host: HTMLElement, name: string, tree: ComponentChildren): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', name);
  host.appendChild(el);
  render(tree, el);
  return () => {
    render(null, el);
    el.remove();
  };
}

/**
 * Who is here, into a wrapper appended to `host`. `compact` is the top-right
 * cluster's circles (Bryan, 2026-08-18: "show smaller circle profile buttons
 * for each active user instead of the long form"); the long form is the
 * original chip with the name and the surface spelled out.
 */
export function mountPresenceIsland(
  host: HTMLElement,
  handlers: PresenceHandlers,
  opts: { compact?: boolean } = {},
): () => void {
  return mountInto(
    host,
    'presence',
    <PresenceStrip host={host} handlers={handlers} compact={opts.compact ?? false} />,
  );
}

/** What is running where, into a wrapper appended to `host`. */
export function mountDriftIsland(host: HTMLElement): () => void {
  return mountInto(host, 'presence-drift', <DriftStrip host={host} />);
}
