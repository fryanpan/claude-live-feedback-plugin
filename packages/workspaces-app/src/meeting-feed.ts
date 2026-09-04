/**
 * The transcript feed: the one line under the Record button where a meeting's
 * words appear, and every note that stands in for them when there are none.
 * Split out of `meeting-strip.ts` (split-plan B4's follow-on), which keeps the
 * socket state machine that decides WHICH of those the line should be showing.
 *
 * IT IS THE ONLY PLACE THE WORDS ARE. The transcript is never written into the
 * document while a meeting runs, so a state the strip can be left in — a mic
 * that was refused, a server with no transcription key, a bot that left — has
 * to arrive here as a sentence. That is why `showNote` sits beside
 * `renderFeed` rather than in the strip: the note and the words are the same
 * slot, and only one of them can be in it.
 *
 * CORRECTIONS LAND ON THE WORD ALREADY ON SCREEN. A `transcript` frame carries
 * the WHOLE turn as currently understood, so a later frame for the same turn
 * is the engine revising itself. `diffTurnWords` finds which words actually
 * moved and only those are rewritten and flashed — redrawing the line instead
 * would make every partial look like a correction. The per-turn spans that
 * makes possible are this module's own state; nothing outside it holds them.
 *
 * IT OWNS NO DECISIONS. Everything it reads — which state the machine is in,
 * what the turns are, whether a bot is live, what a voice is called — arrives
 * as `MeetingFeedDeps` accessors read at call time, because every one of them
 * is a `let` the strip moves. The one verb it offers back, a tap on a speaker
 * tag, is handed straight to the strip's `nameSpeaker`.
 */

import type { CaptureMode, MeetingBotStatus } from '@feedback/core';
import { RECORDING_CONSENT_NOTE, describeBotState, speakerDisplayName } from '@feedback/core';
import type { MeetingLiveZone } from './meeting-live-zone.ts';
import { type TranscriptTurn, diffTurnWords } from './meeting-protocol.ts';
import type { StripState } from './meeting-strip.ts';

/**
 * Everything the feed reaches outside its own spans, named instead of
 * captured. The accessors are the strip's `let`s — a state machine that moves
 * under a rendered line — so they are read at call time rather than bound
 * once.
 */
export interface MeetingFeedDeps {
  /** The element the words and the notes are written into. */
  line: HTMLElement;
  /**
   * The provisional zone at the end of the doc. Present, it is the transcript
   * surface and this feed renders no turns at all — the same words rolling in
   * two places read as two meetings.
   */
  liveZone?: MeetingLiveZone;
  /** What the meeting machinery is doing right now. */
  state(): StripState;
  /** The rolling window of turns, newest last. */
  turns(): TranscriptTurn[];
  /** What the live capture is listening for; a solo one gets no consent note. */
  mode(): CaptureMode;
  /** Engine label → what the person calls that voice. */
  names(): Record<string, string>;
  /** The bot's status while it will still act, or null. */
  liveBot(): MeetingBotStatus | null;
  /** The terminal bot state worth a dismissable line, or null. */
  botFarewell(): string | null;
  /** Ask the person what to call this voice — the strip's, because a name
   *  travels on its socket. */
  nameSpeaker(label: string): void;
  /** The farewell note was tapped away. */
  dismissBotNote(): void;
}

/** What the strip drives the line through. */
export interface MeetingFeed {
  /** Draw whatever the current state says this line should be. */
  renderFeed(): void;
  /** Empty the line and forget every per-turn span. */
  clearTurnSpans(): void;
  /** Replace the line with one sentence. */
  showNote(text: string, extra?: string): void;
  /** Rewrite every tag wearing `label` to the name it now has. */
  retagSpeaker(label: string): void;
}

