/**
 * How a `voice.request` event reads to the agent that receives it.
 *
 * The row rides the per-workspace channel every attached agent hears, and for
 * as long as the fast path could only NAVIGATE there were exactly two things
 * one could be: a lookup the server already answered (drop it — nothing
 * happened and nothing is pending), or an utterance that needs judgment
 * (render the imperative, "act on it through the task/edit tools").
 *
 * `fast-path-action` is a third thing, and the old two-way rendering gets it
 * wrong in the dangerous direction. The board ALREADY MOVED — the server set
 * the status, reassigned the row, posted the comment, answered the review
 * item — and the imperative describes all of that as work still to do. For a
 * status change a second application is caught by `same-status`; for an
 * assignee it is not, and for a spoken comment it posts the same words twice
 * under the speaker's name.
 *
 * So the row must still be DELIVERED (it is the one voice row an agent most
 * needs to see: something changed on its board that it did not do) while
 * saying the opposite thing about what to do with it.
 *
 * Kept out of mcp.ts — which exports nothing, being a bundle entry point —
 * for the same reason `nudge-line.ts` is: the wording is a decision, and
 * inline in a 3,000-line switch it is untestable. Composed entirely from
 * fields already on the payload (`route`, `transcript`, `ack`, `context`), so
 * no new event field is needed and the visitor's drop-list stays correct.
 */

export interface VoiceRequestPayload {
  /** Which route handled the utterance. `VoiceRoute` on the server side;
   *  widened to `string` here because this renders whatever arrives on the
   *  wire, including from a server newer than this bundle. */
  route?: string;
  /** The utterance VERBATIM (§3.8: changes carry the transcript verbatim). */
  transcript?: string;
  /** The explicit reply the speaker saw. On an action route this is the
   *  record of WHAT CHANGED — "Moved X to done" — which is why it is worth
   *  more here than on any other route. */
  ack?: string;
  actor?: { id?: string; name?: string };
  /** Where the speaker was standing when they said it. */
  context?: { surface?: string; docId?: string; taskId?: string; visibleHeading?: string };
}

/** Mirrors mcp.ts's helper of the same name. Duplicated rather than shared
 *  because mcp.ts is a bundle entry point and exports nothing; the copy is
 *  what lets the rendered line be asserted end-to-end from a test. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The anchor the utterance carried, rendered only for the parts present — a
 *  missing field drops out rather than reading as the word "undefined". */
function where(p: VoiceRequestPayload): string {
  const c = p.context;
  if (!c) return '';
  return ` (at ${c.surface ?? '?'}${c.docId ? ` ${c.docId}` : ''}${c.taskId ? ` ${c.taskId}` : ''}${
    c.visibleHeading ? `, near "${c.visibleHeading}"` : ''
  })`;
}

/**
 * Render the body for a `voice.request` event, or `null` when the event must
 * not be forwarded at all.
 *
 * Every route is an explicit branch. The suppression used to be a guard
 * clause at the top, which meant a new route joined the imperative by
 * OMISSION — which is exactly how `fast-path-action` came to be described to
 * agents as work to do. A route added to the server without a branch here
 * still renders the imperative, and that remains the right default: the
 * failure mode is an agent asked to look at something already handled, never
 * a board change that reaches nobody. Silence has no recovery path — an
 * utterance is not replayed.
 */
export function voiceRequestLine(p: VoiceRequestPayload): string | null {
  // A lookup the server already answered. Nothing moved, nothing is pending,
  // so the row is pure context noise.
  if (p.route === 'fast-path') return null;

  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  const said = `[voice.request]${by}${where(p)}: "${p.transcript ?? ''}"`;
  const told = truncate(p.ack ?? '', 120);

  // The server already wrote it. Say so, and say what to do instead of it.
  if (p.route === 'fast-path-action') {
    return (
      `${said} — the fast path ALREADY applied this to the board on the speaker's behalf; ` +
      `they were told: "${told}". Do NOT redo it — reconcile your own picture of the board ` +
      'with what changed, and pick up only whatever the utterance asked for beyond it.'
    );
  }

  return `${said} — act on it through the task/edit tools; the speaker was told: "${told}"`;
}
