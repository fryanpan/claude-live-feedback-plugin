/**
 * The speaker menu: the popover Record opens while a meeting is running.
 * Split out of `meeting-strip.ts` (split-plan B4's follow-on), which keeps the
 * socket state machine the menu reports on. Its sibling is
 * `meeting-chooser.ts`, the popover the same button opens while nothing is
 * running — one panel element, two builders, and this is the running half.
 *
 * IT IS A REPORT WITH ONE VERB. Everything on it except Stop is a fact settled
 * before the meeting began — the source, how many voices were paid for, when
 * it started — because a streaming session's configuration IS its connect URL
 * and cannot move under it. The single exception is the Advanced Options
 * panel, borrowed back from the chooser: AssemblyAI's protocol takes some of
 * its turn-detection knobs on the open socket, and the panel says "next
 * recording" under every knob it does not.
 *
 * THE CAST OUTLIVES THE WINDOW. The rename rows list every voice the meeting
 * has shown, not the three turns still on the strip — a voice that spoke early
 * and went quiet has to stay nameable until the meeting is over, and after it
 * (the rename then rides HTTP to the meeting it belonged to). `speakerRow` is
 * this module's, and the chooser borrows it for the same reason: a doc opened
 * after its meeting ended shows its cast in the chooser, not here.
 *
 * IT OWNS NOTHING IT SHOWS. State, mode, cast, the live bot, the recording
 * engine and disposal all arrive as `MeetingMenuDeps` accessors, read at call
 * time because each is a `let` the strip moves; Stop and the popover's own
 * close are the strip's verbs, handed in.
 */

import type { CaptureMode, MeetingBotStatus } from '@feedback/core';
import { describeBotState, speakerDisplayName } from '@feedback/core';
import { advancedControls } from './meeting-advanced.ts';
import type { MeetingBotClient } from './meeting-bot-client.ts';
import { formatElapsed } from './meeting-protocol.ts';
import type { StripState } from './meeting-strip.ts';

/**
 * Everything the menu reaches outside the panel it draws into, named instead
 * of captured.
 */
export interface MeetingMenuDeps {
  /** The popover element the menu renders into — shared with the chooser. */
  pop: HTMLElement;
  /** The bot client, or undefined where the strip was mounted without one. */
  bot: MeetingBotClient | undefined;
  /** What the meeting machinery is doing right now. */
  state(): StripState;
  /** What the live capture is listening for. */
  mode(): CaptureMode;
  /** Engine label → what the person calls that voice. */
  names(): Record<string, string>;
  /** Every voice this meeting (or the last one) has shown. */
  cast(): string[];
  /** The bot's status while it will still act, or null. */
  liveBot(): MeetingBotStatus | null;
  /** Ask the person what to call this voice. */
  nameSpeaker(label: string): void;
  /** The clock the headline quotes, injectable so a test can drive it. */
  now(): number;
  /** The engine the LIVE capture runs on, or null while idle. */
  recordingEngine(): string | null;
  /** The Advanced Options section — the chooser's builder, borrowed. */
  buildAdvancedPanel(engineId: string, recording: boolean): HTMLElement;
  /** End the microphone capture. */
  stop(): void;
  /** Close whichever popover is open. */
  closePop(): void;
  /** Whether the mount has been torn down under an in-flight promise. */
  isDisposed(): boolean;
}

/** What the strip calls back into. */
export interface MeetingMenu {
  /** Render the speaker menu into `pop`. */
  buildMenu(): void;
  /** The menu's one line of facts, also read by the strip's clock tick. */
  headline(): string;
  /** One nameable speaker row, shared with the chooser's cast list. */
  speakerRow(label: string): HTMLElement;
}

