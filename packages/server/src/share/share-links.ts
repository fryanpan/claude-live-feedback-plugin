/**
 * Share LINKS: `https://share.<domain>/s/<id>`, and the workspace membership
 * redeeming one creates.
 *
 * The design Bryan chose on 2026-09-03 (option A on the share-links options
 * doc). ONE Cloudflare Access application covers the whole share hostname,
 * with an "everyone" policy and a one-time PIN login, so Cloudflare proves an
 * email address and nothing more. This module owns the other half of the
 * question — may THIS email open THIS workspace — which is the half the
 * security model has always kept on our side of the line.
 *
 * The split from `shares.ts` is deliberate rather than tidiness. A `Share` is
 * a Cloudflare Access APPLICATION: it carries a hostname, an audience, an app
 * id, a policy id and an allow list, and minting one needs an API token on the
 * box. A `ShareLinkRecord` is a row in a file. They answer the same product
 * question through completely different machinery, and putting the new one
 * inside the old type would mean every field on it being optional and every
 * reader asking which kind it holds. `shares.ts` stays for the records already
 * minted (see the retired-once-drained notes there and in auth-share.ts).
 *
 * Three rules the rest of the server depends on:
 *
 *  1. **A link is not a credential for the workspace, it is an invitation to
 *     become a member.** Redeeming writes the verified email down against the
 *     workspace, once; from then on every request is judged on the MEMBERSHIP,
 *     never on the link. So revoking a link cannot eject the people who
 *     already came through it — `removeMember` is that, and it is a separate,
 *     deliberate act.
 *  2. **A link that is not live records nothing.** Revoked, expired and
 *     never-existed are one answer to a caller (`state`), because three
 *     answers would let anyone with the route enumerate which ids are real.
 *  3. **Expiry is optional and defaults to none.** Bryan, 2026-09-03: links
 *     are long-living. `expiresAt: null` is a link with no expiry, which is a
 *     different thing from a link whose expiry has passed, and the two must
 *     not collapse into a falsy check.
 *
 * Nothing here talks to Cloudflare, and nothing here needs an API token.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEmail } from '@feedback/core';

const SECRET_MODE = 0o600;
const REGISTRY_FILENAME = 'share-links.json';

/** One person coming through a link, the first time they came. */
export interface ShareLinkRedemption {
  /** The address Cloudflare Access verified, normalized. */
  email: string;
  at: number;
}

/**
 * A share link. The id is the whole of the URL's secret, so it is 128 bits of
 * randomness — but note what it buys the holder: the chance to sign in and be
 * recorded, not access to the workspace. Access still requires an email
 * Cloudflare verified.
 */
export interface ShareLinkRecord {
  linkId: string;
  workspaceId: string;
  /** The agent or person who minted it, for `list_shares`. */
  createdBy: string;
  createdAt: number;
  /** `null` = no expiry. Long-living is the default (Bryan, 2026-09-03). */
  expiresAt: number | null;
  /** Set by `revoke`; stops new redemptions without touching membership. */
  revokedAt: number | null;
  label?: string;
  redemptions: ShareLinkRedemption[];
}

/** An email written down against a workspace. This is what grants access. */
export interface ShareLinkMember {
  workspaceId: string;
  email: string;
  addedAt: number;
  /** Which link they came through — provenance, never authorization. */
  viaLinkId: string;
}

/**
 * What a link is, to a caller.
 *
 * `unknown` covers a malformed id and one that never existed, and the redeem
 * route renders it exactly as it renders `revoked` and `expired`. The
 * distinction exists for the operator's own listing, not for the visitor.
 */
export type ShareLinkState = 'live' | 'revoked' | 'expired' | 'unknown';

/** A link as the API serves it: the record plus the state it is in. */
export type ListedShareLink = ShareLinkRecord & { state: ShareLinkState };

export interface CreateShareLinkReq {
  workspaceId: string;
  createdBy: string;
  /** Seconds from now. Omitted = no expiry, which is the default. */
  ttlSeconds?: number;
  label?: string;
}

interface Persisted {
  links: ShareLinkRecord[];
  members: ShareLinkMember[];
}

export class ShareLinks {
  private readonly dataDir: string;
  private links: ShareLinkRecord[] = [];
  private members: ShareLinkMember[] = [];

  constructor(opts: { dataDir: string }) {
    this.dataDir = opts.dataDir;
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
    this.load();
  }

