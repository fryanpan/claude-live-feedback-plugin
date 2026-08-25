/**
 * The people roster.
 *
 * There is no human roster in this codebase today. `KNOWN_USERS` in
 * `core/identity.ts` is a two-entry hardcoded const, `attachments` is the
 * AGENT roster, `members` means member docs of a review and `participants`
 * means repliers on a thread. So this file creates the list rather than
 * filtering one: a person becomes a row here the first time they prove
 * control of an email address — by answering a code, or by arriving through
 * Cloudflare Access with a verified claim.
 *
 * Shape decisions, each with its reason:
 *
 * - **One JSON file, `identities.json`, rewritten whole through a temp file
 *   and a rename**, the same shape `agent-watches.json` uses and for the same
 *   reasons: the set is tens of rows, and a crash mid-write leaves the
 *   previous file rather than half of one.
 * - **The id is derived, never stored-and-assigned.** `emailIdentityId` in
 *   core is the one derivation (see its docs); this store holds what cannot
 *   be derived — display name, colour, status, and what was merged into it.
 *   That means a lost roster costs preferences, not attribution: the same
 *   address still resolves to the same id on the next login.
 * - **Archiving is the removal**, per the project-wide soft-delete rule. A
 *   row is never dropped, because the ids in it are stamped on comments and
 *   activity rows that must keep rendering a name years later. `archive` sets
 *   a status and a reason; `unarchive` puts it back.
 * - **`mergedFrom` maps legacy actor ids onto this identity.** The merge
 *   itself is a later commit; the field and its resolution live here now so
 *   readers already resolve through it, and so the merge script has somewhere
 *   to write that never rewrites a stored ydoc or activity row.
 * - **Sessions are revocable without touching the cookie.** `sessionsValidFrom`
 *   is a watermark: a session cookie issued before it is refused. That makes
 *   "log me out everywhere" one field write, and it costs no per-session
 *   record to sweep.
 * - **A corrupt file is renamed aside, never overwritten** — the next write
 *   would otherwise destroy the only evidence of what went wrong.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type User,
  emailDisplayName,
  emailIdentityId,
  hashToColor,
  isEmailLike,
  normalizeEmail,
} from '@feedback/core';

const FILENAME = 'identities.json';
const FORMAT_VERSION = 1;

/** Longest display name stored — the same cap the share visitor path applies,
 *  for the same reason: it is broadcast in presence and stored on comments. */
const MAX_NAME = 40;

export type IdentityStatus = 'active' | 'archived';

export interface IdentityRecord {
  /** `user-<hash>`, derived from the email — see `emailIdentityId`. */
  id: string;
  /** Normalized address. The one field the id cannot be recovered from. */
  email: string;
  displayName: string;
  /** `#rrggbb`. Derived from the id on creation, overridable afterwards. */
  color: string;
  status: IdentityStatus;
  /** Legacy actor ids folded into this identity. Readers resolve through it. */
  mergedFrom: string[];
  createdAt: number;
  updatedAt: number;
  /** Sessions minted before this instant are refused. Bumped by `revokeSessions`. */
  sessionsValidFrom: number;
  /** Why it was archived. Kept because archiving is reversible. */
  archivedReason?: string;
}

interface FileShape {
  version: number;
  identities: Record<string, IdentityRecord>;
}

export interface IdentitiesOptions {
  dataDir: string;
  now?: () => number;
}

/** Patch applied on upsert. Every field optional: an upsert must never
 *  overwrite a name the person chose with one derived from their address. */
export interface IdentityPatch {
  displayName?: string;
  color?: string;
}

export class Identities {
  private readonly path: string;
  private readonly now: () => number;
  private state: FileShape;
  /** Set when the file on disk was unreadable and moved aside. */
  readonly loadError: string | null = null;