export function createMeetingFeed(deps: MeetingFeedDeps): MeetingFeed {
  const { line, liveZone } = deps;
  /** Live word spans per turn, so a correction rewrites the span that is
   *  already on screen instead of redrawing the line under the reader. */
  const rendered = new Map<
    number,
    { span: HTMLElement; tag: HTMLElement | null; words: HTMLElement[]; text: string }
  >();

  /**
   * The button every rename surface uses. The pill is a child so the button
   * itself can stay free of the overflow that clipping a long name needs — a
   * clip anywhere on the button eats its own tap target.
   */
  function speakerButton(): HTMLButtonElement {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'meeting-speaker';
    tag.title = 'Tap to name this speaker';
    const pill = document.createElement('span');
    pill.className = 'meeting-speaker-pill';
    tag.append(pill);
    tag.addEventListener('click', () => deps.nameSpeaker(tag.dataset.speaker ?? ''));
    return tag;
  }

  /**
   * The same tag with no tap in it — a bot turn's. The platform already
   * named the voice, and a live bot meeting cannot be renamed from here
   * anyway (the rename route refuses a recording meeting; the socket a
   * live rename rides is the microphone's). Same pill, same place on the
   * line, so a bot meeting reads exactly like a microphone one; the
   * pencil and the dotted underline are the stylesheet's to withhold.
   */
  function speakerLabel(): HTMLElement {
    const tag = document.createElement('span');
    tag.className = 'meeting-speaker is-fixed';
    const pill = document.createElement('span');
    pill.className = 'meeting-speaker-pill';
    tag.append(pill);
    return tag;
  }

  /** The tag every turn with this label wears, as it should read now. The
   *  name goes on the PILL, never on the button: the button is the tap
   *  target and holds nothing but padding (see the stylesheet). */
  function renderTag(entry: { tag: HTMLElement | null }, label: string): void {
    const tag = entry.tag;
    if (!tag) return;
    const shown = speakerDisplayName(label, deps.names());
    tag.dataset.speaker = label;
    const pill = tag.querySelector('.meeting-speaker-pill');
    if (pill) pill.textContent = shown;
    if (tag instanceof HTMLButtonElement) tag.setAttribute('aria-label', `Name ${shown}`);
  }

  function renderFeed(): void {
    const state = deps.state();
    const turns = deps.turns();
    if (state.kind !== 'idle' && state.kind !== 'recording') return;
    // A note and a transcript share the line, so the reason the last attempt
    // gave has to go when words start arriving.
    line.querySelector('.meeting-note')?.remove();
    if (state.kind === 'idle') {
      // An idle strip with a live bot shows the bot's words once there are
      // any, and narrates its state until then; with a farewell, the
      // farewell; otherwise the strip is hidden and the line stays empty.
      const live = deps.liveBot();
      if (live && turns.length > 0) {
        renderTurns(false);
        return;
      }
      if (live) {
        clearTurnSpans();
        const who = live.speakers.length ? ` · ${live.speakers.join(', ')}` : '';
        const note = document.createElement('span');
        note.className = 'meeting-note meeting-bot-note';
        note.textContent = `${describeBotState(live.state)}${who}`;
        line.append(note);
        return;
      }
      const farewell = deps.botFarewell();
      if (farewell) {
        clearTurnSpans();
        const note = document.createElement('button');
        note.type = 'button';
        note.className = 'meeting-note meeting-note-dismiss meeting-bot-note';
        note.textContent = farewell;
        note.title = 'Tap to dismiss';
        note.addEventListener('click', () => deps.dismissBotNote());
        line.append(note);
        return;
      }
      clearTurnSpans();
      return;
    }
    // Recording, and nothing said yet: the line the transcript opens with.
    // It is where the announcement used to go, and it is deliberately a
    // different kind of thing — addressed to the person recording rather than
    // to the room, gone the instant there are words to show instead, and
    // never a control. See `RECORDING_CONSENT_NOTE`. A solo capture has no
    // room to have asked, so it gets no line at all: a reminder with nobody
    // to act on it is a question with no answer (Urgent-fixes ticket,
    // 2026-09-02).
    if (turns.length === 0) {
      if (deps.mode() !== 'solo') showNote(RECORDING_CONSENT_NOTE, 'meeting-consent-note');
      return;
    }
    renderTurns(true);
  }

  /**
   * The rolling window onto the line, one span per turn and one per word.
   * `tappable` is whether a speaker tag is the rename button (a microphone
   * meeting) or the fixed label a bot meeting's turns wear.
   */
  function renderTurns(tappable: boolean): void {
    // The zone at the end of the doc is the transcript surface when it
    // exists; the same words rolling in two places read as two meetings.
    if (liveZone) {
      clearTurnSpans();
      return;
    }
    const turns = deps.turns();
    for (const [turn, entry] of rendered) {
      if (!turns.some((t) => t.turn === turn)) {
        entry.span.remove();
        rendered.delete(turn);
      }
    }
    for (const turn of turns) {
      let entry = rendered.get(turn.turn);
      if (!entry) {
        const span = document.createElement('span');
        span.className = 'meeting-turn';
        line.append(span);
        entry = { span, tag: null, words: [], text: '' };
        rendered.set(turn.turn, entry);
      }
      // The tag comes and goes with the label — the engine attributes a turn
      // once it has heard enough of it, and may reattribute it at the end.
      const label = turn.speaker;
      if (label === undefined) {
        entry.tag?.remove();
        entry.tag = null;
      } else {
        if (!entry.tag) {
          const tag = tappable ? speakerButton() : speakerLabel();
          entry.span.prepend(tag);
          entry.tag = tag;
        }
        renderTag(entry, label);
      }
      if (entry.text === turn.text) continue;
      const words = diffTurnWords(entry.text, turn.text);
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!word) continue;
        let el = entry.words[i];
        if (!el) {
          el = document.createElement('span');
          el.className = 'w';
          entry.span.append(el);
          entry.words[i] = el;
        }
        // A leading space on every word, never a generated one: a ::before
        // cannot line-break, and at the start of a line a real space
        // collapses away.
        el.textContent = ` ${word.text}`;
        el.classList.remove('is-fixed');
        if (word.changed) {
          // Reading the box restarts the animation for a word corrected twice.
          void el.offsetWidth;
          el.classList.add('is-fixed');
        }
      }
      for (const extra of entry.words.splice(words.length)) extra.remove();
      entry.text = turn.text;
    }
  }

  function clearTurnSpans(): void {
    rendered.clear();
    line.replaceChildren();
  }

  function showNote(text: string, extra?: string): void {
    clearTurnSpans();
    const note = document.createElement('span');
    note.className = extra ? `meeting-note ${extra}` : 'meeting-note';
    note.textContent = text;
    line.append(note);
  }

  function retagSpeaker(label: string): void {
    for (const entry of rendered.values()) {
      if (entry.tag?.dataset.speaker === label) renderTag(entry, label);
    }
  }

  return { renderFeed, clearTurnSpans, showNote, retagSpeaker };
}
