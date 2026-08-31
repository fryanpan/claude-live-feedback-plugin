import { describe, expect, it, vi } from 'vitest';
import { loadDocVoices } from '../src/speaker-voices.ts';

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
