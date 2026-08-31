/**
 * Recall's realtime frames, turned into the `EngineTurn`s the rest of the
 * meeting assistant already understands.
 *
 * This file is pure: no sockets, no clock, no vendor calls. Everything that
 * makes a bot meeting different from a microphone meeting is a decision about
 * NUMBERING and NAMING, and both are decisions a test should be able to drive
 * with a list of frames.
 *
 * WHY TURN NUMBERS HAVE TO BE INVENTED HERE. AssemblyAI's own stream carries
 * `turn_order` and the direct engine passes it through. Recall does not: a
 * `transcript.data` event is one finalized utterance with a participant and a
 * word list, and nothing in it says which utterance it is. But every stage
 * downstream — the append-only record, the strip, the notes composer's
 * revise-in-place — is keyed on a turn number that is stable while a turn is
 * being revised and new when a new turn starts. So this module allocates them.
 *
 * THE RULE, and why it has a same-words clause bolted onto it:
 *
 *   A partial opens a participant's turn; a final settles it. A final that
 *   arrives on an already-settled turn opens a NEW one — UNLESS its words are
 *   the same words, in which case it is a re-emission and revises in place.
 *
 * The "same words" clause is there for the double-final. AssemblyAI with
 * `format_turns` on ends every turn TWICE at the same turn order — the
 * unformatted text first, the punctuated text immediately after — and the
 * direct engine tells them apart by requiring both of its flags. Recall
 * normalises its providers and the flags do not survive, so if both finals
 * reach us they arrive as two indistinguishable `transcript.data` events. Two
 * turn numbers would put the sentence in the transcript twice, once without
 * punctuation.
 *
 * The clause is narrow in two ways, because the failure it must NOT cause is
 * the opposite one — a genuine utterance merging into the previous turn and
 * vanishing, since `recordTurn` ignores a repeat of a turn already written.
 * Words that differ are always a new turn. And words that ARE the same only
 * count as a re-emission inside {@link REEMISSION_WINDOW_MS} of the final they
 * repeat: the formatter's second pass follows the first immediately, whereas a
 * person saying "Yes." twice does not. Without the window, two identical
 * one-word answers become one and the second is lost — raised by review.
 *
 * The window is the honest discriminator available, not a certainty. Recall
 * normalises its providers and may well emit only the formatted final, in
 * which case this clause never fires — but if both do arrive they are
 * otherwise indistinguishable, and a transcript with every sentence in it
 * twice, once unpunctuated, is the worse of the two failures to ship blind.
 */

import type { EngineTurn } from './transcribe.ts';

/** A participant as Recall describes one. */
export interface RecallParticipant {
  id: number;
  name: string | null;
}

/** A realtime frame this server acts on. Anything else parses to null. */
export type RecallFrame =
  | { kind: 'transcript'; participant: RecallParticipant; text: string; final: boolean }
  | { kind: 'other'; event: string };

/**
 * Parse one websocket text frame.
 *
 * Tolerant on purpose: an event this server did not subscribe to, or a shape
 * the vendor extends, must not end a meeting. Only a frame we can fully read
 * becomes a transcript.
 */
export function parseRecallFrame(raw: string): RecallFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const top = parsed as Record<string, unknown>;
  const event = typeof top.event === 'string' ? top.event : '';
  if (!event) return null;
  if (event !== 'transcript.data' && event !== 'transcript.partial_data') {
    return { kind: 'other', event };
  }
  // The payload is doubly nested — `data.data` — on every realtime event
  // Recall documents. The outer `data` carries the artifact ids (recording,
  // bot, transcript); the inner one carries what was said.
  const outer = asRecord(top.data);
  const inner = asRecord(outer?.data);
  if (!inner) return null;
  const participant = parseParticipant(inner.participant);
  if (!participant) return null;
  const text = joinWords(inner.words);
  // An empty utterance is not an error and not a turn. Recall emits them at
  // stream boundaries; forwarding one would blank a turn already on screen,
  // because the contract says a later frame REPLACES the earlier text.
  if (!text) return null;
  return { kind: 'transcript', participant, text, final: event === 'transcript.data' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parseParticipant(raw: unknown): RecallParticipant | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = rec.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : null;
  return { id: Math.trunc(id), name };
}

/**
 * The utterance's text, from Recall's word list.
 *
 * Joined with single spaces rather than reconstructed from the timestamps:
 * `format_turns` has already produced a punctuated sentence and the words are
 * that sentence split up, so spacing is the only thing to put back.
 */
