/**
 * The Soniox mapping, driven by a fake socket. NOTHING HERE REACHES THE
 * NETWORK — the socket is a parameter, and `apiKey` accepts an explicit
 * `null` for the same reason AssemblyAI's tests do: on the machine where
 * this feature is configured, a lookup would find the real key and a "no
 * key" test would silently assert the opposite of what it says.
 *
 * The payloads are shaped exactly as
 * https://soniox.com/docs/stt/api-reference/websocket-api documents them:
 * token batches with `is_final`, numbered `speaker` strings, the `<end>`
 * endpoint token, and a `finished: true` reply to the empty end-of-audio
 * frame. Speaker names are invented — the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { EngineSocket, EngineSocketArgs } from '../src/transcribe-assemblyai.ts';
import {
  END_TOKEN,
  SONIOX_ENV_VAR,
  SONIOX_KEYCHAIN_SERVICE,
  SONIOX_MODEL,
  createSonioxEngine,
  resolveSonioxKey,
  sonioxConfig,
  speakerLetter,
} from '../src/transcribe-soniox.ts';
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
  open(): void {
    this.args.onOpen();
  }
  /** Push a server frame down the wire. */
  deliver(msg: unknown): void {
    this.args.onMessage(JSON.stringify(msg));
  }
  /** A batch of tokens, exactly as the engine frames one. */
  tokens(tokens: unknown[], extra: Record<string, unknown> = {}): void {
    this.deliver({ tokens, final_audio_proc_ms: 0, total_audio_proc_ms: 0, ...extra });
  }
  textFrames(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string');
  }
  audioFrames(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string');
  }
}

