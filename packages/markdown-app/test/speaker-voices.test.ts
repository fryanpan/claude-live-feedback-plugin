import { describe, expect, it, vi } from 'vitest';
import { loadDocSpeakers, loadDocVoices, postSpeakerName } from '../src/speaker-voices.ts';

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

describe('loadDocVoices', () => {
  it('asks the latest meeting for its cast, and names them from the record', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/meetings')) {
        return ok({
          meetings: [
            { meetingId: 'm-old', startedAt: 100 },
            { meetingId: 'm-new', startedAt: 900 },
          ],
        });
      }
      return ok({
        speakers: { A: 'Devi' },
        transcript: [
          { text: 'Move the gate.', speaker: 'A' },
          { text: 'Not before Friday.', speaker: 'B' },
        ],
      });
    });
    const voices = await loadDocVoices('huddle', fetchImpl as unknown as typeof fetch);
    expect(voices).toEqual([
      { label: 'A', name: 'Devi', lastSaid: 'Move the gate.' },
      { label: 'B', name: 'Speaker B', lastSaid: 'Not before Friday.' },
    ]);
    // The LATEST meeting, not the first the index happened to list.
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('m-new');
  });

  it('offers nothing for a doc that has never had a meeting', async () => {
    const fetchImpl = vi.fn(async () => ok({ meetings: [] }));
    expect(await loadDocVoices('plain', fetchImpl as unknown as typeof fetch)).toEqual([]);
    // One request, not two: there is no meeting to ask about.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects rather than reporting an empty cast when the request fails', async () => {
    // An empty menu and a broken menu look identical to a reader, and only
    // one of them means "this capture had one voice".
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    await expect(loadDocVoices('huddle', fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      'meetings 500',
    );
  });

  it('escapes a doc id that would otherwise change the path', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return ok({ meetings: [] });
    });
    await loadDocVoices('a/b', fetchImpl as unknown as typeof fetch);
    expect(seen[0]).toBe('/api/docs/a%2Fb/meetings');
  });
});

describe('loadDocSpeakers', () => {
  it('says WHICH meeting the cast belongs to — a later rename is addressed to it', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/meetings')) {
        return ok({ meetings: [{ meetingId: 'm-1', startedAt: 100 }] });
      }
      return ok({ transcript: [{ text: 'Hi.', speaker: 'A' }] });
    });
    expect(await loadDocSpeakers('huddle', fetchImpl as unknown as typeof fetch)).toEqual({
      meetingId: 'm-1',
      voices: [{ label: 'A', name: 'Speaker A', lastSaid: 'Hi.' }],
    });
  });

  it('answers null, not an empty cast, for a doc that has never held a meeting', async () => {
    const fetchImpl = vi.fn(async () => ok({ meetings: [] }));
    expect(await loadDocSpeakers('plain', fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});

describe('postSpeakerName', () => {
  it('posts the name to the meeting it belongs to, and reports the server took it', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init ?? {}]);
      return { ok: true, status: 200 } as unknown as Response;
    };
    const took = await postSpeakerName(
      { docId: 'a/b', meetingId: 'm 1', speaker: 'B', name: 'Priya' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(took).toBe(true);
    expect(calls[0]?.[0]).toBe('/api/docs/a%2Fb/meetings/m%201/speakers');
    expect(calls[0]?.[1].method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ speaker: 'B', name: 'Priya' });
  });

  it('reports a refusal as false — the caller must not show a name the record refused', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 409 }) as unknown as Response);
    expect(
      await postSpeakerName(
        { docId: 'doc', meetingId: 'm-1', speaker: 'A', name: 'Sam' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).toBe(false);
  });
});
