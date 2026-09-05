/**
 * Who an actor IS: person or agent, and which identity a stored id stands for
 * now.
 *
 * Split out of `activity.ts` (A7), which is about writing an append-only
 * event stream. The two only ever sat together because every row that stream
 * writes has to name its actor — but the stream is a file format and this is
 * a registry, and 23 of the 24 files that import `activity.ts` want only this
 * half.
 *
 * THE MODULE-LEVEL STATE LIVES HERE AND NOWHERE ELSE. The owner ids, the
 * identity links and the roster handle are process-wide by design — the
 * `isOwnerActor` note below argues why — so the split had to move them rather
 * than copy them. `activity.ts` imports what it needs from this file and this
 * file imports nothing at all; a second registry, reached through a second
 * import path, would answer "no" for half the callers with nothing to see.
 *
 * The roster is reached through an INTERFACE (`ActivityIdentityRoster`) for
 * the same reason it was before: `identities.ts` imports this module, so this
 * module may not import it.
 */
export type ActorKind = 'person' | 'agent';

/**
 * Classify a comment author as `person` or `agent`. Agent identities are the
 * generic "known-agent" one, per-agent MCP identities (`agent-<slug>` ids
 * from CW_AGENT_NAME), a literal "Agent" name, an author that declares
 * `kind: 'agent'`, or an author whose `kind` is missing entirely. Everyone
 * else is a person. Agent events are still recorded (so WR can filter them)
 * but person events are the ones that must never be dropped.
 *
 * `kind` carries two different meanings and that is the whole subtlety here.
 * On a browser `User` it is the identity axis (`'known' | 'anon'`), and its
 * mere PRESENCE is what used to mean "a real browser session, therefore a
 * person". But a REST/MCP caller reasonably reads the field as the actor axis
 * and sends `kind: 'agent'` — and under the presence test that landed as
 * `person`, so the honest caller was misfiled as a human while the caller who
 * said nothing was classified correctly. Reported from the field by an agent
 * that populated the field the obvious way.
 *
 * Two properties this ordering is built to have:
 *  - An explicit actor-axis value is honoured, so a client can just say what
 *    it is instead of encoding it in an id.
 *  - Every agent signal is checked BEFORE `kind: 'person'`, so contradictory
 *    input resolves to `agent`. That direction is deliberate: an agent filed
 *    as a person launders the audit log AND trips the reply-reopen rule in
 *    doc-store.ts (which exists precisely so an agent's closing note doesn't
 *    resurrect a thread a human just resolved), whereas a person filed as an
 *    agent only over-filters a view.
 */
/**
 * Read `id` and `name` off a comment author of unknown shape.
 *
 * The TYPE says `User`; the DATA does not. Authors are persisted in the CRDT
 * by whatever wrote them, across months and several shapes of the field, and
 * nothing revalidates a CRDT on load. Measured on the live corpus: 26 of 1,825
 * comments carry an author that is a bare STRING — `"author": "claude"` sitting
 * in the same thread as a well-formed `{ id: 'known-bryan', name: 'Bryan' }`.
 *
 * That string is the author's NAME, so it is recoverable, and every reader was
 * discarding it. `activity-backfill.ts` wrote those rows with `actorName:
 * undefined` — no crash, which is why it went unnoticed, but the weekly review
 * reads that stream and 26 of its rows named nobody.
 *
 * One reader for all three call sites, because the failure they share is
 * reading a field off a value whose shape they assumed. Returns `undefined`
 * for anything it cannot read as a string rather than passing the wrong type
 * through — a numeric `id` reaching a consumer that expects a string is the
 * same class of bug one layer further on.
 */
export function authorFields(author: unknown): { id?: string; name?: string } {
  if (typeof author === 'string') return { id: undefined, name: author };
  const a: { id?: unknown; name?: unknown } =
    author && typeof author === 'object' ? (author as { id?: unknown; name?: unknown }) : {};
  return {
    id: typeof a.id === 'string' ? a.id : undefined,
    name: typeof a.name === 'string' ? a.name : undefined,
  };
}

