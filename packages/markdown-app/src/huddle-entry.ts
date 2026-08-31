/**
 * The editor's side of the Board's "Start a planning huddle".
 *
 * The button's click is the person's gesture, and a full navigation does not
 * carry it into the editor — so the Board puts a flag on the address and the
 * markdown mount reads it ONCE, asking for the mic on load and then taking
 * the flag back out of the address so a reload or a later Back into this
 * entry does not open a mic nobody pressed for.
 *
 * The "Huddle" word in the crumb is a different fact: it is about the DOC
 * (its meta says it is a huddle) and shows on every visit, so the router
 * applies it beside the back arrow, as shell chrome that outlives each mount.
 */

import { type CaptureMode, parseCaptureMode, parseRoomSpeakers } from '@feedback/core';
import { type RoomAudioProcessing, parseRoomAudio } from './meeting-audio.ts';

/** `?huddle=1` — set by the Board, consumed by the markdown mount. */
export const HUDDLE_START_PARAM = 'huddle';

/**
 * `?mode=conversation` — the Board's "Record a conversation" button. The
 * choice is made on the Board because that press is the only thing that says
 * anyone else is in the room: nothing announces an in-person conversation.
 */
export const HUDDLE_MODE_PARAM = 'mode';

/**
 * `?speakers=3` — how many people are in the room, when somebody says.
 *
 * Read on EVERY visit rather than only on a huddle start, and left on the
 * address when the one-shot flags are taken off, because it is not a gesture:
 * it is a fact about the room that stays true across a reload and across the
 * strip's own switch being flipped by hand.
 */
export const ROOM_SPEAKERS_PARAM = 'speakers';

/**
 * `?mic=ec1-ns0-agc0` — which of the browser's microphone processors this
 * capture asks for. Same rule as `speakers`: a property of the room's
 * hardware, not of the press, so it survives the reload.
 *
 * It exists because the measurement in `scripts/room-labels-check.ts` needs
 * the SAME room recorded under different settings, and the only place those
 * settings can be applied is the browser that opens the microphone.
 */
export const ROOM_MIC_PARAM = 'mic';

/** How many voices this address expects, if it says. */
export function huddleRoomSpeakers(search: string): number | undefined {
  return parseRoomSpeakers(new URLSearchParams(search).get(ROOM_SPEAKERS_PARAM));
}

/** The microphone processing this address asks for, if it says. */
export function huddleRoomAudio(search: string): RoomAudioProcessing | undefined {
  return parseRoomAudio(new URLSearchParams(search).get(ROOM_MIC_PARAM));
}

/** Whether this address asks the editor to start the meeting on load. */
export function wantsHuddleStart(search: string): boolean {
  return new URLSearchParams(search).get(HUDDLE_START_PARAM) === '1';
}

/** What the huddle on this address listens for. Solo unless it says so. */
export function huddleCaptureMode(search: string): CaptureMode {
  return parseCaptureMode(new URLSearchParams(search).get(HUDDLE_MODE_PARAM));
}

/** The same address with the flag taken out; everything else stays. */
export function withoutHuddleStart(href: string): string {
  const q = href.indexOf('?');
  if (q < 0) return href;
  const hashAt = href.indexOf('#', q);
  const path = href.slice(0, q);
  const search = href.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const hash = hashAt < 0 ? '' : href.slice(hashAt);
  const params = new URLSearchParams(search);
  params.delete(HUDDLE_START_PARAM);
  // Both halves of the same one-shot gesture: leaving the mode behind would
  // make a reload of this address a conversation nobody asked for.
  params.delete(HUDDLE_MODE_PARAM);
  const rest = params.toString();
  return `${path}${rest ? `?${rest}` : ''}${hash}`;
}

/**
 * Whether this browser has been told it may only read.
 *
 * A latch, and the reason it is one: the crumb is written on EVERY
 * navigation, unconditionally, because a word left over from the last doc is
 * a wrong label on this one. So a caller that sets "Reading:" once has it
 * overwritten by the next in-place navigation, and the surface goes back to
 * announcing "Editing:" to somebody who cannot edit. The fact belongs to the
 * browser, not to the visit, so it is remembered here and re-applied by the
 * same function that would otherwise undo it.
 */
let readingOnly = false;
/** The last thing the crumb was told, so the latch can re-render it. */
let lastHuddle = false;

/** Say this browser may only read, and repaint the crumb now. */
export function applyReadingCrumb(doc: Document): void {
  readingOnly = true;
  applyHuddleCrumb(doc, lastHuddle);
}

/** Test seam — the latch is module state and outlives a single test. */
export function resetReadingCrumbForTest(): void {
  readingOnly = false;
  lastHuddle = false;
}

/**
 * Name a huddle doc in the crumb, or put "Editing:" back for the next doc.
 * Always writes every branch — navigation is in place, and a word left over
 * from the last doc is a wrong label on this one.
 *
 * "Huddle" survives the reading latch: it names WHAT the doc is, not what
 * you may do to it. "Editing:" does not, because it claims the second thing.
 */
export function applyHuddleCrumb(doc: Document, huddle: boolean): void {
  lastHuddle = huddle;
  const label = doc.querySelector('.doc-crumb .doc-label');
  if (!label) return;
  label.textContent = huddle ? 'Huddle' : readingOnly ? 'Reading:' : 'Editing:';
  label.classList.toggle('doc-label-huddle', huddle);
}