function joinWords(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  const parts: string[] = [];
  for (const word of raw) {
    const rec = asRecord(word);
    const text = rec && typeof rec.text === 'string' ? rec.text.trim() : '';
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/**
 * A speaker label for a participant id.
 *
 * The pipeline's `speaker` is an opaque LABEL that `speakerDisplayName` turns
 * into "Speaker A" until someone names it. Putting "Jordan Alvarez" in that
 * field directly would render "Speaker Jordan Alvarez" everywhere. So a bot
 * meeting synthesises a label per participant and NAMES it immediately with
 * the platform's own name — which means the entire rename machinery, the
 * record's name map, and the notes composer's display logic all work
 * unchanged, and a person can still correct a name the platform got wrong.
 *
 * Under 16 characters because `parseMeetingClientMessage` caps the label
 * there; a participant id is a small integer.
 */
export function labelForParticipant(id: number): string {
  return `p${id}`;
}

/**
 * The names a bot meeting hands to `nameSpeaker`, kept unique.
 *
 * WHY UNIQUENESS IS THIS MODULE'S PROBLEM. Composed notes carry no per-mention
 * attribution — the display name is the only handle they give — so two voices
 * called "Alex" make "Alex" in the notes ambiguous, and the notes session
 * detects exactly that and REFUSES to rewrite retroactively. A meeting with
 * two Alexes is ordinary; a meeting where renaming one silently reattributes
 * the other's words is not. Disambiguating at the seam is cheap and keeps the
 * downstream guard for the case it was written for.
 *
 * An unnamed participant gets "Guest N" rather than falling through to
 * "Speaker p7", which is the label leaking into prose.
 */
export class SpeakerNamer {
  private readonly byLabel = new Map<string, string>();
  private readonly taken = new Set<string>();
  private guests = 0;

  /** The display name for this participant, allocated once and then stable. */
  nameFor(participant: RecallParticipant): string {
    const label = labelForParticipant(participant.id);
    const existing = this.byLabel.get(label);
    if (existing !== undefined) return existing;
    const base = participant.name ?? `Guest ${++this.guests}`;
    let name = base;
    for (let n = 2; this.taken.has(name); n++) name = `${base} (${n})`;
    this.taken.add(name);
    this.byLabel.set(label, name);
    return name;
  }

  /** True the first time a participant is seen — when the name must be sent. */
  isNew(participant: RecallParticipant): boolean {
    return !this.byLabel.has(labelForParticipant(participant.id));
  }

  /** Display names in first-heard order, for the doc's bot status strip. */
  names(): string[] {
    return [...this.byLabel.values()];
  }
}

/**
 * Allocates turn numbers across participants. See the rule at the top.
 *
 * One counter for the whole meeting rather than one per participant: turn
 * numbers are the record's identity for a turn and two participants must not
 * collide on one. They interleave freely — the downstream contract treats a
 * turn number as an identity to revise, never as a position in a sequence.
 */
/**
 * How long after a final an identical final still counts as the formatter's
 * second pass rather than as something said again.
 *
 * Both events of a double-final are emitted by the same engine at the end of
 * the same turn and arrive together; two seconds is generous for that and far
 * short of the gap between one "Yes." and the next.
 */
export const REEMISSION_WINDOW_MS = 2_000;

export class TurnAllocator {
  private next = 0;
  /** The participant's turn and, once settled, its words and when they landed. */
  private readonly open = new Map<
    string,
    { turn: number; settledText: string | null; settledAt: number }
  >();

  /** `now` is a parameter so a test drives the window instead of waiting it out. */
  constructor(private readonly now: () => number = Date.now) {}

  /** The `EngineTurn` this frame produces. See the rule at the top. */
  allocate(frame: { participant: RecallParticipant; text: string; final: boolean }): EngineTurn {
    const label = labelForParticipant(frame.participant.id);
    const slot = this.open.get(label);
    const settled = slot?.settledText ?? null;
    const at = this.now();
    // A re-emission of the words that JUST settled revises them. Anything else
    // on a settled turn — different words, or the same words said again later
    // — is the next thing this person said and gets its own number.
    const reemission =
      settled !== null &&
      frame.final &&
      settled === normalizeWords(frame.text) &&
      at - (slot?.settledAt ?? 0) <= REEMISSION_WINDOW_MS;
    let turn: number;
    if (!slot || (settled !== null && !reemission)) {
      turn = this.next++;
      this.open.set(label, { turn, settledText: null, settledAt: 0 });
    } else {
      turn = slot.turn;
    }
    if (frame.final) {
      this.open.set(label, { turn, settledText: normalizeWords(frame.text), settledAt: at });
    }
    return { turn, text: frame.text, final: frame.final, speaker: label };
  }
}

/**
 * The words of an utterance with everything the formatter adds taken back off
 * — case and punctuation. "so the sync is the bottleneck" and "So the sync is
 * the bottleneck." normalise to the same string; two different sentences do
 * not, however similar they look.
 */
function normalizeWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
