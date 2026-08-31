/**
 * The AssemblyAI mapping, driven by a fake socket. NOTHING HERE REACHES THE
 * NETWORK — that is the whole reason the socket is a parameter, and the
 * reason `apiKey` accepts an explicit `null`: on the machine where this
 * feature is configured, a lookup would find the real key and a "no key"
 * test would silently assert the opposite of what it says.
 *
 * The payloads are shaped exactly as
 * https://www.assemblyai.com/docs/streaming/message-sequence documents them,
 * including the pair of `end_of_turn: true` messages a formatted turn ends
 * with. Speaker names are invented — the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  ENV_VAR,
  type EngineSocket,
  type EngineSocketArgs,
  KEYCHAIN_SERVICE,
  createAssemblyAiEngine,
  expiryFrom,
  resolveAssemblyAiKey,
  streamingUrl,
} from '../src/transcribe-assemblyai.ts';
import type { EngineTurn } from '../src/transcribe.ts';

/** A socket that records what went up and lets the test push what comes down. */
class FakeSocket implements EngineSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  constructor(readonly args: EngineSocketArgs) {}
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** Push a server frame down the wire. */
  deliver(msg: unknown): void {
    this.args.onMessage(JSON.stringify(msg));
  }
  /** `expiresAt` is the engine's own field: a Unix timestamp in SECONDS. */
  begin(expiresAt = 1_756_000_000): void {
    this.deliver({
      type: 'Begin',
      id: 'b1e5b0f8-0000-4000-8000-000000000001',
      expires_at: expiresAt,
    });
  }
  /** Only the JSON control frames; audio is binary and never echoed. */
  textFrames(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string');
  }
  audioFrames(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string');
  }
}

function harness(
  opts: {
    flushTimeoutMs?: number;
    connectTimeoutMs?: number;
    detectSpeakers?: boolean;
    rolloverMarginMs?: number;
    /** Capture the rollover timer instead of letting a real clock run it. */
    manualSchedule?: boolean;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const turns: EngineTurn[] = [];
  const errors: string[] = [];
  /** Every rollover the engine armed, newest last. */
  const scheduled: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const { manualSchedule, ...engineOpts } = opts;
  const engine = createAssemblyAiEngine({
    apiKey: 'test-key-not-a-real-credential',
    socketFactory: (args) => {
      const socket = new FakeSocket(args);
      sockets.push(socket);
      return socket;
    },
    ...(manualSchedule
      ? {
          schedule: (ms: number, fn: () => void) => {
            const entry = { ms, fire: fn, cancelled: false };
            scheduled.push(entry);
            return () => {
              entry.cancelled = true;
            };
          },
        }
      : {}),
    ...engineOpts,
  });
  if (!engine) throw new Error('engine should exist when a key is supplied');
  const opening = engine.open({
    sampleRate: 16_000,
    // Labels on by default here because most of this file is about mapping
    // them; the solo case has its own test on the URL, which is the only
    // place the decision is expressed.
    detectSpeakers: opts.detectSpeakers ?? true,
    onTurn: (t) => turns.push({ ...t }),
    onError: (m) => errors.push(m),
  });
  const fake = (index = sockets.length - 1): FakeSocket => {
    const socket = sockets[index];
    if (!socket) throw new Error(`socket ${index} was never created`);
    return socket;
  };
  /** The rollover timer still armed, or a failure naming what was there. */
  const pending = () => {
    const live = scheduled.filter((s) => !s.cancelled);
    const last = live[live.length - 1];
    if (!last) throw new Error(`no rollover armed (${scheduled.length} armed and cancelled)`);
    return last;
  };
  return { engine, opening, fake, sockets, turns, errors, scheduled, pending };
}

describe('assemblyai key resolution', () => {
  const noKeychain = (): string | null => null;

  it('returns null when nothing supplies a key — the not-configured state', () => {
    expect(resolveAssemblyAiKey(undefined, {}, noKeychain)).toBeNull();
    expect(createAssemblyAiEngine({ apiKey: null })).toBeNull();
  });

  it('prefers the explicit option, then the env, then the keychain', () => {
    const env = { [ENV_VAR]: 'from-env' };
    const keychain = (service: string) => (service === KEYCHAIN_SERVICE ? 'from-keychain' : null);
    expect(resolveAssemblyAiKey('explicit', env, keychain)).toBe('explicit');
    expect(resolveAssemblyAiKey(undefined, env, keychain)).toBe('from-env');
    expect(resolveAssemblyAiKey(undefined, {}, keychain)).toBe('from-keychain');
  });

  it('treats an explicit null as "no key" and never consults the keychain', () => {
    let consulted = false;
    const keychain = () => {
      consulted = true;
      return 'from-keychain';
    };
    expect(resolveAssemblyAiKey(null, { [ENV_VAR]: 'from-env' }, keychain)).toBeNull();
    expect(consulted).toBe(false);
  });

  it('survives a keychain lookup that throws, which is how "absent" arrives', () => {
    const keychain = () => {
      throw new Error('Keychain entry not found');
    };
    expect(resolveAssemblyAiKey(undefined, {}, keychain)).toBeNull();
  });
});

describe('assemblyai connect url', () => {
  it('carries the sample rate, the PCM encoding and formatted turns', () => {
    const url = new URL(streamingUrl(16_000, false));
    expect(url.origin + url.pathname).toBe('wss://streaming.assemblyai.com/v3/ws');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('encoding')).toBe('pcm_s16le');
    expect(url.searchParams.get('format_turns')).toBe('true');
  });
});

