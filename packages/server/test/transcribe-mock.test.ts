/**
 * The mock engine is what every other meeting test speaks to, so its own
 * behaviour has to be pinned: one step per chunk, turns that revise in place,
 * and a close that does not swallow the sentence in progress.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MOCK_SCRIPT,
  type EngineTurn,
  createMockTranscriptionEngine,
} from '../src/transcribe.ts';

const CHUNK = new Uint8Array(320);

async function drive(
  chunks: number,
  script?: Parameters<typeof createMockTranscriptionEngine>[0],
  labels = true,
) {
  const turns: EngineTurn[] = [];
  const errors: string[] = [];
  const engine = createMockTranscriptionEngine(script);
  const session = await engine.open({
    sampleRate: 16_000,
    detectSpeakers: labels,
    onTurn: (t) => turns.push({ ...t }),
    onError: (m) => errors.push(m),
  });
  for (let i = 0; i < chunks; i++) session.send(CHUNK);
  return { session, turns, errors };
}

describe('mock transcription engine', () => {
  it('reveals one word per audio chunk, replacing the turn in place', async () => {
    const { turns } = await drive(3, [{ words: ['pull', 'the', 'schema'] }]);
    expect(turns.map((t) => t.text)).toEqual(['pull', 'pull the', 'pull the schema']);
    // Same turn number throughout: the client replaces, never appends.
    expect(new Set(turns.map((t) => t.turn))).toEqual(new Set([0]));
    expect(turns.every((t) => !t.final)).toBe(true);
  });

  it('settles a turn to text that differs from the partials', async () => {
    // Four chunks: three words, then the step that settles the turn.
    const { turns } = await drive(4, [
      { words: ['pull', 'the', 'schema'], settled: 'Pull the schema.' },
    ]);
    const last = turns[turns.length - 1];
    expect(last).toEqual({ turn: 0, text: 'Pull the schema.', final: true });
    // The correction lands on the SAME turn that was already on screen.
    expect(turns[2]).toEqual({ turn: 0, text: 'pull the schema', final: false });
  });

  it('advances to the next turn after one settles', async () => {
    const { turns } = await drive(6, [{ words: ['one'] }, { words: ['two', 'three'] }]);
    expect(turns.filter((t) => t.final).map((t) => [t.turn, t.text])).toEqual([
      [0, 'one'],
      [1, 'two three'],
    ]);
  });

  it('is deterministic — the same chunk count gives the same script twice', async () => {
    const a = await drive(5);
    const b = await drive(5);
    expect(a.turns).toEqual(b.turns);
    expect(a.errors).toEqual([]);
  });

  it('flushes the sentence in progress on close', async () => {
    const { session, turns } = await drive(2, [{ words: ['we', 'should', 'measure'] }]);
    await session.close();
    expect(turns[turns.length - 1]).toEqual({ turn: 0, text: 'we should', final: true });
  });

  it('emits nothing on close when no turn is in progress', async () => {
    const { session, turns } = await drive(0);
    await session.close();
    expect(turns).toEqual([]);
    // A second close is a no-op, not a second final turn.
    await session.close();
    expect(turns).toEqual([]);
  });

  it('ships a default script that corrects a word in place', async () => {
    const first = DEFAULT_MOCK_SCRIPT[0];
    expect(first).toBeDefined();
    if (!first) return;
    const { turns } = await drive(first.words.length + 1);
    const partials = turns.filter((t) => !t.final).map((t) => t.text);
    const settled = turns.find((t) => t.final);
    expect(settled).toBeDefined();
    // The point of the default script: the last partial is NOT what the turn
    // settles to, so anything driven by it exercises a real revision.
    expect(partials[partials.length - 1]).not.toBe(settled?.text);
    expect(settled?.text).toContain('sync');
    expect(partials[partials.length - 1]).toContain('sink');
  });
});
