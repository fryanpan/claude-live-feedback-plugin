/**
 * Recall's realtime frames → the turns the rest of the pipeline understands.
 *
 * The fixtures are shaped exactly as
 * docs.recall.ai/docs/real-time-event-payloads and /reference/real-time-transcription
 * document them, doubly-nested `data.data` included. Every participant name
 * here is INVENTED — the repo is public, and a fixture is the easiest place
 * for a real name to end up by accident.
 */
import { describe, expect, it } from 'bun:test';
import {
  SpeakerNamer,
  TurnAllocator,
  labelForParticipant,
  parseRecallFrame,
} from '../src/recall-turns.ts';

/** One `transcript.data` / `transcript.partial_data` frame, as Recall sends it. */
function transcriptFrame(args: {
  final: boolean;
  id: number;
  name: string | null;
  words: string[];
}): string {
  return JSON.stringify({
    event: args.final ? 'transcript.data' : 'transcript.partial_data',
    data: {
      data: {
        words: args.words.map((text, i) => ({
          text,
          start_timestamp: { relative: i * 0.4 },
          end_timestamp: { relative: i * 0.4 + 0.35 },
        })),
        language_code: 'en',
        participant: {
          id: args.id,
          name: args.name,
          is_host: false,
          platform: 'zoom',
          extra_data: {},
          email: null,
        },
      },
      realtime_endpoint: { id: 're_1', metadata: {} },
      transcript: { id: 'tr_1', metadata: {} },
      recording: { id: 'rec_1', metadata: {} },
      bot: { id: 'bot_1', metadata: {} },
    },
  });
}