  constructor(opts: IdentitiesOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.state = { version: FORMAT_VERSION, identities: {} };
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.identities !== 'object') {
        throw new Error('missing "identities" object');
      }
      for (const [id, rec] of Object.entries(parsed.identities ?? {})) {
        const clean = sanitize(id, rec, this.now());
        if (clean) this.state.identities[clean.id] = clean;
      }
    } catch (err) {
      const aside = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // If even the rename fails there is nothing better available; the
        // loadError below still says what happened.
      }
      this.loadError = `${err instanceof Error ? err.message : String(err)} (moved to ${aside})`;
      this.state = { version: FORMAT_VERSION, identities: {} };
    }
  }

  /**
   * The identity for a verified address, creating the row on first sight.
   *
   * Idempotent by construction — the id is derived, so a second login is an
   * update of the same row rather than a second person. `createdAt` and any
   * chosen `displayName` survive; an archived row is NOT silently revived,
   * because un-archiving is a decision somebody makes (see `unarchive`).
   *
   * An upsert that would change NOTHING writes nothing. That is not a
   * micro-optimization: the Cloudflare Access path resolves an identity on
   * every authenticated write, so an unconditional save would rewrite this
   * file once per comment — and it would leave `updatedAt` meaning "last
   * seen" when every other field in the row means "last changed".
   */
  upsertByEmail(email: string, patch: IdentityPatch = {}): IdentityRecord {
    if (!isEmailLike(email)) throw new Error(`not an email address: ${JSON.stringify(email)}`);
    const normalized = normalizeEmail(email);
    const id = emailIdentityId(normalized);
    const now = this.now();
    const existing = this.state.identities[id];
    if (existing) {
      const displayName = cleanName(patch.displayName) ?? existing.displayName;
      const color = cleanColor(patch.color) ?? existing.color;
      if (
        existing.email === normalized &&
        existing.displayName === displayName &&
        existing.color === color
      ) {
        return existing;
      }
      const updated: IdentityRecord = {
        ...existing,
        email: normalized,
        displayName,
        color,
        updatedAt: now,
      };
      this.state.identities[id] = updated;
      this.save();
      return updated;
    }
    const record: IdentityRecord = {
      id,
      email: normalized,
      displayName: cleanName(patch.displayName) ?? emailDisplayName(normalized),
      color: cleanColor(patch.color) ?? hashToColor(id),
      status: 'active',
      mergedFrom: [],
      createdAt: now,
      updatedAt: now,
      sessionsValidFrom: 0,
    };
    this.state.identities[id] = record;
    this.save();
    return record;
  }

  /**
   * The identity behind an id, resolving a legacy id through `mergedFrom`.
   *
   * Resolution lives here rather than at the call sites so that "who is this
   * actor" has one answer: a reader holding an `anon-…` id from an old
   * comment gets the person it was merged into, and a reader holding the
   * canonical id gets the same row.
   */
  get(id: string): IdentityRecord | null {
    const direct = this.state.identities[id];
    if (direct) return direct;
    for (const rec of Object.values(this.state.identities)) {
      if (rec.mergedFrom.includes(id)) return rec;
    }
    return null;
  }

  byEmail(email: string): IdentityRecord | null {
    if (!isEmailLike(email)) return null;
    return this.state.identities[emailIdentityId(email)] ?? null;
  }

  /** Every row, archived included — an archived person still authored things. */
  list(): IdentityRecord[] {
    return Object.values(this.state.identities).sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  }

  setDisplayName(id: string, name: string): IdentityRecord | null {
    return this.patch(id, (rec) => ({ ...rec, displayName: cleanName(name) ?? rec.displayName }));
  }

  /** Soft removal. The row stays readable so old comments keep a name. */
  archive(id: string, reason?: string): IdentityRecord | null {
    return this.patch(id, (rec) => ({
      ...rec,
      status: 'archived',
      ...(reason ? { archivedReason: reason } : {}),
      // Archiving must end the person's access, not merely hide the row.
      sessionsValidFrom: this.now(),
    }));
  }

  unarchive(id: string): IdentityRecord | null {
    return this.patch(id, (rec) => {
      const { archivedReason: _dropped, ...rest } = rec;
      return { ...rest, status: 'active' };
    });
  }

  /** Invalidate every session already minted for this identity. */
  revokeSessions(id: string): IdentityRecord | null {
    return this.patch(id, (rec) => ({ ...rec, sessionsValidFrom: this.now() }));
  }

  /** Record that `legacyId` was this person all along (commit 7's writer). */
  addMergedFrom(id: string, legacyId: string): IdentityRecord | null {
    return this.patch(id, (rec) =>
      rec.mergedFrom.includes(legacyId)
        ? rec
        : { ...rec, mergedFrom: [...rec.mergedFrom, legacyId] },
    );
  }

  private patch(id: string, fn: (rec: IdentityRecord) => IdentityRecord): IdentityRecord | null {
    const rec = this.get(id);
    if (!rec) return null;
    const next = { ...fn(rec), updatedAt: this.now() };
    this.state.identities[next.id] = next;
    this.save();
    return next;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

/**
 * The author shape the rest of the server speaks, for a roster row.
 *
 * `kind: 'known'` because that is what the UI reads as "someone the fleet
 * recognizes" — and unlike every other producer of that field, this one has
 * actually verified something.
 */
export function userForIdentity(rec: IdentityRecord): User {
  return { id: rec.id, name: rec.displayName, kind: 'known', color: rec.color };
}

function cleanName(name: string | undefined): string | null {
  const trimmed = name?.trim().slice(0, MAX_NAME);
  return trimmed ? trimmed : null;
}

function cleanColor(color: string | undefined): string | null {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

/** One stored row, or null when it is too broken to keep. */
function sanitize(key: string, rec: unknown, now: number): IdentityRecord | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Partial<IdentityRecord>;
  const email = typeof r.email === 'string' ? normalizeEmail(r.email) : '';
  if (!isEmailLike(email)) return null;
  // The id is DERIVED, so a stored one that disagrees with the address is a
  // hand-edited or migrated file. The derivation wins: the login path will
  // compute this same id, and honouring the stored one would create a row
  // nothing can ever look up.
  const id = emailIdentityId(email);
  if (key !== id && typeof r.id === 'string' && r.id !== id) {
    // Keep the disagreeing spelling reachable rather than dropping it.
    r.mergedFrom = [...(Array.isArray(r.mergedFrom) ? r.mergedFrom : []), key];
  }
  return {
    id,
    email,
    displayName: cleanName(r.displayName) ?? emailDisplayName(email),
    color: cleanColor(r.color) ?? hashToColor(id),
    status: r.status === 'archived' ? 'archived' : 'active',
    mergedFrom: Array.isArray(r.mergedFrom)
      ? Array.from(new Set(r.mergedFrom.filter((m): m is string => typeof m === 'string')))
      : [],
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : now,
    sessionsValidFrom: typeof r.sessionsValidFrom === 'number' ? r.sessionsValidFrom : 0,
    ...(typeof r.archivedReason === 'string' ? { archivedReason: r.archivedReason } : {}),
  };
}
