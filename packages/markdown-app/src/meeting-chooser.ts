/**
 * The start chooser and the Advanced Options panel: the two popovers the
 * Record button opens, and the one tune frame a live meeting can send. Split
 * out of `meeting-strip.ts` (split-plan B4), which keeps the Record button,
 * the socket state machine and the transcript feed.
 *
 * EVERY BILLED CHOICE IS MADE HERE. A streaming session's configuration IS
 * its connect URL, so source (microphone, or a bot sent to a call) and how
 * many voices the room has are settled before `start` and cannot move after
 * it. The one exception is this file's other half: AssemblyAI can take some
 * of its turn-detection knobs on the open socket, which is what `sendTune`
 * is, and every knob it cannot take says "next recording" under itself.
 *
 * IT DOES NOT OWN THE STATE IT WRITES. `ChooserState` is the strip's, passed
 * in — the strip reads the same fields when the Start press is finally
 * handled, and the fetch that settles the engine writes one of them. The rest
 * of what these builders reach for arrives as `MeetingChooserDeps` rather
 * than as a captured closure, which is why they could leave the mount at all.
 */

import type { CaptureMode } from '@feedback/core';
import { liveTuningKeys } from '@feedback/core';
import { advancedControls, buildAdvancedSection } from './meeting-advanced.ts';
import type { AdvancedState } from './meeting-advanced.ts';
import type { MeetingBotClient } from './meeting-bot-client.ts';

/**
 * The chooser form as it currently stands. Lives on the strip because the
 * Start press it feeds is the strip's, and because the engine is settled by a
 * fetch the strip owns.
 */
export interface ChooserState {
  /** The chooser's source choice. Mic unless the last press said otherwise. */
  chooseSource: 'mic' | 'bot';
  /**
   * The chooser's speaker choice. Multiple by default — this product's
   * ordinary meeting has other people in it, and the approved mock preselects
   * it; "Just me" is the deliberate cheaper pick.
   */
  chooseMode: CaptureMode;
  /**
   * The engine the next capture opens. Starts as the address's ask
   * (`?engine=soniox`), settled once the strip's engine fetch answers.
   * Nothing in the chooser moves it.
   */
  chooseEngine: string | undefined;
  /** Whether the Advanced section is unfolded — one flag across engines. */
  advOpen: boolean;
  /** The call the bot would be sent to join. */
  chooseBotUrl: string;
  /** The name that bot wears in the meeting. */
  chooseBotName: string;
  /** Why the last chooser press did not start, shown in the sheet. */
  chooseError: string;
  /** An invite is in flight; the CTA must not send a second bot. */
  chooseBusy: boolean;
}

/**
 * Everything these builders reach outside their own form, named instead of
 * captured. The four accessors are the strip's `let`s — a socket that opens
 * and closes, and which popover is up — so they are read at call time rather
 * than bound once.
 */
export interface MeetingChooserDeps {
  /** The form state above, shared with the strip that presses Start. */
  choose: ChooserState;
  /** The popover element both panels render into. */
  pop: HTMLElement;
  /** Keys the server confirmed applying to the live session ("Applied."). */
  appliedKeys: Set<string>;
  /** Live keys the panel moved that the open session could not be moved to. */
  staleKeys: Set<string>;
  /** The bot client, or undefined where the strip was mounted without one. */
  bot: MeetingBotClient | undefined;
  /** Advanced Options for one engine, created on first look. */
  advFor(engineId: string): AdvancedState;
  /** The speakers the last recording named, still nameable after it ended. */
  cast(): string[];
  /** One nameable speaker row. */
  speakerRow(label: string): HTMLElement;
  /** Redraw whichever popover is open. */
  renderPop(): void;
  /** The chooser's one verb, which the strip owns because it starts a meeting. */
  onStartPressed(): void;
  /** Whether the chooser, rather than the menu, is the popover on screen. */
  isChooserView(): boolean;
  /** Whether the audio socket is open, so a tune frame can travel now. */
  socketOpen(): boolean;
  /** Send one frame on the audio socket, if there is one. */
  sendSocket(data: string): void;
}

