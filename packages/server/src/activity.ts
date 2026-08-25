import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DocMeta } from '@feedback/core';

/**
 * The "hands-on activity" event stream. One JSON object per line, append-only,
 * at `<dataDir>/activity.jsonl`. The Weekly Review agent reads this file and
 * analyzes it — the schema below is Bryan-mandated and must be honored exactly.
 *
 * Key design points the WR agent depends on:
 *   - `ts` is ALWAYS ISO-8601 UTC with a trailing `Z`, millisecond precision.
 *   - `eventId` is a deterministic hash of the event's identity so re-running
 *     the backfill is idempotent (never double-counts).
 *   - `read_session` events are interaction-bounded: their `durationMs` is the
 *     SUM of active-interaction spans, NOT (endTs - startTs). Idle time is
 *     excluded so a tab left open doesn't inflate reading hours.
 */

/**
 * `archive` / `unarchive` are review-lifecycle rows: a review was retired
 * (soft — its ydocs moved to `_archive`) or brought back, by whom and why.
 * Like `read_session` and `doc_open` they are LIVE-CAPTURE ONLY — a backfill
 * reconstructs events from ydoc contents, and nothing in a moved file records
 * who moved it. A consumer that buckets by type should expect them the same
 * way it expects the read-family rows.
 */
export type ActivityType =
  | 'comment'
  | 'reply'
  | 'resolve'
  | 'reopen'
  | 'read_session'
  | 'doc_open'
  | 'archive'
  | 'unarchive';

export type ActorKind = 'person' | 'agent';

export type DocKind = 'markdown' | 'mockup' | 'code';

export interface EventDocRepo {
  owner: string;
  name: string;
}

export interface EventDocProducedBy {
  agentId: string | null;
  sessionId: string | null;
  cwd: string | null;
}

export interface EventDoc {
  docId: string;
  sourceUrl: string | null;
  relPath: string | null;
  title: string | null;
  kind: DocKind;
  repo: EventDocRepo;
  producedBy: EventDocProducedBy;
}

export interface EventPayload {
  text?: string;
  wordCount?: number;
  scrollDepthPct?: number;
  maxScrollDepthPct?: number;
  durationMs?: number;
  sessionId?: string;
  startTs?: string;
  endTs?: string;
  interactionBounded?: boolean;
  /** archive / unarchive: the review that was retired or restored. */
  reviewId?: string;
  /** archive / unarchive: how many member docs moved. */
  memberCount?: number;
  /** archive: why, in the operator's words. */
  reason?: string;
}

export interface Event {
  eventId: string;
  /** ISO-8601 UTC with trailing 'Z', millisecond precision. */
  ts: string;
  type: ActivityType;
  actor: ActorKind;
  /** Absent when the persisted author carried no readable id/name. These were
   *  typed as required `string` and were never guaranteed to be either: an
   *  author is whatever some writer put in the CRDT, so `JSON.stringify` has
   *  been omitting these keys for such rows since they were written. Making
   *  them optional emits not one different byte — it stops the type asserting
   *  something the file on disk already contradicts. */
  actorId?: string;
  actorName?: string;
  isOwner: boolean;
  threadId?: string;
  doc: EventDoc;
  payload: EventPayload;
}

/**
 * Render an epoch-ms timestamp (or a Date) as ISO-8601 UTC with a trailing
 * `Z` at millisecond precision. `Date.prototype.toISOString()` already does
 * exactly this, but routing every timestamp through one helper keeps the
 * contract impossible to violate by accident.
 */
export function toUtcIso(tsMs: number | Date): string {
  const d = typeof tsMs === 'number' ? new Date(tsMs) : tsMs;
  return d.toISOString();
}

/**
 * Stable, deterministic event id: sha256 hex (first 24 chars) over the
 * event's identity tuple — ts + actor + docId + type + threadId +
 * payload-digest. Re-running the backfill over the same source data produces
 * the same id, so the WR agent can dedupe a re-run without double-counting.
 *
 * `ts` is normalized to its UTC-Z form before hashing so two timestamps that
 * represent the same instant always hash identically.
 */
