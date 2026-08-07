import { type User, guestNameFor } from '@feedback/core';

/**
 * What a share visitor is allowed to claim about who they are.
 *
 * Every write endpoint takes its `author` straight from the request body —
 * fine on the tailnet, where the only callers are Bryan's browser and his
 * own agents, but a share link puts that body in a stranger's hands. Left
 * alone, a visitor could post a comment signed `known-bryan / "Bryan"`, and
 * `/activity` went further and DEFAULTED to Bryan when no author was sent.
 * Feedback that looks like it came from the person who asked for it is
 * worse than no feedback.
 *
 * The rule: a visitor picks their DISPLAY NAME (they should — an animal or
 * a real one, see guestNameFor), but never their identity. The id is
 * server-derived and lives in a `guest-` namespace that can't collide with
 * `known-*` or with an agent's, and reserved names are refused.
 *
 * Not anti-spoofing between guests: two visitors on the same link are
 * equally trusted by design, and one can type the other's name. What this
 * stops is a visitor claiming to be a member of the fleet.
 */

/** Names a visitor may not display under, whatever they type. Matched
 *  case- and whitespace-insensitively so "  bryan " is refused too. */
const RESERVED_NAMES = new Set(['bryan', 'agent', 'claude', 'system', 'admin']);

/** Longest display name we'll store — same cap the client applies, enforced
 *  here because the client is the thing we don't trust. */
const MAX_NAME = 40;

export interface VisitorContext {
  /** The share this visitor is authorized by — scopes their id namespace so
   *  two different shares can't produce the same guest id. */
  shareKey: string;
}

/**
 * Rewrite a caller-supplied author into one a share visitor is allowed to
 * have. Returns a User that is safe to persist and broadcast.
 *
 * `claimed` is whatever arrived in the request body — possibly undefined,
 * possibly hostile, possibly not even an object.
 */
export function sanitizeVisitorAuthor(claimed: unknown, ctx: VisitorContext): User {
  const raw = isRecord(claimed) ? claimed : {};
  // The visitor's own stable id (from their browser) only seeds OUR id — it
  // is never used verbatim, so `known-bryan` can't survive the trip.
  const seed = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : 'anon';
  const id = `guest-${shortHash(`${ctx.shareKey}:${seed}`)}`;

  const claimedName = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_NAME) : '';
  const name =
    claimedName && !RESERVED_NAMES.has(claimedName.toLowerCase())
      ? claimedName
      : // No name, or a name they may not use: fall back to the same
        // animal the client would have shown them, derived from OUR id so
        // it's stable for this visitor on this share.
        guestNameFor(id);

  return {
    id,
    name,
    // Always 'anon': a guest is a guest even when they've typed a name, and
    // 'known' is what the UI uses to mean "someone the fleet recognizes".
    kind: 'anon',
    color:
      typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)
        ? raw.color
        : hashToHexColor(id),
  };
}

/** True when a display name is one only the fleet may use. */
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.trim().toLowerCase());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

function hashToHexColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  // Mid saturation/lightness keeps every generated color readable on both
  // the light and dark editor themes.
  const c = 0.45 * (1 - Math.abs(2 * 0.55 - 1)) * 2;
  const hp = hue / 60;
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
  const m = 0.55 - c / 2;
  const to = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}