/** What the strip calls back into. */
export interface MeetingChooser {
  /** Render the start chooser into `pop`. */
  buildChooser(): void;
  /** The Advanced Options section, for the chooser or the live menu. */
  buildAdvancedPanel(engineId: string, recording: boolean): HTMLElement;
}

/** One radio card in the chooser. */
function choice(args: {
  group: string;
  title: string;
  detail: string;
  checked: boolean;
  onPick: () => void;
}): { el: HTMLLabelElement; body: HTMLElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.className = args.checked ? 'meeting-choice is-selected' : 'meeting-choice';
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = args.group;
  input.checked = args.checked;
  const body = document.createElement('span');
  body.className = 'meeting-choice-body';
  const title = document.createElement('span');
  title.className = 'meeting-choice-title';
  title.textContent = args.title;
  const detail = document.createElement('span');
  detail.className = 'meeting-choice-detail';
  detail.textContent = args.detail;
  body.append(title, detail);
  label.append(input, body);
  input.addEventListener('change', () => {
    if (input.checked) args.onPick();
  });
  return { el: label, body, input };
}

function choiceGroup(name: string): { group: HTMLElement; add: (el: HTMLElement) => void } {
  const group = document.createElement('div');
  group.className = 'meeting-choice-group';
  const label = document.createElement('div');
  label.className = 'meeting-choice-group-label';
  label.textContent = name;
  group.append(label);
  return { group, add: (el) => group.append(el) };
}
export function createMeetingChooser(deps: MeetingChooserDeps): MeetingChooser {
  const {
    choose,
    pop,
    appliedKeys,
    staleKeys,
    bot,
    advFor,
    cast,
    speakerRow,
    renderPop,
    onStartPressed,
    isChooserView,
    socketOpen,
    sendSocket,
  } = deps;
  /**
   * One change to the LIVE meeting's knobs. Sent only for a key the running
   * engine can take on the open socket; the server answers `tuned` naming
   * what it applied, which is what turns the control's note into "Applied."
   * Everything else — Soniox entirely, and the non-live keys — changes the
   * stored panel and waits for the next recording, which the control already
   * says under itself.
   */
  function sendTune(engineId: string, key: string): void {
    // Whether the ENGINE is currently running this key, per the server's own
    // `tuned` answer — the only honest basis for claiming it still is.
    const wasApplied = appliedKeys.has(key);
    appliedKeys.delete(key);
    if (!socketOpen() || !liveTuningKeys(engineId).has(key)) return;
    const value = advFor(engineId)[key];
    if (value === undefined) return;
    // An emptied term list cannot travel — the server's sanitizer drops
    // `[]` (an empty list IS the default) — so the frame would apply
    // nothing and still flash "Applied.". If the engine already took a list
    // this session it is still running it, and the control has to say so:
    // an empty box over live terms is the panel lying about the session.
    if (Array.isArray(value) && value.length === 0) {
      if (wasApplied) staleKeys.add(key);
      return;
    }
    staleKeys.delete(key);
    sendSocket(
      JSON.stringify({
        type: 'tune',
        settings: { [key]: Array.isArray(value) ? [...value] : value },
      }),
    );
  }

  /**
   * The Advanced Options section, shared by the chooser (pre-recording) and
   * the menu (mid-meeting tuning). State lives in `advStates`; every change
   * re-renders the popover — except a slider mid-drag, which the section
   * repaints in place and only commits when the drag settles.
   */
  function buildAdvancedPanel(engineId: string, recording: boolean): HTMLElement {
    const rerenderKeeping = (key: string | null): void => {
      renderPop();
      if (!key) return;
      // Adding a chip rebuilds the panel under the keyboard; hand focus back
      // to the field that was being typed in so a list of terms is one
      // sitting, not one term per tap. The selector only matches a chips
      // control, so a slider commit moves nothing.
      pop
        .querySelector<HTMLInputElement>(
          `.meeting-adv-ctl[data-key="${key}"] .meeting-adv-chips input`,
        )
        ?.focus();
    };
    return buildAdvancedSection({
      engineId,
      state: advFor(engineId),
      open: choose.advOpen,
      recording,
      applied: appliedKeys,
      stale: staleKeys,
      onToggleOpen: () => {
        choose.advOpen = !choose.advOpen;
        renderPop();
      },
      onReset: (wasModified) => {
        // Mid-meeting, the panel's defaults must reach the live session too,
        // or the UI claims defaults the engine is not running. Each reverted
        // live key goes up as its own tune frame carrying the documented
        // default the panel showed beside the knob. Keys the session cannot
        // take already say "next recording" under themselves; a term list it
        // CAN take but cannot be emptied over the wire is the one case that
        // ends diverged, and `sendTune` marks it so the control admits it.
        if (recording) {
          for (const key of wasModified) sendTune(engineId, key);
        }
        renderPop();
      },
      onChange: (key) => {
        if (recording) sendTune(engineId, key);
        rerenderKeeping(key);
      },
    });
  }

  /**
   * The start chooser: every decision a recording takes, taken here, and a
   * red Start Recording that is the only verb.
   */
  function buildChooser(): void {
    pop.replaceChildren();
    pop.className = 'meeting-pop meeting-sheet';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Start recording');
    const h = document.createElement('h3');
    h.className = 'meeting-sheet-title';
    h.textContent = 'Start recording';
    pop.append(h);

    // The last meeting's voices, still nameable after it ended — the behavior
    // the old strip's idle legend carried, now living where the button leads.
    const idleCast = cast();
    if (idleCast.length > 0) {
      const castWrap = document.createElement('div');
      castWrap.className = 'meeting-pop-cast';
      const hint = document.createElement('div');
      hint.className = 'meeting-choice-group-label';
      hint.textContent = 'Speakers from the last recording';
      castWrap.append(hint);
      for (const label of idleCast) castWrap.append(speakerRow(label));
      pop.append(castWrap);
    }

    const source = choiceGroup('Source');
    const micChoice = choice({
      group: 'meeting-source',
      title: 'Use microphone',
      detail: 'Record the room from this device',
      checked: choose.chooseSource === 'mic',
      onPick: () => {
        choose.chooseSource = 'mic';
        renderChoiceSelection();
      },
    });
    micChoice.el.classList.add('meeting-choice-mic');
    source.add(micChoice.el);
    // Only where the server can actually field one: no key means no bot
    // source at all rather than a card that always fails.
    if (bot?.configured()) {
      const botChoice = choice({
        group: 'meeting-source',
        title: 'Join Zoom / Google Meet',
        detail: 'A bot joins the call and records it',
        checked: choose.chooseSource === 'bot',
        onPick: () => {
          choose.chooseSource = 'bot';
          renderChoiceSelection();
        },
      });
      botChoice.el.classList.add('meeting-choice-bot');
      const url = document.createElement('input');
      url.type = 'url';
      url.className = 'meeting-bot-url';
      url.placeholder = 'Paste the meeting link';
      url.setAttribute('aria-label', 'Meeting link for the bot to join');
      url.value = choose.chooseBotUrl;
      url.addEventListener('input', () => {
        choose.chooseBotUrl = url.value;
      });
      // Typing a link IS choosing the bot; make the radio agree.
      url.addEventListener('focus', () => {
        if (choose.chooseSource !== 'bot') {
          choose.chooseSource = 'bot';
          renderChoiceSelection();
        }
      });
      // Bryan's late redline on the mock: sighted users saw a plain text box
      // with a prefilled string and no cue what it controlled. A visible
      // caption, not just the aria-label, says what the value becomes.
      const nameHint = document.createElement('span');
      nameHint.className = 'meeting-bot-name-hint';
      nameHint.textContent = 'Name shown in the meeting';
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'meeting-bot-name';
      name.setAttribute('aria-label', 'Bot display name shown in the meeting — tap to change');
      name.value = choose.chooseBotName;
      name.addEventListener('input', () => {
        choose.chooseBotName = name.value;
      });
      botChoice.body.append(url, nameHint, name);
      source.add(botChoice.el);
    }
    pop.append(source.group);

    // No engine row: the engine is the server's default (or the address's
    // preference), never a question asked here — see the header.
    const speakers = choiceGroup('Speakers');
    speakers.add(
      choice({
        group: 'meeting-speakers',
        title: 'Just me',
        detail: 'No speaker labels',
        checked: choose.chooseMode === 'solo',
        onPick: () => {
          choose.chooseMode = 'solo';
          renderChoiceSelection();
        },
      }).el,
    );
    speakers.add(
      choice({
        group: 'meeting-speakers',
        title: 'Multiple Speakers',
        detail: 'Labels each voice in the transcript',
        checked: choose.chooseMode === 'conversation',
        onPick: () => {
          choose.chooseMode = 'conversation';
          renderChoiceSelection();
        },
      }).el,
    );
    pop.append(speakers.group);
    // The one per-engine fact worth stating beside the toggle itself: the
    // cap the AssemblyAI panels offer does not exist on Soniox at all.
    if (choose.chooseEngine === 'soniox' && choose.chooseMode === 'conversation') {
      const note = document.createElement('div');
      note.className = 'meeting-engine-hint';
      note.textContent = "Soniox labels speakers but doesn't cap how many.";
      pop.append(note);
    }

    // Advanced Options, below Speakers: the engine's own knobs, collapsed
    // until asked for. Absent entirely when the engine is unknown (an old
    // server never answered the list).
    if (choose.chooseEngine !== undefined && advancedControls(choose.chooseEngine).length > 0) {
      pop.append(buildAdvancedPanel(choose.chooseEngine, false));
    }

    syncStartActions();
  }

  /**
   * The tail of the chooser — the error line and the start verb — rebuilt from
   * the choices as they stand.
   *
   * Separate from `buildChooser` because it follows the SOURCE and SPEAKERS
   * cards, which are picked without a rebuild.
   *
   * It stays a direct child of `pop` rather than moving into a wrapper of its
   * own: `.meeting-start-actions` is sticky, and a sticky element can only
   * travel inside its parent's box — put it in a wrapper the height of its own
   * contents and it has nowhere to stick to.
   */
  function syncStartActions(): void {
    for (const sel of ['.meeting-pop-error', '.meeting-start-actions']) {
      pop.querySelector(sel)?.remove();
    }

    const err = document.createElement('span');
    err.className = 'meeting-pop-error';
    // Assertive: this one only ever appears in answer to a press, and it is
    // the reason the thing the person just asked for did not happen.
    err.setAttribute('aria-live', 'assertive');
    err.textContent = choose.chooseError;
    pop.append(err);

    // The verb rides a sticky footer: the chooser outgrows the iPad tier's
    // height as soon as Advanced Options is open, so this is the ordinary
    // case, not the edge one.
    const actions = document.createElement('div');
    actions.className = 'meeting-start-actions';

    const startCta = document.createElement('button');
    startCta.type = 'button';
    startCta.className = 'meeting-start-cta';
    startCta.textContent = '● Start Recording';
    startCta.disabled = choose.chooseBusy;
    startCta.addEventListener('click', () => onStartPressed());
    actions.append(startCta);

    pop.append(actions);
  }

  /** Re-mark the selected cards without rebuilding inputs mid-interaction. */
  function renderChoiceSelection(): void {
    for (const card of pop.querySelectorAll('.meeting-choice')) {
      const input = card.querySelector('input');
      card.classList.toggle('is-selected', input?.checked === true);
    }
    // The verbs below depend on what was just picked. Guarded because this
    // runs off card clicks, and only the chooser has cards — a menu that
    // grew one later must not sprout a Start button.
    if (isChooserView()) syncStartActions();
  }
  return { buildChooser, buildAdvancedPanel };
}