function harness(
  opts: {
    detectSpeakers?: boolean;
    flushTimeoutMs?: number;
    /** Advanced options on the open, as the relay would pass them. */
    tuning?: Record<string, number | string | boolean | string[]>;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  /** Turns without the wall-clock mark, for whole-object assertions. */
  const turns: EngineTurn[] = [];
  const raw: EngineTurn[] = [];
  const errors: string[] = [];
  const engine = createSonioxEngine({
    apiKey: 'test-key-not-a-real-credential',
    socketFactory: (args) => {
      const socket = new FakeSocket(args);
      sockets.push(socket);
      return socket;
    },
    flushTimeoutMs: opts.flushTimeoutMs ?? 50,
  });
  if (!engine) throw new Error('engine should exist when a key is supplied');
  const opening = engine.open({
    sampleRate: 16_000,
    detectSpeakers: opts.detectSpeakers ?? true,
    ...(opts.tuning ? { tuning: opts.tuning } : {}),
    onTurn: (t) => {
      raw.push({ ...t });
      const { engineMs: _engineMs, audioEndMs: _audioEndMs, ...rest } = t;
      turns.push(rest);
    },
    onError: (m) => errors.push(m),
  });
  const fake = (): FakeSocket => {
    const socket = sockets[0];
    if (!socket) throw new Error('socket was never created');
    return socket;
  };
  return { engine, opening, fake, turns, raw, errors };
}

describe('soniox key resolution', () => {
  const noKeychain = (): string | null => null;

  it('returns null when nothing supplies a key — the not-configured state', () => {
    expect(resolveSonioxKey(undefined, {}, noKeychain)).toBeNull();
    expect(createSonioxEngine({ apiKey: null })).toBeNull();
  });

  it('prefers the explicit option, then the env, then the keychain', () => {
    const env = { [SONIOX_ENV_VAR]: 'from-env' };
    const keychain = (service: string) =>
      service === SONIOX_KEYCHAIN_SERVICE ? 'from-keychain' : null;
    expect(resolveSonioxKey('explicit', env, keychain)).toBe('explicit');
    expect(resolveSonioxKey(undefined, env, keychain)).toBe('from-env');
    expect(resolveSonioxKey(undefined, {}, keychain)).toBe('from-keychain');
  });

  it('treats an explicit null as "no key" and never consults the keychain', () => {
    let consulted = false;
    const keychain = () => {
      consulted = true;
      return 'from-keychain';
    };
    expect(resolveSonioxKey(null, { [SONIOX_ENV_VAR]: 'from-env' }, keychain)).toBeNull();
    expect(consulted).toBe(false);
  });

  it('survives a keychain lookup that throws, which is how "absent" arrives', () => {
    const keychain = () => {
      throw new Error('Keychain entry not found');
    };
    expect(resolveSonioxKey(undefined, {}, keychain)).toBeNull();
  });
});

describe('soniox config frame', () => {
  it('names the model, the PCM shape and endpoint detection', () => {
    const config = sonioxConfig(16_000, false);
    expect(config).toEqual({
      model: SONIOX_MODEL,
      audio_format: 'pcm_s16le',
      sample_rate: 16_000,
      num_channels: 1,
      enable_endpoint_detection: true,
    });
  });

  it('asks for diarization only when the capture said conversation', () => {
    expect(sonioxConfig(16_000, true).enable_speaker_diarization).toBe(true);
    expect('enable_speaker_diarization' in sonioxConfig(16_000, false)).toBe(false);
  });

  it('sends the key inside the first frame, after the socket opens', async () => {
    const h = harness();
    // Nothing goes up before the socket opens — the config would be lost.
    expect(h.fake().sent.length).toBe(0);
    h.fake().open();
    await h.opening;
    const first = JSON.parse(h.fake().textFrames()[0] ?? '{}') as Record<string, unknown>;
    expect(first.api_key).toBe('test-key-not-a-real-credential');
    expect(first.model).toBe(SONIOX_MODEL);
    expect(first.enable_speaker_diarization).toBe(true);
  });

  it('spreads tuning keys into the config frame, terms nested as context', () => {
    const config = sonioxConfig(16_000, true, {
      endpoint_sensitivity: 0.5,
      max_endpoint_delay_ms: 1200,
      context_terms: ['Fryanpan', 'ydoc'],
      language_hints: ['en', 'yue'],
    });
    expect(config.endpoint_sensitivity).toBe(0.5);
    expect(config.max_endpoint_delay_ms).toBe(1200);
    // The API's own shape: an object holding the list, not a bare key.
    expect(config.context).toEqual({ terms: ['Fryanpan', 'ydoc'] });
    expect('context_terms' in config).toBe(false);
    // Hints pass through under their own name.
    expect(config.language_hints).toEqual(['en', 'yue']);
  });

  it('sends no context object for an absent or empty term list', () => {
    expect('context' in sonioxConfig(16_000, true)).toBe(false);
    expect('context' in sonioxConfig(16_000, true, { context_terms: [] })).toBe(false);
  });

  it('connects with the tuning it was opened with', async () => {
    const h = harness({ tuning: { endpoint_sensitivity: -0.4 } });
    h.fake().open();
    await h.opening;
    const first = JSON.parse(h.fake().textFrames()[0] ?? '{}') as Record<string, unknown>;
    expect(first.endpoint_sensitivity).toBe(-0.4);
  });
});

describe('soniox speaker letters', () => {
  it('maps the numbered labels onto the letters the product speaks', () => {
    expect(speakerLetter('1')).toBe('A');
    expect(speakerLetter('2')).toBe('B');
    expect(speakerLetter(3)).toBe('C');
    expect(speakerLetter('26')).toBe('Z');
  });

  it('passes an unmappable label through rather than inventing around it', () => {
    expect(speakerLetter('27')).toBe('27');
    expect(speakerLetter('kitchen-mic')).toBe('kitchen-mic');
    expect(speakerLetter('')).toBeUndefined();
    expect(speakerLetter(undefined)).toBeUndefined();
  });
});

describe('soniox session', () => {
  it('forwards audio as binary frames once open', async () => {
    const h = harness();
    h.fake().open();
    const session = await h.opening;
    session.send(new Uint8Array([1, 2, 3]));
    expect(h.fake().audioFrames()).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('grows a turn from final tokens and revises the non-final tail in place', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().tokens([
      { text: 'So', is_final: true, end_ms: 200 },
      { text: ' the', is_final: true, end_ms: 350 },
      { text: ' sink', is_final: false, end_ms: 520 },
    ]);
    // The next batch REPLACES the tail: "sink" becomes "sync", in place.
    h.fake().tokens([{ text: ' sync', is_final: false, end_ms: 540 }]);
    expect(h.turns).toEqual([
      { turn: 0, text: 'So the sink', final: false },
      { turn: 0, text: 'So the sync', final: false },
    ]);
  });

  it('settles the turn at the <end> token and starts the next one', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().tokens([
      { text: 'Sounds', is_final: true, end_ms: 100, speaker: '1' },
      { text: ' good.', is_final: true, end_ms: 300, speaker: '1' },
      { text: END_TOKEN, is_final: true },
    ]);
    h.fake().tokens([{ text: 'Next', is_final: false, end_ms: 700, speaker: '1' }]);
    expect(h.turns).toEqual([
      { turn: 0, text: 'Sounds good.', final: true, speaker: 'A' },
      { turn: 1, text: 'Next', final: false, speaker: 'A' },
    ]);
  });

  it('drops a provisional tail the endpoint withdrew instead of settling it', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().tokens([
      { text: 'Ship', is_final: true, end_ms: 100 },
      { text: ' maybe', is_final: false, end_ms: 300 },
    ]);
    // The engine settles the turn WITHOUT the tail: " maybe" was noise.
    h.fake().tokens([
      { text: ' it.', is_final: true, end_ms: 320 },
      { text: END_TOKEN, is_final: true },
    ]);
    const settled = h.turns.filter((t) => t.final);
    expect(settled).toEqual([{ turn: 0, text: 'Ship it.', final: true }]);
  });

  it('splits a turn where the settled voice changes, without an endpoint', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().tokens([
      { text: 'Agreed.', is_final: true, end_ms: 100, speaker: '1' },
      { text: ' Wait,', is_final: true, end_ms: 400, speaker: '2' },
      { text: ' no', is_final: false, end_ms: 600, speaker: '2' },
    ]);
    expect(h.turns).toEqual([
      { turn: 0, text: 'Agreed.', final: true, speaker: 'A' },
      { turn: 1, text: 'Wait, no', final: false, speaker: 'B' },
    ]);
  });

  it('never labels a turn on a session that did not ask for diarization', async () => {
    const h = harness({ detectSpeakers: false });
    h.fake().open();
    await h.opening;
    // The engine should not send speakers here, but a stray one must not
    // reach a transcript whose session never paid for labels… it cannot:
    // this asserts the config was the thing that decided, not the adapter.
    h.fake().tokens([
      { text: 'Solo', is_final: true, end_ms: 90 },
      { text: END_TOKEN, is_final: true },
    ]);
    expect(h.turns).toEqual([{ turn: 0, text: 'Solo', final: true }]);
  });

  it('carries the last word offset and the arrival clock on each frame', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    const before = Date.now();
    h.fake().tokens([
      { text: 'One', is_final: true, end_ms: 150 },
      { text: ' two', is_final: false, end_ms: 480 },
    ]);
    const frame = h.raw[0];
    expect(frame?.audioEndMs).toBe(480);
    expect(frame?.engineMs).toBeGreaterThanOrEqual(before);
    // The settled emission prices the last FINAL word, not the tail's.
    h.fake().tokens([{ text: END_TOKEN, is_final: true }]);
    const settled = h.raw[h.raw.length - 1];
    expect(settled?.final).toBe(true);
    expect(settled?.audioEndMs).toBe(150);
  });

  it('ends by sending the empty frame and waiting for finished', async () => {
    const h = harness();
    h.fake().open();
    const session = await h.opening;
    const closing = session.close();
    // The empty frame is the end-of-audio signal; the socket stays up for
    // the flush.
    expect(h.fake().sent[h.fake().sent.length - 1]).toBe('');
    expect(h.fake().closed).toBe(false);
    h.fake().tokens([{ text: 'last words.', is_final: true, end_ms: 900 }], { finished: true });
    await closing;
    expect(h.fake().closed).toBe(true);
    // The flush is the point: the words arrived after close() was called,
    // and they SETTLE — only final turns reach the meeting's record.
    expect(h.turns[h.turns.length - 1]).toEqual({ turn: 0, text: 'last words.', final: true });
    expect(h.errors).toEqual([]);
  });

  it('gives up the flush after the timeout rather than hanging the stop', async () => {
    const h = harness({ flushTimeoutMs: 10 });
    h.fake().open();
    const session = await h.opening;
    await session.close();
    expect(h.fake().closed).toBe(true);
  });

  it('reports an engine error frame without ending the meeting', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().deliver({ tokens: [], error_code: 429, error_message: 'rate limited' });
    expect(h.errors).toEqual(['soniox: rate limited']);
  });

  it('reports an unasked-for close as the meeting-ending failure it is', async () => {
    const h = harness();
    h.fake().open();
    await h.opening;
    h.fake().args.onClose();
    expect(h.errors).toEqual(['soniox: session closed unexpectedly']);
  });

  it('rejects the open when the socket closes before it ever opened', async () => {
    const h = harness();
    h.fake().args.onClose();
    await expect(h.opening).rejects.toThrow('closed before the session began');
  });
});