export function createMeetingMenu(deps: MeetingMenuDeps): MeetingMenu {
  const { pop } = deps;

  /** `Recording · microphone · 2 speakers · 12:47` — the menu's one line of
   *  facts, every one settled at start time except the clock. */
  function headline(): string {
    const live = deps.liveBot();
    if (live) {
      const parts = [describeBotState(live.state), 'meeting bot'];
      if (live.speakers.length > 0) {
        parts.push(`${live.speakers.length} speaker${live.speakers.length === 1 ? '' : 's'}`);
      }
      return parts.join(' · ');
    }
    const state = deps.state();
    const parts = [state.kind === 'recording' ? 'Recording' : 'Starting…', 'microphone'];
    const voices = deps.cast().length;
    if (deps.mode() === 'conversation') {
      parts.push(voices > 0 ? `${voices} speaker${voices === 1 ? '' : 's'}` : 'multiple speakers');
    }
    if (state.kind === 'recording') parts.push(formatElapsed(deps.now() - state.startedAt));
    return parts.join(' · ');
  }

  /** One rename row: the display name (label until renamed, then only the
   *  name — never both) and the Rename affordance. */
  function speakerRow(label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'meeting-pop-speaker';
    const name = document.createElement('span');
    name.className = 'meeting-pop-speaker-name';
    name.textContent = speakerDisplayName(label, deps.names());
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'meeting-pop-rename';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${speakerDisplayName(label, deps.names())}`);
    rename.addEventListener('click', () => deps.nameSpeaker(label));
    row.append(name, rename);
    return row;
  }

  /** The speaker menu: the facts line, the cast, and Stop as the one action. */
  function buildMenu(): void {
    pop.replaceChildren();
    pop.className = 'meeting-pop meeting-menu';
    pop.setAttribute('role', 'menu');
    pop.removeAttribute('aria-label');
    const head = document.createElement('div');
    head.className = 'meeting-pop-head';
    const headBlink = document.createElement('span');
    headBlink.className = 'meeting-blinker';
    headBlink.setAttribute('aria-hidden', 'true');
    const headlineEl = document.createElement('span');
    headlineEl.className = 'meeting-pop-headline';
    headlineEl.textContent = headline();
    head.append(headBlink, headlineEl);
    pop.append(head);
    const live = deps.liveBot();
    if (live) {
      // A bot's speakers are display names from the call — nothing here to
      // rename; the rename that reaches backwards lives on the notes' tags.
      for (const who of live.speakers) {
        const row = document.createElement('div');
        row.className = 'meeting-pop-speaker';
        const name = document.createElement('span');
        name.className = 'meeting-pop-speaker-name';
        name.textContent = who;
        row.append(name);
        pop.append(row);
      }
    } else {
      for (const label of deps.cast()) pop.append(speakerRow(label));
    }
    // Mid-meeting tuning (v1 keeps it to this same panel, no new chrome):
    // the recording engine's own Advanced Options, still reachable while it
    // runs. Changes the live session can take apply immediately and say
    // "Applied."; the rest wait for the next recording and say that instead.
    // A bot meeting has no microphone engine to tune, so it gets nothing.
    const engine = deps.recordingEngine();
    if (!live && engine !== null && advancedControls(engine).length > 0) {
      pop.append(deps.buildAdvancedPanel(engine, true));
    }
    const sep = document.createElement('div');
    sep.className = 'meeting-pop-sep';
    pop.append(sep);
    const stopCta = document.createElement('button');
    stopCta.type = 'button';
    stopCta.className = 'meeting-stop-cta';
    stopCta.textContent = live ? '■ Send the bot home' : '■ Stop Recording';
    stopCta.addEventListener('click', () => {
      if (live) {
        stopCta.disabled = true;
        void deps.bot
          ?.leave()
          .catch(() => {
            // The strip keeps showing the bot's real state; a failed leave
            // changes nothing worth a second surface.
          })
          .finally(() => {
            if (!deps.isDisposed()) deps.closePop();
          });
        return;
      }
      deps.stop();
      deps.closePop();
    });
    pop.append(stopCta);
  }

  return { buildMenu, headline, speakerRow };
}