// `unknown`, not `Pick<User, 'id' | 'name'>`. The old signature asserted a
// shape this function exists BECAUSE the data does not have — it was written
// at a boundary years of CRDT writes ago, nothing revalidates a persisted doc
// on load, and the reward for believing it was a 500 on every page that reads
// across docs. A parameter type that lies costs more than it buys: it makes
// the malformed case unrepresentable in a test while leaving it reachable in
// production.
export function classifyActor(author: unknown): ActorKind {
  // The TYPE says this is a User; the DATA does not. Comment authors are
  // persisted in the CRDT by whatever wrote them, across months and several
  // shapes of the field, so an old row can carry an author with no `id` — or
  // an author that is a bare string. Reading `.id.startsWith` off one of those
  // throws, and it threw in production the first time this ran over every doc
  // on the server rather than over one live workspace's threads.
  //
  // So read the fields defensively and keep every decision below identical for
  // input that HAS them. An author we cannot read declares nothing, which is
  // the same state as `kind == null` — and that already falls through to
  // `agent`, in the safe direction argued for above.
  const a: { kind?: unknown } = author && typeof author === 'object' ? author : {};
  const { id = '', name = '' } = authorFields(author);
  // Case-folded because the field is hand-populated by outside callers, and
  // `kind: 'Agent'` matching nothing would fall all the way through to the
  // `person` default — reintroducing the exact misfiling this function was
  // changed to fix, for a caller who did declare itself.
  const kind = typeof a.kind === 'string' ? a.kind.toLowerCase() : undefined;
  if (kind === 'agent') return 'agent';
  if (id === 'known-agent') return 'agent';
  if (id.startsWith('agent-')) return 'agent';
  if (name === 'Agent') return 'agent';
  if (kind === 'person') return 'person';
  if (a.kind == null) return 'agent';
  return 'person';
}

/**
 * Ids that mean the fleet owner.
 *
 * Seeded with the two spellings that predate email identity — the id is the
 * browser identity, the name is what a REST/MCP caller sends, and both are
 * load-bearing. `registerOwnerIdentity` adds the owner's `user-<hash>` once
 * the server knows which address is theirs.
 *
 * WHY A MODULE-LEVEL REGISTRY AND NOT A PARAMETER. `isOwnerActor` is called
 * from three places (`doc-store.ts` twice, `activity-backfill.ts` twice) that sit
 * far below any request and hold no configuration to thread through. The
 * alternative — an options bag pushed down four call layers — buys nothing a
 * registry does not, and the registry is set exactly once, at server
 * construction.
 */
const OWNER_IDS = new Set<string>(['known-bryan']);
/** Matched EXACTLY, case included: widening it here would change who counts
 *  as the owner on the existing corpus, which is not what this fixes. */
const OWNER_NAMES = new Set<string>(['Bryan']);

/** The owner's display names, for the roster's rename refusal: an agent
 *  may not attach under a name that every owner check reads as the owner. */
export function ownerDisplayNames(): string[] {
  return [...OWNER_NAMES];
}

/**
 * Teach the owner check an identity id — the owner's email identity.
 *
 * Without this, the moment the owner's identity becomes `user-<hash>` the
 * check below stops matching and fails SILENTLY: no error, no warning, just
 * an owner-activity view that quietly reads empty and a weekly review that
 * under-counts. It is the same shape of drift `agentIdForName` exists to
 * prevent, and it fails the same way — by answering "no" forever.
 */
export function registerOwnerIdentity(id: string): void {
  const trimmed = id.trim();
  if (trimmed) OWNER_IDS.add(trimmed);
}

/** What the owner check currently recognizes — for a boot log and for tests. */
export function ownerIdentityIds(): string[] {
  return [...OWNER_IDS];
}

/** Back to the built-in spellings, links cleared. A test seam: both
 *  registries are process-wide, so a test that adds to one must be able to
 *  put it back — and a link that leaked between tests would silently make an
 *  unrelated actor the owner. */
export function resetOwnerIdentities(): void {
  OWNER_IDS.clear();
  OWNER_IDS.add('known-bryan');
  resetIdentityLinks();
  IDENTITY_ROSTER = undefined;
}

/**
 * Explicit "this actor id IS that identity" links, actor id -> identity id.
 *
 * WHY THIS EXISTS. An anonymous browser session gets an `anon-*` id and
 * whatever name the person types. Measured on the live stream, six such ids
 * typed the owner's full name across 1,120 events and every one recorded
 * `isOwner: false`, because the name check above matches one exact spelling.
 *
 * WHY NOT JUST ADD THE OTHER SPELLING. A name is a claim the browser makes
 * about itself and nothing verifies it, so a looser name match starts
 * attributing SOMEBODY ELSE's rows to the owner. That error is worse than the
 * under-count it replaces, because nothing downstream can tell it happened.
 * A link is evidence a person entered once, about one id.
 *
 * The map is populated from `<dataDir>/identity-links.json` at server
 * construction and at the top of a backfill run — see identity-links.ts. It
 * is data rather than literals because the population that needs it grows: a
 * new browser profile mints a new id, and that must be a one-line edit to a
 * file, not a code change and a release.
 */