  /**
   * Mint a link. No Cloudflare call, no hostname, no audience — the hostname
   * is one the operator configured once and the audience belongs to the ONE
   * Access application in front of it.
   */
  create(req: CreateShareLinkReq): ShareLinkRecord {
    if (!req.workspaceId) throw new Error('workspaceId is required');
    if (req.ttlSeconds !== undefined && (!Number.isFinite(req.ttlSeconds) || req.ttlSeconds <= 0)) {
      throw new Error('ttlSeconds must be a positive, finite number of seconds');
    }
    const now = Date.now();
    const record: ShareLinkRecord = {
      linkId: randomHex(16),
      workspaceId: req.workspaceId,
      createdBy: req.createdBy,
      createdAt: now,
      expiresAt: req.ttlSeconds === undefined ? null : now + req.ttlSeconds * 1000,
      revokedAt: null,
      ...(req.label ? { label: req.label } : {}),
      redemptions: [],
    };
    this.links.push(record);
    this.save();
    return record;
  }

  get(linkId: string): ShareLinkRecord | null {
    if (!linkId) return null;
    return this.links.find((l) => l.linkId === linkId) ?? null;
  }

  /**
   * Is this link redeemable right now?
   *
   * `expiresAt === null` is a link with no expiry and stays live forever; a
   * numeric one is compared, so a link that lapsed a second ago is `expired`
   * and not `live`. Revocation is checked first because it is the deliberate
   * act and should be what an operator sees in a listing.
   */
  state(linkId: string, now: number = Date.now()): ShareLinkState {
    const link = this.get(linkId);
    if (!link) return 'unknown';
    if (link.revokedAt !== null) return 'revoked';
    if (link.expiresAt !== null && link.expiresAt <= now) return 'expired';
    return 'live';
  }

  /**
   * Stop new redemptions. Existing members are untouched, on purpose: they
   * were admitted deliberately and ejecting them is `removeMember`.
   *
   * Soft, and it has to be: the record is what `list_shares` shows and what
   * says who came through this link and when. Destroying it would destroy
   * that history to achieve something the flag already achieves.
   */
  revoke(linkId: string, now: number = Date.now()): boolean {
    const link = this.get(linkId);
    if (!link || link.revokedAt !== null) return false;
    link.revokedAt = now;
    this.save();
    return true;
  }

  /**
   * Redeem a link as a verified email.
   *
   * Idempotent by construction: a second visit from the same address finds
   * the membership already written and changes nothing, so a reviewer who
   * bookmarks the link does not grow the file one row per visit. `added` says
   * which happened, so a caller can log the first arrival without inventing
   * a second lookup that could disagree with this one.
   *
   * A link that is not live records NOTHING — no member, no redemption — and
   * says only that it did not work.
   */
  redeem(
    linkId: string,
    email: string,
    now: number = Date.now(),
  ): { ok: true; workspaceId: string; added: boolean } | { ok: false; state: ShareLinkState } {
    const state = this.state(linkId, now);
    if (state !== 'live') return { ok: false, state };
    const link = this.get(linkId);
    // Unreachable while `state` said live; re-checked because a null here
    // would otherwise be a member row against an empty workspace.
    if (!link) return { ok: false, state: 'unknown' };
    const who = normalizeEmail(email);
    // A token with no email claim is nobody, and nobody cannot be made a
    // member. Answering `unknown` rather than a distinct reason keeps the
    // visitor's page identical whatever went wrong.
    if (who === '') return { ok: false, state: 'unknown' };
    const added = this.addMember(link.workspaceId, who, linkId, now);
    if (added) {
      link.redemptions.push({ email: who, at: now });
      this.save();
    }
    return { ok: true, workspaceId: link.workspaceId, added };
  }

  /**
   * Is this email a member of this workspace?
   *
   * The ONLY question the per-request gate asks, and it reads the membership
   * rows rather than the links: that is what "from then on the membership,
   * not the link, grants access" means in code. A revoked link's members
   * still answer true here, and that is the intended behaviour, not a gap.
   */
  isMember(workspaceId: string, email: string | null | undefined): boolean {
    const who = email ? normalizeEmail(email) : '';
    if (who === '' || !workspaceId) return false;
    return this.members.some((m) => m.workspaceId === workspaceId && m.email === who);
  }

  /** Every member of a workspace, in the order they arrived. */
  membersOf(workspaceId: string): ShareLinkMember[] {
    return this.members.filter((m) => m.workspaceId === workspaceId);
  }

  /**
   * Every membership this server holds, across every workspace — what
   * `list_shares` reports so an operator can see who is in before deciding
   * whom to remove.
   *
   * Its own method rather than the caller walking links and calling
   * `membersOf`: a workspace with two links would then list each member
   * twice, and a member whose link was deleted would not list at all.
   */
  allMembers(): ShareLinkMember[] {
    return this.members.slice();
  }

