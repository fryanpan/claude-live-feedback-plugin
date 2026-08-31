/**
 * The voices a meeting had, for the one question a reader asks of a speaker
 * tag: "not them — it was HER."
 *
 * Reassigning a mention means picking a voice, and a label picks nothing: a
 * person recognises "Speaker B" by the last thing Speaker B said, not by the
 * letter the engine gave them. So a roster entry carries the name to show,
 * the label to write, and the words that let someone tell the two apart.
 *
 * Derived, never stored. The transcript already says who spoke and the
 * meeting record already says what each voice is called; a second copy of
 * that would be a third thing to keep true.
 */

import { speakerDisplayName } from './meeting.ts';

/** As much of a settled turn as the roster reads. */
export interface RosterTurn {
  text: string;
  /** The engine's label. Absent on a turn diarization gave to nobody. */
  speaker?: string;
}

/** One voice, ready to be offered. */
export interface RosterVoice {
  /** What the tag's href will carry. */
  label: string;
  /** What the reader sees, named or not. */
  name: string;
  /** The last thing this voice said, or '' if it has been named but has
   *  not spoken yet. Empty is a real state, not a missing value. */
  lastSaid: string;
}

/**
 * Every voice this meeting can attribute anything to, ordered by label.
 *
 * Ordered by LABEL rather than by recency so the list holds still: a menu
 * that reshuffles between the moment someone reads it and the moment they
 * tap is a menu that gets mis-tapped, and the whole point of this one is
 * correcting a mis-attribution rather than making another.
 *
 * A named voice appears even with nothing said yet — naming happens on the
 * strip and can land before that voice's first turn settles, and a roster
 * that waited would refuse the person the name they had just given.
 */
export function speakerRoster(
  turns: readonly RosterTurn[],
  names: Readonly<Record<string, string>>,
): RosterVoice[] {
  const lastSaid = new Map<string, string>();
  for (const turn of turns) {
    // A turn with no label belongs to nobody: solo capture, or a voice
    // diarization could not place. It names no one, so it offers no one.
    if (turn.speaker === undefined) continue;
    lastSaid.set(turn.speaker, turn.text);
  }
  const labels = new Set([...lastSaid.keys(), ...Object.keys(names)]);
  return [...labels]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({
      label,
      name: speakerDisplayName(label, names),
      lastSaid: lastSaid.get(label) ?? '',
    }));
}