describe('assemblyai session', () => {
  it('sends the key as a bare Authorization header and opens on Begin', async () => {
    const h = harness();
    // The header goes out at construction, before anything is awaited.
    expect(h.fake().args.headers).toEqual({ Authorization: 'test-key-not-a-real-credential' });
    expect(h.fake().args.url).toBe(streamingUrl(16_000, true));
    h.fake().begin();
    const session = await h.opening;
    expect(session).toBeDefined();
  });

  it('forwards audio as raw binary frames on the same socket', async () => {
    const h = harness();
    h.fake().begin();
    const session = await h.opening;
    session.send(new Uint8Array([1, 2, 3, 4]));
    session.send(new Uint8Array([5, 6]));
    expect(
      h
        .fake()
        .audioFrames()
        .map((f) => [...f]),
    ).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
    // No JSON went up alongside the audio — there is no envelope.
    expect(h.fake().textFrames()).toEqual([]);
  });

  it('maps a growing turn to in-place revisions and settles on the formatted final', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().deliver({
      type: 'Turn',
      turn_order: 0,
      turn_is_formatted: false,
      end_of_turn: false,
      transcript: 'the sink is',
      end_of_turn_confidence: 0.1,
      words: [],
    });
    h.fake().deliver({
      type: 'Turn',
      turn_order: 0,
      turn_is_formatted: false,
      end_of_turn: false,
      transcript: 'the sink is the bottleneck',
      end_of_turn_confidence: 0.2,
      words: [],
    });
    // The unformatted final — end_of_turn true, formatting not applied yet.
    h.fake().deliver({
      type: 'Turn',
      turn_order: 0,
      turn_is_formatted: false,
      end_of_turn: true,
      transcript: 'the sink is the bottleneck',
      end_of_turn_confidence: 0.81,
      words: [],
    });
    // The formatted final that supersedes it, correcting a word already shown.
    h.fake().deliver({
      type: 'Turn',
      turn_order: 0,
      turn_is_formatted: true,
      end_of_turn: true,
      transcript: 'The sync is the bottleneck.',
      end_of_turn_confidence: 0.81,
      words: [],
    });

    expect(h.turns).toEqual([
      { turn: 0, text: 'the sink is', final: false },
      { turn: 0, text: 'the sink is the bottleneck', final: false },
      // The unformatted end_of_turn is NOT settled: a second message for the
      // same turn is still coming, and it rewrites the text.
      { turn: 0, text: 'the sink is the bottleneck', final: false },
      { turn: 0, text: 'The sync is the bottleneck.', final: true },
    ]);
    expect(h.errors).toEqual([]);
  });

  it('keeps turn numbers as the engine numbers them across turns', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    for (const [order, transcript] of [
      [0, 'Morning, Jordan.'],
      [1, 'Can you take the migration?'],
    ] as const) {
      h.fake().deliver({
        type: 'Turn',
        turn_order: order,
        turn_is_formatted: true,
        end_of_turn: true,
        transcript,
        words: [],
      });
    }
    expect(h.turns).toEqual([
      { turn: 0, text: 'Morning, Jordan.', final: true },
      { turn: 1, text: 'Can you take the migration?', final: true },
    ]);
  });

  it('ignores frames it cannot use instead of ending the meeting', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().args.onMessage('not json at all');
    h.fake().deliver({ type: 'Turn', turn_order: 'nope', transcript: 'x' });
    h.fake().deliver({ type: 'SomethingNew', hello: true });
    expect(h.turns).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  it('reports an engine Error frame without closing the session', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().deliver({ type: 'Error', error: 'rate limit exceeded' });
    expect(h.errors).toEqual(['assemblyai: rate limit exceeded']);
    expect(h.fake().closed).toBe(false);
  });

  it('closes by sending Terminate and waiting for Termination to flush', async () => {
    const h = harness();
    h.fake().begin();
    const session = await h.opening;
    const closing = session.close();
    expect(h.fake().textFrames()).toEqual([JSON.stringify({ type: 'Terminate' })]);
    // The flush: the last turn arrives AFTER Terminate and before Termination.
    h.fake().deliver({
      type: 'Turn',
      turn_order: 0,
      turn_is_formatted: true,
      end_of_turn: true,
      transcript: "Let's pick it up tomorrow.",
      words: [],
    });
    h.fake().deliver({
      type: 'Termination',
      audio_duration_seconds: 12,
      session_duration_seconds: 14,
    });
    await closing;
    expect(h.turns.at(-1)).toEqual({ turn: 0, text: "Let's pick it up tomorrow.", final: true });
    expect(h.fake().closed).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('gives up on the flush rather than hanging when Termination never comes', async () => {
    const h = harness({ flushTimeoutMs: 5 });
    h.fake().begin();
    const session = await h.opening;
    await session.close();
    expect(h.fake().closed).toBe(true);
    // A stop the human pressed is not a failure, however the engine behaved.
    expect(h.errors).toEqual([]);
  });

  it('treats a socket close that follows our Terminate as the clean end', async () => {
    const h = harness();
    h.fake().begin();
    const session = await h.opening;
    const closing = session.close();
    // Some engines just hang up after Terminate instead of sending
    // Termination. That is a finished meeting, not a dropped one.
    h.fake().args.onClose();
    await closing;
    expect(h.errors).toEqual([]);
  });

  it('rejects the open when the socket closes before Begin', async () => {
    const h = harness();
    h.fake().args.onClose();
    await expect(h.opening).rejects.toThrow(/before the session began/);
  });

  it('rejects the open when the socket errors before Begin', async () => {
    const h = harness();
    h.fake().args.onError('connection refused');
    await expect(h.opening).rejects.toThrow(/connection refused/);
  });

  it('reports a mid-meeting disconnect as an error, not a clean stop', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().args.onClose();
    expect(h.errors).toEqual(['assemblyai: session closed unexpectedly']);
  });

  it('gives up when Begin never arrives', async () => {
    const h = harness({ connectTimeoutMs: 5 });
    await expect(h.opening).rejects.toThrow(/connect timeout/);
  });
});