export function eventId(parts: {
  ts: string;
  actor: ActorKind;
  docId: string;
  type: ActivityType;
  threadId?: string | null;
  payloadDigest?: string;
}): string {
  const h = createHash('sha256');
  h.update(
    [
      parts.ts,
      parts.actor,
      parts.docId,
      parts.type,
      parts.threadId ?? '',
      parts.payloadDigest ?? '',
    ].join('\x00'),
  );
  return h.digest('hex').slice(0, 24);
}

/** Deterministic digest of a payload's stable identity-bearing fields. Used
 *  as the `payloadDigest` input to `eventId` so two events that differ only
 *  in volatile fields still collide (e.g. comment text identifies a comment
 *  event uniquely within a thread + timestamp). */
export function payloadDigest(input: string | undefined | null): string {
  if (!input) return '';
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

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
 *    rooms.ts (which exists precisely so an agent's closing note doesn't
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

/** Whitespace-split word count for comment/reply text. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
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
 * from three places (`rooms.ts` twice, `activity-backfill.ts` twice) that sit
 * far below any request and hold no configuration to thread through. The
 * alternative — an options bag pushed down four call layers — buys nothing a
 * registry does not, and the registry is set exactly once, at server
 * construction.
 */
const OWNER_IDS = new Set<string>(['known-bryan']);
/** Matched EXACTLY, case included: widening it here would change who counts
 *  as the owner on the existing corpus, which is not what this fixes. */
const OWNER_NAMES = new Set<string>(['Bryan']);

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

/** Back to the built-in spellings. A test seam: the registry is process-wide,
 *  so a test that registers one must be able to put it back. */
export function resetOwnerIdentities(): void {
  OWNER_IDS.clear();
  OWNER_IDS.add('known-bryan');
}

/** Bryan is the doc owner / known person on this single-user fleet. A person
 *  whose author id resolves to a known owner identity is the owner. */
export function isOwnerActor(author: unknown): boolean {
  // Same normalization as `classifyActor`, for the same reason: a legacy
  // string author naming the owner IS the owner, and `author.id` on a null
  // author throws.
  const { id = '', name = '' } = authorFields(author);
  return OWNER_IDS.has(id) || OWNER_NAMES.has(name);
}

const repoCache = new Map<string, EventDocRepo | null>();

/**
 * Derive `{owner, name}` for a doc from its bound file. Walks to the git repo
 * root of the file's directory, reads `origin`'s remote URL, and parses the
 * owner/name out of it. Results are cached per directory (git shells out).
 *
 * For docs with no file on disk (mockups, no-file docs), the caller should
 * fall back to the binding workspace/cwd as the owner — see `deriveRepo`.
 */
function gitRepoFor(dir: string): EventDocRepo | null {
  if (repoCache.has(dir)) return repoCache.get(dir) ?? null;
  let result: EventDocRepo | null = null;
  try {
    const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    });
    if (top.status === 0 && typeof top.stdout === 'string' && top.stdout.trim()) {
      const remote = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
      });
      if (remote.status === 0 && typeof remote.stdout === 'string' && remote.stdout.trim()) {
        result = parseRemote(remote.stdout.trim());
      }
      // No origin remote — fall back to the repo-root basename as the name,
      // owner from the root's parent basename (best-effort).
      if (!result) {
        const root = top.stdout.trim();
        result = { owner: basename(dirname(root)), name: basename(root) };
      }
    }
  } catch {
    result = null;
  }
  repoCache.set(dir, result);
  return result;
}

/** Parse owner/name out of a git remote URL (ssh or https forms). */
export function parseRemote(remote: string): EventDocRepo | null {
  // git@github.com:owner/name.git  OR  https://github.com/owner/name(.git)
  const ssh = remote.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) {
    const owner = ssh[1];
    const name = ssh[2];
    if (owner && name) return { owner, name };
  }
  return null;
}

/**
 * Resolve the `repo` + `producedBy.cwd` for a doc. Prefers the git repo of the
 * doc's bound file; for mockup / no-file docs falls back to the binding
 * workspace/cwd (`owner` field) as the repo owner.
 */
