/**
 * Who else is on this doc — the one fact the browser holds about whether the
 * person pressing Record is alone.
 *
 * Nothing on the client can hear the room, so "alone" is answered from the
 * doc's presence: the awareness states of everyone connected to it. It is a
 * proxy, and an honest one in both directions the product cares about. A
 * doc with nobody else on it is the working session the assistant was built
 * for ("assume by default that Bryan is alone"), and a tap there should
 * record, not ask. A doc with a collaborator on it is a session with a
 * second person in it, and the questions the start chooser asks — who the
 * microphone will hear, whether a bot goes instead — have answers again.
 *
 * Two entries are not somebody else: a nameless state (the server's own, or
 * a tab still choosing a name), and the same person in a second tab — the
 * iPad and the laptop open on one doc are one person, not a meeting.
 */

/** The slice of a Yjs awareness this needs: its own id and everyone's state. */
export interface DocPresence {
  clientID: number;
  getStates(): Map<number, unknown>;
}

/** The person asking, as awareness carries them. `id` is absent on older tabs. */
export interface PresentSelf {
  id?: string;
  name: string;
}

/**
 * The distinct other people on the doc, by display name, sorted. Empty means
 * the person asking is alone here.
 */
export function othersOnDoc(presence: DocPresence, self: PresentSelf): string[] {
  const others = new Set<string>();
  presence.getStates().forEach((raw, clientId) => {
    if (clientId === presence.clientID) return;
    const user = (raw as { user?: { id?: unknown; name?: unknown } } | null | undefined)?.user;
    const name = typeof user?.name === 'string' ? user.name.trim() : '';
    if (!name) return;
    const id = typeof user?.id === 'string' ? user.id : undefined;
    // Ids when both sides have one — a rename mid-session is still the same
    // person — and the name otherwise, which is all an older tab sends.
    const samePerson =
      id !== undefined && self.id !== undefined ? id === self.id : name === self.name.trim();
    if (samePerson) return;
    others.add(name);
  });
  return [...others].sort((a, b) => a.localeCompare(b));
}