describe('assemblyai session rollover — the three-hour cap', () => {
  const turn = (over: Record<string, unknown>) => ({
    type: 'Turn',
    turn_is_formatted: true,
    end_of_turn: true,
    end_of_turn_confidence: 0.9,
    words: [],
    ...over,
  });
  /** Two minutes of session left, so a one-minute margin arms a minute out. */
  const soon = (): number => Math.floor(Date.now() / 1000) + 120;

  it('arms the rollover a margin before the expiry the engine gave', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake().begin(soon());
    await h.opening;
    // Around a minute: 120s of session, minus the 60s margin.
    expect(h.pending().ms).toBeGreaterThan(50_000);
    expect(h.pending().ms).toBeLessThanOrEqual(60_000);
  });

  it('opens the next session before retiring the old one, and never drops it', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake(0).begin(soon());
    const session = await h.opening;

    h.pending().fire();
    // The new socket exists, but the audio has NOT moved yet: nothing is
    // spoken into a session that has not said Begin.
    expect(h.sockets.length).toBe(2);
    session.send(new Uint8Array([1, 2]));
    expect(h.fake(0).audioFrames().length).toBe(1);
    expect(h.fake(1).audioFrames().length).toBe(0);
    // The old socket is still carrying the meeting, so it has not been told
    // anything yet.
    expect(h.fake(0).textFrames()).toEqual([]);

    h.fake(1).begin(soon());
    await Promise.resolve();
    await Promise.resolve();

    // Audio has moved across.
    session.send(new Uint8Array([3, 4]));
    expect(h.fake(1).audioFrames().length).toBe(1);
    expect(h.fake(0).audioFrames().length).toBe(1);
    // And the old session was TERMINATED, not merely dropped — an
    // unterminated session stays open on AssemblyAI's side and is billed for
    // the full three hours.
    expect(
      h
        .fake(0)
        .textFrames()
        .map((f) => JSON.parse(f).type),
    ).toEqual(['Terminate']);
    // The meeting is intact: no error reached the caller.
    expect(h.errors).toEqual([]);
  });

  it('continues turn numbering across the join, in both directions', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake(0).begin(soon());
    await h.opening;
    h.fake(0).deliver(turn({ turn_order: 0, transcript: 'First thing.' }));
    h.fake(0).deliver(turn({ turn_order: 1, transcript: 'Second thing.' }));

    h.pending().fire();
    h.fake(1).begin(soon());
    await Promise.resolve();
    await Promise.resolve();

    // A fresh AssemblyAI session counts from zero again. Downstream, a turn
    // id is the identity a transcript revises in place and the key the
    // record is written under, so turn 0 of the new session must not land on
    // top of turn 0 of the old one.
    h.fake(1).deliver(turn({ turn_order: 0, transcript: 'After the handover.' }));
    // The old session's flush still arrives, and still means its own turn 1.
    h.fake(0).deliver(turn({ turn_order: 1, transcript: 'Second thing, finished.' }));

    expect(h.turns.map((t) => [t.turn, t.text])).toEqual([
      [0, 'First thing.'],
      [1, 'Second thing.'],
      [2, 'After the handover.'],
      [1, 'Second thing, finished.'],
    ]);
  });

  it('gives the two legs distinct ids when the old one speaks again', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake(0).begin(soon());
    await h.opening;
    h.fake(0).deliver(turn({ turn_order: 0, transcript: 'Before the handover.' }));

    h.pending().fire();
    h.fake(1).begin(soon());
    await Promise.resolve();
    await Promise.resolve();

    // The new leg speaks first, and then the old one delivers a turn it had
    // opened while the handshake was out. Both are turn 1 as far as arithmetic
    // on the old session's numbering goes, and they are different sentences by
    // (possibly) different people, so they cannot share an id: downstream a
    // turn id is an identity, and one would overwrite the other.
    h.fake(1).deliver(turn({ turn_order: 0, transcript: 'Said on the new session.' }));
    h.fake(0).deliver(turn({ turn_order: 1, transcript: 'Said on the old session.' }));

    expect(h.turns.map((t) => [t.turn, t.text])).toEqual([
      [0, 'Before the handover.'],
      [1, 'Said on the new session.'],
      [2, 'Said on the old session.'],
    ]);
  });

  it('keeps the meeting on the old session when the new one refuses', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake(0).begin(soon());
    const session = await h.opening;

    h.pending().fire();
    // The replacement never begins — the engine hangs up on it.
    h.fake(1).args.onClose();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Audio still flows to the session that is actually open, the caller is
    // told nothing (the meeting has not ended), and another attempt is armed
    // inside the margin that is left.
    session.send(new Uint8Array([1, 2]));
    expect(h.fake(0).audioFrames().length).toBe(1);
    expect(h.errors).toEqual([]);
    expect(h.pending().ms).toBeGreaterThan(0);
  });

  it('terminates a session that opened while the meeting was ending', async () => {
    const h = harness({ manualSchedule: true, rolloverMarginMs: 60_000 });
    h.fake(0).begin(soon());
    const session = await h.opening;

    h.pending().fire();
    // Stop pressed with the handshake still out.
    const closing = session.close();
    h.fake(0).deliver({
      type: 'Termination',
      audio_duration_seconds: 1,
      session_duration_seconds: 1,
    });
    await closing;

    // The replacement answers after the meeting is over. It is a real open,
    // billed session, so it is terminated rather than abandoned.
    h.fake(1).begin(soon());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      h
        .fake(1)
        .textFrames()
        .map((f) => JSON.parse(f).type),
    ).toEqual(['Terminate']);
  });
});

