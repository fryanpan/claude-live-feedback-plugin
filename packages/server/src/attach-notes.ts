/**
 * What an attach found, said in sentences.
 *
 * `attach_agent` answered with fields and no reading of them: `lead: false`
 * is the same value whether a working peer holds the seat or an id that
 * exited hours ago holds it, and `watches: []` is the same value whether a
 * session has not subscribed yet or has just lost every subscription it had
 * to a rename. On 2026-08-29/30 both readings were the wrong one for 4.5
 * hours and the response looked completely ordinary throughout.
 *
 * So the notes name the GAP, never the healthy state. A line here means
 * something is wrong that this session can act on; silence means there is
 * nothing to say. That is deliberate — a note on every attach is a note
 * nobody reads, and this has to still be legible on the day it matters.
 */

export interface AttachSeatView {
  leadAgentId?: string;
  live: boolean;
  stale: boolean;
  notice?: string;
}

export interface AttachOutcome {
  /** Does THIS session hold the seat now? */
  lead: boolean;
  seat: AttachSeatView;
  /** Set when this attach took the seat from a holder that was gone. */
  seatTakenFrom?: string;
}

export function attachNotes(outcome: AttachOutcome, watching: number): string[] {
  const notes: string[] = [];
  if (outcome.seatTakenFrom !== undefined) {
    notes.push(
      `You have taken this board's lead seat from ${outcome.seatTakenFrom}, which was off ` +
        'the wire and past the stale window. That id was the addressee for every ' +
        'lead-addressed delivery here, so anything queued for it was going nowhere. The ' +
        'handover is recorded on the board like any other.',
    );
  } else if (outcome.seat.stale && outcome.seat.notice) {
    // Reachable when the attaching session is not eligible to hold the seat.
    // Naming it is the whole point: somebody has to be told.
    notes.push(outcome.seat.notice);
  }
  if (watching === 0) {
    notes.push(
      'You are watching nothing on this board. An empty watch set reads the same whether ' +
        'you have not subscribed yet or a rename left your subscriptions behind on your ' +
        'old agent id — if you restarted under a new name, they are on the old one. ' +
        'Re-subscribe to the docs you work, or board comments will not reach you.',
    );
  }
  return notes;
}
