/**
 * Cap how long AssemblyAI keeps anything our key created.
 *
 * WHAT THE VENDOR KEEPS, measured against the live API on 2026-08-31 rather
 * than assumed (docs: assemblyai.com/docs/data-retention-and-model-training):
 *
 *  - **Streaming (what the meeting assistant actually uses) keeps nothing.**
 *    With model-training opt-out on the account, AssemblyAI offers zero data
 *    retention of audio and transcripts for the Streaming product; only
 *    logging/billing metadata survives. There is no per-session parameter for
 *    it — the opt-out is an ACCOUNT setting, so no code in this repo can turn
 *    it on or assert it.
 *  - **Async (`POST /v2/transcript`) keeps a lot longer.** Uploaded audio
 *    starts deleting at 24h (at most 48h); the transcript artifact starts
 *    deleting at 30 DAYS. A shorter TTL is configurable, but from the
 *    dashboard's Data Controls — there is no `ttl` field on the transcript
 *    request body.
 *
 * This repo creates NO async transcripts: the engine is Universal Streaming
 * v3 over a WebSocket (`transcribe-assemblyai.ts`), and on 2026-08-31 the
 * account's `GET /v2/transcript` listed zero rows. So this module is not a
 * cleanup step wired into a pipeline that produces them — it is the sweep
 * that makes "nothing of ours sits on their disk for 30 days" checkable, and
 * true for anything else this key is ever pointed at. Run it from
 * `scripts/assemblyai-retention-sweep.ts`.
 *
 * TWO THINGS THE API DOES THAT A NAIVE SWEEP GETS WRONG, both recorded in
 * `test/fixtures/assemblyai-retention.json` from a real create/delete cycle:
 *
 *  1. **DELETE redacts; it does not remove the row.** The transcript keeps
 *     `status: "completed"` and stays in the list forever. `text` becomes the
 *     literal `"Deleted by user."` and `words` becomes null. So "gone from
 *     the list" is the WRONG test for deletion, and a sweep that used it
 *     would report failure on every row it had just successfully cleared.
 *  2. **The list is eventually consistent, and spells the sentinel
 *     differently.** Immediately after a delete the list still shows the
 *     original `audio_url`; a few minutes later it shows `deleted_by_user`,
 *     while the single-transcript GET shows `http://deleted_by_user`. One
 *     predicate has to accept both spellings, and the sweep must not depend
 *     on the list being fresh — which is safe because DELETE is idempotent
 *     (a second delete of the same id returns 200, verified live).
 *
 * A failed delete is counted and left for the next sweep. Nothing here logs
 * transcript TEXT — counts and ids only — because the point of the module is
 * that the words stop existing.
 */

const API_BASE = 'https://api.assemblyai.com/v2/transcript';

/** What the vendor writes over `audio_url` once a transcript is deleted. */
const DELETED_AUDIO_SENTINEL = 'deleted_by_user';
/** What it writes over `text`. */
const DELETED_TEXT_SENTINEL = 'Deleted by user.';

/** A row as the LIST endpoint returns it — no `text` field at this level. */
export interface StoredTranscriptRow {
  id: string;
  status: string;
  created?: string;
  audio_url?: string | null;
}

/** A transcript as the single-resource GET returns it (trimmed to what we read). */
export interface StoredTranscript {
  id: string;
  status: string;
  text?: string | null;
  audio_url?: string | null;
  words?: unknown[] | null;
}