describe('parsing a realtime frame', () => {
  it('reads a finalized utterance out of the doubly-nested payload', () => {
    const frame = parseRecallFrame(
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', words: ['So', 'the', 'sync.'] }),
    );
    expect(frame).toEqual({
      kind: 'transcript',
      participant: { id: 7, name: 'Rowan Pike' },
      text: 'So the sync.',
      final: true,
    });
  });

  it('marks a partial as not final', () => {
    const frame = parseRecallFrame(
      transcriptFrame({ final: false, id: 7, name: 'Rowan Pike', words: ['So', 'the'] }),
    );
    expect(frame).toMatchObject({ kind: 'transcript', text: 'So the', final: false });
  });

  it('passes an unsubscribed event through as "other" rather than failing', () => {
    const frame = parseRecallFrame(
      JSON.stringify({ event: 'participant_events.join', data: { data: {} } }),
    );
    expect(frame).toEqual({ kind: 'other', event: 'participant_events.join' });
  });

  it('drops an empty utterance instead of blanking a turn already on screen', () => {
    // The contract says a later frame REPLACES the earlier text, so an empty
    // one would erase the sentence rather than leave it alone.
    expect(
      parseRecallFrame(transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', words: [] })),
    ).toBeNull();
  });

  it('returns null for anything it cannot fully read', () => {
    expect(parseRecallFrame('not json')).toBeNull();
    expect(parseRecallFrame('[]')).toBeNull();
    expect(parseRecallFrame(JSON.stringify({ data: {} }))).toBeNull();
    // No participant: there is nobody to attribute the words to, and an
    // unattributed turn in a bot meeting is worse than a missing one.
    expect(
      parseRecallFrame(
        JSON.stringify({ event: 'transcript.data', data: { data: { words: [{ text: 'hi' }] } } }),
      ),
    ).toBeNull();
  });
});

describe('allocating turn numbers', () => {
  const speak = (
    alloc: TurnAllocator,
    id: number,
    text: string,
    final: boolean,
  ): { turn: number; text: string; final: boolean; speaker?: string } =>
    alloc.allocate({ participant: { id, name: null }, text, final });

  it('keeps one number while a turn is revised, and a new one after it', () => {
    const alloc = new TurnAllocator();
    expect(speak(alloc, 1, 'so the', false).turn).toBe(0);
    expect(speak(alloc, 1, 'so the sink', false).turn).toBe(0);
    expect(speak(alloc, 1, 'So the sync.', true).turn).toBe(0);
    expect(speak(alloc, 1, 'next', false).turn).toBe(1);
  });

  it('treats a re-emission of the SAME words as a revision, not a new turn', () => {
    // AssemblyAI with format_turns ends a turn twice — unformatted, then
    // punctuated. The direct engine sees both flags and can tell; Recall
    // normalises its providers and the flags do not survive, so if both
    // reach us they are indistinguishable. Numbering per final would put the
    // sentence in the transcript twice, once without punctuation.
    const alloc = new TurnAllocator();
    speak(alloc, 1, 'so the sync is the bottleneck', false);
    const unformatted = speak(alloc, 1, 'so the sync is the bottleneck', true);
    const formatted = speak(alloc, 1, 'So the sync is the bottleneck.', true);
    expect(unformatted.turn).toBe(0);
    expect(formatted.turn).toBe(0);
  });

  it('gives two DIFFERENT back-to-back finals two turns, partial or no partial', () => {
    // The failure the same-words clause must not cause. Two sentences said
    // one after the other, with the partial stream lost, must not merge and
    // lose the first — losing words is worse than duplicating punctuation.
    const alloc = new TurnAllocator();
    expect(speak(alloc, 1, 'So the sync is the bottleneck.', true).turn).toBe(0);
    expect(speak(alloc, 1, "Let's measure it first.", true).turn).toBe(1);
    expect(speak(alloc, 1, 'And then rewrite.', true).turn).toBe(2);
  });

  it('opens a new turn when the same speaker starts partialling again', () => {
    const alloc = new TurnAllocator();
    speak(alloc, 1, 'First one.', true);
    expect(speak(alloc, 1, 'and now', false).turn).toBe(1);
    expect(speak(alloc, 1, 'And now the second.', true).turn).toBe(1);
  });

  it('gives concurrent speakers distinct numbers that interleave freely', () => {
    const alloc = new TurnAllocator();
    expect(speak(alloc, 1, 'I think', false).turn).toBe(0);
    expect(speak(alloc, 2, 'wait', false).turn).toBe(1);
    expect(speak(alloc, 1, 'I think we should.', true).turn).toBe(0);
    expect(speak(alloc, 2, 'Wait, say that again.', true).turn).toBe(1);
  });

  it('opens a turn for a final that never partialled', () => {
    // The one-word "yes" that settles before a partial ever goes out, and the
    // degraded case where the partial subscription is lost entirely.
    const alloc = new TurnAllocator();
    expect(speak(alloc, 3, 'Yes.', true).turn).toBe(0);
    expect(speak(alloc, 3, 'And another thing.', false).turn).toBe(1);
  });

  it('labels every turn with the participant, not with their name', () => {
    const alloc = new TurnAllocator();
    expect(speak(alloc, 42, 'hello', false).speaker).toBe('p42');
    expect(labelForParticipant(42)).toBe('p42');
    // The label rides in a field capped at 16 characters by the wire contract.
    expect(labelForParticipant(999999999).length).toBeLessThanOrEqual(16);
  });
});

describe('naming the voices', () => {
  it('uses the platform name, once, and keeps it stable', () => {
    const namer = new SpeakerNamer();
    const rowan = { id: 7, name: 'Rowan Pike' };
    expect(namer.isNew(rowan)).toBe(true);
    expect(namer.nameFor(rowan)).toBe('Rowan Pike');
    expect(namer.isNew(rowan)).toBe(false);
    expect(namer.nameFor(rowan)).toBe('Rowan Pike');
  });

  it('disambiguates two people with the same display name', () => {
    // Composed notes carry no per-mention attribution, so two "Alex Yun"s
    // make every "Alex Yun" in the notes ambiguous — and the notes session
    // detects exactly that and REFUSES to rewrite retroactively. Fixing it at
    // this seam keeps that guard for the case it was written for.
    const namer = new SpeakerNamer();
    expect(namer.nameFor({ id: 1, name: 'Alex Yun' })).toBe('Alex Yun');
    expect(namer.nameFor({ id: 2, name: 'Alex Yun' })).toBe('Alex Yun (2)');
    expect(namer.nameFor({ id: 3, name: 'Alex Yun' })).toBe('Alex Yun (3)');
    // And the first one did not move.
    expect(namer.nameFor({ id: 1, name: 'Alex Yun' })).toBe('Alex Yun');
  });

  it('names an anonymous participant "Guest N" rather than leaking the label', () => {
    const namer = new SpeakerNamer();
    expect(namer.nameFor({ id: 4, name: null })).toBe('Guest 1');
    expect(namer.nameFor({ id: 5, name: null })).toBe('Guest 2');
    expect(namer.names()).toEqual(['Guest 1', 'Guest 2']);
  });
});
