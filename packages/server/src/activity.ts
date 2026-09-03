import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DocMeta } from '@feedback/core';
import type { ActorKind } from './actor-identity.ts';

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

/** Re-exported so `Event`'s own shape stays readable from one import. */
export type { ActorKind };

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
