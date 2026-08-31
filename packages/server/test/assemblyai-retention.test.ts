/**
 * The retention sweep, driven by a fake fetch over RECORDED payloads.
 *
 * `fixtures/assemblyai-retention.json` is not invented: it is a real
 * create → list → delete → read-back → re-list cycle run against the live
 * AssemblyAI API on 2026-08-31 (see the fixture's `_recorded` note). That
 * matters because the two behaviours this module exists to handle are both
 * things the docs do not say and a guessed fixture would have got wrong — a
 * deleted transcript stays `completed` and stays in the list, and the list
 * lags the delete and then spells the sentinel without a scheme.
 *
 * Nothing here reaches the network.
 */
import { describe, expect, it } from 'bun:test';
import {
  type FetchLike,
  deleteStoredTranscript,
  isDeleted,
  listStoredTranscripts,
  sweepStoredTranscripts,
} from '../src/assemblyai-retention.ts';
import fixture from './fixtures/assemblyai-retention.json' with { type: 'json' };

const KEY = 'test-key-not-a-real-one';
const ID = '24327f9c-5687-4e21-b916-1721895d2845';
const SPOKEN = 'The Retention Suite deletes this transcript as soon as it is stored.';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  method: string;
  url: string;
}

/**
 * A fake vendor that behaves the way the recording showed the real one
 * behaving: DELETE redacts the transcript body but leaves the list row
 * alone until it settles.
 */
function fakeVendor(opts: { listSettles?: boolean; deleteStatus?: number } = {}) {
  const calls: Call[] = [];
  let deleted = false;
  const fetchImpl: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'DELETE') {
      const status = opts.deleteStatus ?? 200;
      if (status !== 200) return json({ error: 'nope' }, status);
      deleted = true;
      return json(fixture.deleteResponse);
    }
    if (url.includes(`/transcript/${ID}`)) {
      return json(deleted ? fixture.getAfterDelete : fixture.getBeforeDelete);
    }
    if (!deleted) return json(fixture.listBeforeDelete);
    return json(
      opts.listSettles ? fixture.listAfterDeleteSettled : fixture.listAfterDeleteImmediately,
    );
  };
  return { fetchImpl, calls, wasDeleted: () => deleted };
}

describe('isDeleted', () => {
  it('does NOT read a live transcript as deleted', () => {
    // The positive control for every "skipped because already deleted"
    // assertion below: if the recorded pre-delete shapes read as deleted,
    // those tests would pass while the sweep deleted nothing.
    expect(isDeleted(fixture.getBeforeDelete)).toBe(false);
    expect(isDeleted(fixture.listBeforeDelete.transcripts[0])).toBe(false);
  });

  it('accepts both spellings the vendor uses for the same fact', () => {
    // GET says "http://deleted_by_user"; the settled list says "deleted_by_user".
    expect(isDeleted(fixture.getAfterDelete)).toBe(true);
    expect(isDeleted(fixture.listAfterDeleteSettled.transcripts[0])).toBe(true);
  });

  it('reads the redacted text as deleted even if audio_url were to change shape', () => {
    expect(isDeleted({ id: ID, status: 'completed', text: 'Deleted by user.' })).toBe(true);
  });
});

describe('deleteStoredTranscript', () => {
  it('deletes, then reads the transcript back and finds the words gone', async () => {
    const vendor = fakeVendor();

    // Before: the vendor is holding the actual sentence that was spoken.
    const before = await (
      await vendor.fetchImpl(`https://api.assemblyai.com/v2/transcript/${ID}`)
    ).json();
    expect(before.text).toBe(SPOKEN);

    expect(await deleteStoredTranscript(KEY, ID, vendor.fetchImpl)).toBe(true);

    // After: read it back. The sentence is gone from the vendor's copy.
    const after = await (
      await vendor.fetchImpl(`https://api.assemblyai.com/v2/transcript/${ID}`)
    ).json();
    expect(after.text).not.toBe(SPOKEN);
    expect(after.text).toBe('Deleted by user.');
    expect(after.words).toBeNull();
  });

  it('reports failure when the read-back still shows content', async () => {
    // The read-back is load-bearing, not decorative: a DELETE that returns
    // 200 while the content survives must NOT be counted as a deletion.
    const fetchImpl: FetchLike = async (_url, init) =>
      (init?.method ?? 'GET') === 'DELETE'
        ? json(fixture.deleteResponse)
        : json(fixture.getBeforeDelete);
    expect(await deleteStoredTranscript(KEY, ID, fetchImpl)).toBe(false);
  });

  it('reports failure on a rejected delete without throwing', async () => {
    const vendor = fakeVendor({ deleteStatus: 500 });
    expect(await deleteStoredTranscript(KEY, ID, vendor.fetchImpl)).toBe(false);
  });
});