  /**
   * Take a member's access away. Effective on the next request, because the
   * gate asks this store on every request rather than at the link.
   *
   * A hard removal rather than a flag, and it is not the soft-delete rule
   * being broken: the row is not user content, it is a grant. Removing a
   * grant is what revocation IS, and a tombstone that still had to be read
   * as "not a member" would be a second way to answer the one question the
   * gate asks. The redemption history on the link survives, so who was ever
   * admitted is still on the record.
   */
  removeMember(workspaceId: string, email: string): boolean {
    const who = normalizeEmail(email);
    if (who === '' || !workspaceId) return false;
    const before = this.members.length;
    this.members = this.members.filter((m) => !(m.workspaceId === workspaceId && m.email === who));
    if (this.members.length === before) return false;
    this.save();
    return true;
  }

  list(): ShareLinkRecord[] {
    return this.links.slice();
  }

  /** `list()` with the one thing a record cannot say about itself. */
  listForApi(now: number = Date.now()): ListedShareLink[] {
    return this.links.map((l) => ({ ...l, state: this.state(l.linkId, now) }));
  }

  /** Every link minted for a workspace, live or not. */
  forWorkspace(workspaceId: string): ShareLinkRecord[] {
    return this.links.filter((l) => l.workspaceId === workspaceId);
  }

  private addMember(workspaceId: string, email: string, viaLinkId: string, at: number): boolean {
    if (this.isMember(workspaceId, email)) return false;
    this.members.push({ workspaceId, email, addedAt: at, viaLinkId });
    return true;
  }

  /**
   * Read the registry. A corrupt or unreadable file starts CLEAN rather than
   * crashing the server, which matches `Shares.load` — but note the direction
   * it fails in is different and better: an unreadable share registry loses
   * grants people had, while an unreadable one here loses grants AND is the
   * only thing that grants, so every visitor is refused rather than admitted.
   */
  private load(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
      const links = Array.isArray(parsed?.links) ? parsed.links : [];
      const members = Array.isArray(parsed?.members) ? parsed.members : [];
      this.links = links.filter(
        (l): l is ShareLinkRecord =>
          typeof l?.linkId === 'string' &&
          l.linkId !== '' &&
          typeof l?.workspaceId === 'string' &&
          l.workspaceId !== '',
      );
      // Normalized on the way IN as well as on the way out: a row hand-edited
      // with a capitalised address must not become a member nothing matches.
      this.members = members
        .filter(
          (m): m is ShareLinkMember =>
            typeof m?.workspaceId === 'string' &&
            m.workspaceId !== '' &&
            typeof m?.email === 'string',
        )
        .map((m) => ({ ...m, email: normalizeEmail(m.email) }))
        .filter((m) => m.email !== '');
    } catch {
      this.links = [];
      this.members = [];
    }
  }

  /**
   * Write the registry, mode 600, through a temporary file and a rename.
   *
   * Both halves matter and neither is about confidentiality of workspace
   * content. A `linkId` is a bearer value — whoever reads one can walk up to
   * an everyone-policy sign-in and become a member — and the member list is a
   * roster of email addresses, so this file is handled like the sibling key
   * files beside it rather than like data. The rename is what keeps a crash
   * mid-write from leaving a half-written registry, which this module reads
   * as corrupt and then fails closed on: every member would lose access at
   * once, and the redemption history would be gone with them.
   */
  private save(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    const state: Persisted = { links: this.links, members: this.members };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: SECRET_MODE });
    chmodSync(tmp, SECRET_MODE); // an existing tmp keeps its old mode otherwise
    renameSync(tmp, path);
  }
}

/**
 * The key a live connection carries so that ejecting a member can find it.
 *
 * A websocket and an SSE stream are authorized ONCE, at open, and then never
 * again — so without something on the socket naming who opened it, removing a
 * member left their `/y/<doc>` reading and writing until the connection
 * happened to drop. The retired per-share mode had a `shareId` for this; a
 * share-link visitor has no share, only a membership, so the membership is
 * what gets stamped.
 *
 * Workspace AND email, because membership is per workspace: someone ejected
 * from one board may still hold another, and closing both would be a bug in
 * the other direction. The separator is a NUL, which neither part can contain.
 */
export function shareMemberKey(workspaceId: string, email: string): string {
  return `${workspaceId}\u0000${normalizeEmail(email)}`;
}

/** `bytes` random bytes, hex-encoded — so 2*bytes characters. */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}