export function deriveRepo(meta: {
  sourceUrl?: string;
  owner?: string;
  workspaceRoot?: string;
}): EventDocRepo {
  const fileDir = meta.sourceUrl?.startsWith('/') ? dirname(meta.sourceUrl) : undefined;
  if (fileDir && existsSync(fileDir)) {
    const repo = gitRepoFor(fileDir);
    if (repo) return repo;
  }
  // Fall back to workspaceRoot's git repo when present.
  if (meta.workspaceRoot && existsSync(meta.workspaceRoot)) {
    const repo = gitRepoFor(meta.workspaceRoot);
    if (repo) return repo;
  }
  // No file / no git: owner = binding cwd basename, name = best-effort.
  const ownerPath = meta.owner ?? meta.workspaceRoot ?? '';
  const ownerBase = ownerPath ? basename(ownerPath) : 'unknown';
  return { owner: ownerBase, name: ownerBase };
}

/** Map a DocMeta `type` onto the activity stream's `kind`. The activity
 *  schema only has markdown / mockup / code; the legacy `dev` surface is
 *  recorded as `mockup` (both are widget-injected running surfaces). */
export function docKindFor(type: DocMeta['type']): DocKind {
  if (type === 'markdown') return 'markdown';
  if (type === 'code') return 'code';
  return 'mockup';
}

/**
 * Build the `doc` block of an event from a doc's persisted meta. `producedBy`
 * captures {agentId, sessionId, cwd}: cwd = the doc's `owner` (the creating
 * MCP child's cwd); agentId = owner basename; sessionId = the persisted
 * producedBy.sessionId, else null (see DocMeta.producedBy — only populated
 * when create_review_doc / bind_folder were called with producedBy).
 */
export function buildEventDoc(meta: DocMeta): EventDoc {
  const repo = deriveRepo(meta);
  const cwd = meta.owner ?? meta.workspaceRoot ?? null;
  const agentId = meta.producedBy?.agentId ?? (cwd ? basename(cwd) : null);
  const sessionId = meta.producedBy?.sessionId ?? null;
  return {
    docId: meta.docId,
    sourceUrl: meta.sourceUrl ?? null,
    relPath: meta.relPath ?? null,
    title: meta.title ?? null,
    kind: docKindFor(meta.type),
    repo,
    producedBy: { agentId, sessionId, cwd },
  };
}

/** Hard cap on a single read-session's reported active duration (20 min).
 *  Mirrors the client tracker's cap; re-clamped server-side so a buggy or
 *  spoofed POST can't write an inflated duration into the WR agent's data. */
export const MAX_READ_SESSION_MS = 20 * 60_000;

/**
 * Sanitize a browser-supplied read-session payload before it's persisted:
 * clamp `durationMs` / `maxScrollDepthPct` to sane ranges. Mutates and returns
 * the same object. Non-numeric/absent fields are left untouched.
 */
export function clampReadPayload(payload: Event['payload']): Event['payload'] {
  if (typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs)) {
    payload.durationMs = Math.max(0, Math.min(payload.durationMs, MAX_READ_SESSION_MS));
  }
  if (typeof payload.maxScrollDepthPct === 'number' && Number.isFinite(payload.maxScrollDepthPct)) {
    payload.maxScrollDepthPct = Math.max(0, Math.min(payload.maxScrollDepthPct, 100));
  }
  return payload;
}

/** Absolute path of the activity log inside a data dir. */
export function activityLogPath(dataDir: string): string {
  return join(dataDir, 'activity.jsonl');
}

/**
 * Append one event as a single JSON line to `<dataDir>/activity.jsonl`,
 * creating the file (and dataDir) if missing. Append-only — never rewrites or
 * truncates. Failures are logged, not thrown: activity capture must never
 * break the action it's recording (a comment post, a read session).
 */
export function appendActivity(dataDir: string, event: Event): void {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    appendFileSync(activityLogPath(dataDir), `${JSON.stringify(event)}\n`);
  } catch (err) {
    console.error('[activity] append failed:', err);
  }
}