describe('sweepStoredTranscripts', () => {
  it('deletes the one stored transcript and confirms it', async () => {
    const vendor = fakeVendor();
    const counts = await sweepStoredTranscripts(KEY, vendor.fetchImpl);
    expect(counts).toEqual({ found: 1, alreadyDeleted: 0, deleted: 1, failed: 0 });
    expect(vendor.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });

  it('sends no DELETE for a row the settled list already shows as deleted', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE')
        throw new Error('must not delete an already-deleted row');
      return json(fixture.listAfterDeleteSettled);
    };
    const counts = await sweepStoredTranscripts(KEY, fetchImpl);
    expect(counts).toEqual({ found: 1, alreadyDeleted: 1, deleted: 0, failed: 0 });
  });

  it('re-deletes harmlessly while the list still lags, because DELETE is idempotent', async () => {
    // Verified live: a second DELETE of the same id returns 200. So a stale
    // list costs one redundant call, never a wrong count.
    const vendor = fakeVendor({ listSettles: false });
    await sweepStoredTranscripts(KEY, vendor.fetchImpl);
    const second = await sweepStoredTranscripts(KEY, vendor.fetchImpl);
    expect(second.deleted + second.alreadyDeleted).toBe(1);
    expect(second.failed).toBe(0);
  });

  it('leaves a failed row for the next sweep and logs counts, never content', async () => {
    const vendor = fakeVendor({ deleteStatus: 500 });
    const lines: string[] = [];
    const counts = await sweepStoredTranscripts(KEY, vendor.fetchImpl, (l) => lines.push(l));
    expect(counts).toEqual({ found: 1, alreadyDeleted: 0, deleted: 0, failed: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 of 1');
    expect(lines.join('\n')).not.toContain(SPOKEN);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('does not delete a transcript that is still processing', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') throw new Error('the vendor refuses this anyway');
      return json({
        transcripts: [{ id: ID, status: 'processing', audio_url: 'https://cdn.assemblyai.com/x' }],
        page_details: { next_url: null },
      });
    };
    const counts = await sweepStoredTranscripts(KEY, fetchImpl);
    expect(counts).toEqual({ found: 1, alreadyDeleted: 0, deleted: 0, failed: 1 });
  });

  it('reports nothing to do on an account with no stored transcripts', async () => {
    // This is the state the real account was measured in on 2026-08-31.
    const fetchImpl: FetchLike = async () => json(fixture.listEmptyAccount);
    expect(await sweepStoredTranscripts(KEY, fetchImpl)).toEqual({
      found: 0,
      alreadyDeleted: 0,
      deleted: 0,
      failed: 0,
    });
  });
});

describe('listStoredTranscripts', () => {
  it('follows next_url so the oldest transcripts are not left behind', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      seen.push(url);
      if (seen.length === 1) {
        return json({
          transcripts: [{ id: 'a', status: 'completed' }],
          page_details: { next_url: 'https://api.assemblyai.com/v2/transcript?limit=100&page=2' },
        });
      }
      return json({
        transcripts: [{ id: 'b', status: 'completed' }],
        page_details: { next_url: null },
      });
    };
    const rows = await listStoredTranscripts(KEY, fetchImpl);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(seen).toHaveLength(2);
  });

  it('stops rather than spinning when next_url points at itself', async () => {
    const self = 'https://api.assemblyai.com/v2/transcript?limit=100';
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return json({
        transcripts: [{ id: 'a', status: 'completed' }],
        page_details: { next_url: self },
      });
    };
    await listStoredTranscripts(KEY, fetchImpl);
    expect(calls).toBe(1);
  });

  it('throws on a rejected list rather than reporting an empty account', async () => {
    // An empty result and a 401 must never look the same: "nothing stored"
    // is the claim this whole module makes, and a swallowed auth failure
    // would make it vacuously true.
    const fetchImpl: FetchLike = async () => json({ error: 'bad key' }, 401);
    await expect(listStoredTranscripts(KEY, fetchImpl)).rejects.toThrow('401');
  });
});
