import type { User } from './types.ts';

const KNOWN_USERS: Record<string, { name: string; color: string }> = {
  bryan: { name: 'Bryan', color: '#2e7dd7' },
  agent: { name: 'Agent', color: '#e36f1e' },
};

function hashToColor(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return hslToHex(hue, 55, 55);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function randomAnonId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Names for guests who land on a share link and don't pick one.
 *
 * A raw id ("Anon-a3f9k2") is unusable in a review: nobody can say it out
 * loud, and two of them are indistinguishable at a glance. An animal is
 * pronounceable, memorable, and obviously a placeholder rather than a
 * claim to be someone.
 *
 * Kept to single common words so "Anonymous <X>" always reads naturally,
 * and deliberately free of anything that could land as a jab at the person
 * it gets assigned to.
 */
export const GUEST_ANIMALS = [
  'Turtle',
  'Otter',
  'Badger',
  'Heron',
  'Falcon',
  'Panda',
  'Walrus',
  'Ibex',
  'Lemur',
  'Marmot',
  'Narwhal',
  'Ocelot',
  'Puffin',
  'Quokka',
  'Raccoon',
  'Tapir',
  'Wombat',
  'Yak',
  'Zebra',
  'Antelope',
  'Bison',
  'Capybara',
  'Dolphin',
  'Egret',
  'Ferret',
  'Gecko',
  'Hedgehog',
  'Iguana',
  'Kestrel',
  'Lynx',
  'Manatee',
  'Newt',
  'Osprey',
  'Pelican',
  'Salamander',
  'Toucan',
  'Vole',
  'Weasel',
  'Albatross',
  'Beaver',
  'Cormorant',
  'Dormouse',
  'Elk',
  'Finch',
  'Gopher',
  'Hare',
  'Jackdaw',
  'Kingfisher',
] as const;

/**
 * The guest name for a stable anon id — DERIVED, not drawn at random, so a
 * guest keeps the same animal across reloads. Their comments already hang
 * off this id; a name that reshuffled on every load would make one person
 * look like a crowd.
 *
 * A hash over a finite list collides, so this is not a uniqueness
 * guarantee. Two guests who draw the same animal still get different
 * colors (both derive from the id, and the color space is far larger).
 */
export function guestNameFor(anonId: string): string {
  let h = 0;
  for (let i = 0; i < anonId.length; i++) {
    h = (h * 31 + anonId.charCodeAt(i)) >>> 0;
  }
  return `Anonymous ${GUEST_ANIMALS[h % GUEST_ANIMALS.length]}`;
}

type IdentityStorage = { get(k: string): string | null; set(k: string, v: string): void };

const ANON_ID_KEY = 'feedback-anon-id';
const NAME_KEY = 'feedback-user-name';
const PROMPT_DISMISSED_KEY = 'feedback-name-prompt-dismissed';

function storedName(storage: IdentityStorage | null): string | null {
  const raw = storage?.get(NAME_KEY)?.trim();
  return raw ? raw : null;
}

function stableAnonId(storage: IdentityStorage | null): string {
  let anon = storage?.get(ANON_ID_KEY) ?? null;
  if (!anon) {
    anon = randomAnonId();
    storage?.set(ANON_ID_KEY, anon);
  }
  return anon;
}

/**
 * What to print for a comment's author. The shared "agent" identity —
 * `known-agent`, or the bare word as a name — is what every session launched
 * without a name collapsed into for months, so those rows belong to nobody
 * in particular and say so: "Unnamed agent". Every other author renders as
 * stored. Read-time only; nothing in the doc changes.
 */
export function authorLabel(author: { id?: string; name?: string } | undefined): string {
  if (!author) return '';
  const id = author.id?.trim() ?? '';
  const name = author.name ?? '';
  if (id === 'known-agent' || id === 'agent' || name.trim().toLowerCase() === 'agent') {
    return 'Unnamed agent';
  }
  return name;
}

/** The full known identity for a name/key (`bryan`, `Agent`, …), or null. */
export function knownUserForName(nameOrKey: string): User | null {
  const key = nameOrKey.toLowerCase();
  const meta = KNOWN_USERS[key];
  if (!meta) return null;
  return { id: `known-${key}`, kind: 'known', name: meta.name, color: meta.color };
}

/**
 * The id-safe form of a display name: `Live Feedback` → `live-feedback`.
 *
 * Names with no alphanumerics (emoji, punctuation) must not all collapse to
 * the same id, so those fall back to a content hash of the raw name.
 */
export function agentSlug(name: string): string {
  const trimmed = name.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (h * 31 + trimmed.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * The identity id an agent calling itself `name` attaches under.
 *
 * ONE derivation with two callers: the MCP process mints its own id with it,
 * and the board matches a task's OWNER against the workspace's agent roster
 * with it. Spelled separately they drift, and the drift is silent — a roster
 * that stops matching does not fail, it just answers "not recorded" forever.
 * That is not hypothetical: this function exists because the two sides were
 * spelled differently, so a board whose own lead agent was attached read 83
 * of its rows as having an unrecorded owner.
 */
export function agentIdForName(name: string): string {
  const known = knownUserForName(name.trim());
  if (known) return known.id;
  return `agent-${agentSlug(name)}`;
}

/**
 * The canonical form of an email address for identity purposes.
 *
 * Trimmed, lowercased, and with the angle brackets a mail client pastes
 * (`<alice@example.com>`) removed. Deliberately NOT clever: gmail's dot and
 * plus folding are provider-specific, and folding `a.b@` into `ab@` here
 * would silently merge two people on a provider that treats them as two.
 * What this does fold is the set of spellings that address the same mailbox
 * on EVERY provider, which is exactly case and whitespace.
 *
 * The WHOLE address is lowercased, not just the domain — on purpose, so do
 * not "fix" this to domain-only. RFC 5321 makes only the domain
 * case-insensitive and technically lets a mail server distinguish `Bryan@`
 * from `bryan@`; no real provider does, and identity here keys on the
 * address (see `emailIdentityId`), so folding only the domain would split
 * one person into two identities the first time autocapitalize typed their
 * address with a capital letter.
 */
export function normalizeEmail(email: string): string {
  return email.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * Whether this is something a login code could be delivered to.
 *
 * Deliberately loose — the real proof is that a code sent to the address
 * comes back, so this only has to reject what cannot be a mailbox at all. A
 * tight RFC 5322 regex refuses valid addresses, and the cost of that is a
 * person who cannot log in with their own email.
 */
export function isEmailLike(value: string): boolean {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email);
}

/**
 * The identity id for a verified email address: `user-<hash>`.
 *
 * ONE derivation, two callers — the code-challenge route mints it after a
 * code comes back, and the Cloudflare Access path mints it from a JWT claim
 * without a code. Spelled separately they drift, and the drift is silent in
 * exactly the way `agentIdForName`'s docs describe: the same person becomes
 * two identities and nothing anywhere reports it.
 *
 * HASHED rather than the address itself, because this id is written onto
 * every comment and broadcast to whoever can read the doc — a share visitor
 * included. `user-alice-example-com` would make every review a mailing list.
 *
 * It is an IDENTIFIER, not a secret: anyone who guesses an address can hash
 * it themselves, and the roster stores the address in the clear anyway. What
 * the hash buys is that reading a doc does not hand out addresses nobody
 * typed. Collision resistance is the real requirement (two people must never
 * share an identity), which is why this is 64 bits and not the 32-bit
 * `shortHash` the guest namespace uses.
 */
export function emailIdentityId(email: string): string {
  return `user-${hash64(normalizeEmail(email))}`;
}

/**
 * A first-guess display name from an address — `alice.smith@…` → "Alice
 * Smith". Only ever a DEFAULT: the roster stores a `displayName` the person
 * can change, and this fills it in so nobody's first comment is signed with
 * their email address.
 */
export function emailDisplayName(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  const local = (at > 0 ? normalized.slice(0, at) : '').split('+')[0] ?? '';
  const words = local
    .split(/[._\-]+/)
    .filter((w) => w !== '')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length > 0 ? words.join(' ') : normalized;
}

/**
 * A 64-bit content hash as 14 base-36 characters.
 *
 * Two independent FNV-1a passes with different primes, each finished with an
 * avalanche mix so that addresses differing in one character do not produce
 * neighbouring ids. Pure JS on purpose: this module runs in the browser as
 * well as on the server, and `node:crypto` is not available in both.
 */
function hash64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  h1 = avalanche(h1 ^ input.length);
  h2 = avalanche(h2 ^ h1);
  return `${h1.toString(36).padStart(7, '0')}${h2.toString(36).padStart(7, '0')}`;
}

function avalanche(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Every id a roster could plausibly hold for this display name, lowercased.
 *
 * A roster entry is whatever the attaching session passed — its derived
 * identity id (`agent-live-feedback`), a hand-supplied slug (`my-tool`),
 * or the display name itself. All three occur in the field, so matching one
 * spelling matches roughly none of the fleet.
 */
export function agentIdCandidates(name: string): string[] {
  const trimmed = name.trim();
  if (trimmed === '') return [];
  const slug = agentSlug(trimmed);
  return Array.from(
    new Set([trimmed.toLowerCase(), slug, `agent-${slug}`, agentIdForName(trimmed).toLowerCase()]),
  );
}

/** Persist the user's chosen display name (first-arrival prompt, or seeded from
 *  `?as=`). Hard 40-char cap — the prompt's maxlength is advisory; the name is
 *  broadcast in every awareness packet and stored on every comment. */
export function storeUserName(storage: IdentityStorage | null, name: string): void {
  storage?.set(NAME_KEY, name.trim().slice(0, 40));
}

/** Record that the user chose to stay anonymous — the prompt won't re-ask this browser. */
export function dismissNamePrompt(storage: IdentityStorage | null): void {
  storage?.set(PROMPT_DISMISSED_KEY, '1');
}

/** Whether the first-arrival name prompt should be shown. */
export function needsNamePrompt(
  asParam: string | null | undefined,
  storage: IdentityStorage | null,
): boolean {
  if (asParam && KNOWN_USERS[asParam.toLowerCase()]) return false;
  if (storedName(storage)) return false;
  return storage?.get(PROMPT_DISMISSED_KEY) !== '1';
}

/**
 * Resolve a user from (in precedence order) a `?as=` query-param hint, the
 * stored display name, or a stable per-browser anonymous identity. A known
 * `?as=` hit seeds the stored name so the param is a one-time bootstrap. Named
 * users keep the stable anon id (identity continuity with their earlier
 * comments) but derive color from the NAME, so the same person on another
 * device gets the same color.
 */
export function resolveUser(
  asParam: string | null | undefined,
  storage: IdentityStorage | null,
): User {
  if (asParam) {
    const known = knownUserForName(asParam);
    if (known) {
      // Seed only when nothing is stored: the param bootstraps a fresh
      // browser but must never rebrand someone who already named themselves
      // (review URLs get shared, and the server emits ?as= links).
      if (!storedName(storage)) storeUserName(storage, known.name);
      return known;
    }
  }
  const name = storedName(storage);
  if (name) {
    const known = knownUserForName(name);
    if (known) return known;
    return { id: `anon-${stableAnonId(storage)}`, kind: 'known', name, color: hashToColor(name) };
  }
  const anon = stableAnonId(storage);
  return {
    id: `anon-${anon}`,
    kind: 'anon',
    name: guestNameFor(anon),
    color: hashToColor(anon),
  };
}

export { hashToColor };
