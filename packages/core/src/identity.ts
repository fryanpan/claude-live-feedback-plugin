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

function knownUser(key: string): User | null {
  const meta = KNOWN_USERS[key.toLowerCase()];
  if (!meta) return null;
  return { id: `known-${key.toLowerCase()}`, kind: 'known', name: meta.name, color: meta.color };
}

/** Persist the user's chosen display name (first-arrival prompt, or seeded from `?as=`). */
export function storeUserName(storage: IdentityStorage | null, name: string): void {
  storage?.set(NAME_KEY, name);
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
    const known = knownUser(asParam);
    if (known) {
      storeUserName(storage, known.name);
      return known;
    }
  }
  const name = storedName(storage);
  if (name) {
    const known = knownUser(name);
    if (known) return known;
    return { id: `anon-${stableAnonId(storage)}`, kind: 'known', name, color: hashToColor(name) };
  }
  const anon = stableAnonId(storage);
  return {
    id: `anon-${anon}`,
    kind: 'anon',
    name: `Anon-${anon}`,
    color: hashToColor(anon),
  };
}

export { hashToColor };
