/**
 * Which SSE events are the AGENT's business at all.
 *
 * Every event a watched doc's stream carries reaches `handleFrame`, and until
 * this gate every one that survived dedup became a channel notification — a
 * wake turn for the session. That was fine while the stream carried only
 * things an agent acts on: a comment, a suggestion, a task moving, a decision.
 * It stopped being fine when a bot meeting's live transcript joined the
 * stream (`meeting.transcript`, one frame per vendor partial, hundreds per
 * hour): the frames are transient by design and carry no `eid`, so dedup has
 * nothing to key on and forwards every one. Measured before this gate: 11
 * vendor frames, 11 wake turns. Every agent that ever touched the doc
 * auto-watches it, so an hour-long call was thousands of turns per agent.
 *
 * `meeting.*` is dropped WHOLE, not just the transcript. The lifecycle facts
 * (`meeting.started`, `meeting.stopped`, `meeting.bot`) are for the strip a
 * person is looking at; an agent's view of a meeting is the notes the
 * composer writes into the doc, which `get_doc` reads on demand. A wake per
 * status change bought nothing an agent could act on and cost a turn each —
 * they leaked through at a handful per meeting before this, and nothing
 * missed them.
 *
 * This is a gate on the EVENT NAME, deliberately separate from the dedup: the
 * dedup answers "have I delivered this exact event already" and fails OPEN,
 * because a dropped comment is silence; this answers "is this kind of event
 * ever delivered", and fails CLOSED only for the prefixes named here.
 */
export function isChannelEvent(event: string): boolean {
  if (event.startsWith('meeting.')) return false;
  return true;
}
