/**
 * The Recall client's key resolution and the body it would actually send.
 *
 * NOTHING HERE REACHES THE NETWORK — `fetch` is a parameter for the same
 * reason the AssemblyAI socket is, and here it is also money: one real create
 * puts a bot in a call. `apiKey` accepts an explicit `null` so a "no key"
 * assertion still means something on the machine where the key exists.
 *
 * No real credential appears in this file, and none can: the fake below is a
 * literal the test invents, and every assertion about the key asserts that
 * literal's presence, never its shape.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_BOT_NAME,
  DEFAULT_RETENTION_HOURS,
  ENV_VAR,
  KEYCHAIN_SERVICE,
  type RecallConfig,
  buildCreateBotBody,
  createRecallClient,
  isRecallRegion,
  normalizeWsBase,
  recallApiBase,
  recallConfigFromEnv,
  resolveRecallKey,
} from '../src/recall.ts';

const FAKE_KEY = 'test-key-not-a-credential';

const baseConfig = (over: Partial<RecallConfig> = {}): RecallConfig => ({
  region: 'us-east-1',
  publicWsBase: 'wss://example.test',
  retentionHours: 24,
  separateStreams: true,
  botName: DEFAULT_BOT_NAME,
  ...over,
});

describe('recall key resolution', () => {
  it('prefers an explicit key over everything else', () => {
    const key = resolveRecallKey(FAKE_KEY, { [ENV_VAR]: 'from-env' }, () => 'from-keychain');
    expect(key).toBe(FAKE_KEY);
  });

  it('reads the environment before the keychain', () => {
    let read = 0;
    const key = resolveRecallKey(undefined, { [ENV_VAR]: FAKE_KEY }, () => {
      read++;
      return 'from-keychain';
    });
    expect(key).toBe(FAKE_KEY);
    // The env var is the deliberate per-launch override; consulting the
    // keychain anyway would make a staging launch spend the wrong account.
    expect(read).toBe(0);
  });

  it('falls back to the keychain under the documented service name', () => {
    const asked: string[] = [];
    const key = resolveRecallKey(undefined, {}, (service) => {
      asked.push(service);
      return FAKE_KEY;
    });
    expect(key).toBe(FAKE_KEY);
    expect(asked).toEqual([KEYCHAIN_SERVICE]);
  });

  it('uses the env-var name the keychain helper derives from the service', () => {
    // readKeychainPassword's own convention is uppercase, dashes to
    // underscores. If these two ever disagree, a test that injects the key
    // one way passes while the other silently reads the real keychain.
    expect(ENV_VAR).toBe(KEYCHAIN_SERVICE.toUpperCase().replace(/-/g, '_'));
  });

  it('treats a missing keychain entry (which throws) as "not configured"', () => {
    const key = resolveRecallKey(undefined, {}, () => {
      throw new Error('Keychain entry not found');
    });
    expect(key).toBeNull();
  });

  it('returns null for an explicit null, without consulting anything', () => {
    let read = 0;
    const key = resolveRecallKey(null, { [ENV_VAR]: FAKE_KEY }, () => {
      read++;
      return FAKE_KEY;
    });
    expect(key).toBeNull();
    expect(read).toBe(0);
  });

  it('builds no client without a key', () => {
    expect(createRecallClient({ apiKey: null, env: {}, readKey: () => null })).toBeNull();
  });
});

describe('recall config', () => {
  it('defaults the region and rejects one that is not a real host', () => {
    expect(recallConfigFromEnv({ RECALL_REGION: 'moon-base-1' }).region).toBe('us-east-1');
    expect(recallConfigFromEnv({ RECALL_REGION: 'eu-central-1' }).region).toBe('eu-central-1');
    expect(isRecallRegion('ap-northeast-1')).toBe(true);
    expect(isRecallRegion('us-east-2')).toBe(false);
  });

  it('puts the region in the hostname, because that is where Recall reads it', () => {
    expect(recallApiBase('eu-central-1')).toBe('https://eu-central-1.recall.ai/api');
  });

  it('disables bots when no public ws base is set', () => {
    expect(recallConfigFromEnv({}).publicWsBase).toBeNull();
    // http:// is not a websocket scheme, and silently coercing it would send
    // Recall to an endpoint that cannot upgrade.
    expect(normalizeWsBase('https://example.test')).toBeNull();
    expect(normalizeWsBase('wss://example.test/')).toBe('wss://example.test');
    expect(normalizeWsBase('wss://example.test/hook/')).toBe('wss://example.test/hook');
  });

  it('floors retention at the documented minimum and defaults it short', () => {
    expect(recallConfigFromEnv({}).retentionHours).toBe(DEFAULT_RETENTION_HOURS);
    expect(recallConfigFromEnv({ RECALL_RETENTION_HOURS: '0' }).retentionHours).toBe(
      DEFAULT_RETENTION_HOURS,
    );
    expect(recallConfigFromEnv({ RECALL_RETENTION_HOURS: '1' }).retentionHours).toBe(1);
  });

  it('keeps separate streams on unless they are switched off on purpose', () => {
    expect(recallConfigFromEnv({}).separateStreams).toBe(true);
    expect(recallConfigFromEnv({ RECALL_SEPARATE_STREAMS: '0' }).separateStreams).toBe(false);
  });
});

describe('the create-bot body', () => {
  const body = buildCreateBotBody(baseConfig(), {
    meetingUrl: 'https://example.zoom.us/j/1234567890',
    realtimeUrl: 'wss://example.test/recall/0123456789abcdef0123456789abcdef',
    permissionDeniedTimeoutSec: 60,
  });
  const recording = body.recording_config as Record<string, unknown>;
  const transcript = recording.transcript as Record<string, unknown>;
  const provider = transcript.provider as Record<string, unknown>;

  it('asks for AssemblyAI v3 streaming, never the older name the docs say fails', () => {
    expect(Object.keys(provider)).toEqual(['assembly_ai_v3_streaming']);
    expect(provider.assembly_ai_streaming).toBeUndefined();
  });

  it('turns formatting on, because a settled turn must be a punctuated sentence', () => {
    const aai = provider.assembly_ai_v3_streaming as Record<string, unknown>;
    expect(aai.format_turns).toBe(true);
    expect(aai.speech_model).toBe('universal-streaming-english');
  });

  it('subscribes partials as well as finals', () => {
    // Partials are not decoration: they defer the notes composer's pause tick
    // and they are what tells the turn allocator a new utterance has begun.
    const endpoints = recording.realtime_endpoints as Array<Record<string, unknown>>;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.type).toBe('websocket');
    expect(endpoints[0]?.events).toEqual(['transcript.data', 'transcript.partial_data']);
    expect(endpoints[0]?.url).toBe('wss://example.test/recall/0123456789abcdef0123456789abcdef');
  });

  it('sets a short timed retention and an automatic leave on refusal', () => {
    expect(recording.retention).toEqual({ type: 'timed', hours: 24 });
    expect(body.automatic_leave).toEqual({ recording_permission_denied_timeout: 60 });
  });

  it('carries the separate-streams choice through to diarization', () => {
    expect(transcript.diarization).toEqual({ use_separate_streams_when_available: true });
    const cheap = buildCreateBotBody(baseConfig({ separateStreams: false }), {
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      realtimeUrl: 'wss://example.test/recall/deadbeefdeadbeefdeadbeefdeadbeef',
    });
    const cheapTranscript = (cheap.recording_config as Record<string, unknown>)
      .transcript as Record<string, unknown>;
    expect(cheapTranscript.diarization).toEqual({ use_separate_streams_when_available: false });
    // No timeout asked for, none sent — a Zoom-only field must not ride along
    // on a Meet bot.
    expect(cheap.automatic_leave).toBeUndefined();
  });
});

describe('the client, against a fake transport', () => {
  function clientWith(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createRecallClient({
      apiKey: FAKE_KEY,
      config: baseConfig(),
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(handler(url, init));
      },
    });
    if (!client) throw new Error('expected a client');
    return { client, calls };
  }

  it('sends the key as the whole Authorization header, with no Bearer prefix', async () => {
    const { client, calls } = clientWith(() => Response.json({ id: 'bot-1' }));
    await client.createBot({
      meetingUrl: 'https://example.zoom.us/j/1',
      realtimeUrl: 'wss://example.test/recall/aa',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(FAKE_KEY);
    expect(headers.Authorization.startsWith('Bearer')).toBe(false);
    expect(calls[0]?.url).toBe('https://us-east-1.recall.ai/api/v1/bot/');
  });

  it('names the region in a 401, because a cross-region key is invisible otherwise', async () => {
    const { client } = clientWith(() => new Response('bad key', { status: 401 }));
    await expect(
      client.createBot({ meetingUrl: 'https://example.zoom.us/j/1', realtimeUrl: 'wss://x/y' }),
    ).rejects.toThrow(/RECALL_REGION=us-east-1/);
  });

  it('never puts the key in the error it throws', async () => {
    const { client } = clientWith(() => new Response('nope', { status: 403 }));
    const err = await client
      .createBot({ meetingUrl: 'https://example.zoom.us/j/1', realtimeUrl: 'wss://x/y' })
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain(FAKE_KEY);
  });

  it('refuses a create that came back without an id', async () => {
    const { client } = clientWith(() => Response.json({ status_changes: [] }));
    await expect(
      client.createBot({ meetingUrl: 'https://example.zoom.us/j/1', realtimeUrl: 'wss://x/y' }),
    ).rejects.toThrow(/no id/);
  });

  it('POSTs leave_call and request_recording_permission at the documented paths', async () => {
    const { client, calls } = clientWith(() => Response.json({ ok: true }));
    await client.leaveCall('bot-9');
    await client.requestRecordingPermission('bot-9');
    expect(calls.map((c) => c.url)).toEqual([
      'https://us-east-1.recall.ai/api/v1/bot/bot-9/leave_call/',
      'https://us-east-1.recall.ai/api/v1/bot/bot-9/request_recording_permission/',
    ]);
    expect(calls.every((c) => c.init.method === 'POST')).toBe(true);
  });

  it('reports a refused permission request rather than losing the bot over it', async () => {
    const { client } = clientWith(() => new Response('nope', { status: 400 }));
    expect(await client.requestRecordingPermission('bot-9')).toBe(false);
  });
});