export interface SweepCounts {
  /** Rows the list returned. */
  found: number;
  /** Rows already redacted when we looked — no DELETE sent. */
  alreadyDeleted: number;
  /** Rows we deleted AND confirmed redacted by reading back. */
  deleted: number;
  /** Rows whose delete or read-back did not confirm. Left for the next sweep. */
  failed: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Is this transcript's content gone?
 *
 * Accepts the list's `deleted_by_user` and the GET's `http://deleted_by_user`
 * by ignoring a scheme prefix, and treats the redacted `text` as proof on its
 * own so a shape change to one field alone cannot make a deleted transcript
 * read as live.
 */
export function isDeleted(t: StoredTranscriptRow | StoredTranscript): boolean {
  const audio = (t.audio_url ?? '').replace(/^[a-z]+:\/\//i, '');
  if (audio === DELETED_AUDIO_SENTINEL) return true;
  return (t as StoredTranscript).text === DELETED_TEXT_SENTINEL;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: apiKey };
}

/**
 * Every transcript the key can see, following `next_url` to the end.
 *
 * `limit` is the page size, not a cap on the result: a sweep that stopped at
 * one page would leave the oldest transcripts — the ones closest to their
 * 30-day expiry, and so the ones that matter most — untouched.
 */
export async function listStoredTranscripts(
  apiKey: string,
  fetchImpl: FetchLike,
  limit = 100,
): Promise<StoredTranscriptRow[]> {
  const rows: StoredTranscriptRow[] = [];
  let url: string | null = `${API_BASE}?limit=${limit}`;
  const seen = new Set<string>();
  while (url) {
    if (seen.has(url)) break; // a self-referential next_url must not spin forever
    seen.add(url);
    const res = await fetchImpl(url, { headers: authHeaders(apiKey) });
    if (!res.ok) throw new Error(`assemblyai: list failed with ${res.status}`);
    const body = (await res.json()) as {
      transcripts?: StoredTranscriptRow[];
      page_details?: { next_url?: string | null };
    };
    rows.push(...(body.transcripts ?? []));
    url = body.page_details?.next_url ?? null;
  }
  return rows;
}

/** One transcript, as the vendor currently holds it. */
export async function getStoredTranscript(
  apiKey: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<StoredTranscript> {
  const res = await fetchImpl(`${API_BASE}/${id}`, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error(`assemblyai: read failed with ${res.status}`);
  return (await res.json()) as StoredTranscript;
}

/**
 * Delete one transcript and PROVE it by reading it back.
 *
 * The DELETE response already carries the redacted body, but a separate GET
 * is what the acceptance asks for and it is the only thing that shows the
 * redaction survived the write: returns true only when the read-back says the
 * content is gone.
 */
export async function deleteStoredTranscript(
  apiKey: string,
  id: string,
  fetchImpl: FetchLike,
): Promise<boolean> {
  const res = await fetchImpl(`${API_BASE}/${id}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  });
  if (!res.ok) return false;
  const readBack = await getStoredTranscript(apiKey, id, fetchImpl);
  return isDeleted(readBack);
}

/**
 * Delete everything the key still holds content for, and report counts.
 *
 * Only a `completed` or `error` transcript can be deleted — the vendor
 * refuses one still processing — so a row in any other state is left alone
 * and counted as failed, which is the honest reading: it is still there.
 */
export async function sweepStoredTranscripts(
  apiKey: string,
  fetchImpl: FetchLike,
  log: (line: string) => void = () => {},
): Promise<SweepCounts> {
  const rows = await listStoredTranscripts(apiKey, fetchImpl);
  const counts: SweepCounts = {
    found: rows.length,
    alreadyDeleted: 0,
    deleted: 0,
    failed: 0,
  };
  for (const row of rows) {
    if (isDeleted(row)) {
      counts.alreadyDeleted += 1;
      continue;
    }
    if (row.status !== 'completed' && row.status !== 'error') {
      counts.failed += 1;
      continue;
    }
    try {
      if (await deleteStoredTranscript(apiKey, row.id, fetchImpl)) counts.deleted += 1;
      else counts.failed += 1;
    } catch {
      counts.failed += 1;
    }
  }
  if (counts.failed > 0) {
    log(
      `[assemblyai-retention] ${counts.failed} of ${counts.found} not confirmed deleted; retrying next sweep`,
    );
  }
  return counts;
}