describe('assemblyai expiry parsing', () => {
  it('reads seconds and milliseconds, and falls back for anything else', () => {
    const now = 1_800_000_000_000;
    const threeHours = 3 * 60 * 60 * 1_000;
    // Seconds — the shape the engine documents.
    expect(expiryFrom(1_800_000_600, now)).toBe(1_800_000_600_000);
    // Milliseconds, should they ever be sent.
    expect(expiryFrom(1_800_000_600_000, now)).toBe(1_800_000_600_000);
    // Missing, malformed, or already past: a deadline three hours out, which
    // is the engine's own cap. Reading a past timestamp literally would arm
    // the rollover immediately and then again, forever.
    expect(expiryFrom(undefined, now)).toBe(now + threeHours);
    expect(expiryFrom('soon', now)).toBe(now + threeHours);
    expect(expiryFrom(1_700_000_000, now)).toBe(now + threeHours);
  });
});

describe('assemblyai speaker labels', () => {
  const turn = (over: Record<string, unknown>) => ({
    type: 'Turn',
    turn_is_formatted: true,
    end_of_turn: true,
    end_of_turn_confidence: 0.9,
    words: [],
    ...over,
  });

  it('asks for speaker labels only when the capture is a conversation', () => {
    expect(new URL(streamingUrl(16_000, true)).searchParams.get('speaker_labels')).toBe('true');
    // The solo case is the one that costs money to get wrong: the parameter
    // must be ABSENT, not `false` — an unpriced session is one that never
    // asked. Both directions asserted, because a URL builder that always
    // said 'true' and a URL builder that always said 'false' each pass one.
    expect(new URL(streamingUrl(16_000, false)).searchParams.get('speaker_labels')).toBeNull();
  });

  it('carries the turn-level speaker label through the seam', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().deliver(turn({ turn_order: 0, transcript: 'Morning, Jordan.', speaker_label: 'A' }));
    h.fake().deliver(turn({ turn_order: 1, transcript: 'Morning.', speaker_label: 'B' }));
    expect(h.turns).toEqual([
      { turn: 0, text: 'Morning, Jordan.', final: true, speaker: 'A' },
      { turn: 1, text: 'Morning.', final: true, speaker: 'B' },
    ]);
  });

  it('treats a placeholder label as no speaker, so the strip shows no tag for it', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().deliver(turn({ turn_order: 0, transcript: 'Yes.', speaker_label: 'PENDING' }));
    h.fake().deliver(turn({ turn_order: 1, transcript: 'No.', speaker_label: 'UNKNOWN' }));
    h.fake().deliver(turn({ turn_order: 2, transcript: 'Maybe.' }));
    expect(h.turns.map((t) => t.speaker)).toEqual([undefined, undefined, undefined]);
    expect(h.turns.map((t) => 'speaker' in t)).toEqual([false, false, false]);
  });

  it('re-emits a settled turn when the end-of-session SpeakerRevision relabels it', async () => {
    const h = harness();
    h.fake().begin();
    await h.opening;
    h.fake().deliver(
      turn({ turn_order: 0, transcript: 'Take the migration?', speaker_label: 'A' }),
    );
    h.fake().deliver(turn({ turn_order: 1, transcript: 'Sure.', speaker_label: 'A' }));
    h.turns.length = 0;
    h.fake().deliver({
      type: 'SpeakerRevision',
      revisions: [
        { turn_order: 1, speaker_label: 'B', words: [] },
        // A turn the engine never sent cannot be revised — nothing to re-emit.
        { turn_order: 7, speaker_label: 'B', words: [] },
      ],
    });
    expect(h.turns).toEqual([{ turn: 1, text: 'Sure.', final: true, speaker: 'B' }]);
  });
});