const IDENTITY_LINKS = new Map<string, string>();

/** How many hops `resolveIdentityId` will follow before giving up. A cycle in
 *  a hand-edited file must terminate, not hang the boot that reads it. */
const MAX_LINK_HOPS = 8;

/**
 * Record that `fromId` is the same person as `toId`. Blank ends and
 * self-links are ignored — neither says anything, and a self-link would spin
 * the resolver.
 */
export function linkIdentity(fromId: string, toId: string): void {
  const from = fromId.trim();
  const to = toId.trim();
  if (!from || !to || from === to) return;
  IDENTITY_LINKS.set(from, to);
}

/** What the link map currently holds — for a boot log and for tests. */
export function identityLinks(): Record<string, string> {
  return Object.fromEntries(IDENTITY_LINKS);
}

/** Drop every link. The test seam for the process-wide map. */
export function resetIdentityLinks(): void {
  IDENTITY_LINKS.clear();
}

/**
 * Replace the whole map with exactly these pairs.
 *
 * The registry is process-wide while the FILE is per data dir, so a load has
 * to be a replacement rather than an addition. Adding was wrong in two silent
 * ways: a second `createServer` on a different data dir kept the first dir's
 * links, so an actor could be read as the owner while processing a directory
 * that never named them; and a file that went missing or stopped parsing kept
 * every link from the load before it — the opposite of what an unreadable
 * config should mean.
 */
export function replaceIdentityLinks(pairs: Iterable<readonly [string, string]>): void {
  IDENTITY_LINKS.clear();
  for (const [from, to] of pairs) linkIdentity(from, to);
}

/**
 * The slice of the roster (identities.ts) the activity readers consult. An
 * interface, so this module — which the roster's own test seams import —
 * never imports the roster. Wired once at server construction, like the
 * owner registry above and for the same reason: `isOwnerActor` is called
 * from places that hold no configuration to thread through.
 */
export interface ActivityIdentityRoster {
  get(id: string): { id: string; displayName: string } | null;
}

let IDENTITY_ROSTER: ActivityIdentityRoster | undefined;

/** Wire (or clear) the roster. Cleared by `resetOwnerIdentities` too. */
export function setIdentityRoster(roster: ActivityIdentityRoster | undefined): void {
  IDENTITY_ROSTER = roster;
}

/**
 * Follow an id's links to the identity it stands for. An unlinked id resolves
 * to itself, so this is safe to call on every actor.
 *
 * The roster is asked FIRST: an id merged into a roster row (`mergedFrom`)
 * resolves to that row, and only then do the link-file hops run — so a link
 * that points an anon id at a legacy owner spelling still lands on the
 * roster row that spelling was itself merged into.
 */
export function resolveIdentityId(id: string): string {
  let current = id;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const rostered = IDENTITY_ROSTER?.get(current)?.id;
    if (rostered !== undefined && rostered !== current) {
      current = rostered;
      continue;
    }
    const next = IDENTITY_LINKS.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Who a stored row's actor is NOW — the canonical id and the roster's name
 * for it. History is never rewritten; this is the read that makes an old id
 * render as the identity it was merged into. A row the roster does not know
 * reads exactly as stored.
 */
export function resolveActor(row: { actorId?: string; actorName?: string }): {
  id: string;
  name: string;
} {
  const id = row.actorId ?? '';
  const resolved = id ? resolveIdentityId(id) : id;
  const rec = resolved ? IDENTITY_ROSTER?.get(resolved) : null;
  return { id: resolved, name: rec?.displayName ?? row.actorName ?? '' };
}

/** Bryan is the doc owner / known person on this single-user fleet. A person
 *  whose author id resolves to a known owner identity is the owner. */
export function isOwnerActor(author: unknown): boolean {
  // Same normalization as `classifyActor`, for the same reason: a legacy
  // string author naming the owner IS the owner, and `author.id` on a null
  // author throws.
  const { id = '', name = '' } = authorFields(author);
  // The id is resolved through the link map first, so a linked `anon-*`
  // session is recognized by the SAME owner-id check as every other identity
  // — the link widens who is known, never how loosely a name is matched.
  return OWNER_IDS.has(resolveIdentityId(id)) || OWNER_NAMES.has(name);
}
