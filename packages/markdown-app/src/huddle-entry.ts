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

import { type CaptureMode, parseCaptureMode } from '@feedback/core';

/** `?huddle=1` — set by the Board, consumed by the markdown mount. */
export const HUDDLE_START_PARAM = 'huddle';

/**
 * `?mode=conversation` — the Board's "Record a conversation" button. The
 * choice is made on the Board because that press is the only thing that says
 * anyone else is in the room: nothing announces an in-person conversation.
 */
export const HUDDLE_MODE_PARAM = 'mode';

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
 * Name a huddle doc in the crumb, or put "Editing:" back for the next doc.
 * Always writes both branches — navigation is in place, and a word left over
 * from the last doc is a wrong label on this one.
 */
export function applyHuddleCrumb(doc: Document, huddle: boolean): void {
  const label = doc.querySelector('.doc-crumb .doc-label');
  if (!label) return;
  label.textContent = huddle ? 'Huddle' : 'Editing:';
  label.classList.toggle('doc-label-huddle', huddle);
}
