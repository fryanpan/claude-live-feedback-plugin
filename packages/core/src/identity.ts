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

/** Resolve a user given a query-param hint and a storage backend (localStorage in the browser). */
export function resolveUser(
  asParam: string | null | undefined,
  storage: { get(k: string): string | null; set(k: string, v: string): void } | null,
): User {
  if (asParam && KNOWN_USERS[asParam.toLowerCase()]) {
    const k = asParam.toLowerCase();
    const meta = KNOWN_USERS[k];
    if (!meta) {
      // unreachable — the guard above proves k is in KNOWN_USERS
      throw new Error('invariant: known-user lookup');
    }
    const id = `known-${k}`;
    return { id, kind: 'known', name: meta.name, color: meta.color };
  }
  const storageKey = 'feedback-anon-id';
  let anon = storage?.get(storageKey) ?? null;
  if (!anon) {
    anon = randomAnonId();
    storage?.set(storageKey, anon);
  }
  return {
    id: `anon-${anon}`,
    kind: 'anon',
    name: `Anon-${anon}`,
    color: hashToColor(anon),
  };
}

export { hashToColor };
