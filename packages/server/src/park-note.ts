/**
 * The comment a park writes.
 *
 * Parking used to be a state on the row (`parkedUntil` + `parkedReason`), and
 * the owner's call on 2026-08-27 was that it duplicated `triage`: both mean
 * "nobody is working this, and nobody has agreed it is work yet". So the state
 * went and the verb stayed — `park_task` moves the row to triage and leaves
 * this note behind.
 *
 * That trade only works if the note carries everything the two fields did.
 * A date alone said a decision had been made and not what it was waiting for;
 * a reason alone left nobody knowing when to look again. Both halves are in
 * one line here, and the DATE leads, because the reader this is written for is
 * scanning triage for what is due back.
 *
 * Pure, and shared by the route and the startup migration on purpose: the row
 * migrated out of the old state and the row parked tomorrow have to read the
 * same, or the board's history reads as two different products.
 */

export interface ParkNote {
  /** When to come back to it. Absent is a real answer — "not now, and I don't
   *  know when" is what a lot of parks honestly are — and it is spelled out
   *  rather than left blank, so nobody reads a missing date as a lost one. */
  until?: number;
  /** Why, in the parker's words. */
  reason?: string;
  /** The status the row left, when it left one. Omitted for a row already in
   *  triage: "todo → triage" is the half a later reader needs, and printing
   *  "triage → triage" would be noise dressed as a fact. */
  from?: string;
  /** True for a row the startup migration moved out of the removed `parked`
   *  state. Marked because this note is then machine-written from metadata
   *  somebody else entered, on a date long after they entered it. */
  migrated?: boolean;
}

/** `2026-08-28` — UTC, and deliberately not a locale format. The stored parks
 *  are UTC midnights, and a note read on two machines must name one day. */
export function parkDate(until: number): string {
  return new Date(until).toISOString().slice(0, 10);
}

export function parkNoteText(note: ParkNote): string {
  const when = note.until !== undefined ? `Revisit ${parkDate(note.until)}.` : 'No revisit date.';
  const moved = note.from !== undefined ? ` Moved from ${note.from}.` : '';
  const head = `**Parked → triage. ${when}**${moved}`;
  const why = note.reason?.trim();
  const body = why ? `\n\n${why}` : '';
  const tail = note.migrated
    ? '\n\nCarried over from the removed `parked` state — the date and reason above are the ones the row was parked with.'
    : '';
  return `${head}${body}${tail}`;
}
