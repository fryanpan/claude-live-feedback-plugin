/**
 * Recall.ai — the vendor that puts a bot in a Zoom or Google Meet call.
 *
 * PROTOCOL, CONFIRMED FROM THE DOCS rather than remembered (read 2026-08-30):
 *
 *  - `POST https://<region>.recall.ai/api/v1/bot/` creates a bot for a
 *    `meeting_url`. The key travels in the `Authorization` header with NO
 *    `Bearer` prefix — the same shape AssemblyAI uses, and for the same
 *    reason a reviewer should not "fix" it.
 *    (docs.recall.ai/docs/bot_create, /reference/bot_retrieve)
 *  - The REGION IS THE HOSTNAME. There is no region field in the body, and a
 *    key issued for one region is not valid at another
 *    (docs.recall.ai/docs/regions). Four hosts exist; `RECALL_REGION` picks.
 *  - `recording_config.realtime_endpoints[]` is how data leaves Recall while
 *    the meeting is live. `type: "websocket"` means RECALL DIALS US: the URL
 *    must be reachable from the public internet, which is the one thing this
 *    server is not by default. See `publicWsBase` below.
 *    (docs.recall.ai/docs/real-time-websocket-endpoints)
 *  - `recording_config.transcript.provider.assembly_ai_v3_streaming` runs
 *    AssemblyAI Universal Streaming — the SAME engine `transcribe-assemblyai.ts`
 *    speaks to directly — inside Recall, and returns `transcript.data` events
 *    carrying the platform's own participant name. The AssemblyAI key for
 *    THAT path lives in the Recall dashboard for the matching region, not in
 *    this request and not in this repo; the Keychain key still serves the
 *    browser-microphone path. Use `assembly_ai_v3_streaming`, never the older
 *    `assembly_ai_streaming`, which the docs say fails.
 *    (docs.recall.ai/docs/assemblyai, /docs/dsdk-realtime-transcription)
 *  - `recording_config.retention` is `{type:"timed",hours:N}` (min 1, default
 *    168) or `{type:"forever"}`; `null` is zero-data-retention.
 *    (docs.recall.ai/docs/data-retention)
 *  - Zoom's NATIVE recording consent is not a create-time flag. The bot joins,
 *    and `POST /api/v1/bot/{id}/request_recording_permission/` asks the host —
 *    which is what makes Zoom's own banner fire. The answer arrives as the
 *    `bot.recording_permission_allowed` / `_denied` status events, and
 *    `automatic_leave.recording_permission_denied_timeout` is what stops a
 *    refused bot from sitting in the call billing.
 *    (docs.recall.ai/reference/bot_request_recording_permission_create)
 *
 * `fetch` is injected for the same reason the AssemblyAI socket is: a test of
 * this mapping must not reach the vendor, and this one spends money per bot.
 */

import { readKeychainPassword } from './share/keychain.ts';

/** Keychain service holding the key. Env override: CLAUDE_WORKSPACES_RECALL_API_KEY. */
export const KEYCHAIN_SERVICE = 'claude-workspaces-recall-api-key';
export const ENV_VAR = 'CLAUDE_WORKSPACES_RECALL_API_KEY';

/**
 * Every region Recall documents. A closed set on purpose: the region is the
 * hostname, so a typo in `RECALL_REGION` would otherwise become a request to
 * a host that does not exist, surfacing as a DNS error at invite time rather
 * than as a configuration problem at boot.
 */
export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

export function isRecallRegion(value: string): value is RecallRegion {
  return (RECALL_REGIONS as readonly string[]).includes(value);
}

export function recallApiBase(region: RecallRegion): string {
  return `https://${region}.recall.ai/api`;
}

/**
 * Resolve the key: explicit option, then the environment, then Keychain.
 *
 * Identical order and identical reasoning to `resolveAssemblyAiKey` — the env
 * var is the deliberate per-launch override, and returning null is the
 * documented "not configured" state rather than an error. Kept as its own
 * function, not shared with AssemblyAI's, because the two differ in the one
 * thing a shared helper would have to parameterise anyway (which service),
 * and a shared one would invite a caller to pass the wrong one.
 */
export function resolveRecallKey(
  explicit: string | null | undefined,
  env: Record<string, string | undefined>,
  read: (service: string) => string | null,
): string | null {
  if (explicit !== undefined) return explicit || null;
  const fromEnv = env[ENV_VAR];
  if (fromEnv) return fromEnv;
  try {
    const key = read(KEYCHAIN_SERVICE);
    if (key) return key;
  } catch {
    // A missing entry throws. Absent is the normal state, not a failure.
  }
  return null;
}

/**
 * How long Recall keeps the recording. Bryan's call (2026-08-30) is SHORT.
 *
 * One hour is the documented minimum and 24 is the default here: short enough
 * that a meeting's audio is not sitting on a vendor's disk for a week, long
 * enough that a bot which misbehaved at 9am can still be debugged after lunch.
 * The words we actually keep are in this repo's own append-only transcript,
 * which is unaffected by this number.
 */
export const DEFAULT_RETENTION_HOURS = 24;
export const MIN_RETENTION_HOURS = 1;

export interface RecallConfig {
  region: RecallRegion;
  /**
   * The PUBLIC wss:// origin Recall dials back on, e.g. `wss://x.example.com`.
   *
   * DERIVED from `CW_PUBLIC_BASE_URL`, never configured on its own. That
   * value already exists because this deployment sits behind a Cloudflare
   * Tunnel and the server cannot discover its own external origin; a second
   * variable naming the same host would be a second thing to get wrong, and
   * the failure when they disagreed would be a bot that joins, records,
   * bills, and delivers nothing.
   *
   * Null is the ordinary state on a tailnet-only server and it disables the
   * whole feature — see `wsBaseFromPublicBaseUrl` for exactly when.
   */
  publicWsBase: string | null;
  retentionHours: number;
  /**
   * Transcribe each participant's own audio stream rather than the mixed one
   * where the platform supports it (Zoom, Meet, Teams).
   *
   * ON is more accurate over crosstalk and is what makes the participant on a
   * `transcript.data` event the person who actually spoke. It is also the
   * expensive setting: AssemblyAI bills per streaming SESSION-second, and this
   * opens one session per speaking participant. Off, one mixed session
   * transcribes the room at a flat rate and Recall attributes turns by
   * correlating its own speech events — cheaper, and wrong more often when two
   * people talk over each other.
   */
  separateStreams: boolean;
  /** Name shown in the participant list. */
  botName: string;
}

export const DEFAULT_BOT_NAME = 'Meeting Assistant';

/**
 * Build the config from the environment, or null when there is no key.
 *
 * Null is the whole "meeting bots not configured" mechanism, the same shape
 * `createAssemblyAiEngine` uses: the server gets no client, the invite route
 * answers a reason a person can read, and no separate enabled flag exists to
 * disagree with the key.
 */
export function recallConfigFromEnv(
  env: Record<string, string | undefined>,
  publicBaseUrl?: string | null,
): RecallConfig {
  const rawRegion = env.RECALL_REGION?.trim() ?? '';
  const region: RecallRegion = isRecallRegion(rawRegion) ? rawRegion : 'us-east-1';
  const rawHours = Number(env.RECALL_RETENTION_HOURS);
  const retentionHours =
    Number.isFinite(rawHours) && rawHours >= MIN_RETENTION_HOURS
      ? Math.floor(rawHours)
      : DEFAULT_RETENTION_HOURS;
  return {
    region,
    publicWsBase: wsBaseFromPublicBaseUrl(publicBaseUrl),
    retentionHours,
    // Opt OUT rather than opt in: the accurate setting is the one a person
    // asked for when they asked for "who said what", and the cheap one is a
    // deliberate trade they should have to make on purpose.
    separateStreams: env.RECALL_SEPARATE_STREAMS !== '0',
    botName: env.RECALL_BOT_NAME?.trim() || DEFAULT_BOT_NAME,
  };
}

/**
 * The `wss://` origin Recall should dial, derived from the operator-declared
 * external base URL — or null, which disables meeting bots.
 *
 * WHY THIS IS DERIVED AND NOT ITS OWN SETTING. `CW_PUBLIC_BASE_URL` already
 * names the origin this deployment is reached on from outside, because the
 * server sits behind something that terminates TLS and cannot discover its
 * own external name. Recall needs the same host. Two settings naming one host
 * is two things to get wrong, and there is no error when they disagree — just
 * a bot that joins a call, records, bills, and streams to a hostname nobody
 * is listening on.
 *
 * WHY `http://` IS REFUSED RATHER THAN DOWNGRADED TO `ws://`. A plain-http
 * base means nothing is terminating TLS in front, so the only thing that
 * could be derived is a plaintext socket carrying a meeting's audio and
 * everything said in it across the public internet. Refusing it reads as
 * "meeting bots are not configured", which is true and is the state the UI
 * already knows how to show. Accepting it would be the quiet kind of wrong.
 */
export function wsBaseFromPublicBaseUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `wss://${parsed.host}${path}`;
}

/** What `createBot` needs that is not config. */
export interface CreateBotArgs {
  meetingUrl: string;
  /** The full realtime websocket URL, token already in it. */
  realtimeUrl: string;
  /** Zoom only — see the header. Seconds before a refused bot gives up. */
  permissionDeniedTimeoutSec?: number;
}

export interface RecallBotStatusChange {
  code: string;
  sub_code?: string | null;
  message?: string | null;
  created_at?: string;
}

export interface RecallBot {
  id: string;
  status_changes?: RecallBotStatusChange[];
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RecallClientOptions {
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  readKey?: (service: string) => string | null;
  config?: RecallConfig;
  /**
   * The operator-declared external base URL (`CW_PUBLIC_BASE_URL`, already
   * normalized by `normalizePublicBaseUrl`). Recall's realtime endpoint is
   * derived from it; absent, meeting bots stay off.
   */
  publicBaseUrl?: string | null;
  fetch?: FetchLike;
}

export interface RecallClient {
  readonly config: RecallConfig;
  createBot(args: CreateBotArgs): Promise<RecallBot>;
  getBot(botId: string): Promise<RecallBot>;
  leaveCall(botId: string): Promise<void>;
  /** Zoom's native consent prompt. Resolves false when Recall refused to ask. */
  requestRecordingPermission(botId: string): Promise<boolean>;
}

/**
 * The exact body sent to `POST /api/v1/bot/`.
 *
 * Exported and pure so a test asserts the request Recall will actually get —
 * the provider name, the retention, the events subscribed — without a network
 * call and without a fake having to re-state the shape it is checking.
 */
export function buildCreateBotBody(
  config: RecallConfig,
  args: CreateBotArgs,
): Record<string, unknown> {
  return {
    meeting_url: args.meetingUrl,
    bot_name: config.botName,
    recording_config: {
      transcript: {
        provider: {
          // v3, never `assembly_ai_streaming`: the docs say the old name
          // fails. `format_turns` is what makes a settled turn a punctuated
          // sentence rather than the lowercase rough draft — the same reason
          // the direct engine sets it.
          assembly_ai_v3_streaming: {
            speech_model: 'universal-streaming-english',
            format_turns: true,
          },
        },
        diarization: {
          use_separate_streams_when_available: config.separateStreams,
        },
      },
      realtime_endpoints: [
        {
          type: 'websocket',
          url: args.realtimeUrl,
          // Partials are subscribed for two reasons, and only one of them is
          // the ticker: the notes composer treats a partial as speech in
          // progress and defers its pause tick on it, and a partial is what
          // tells this server that a participant has BEGUN a new utterance —
          // which is how a turn number gets allocated. See recall-turns.ts.
          events: ['transcript.data', 'transcript.partial_data'],
        },
      ],
      retention: { type: 'timed', hours: config.retentionHours },
    },
    ...(args.permissionDeniedTimeoutSec !== undefined
      ? {
          automatic_leave: { recording_permission_denied_timeout: args.permissionDeniedTimeoutSec },
        }
      : {}),
  };
}

export function createRecallClient(opts: RecallClientOptions = {}): RecallClient | null {
  const key = resolveRecallKey(
    opts.apiKey,
    opts.env ?? process.env,
    opts.readKey ?? readKeychainPassword,
  );
  if (!key) return null;
  // Copied into a plainly-typed local: `key` is `string | null` at its
  // declaration and the narrowing above does not follow it into the closure
  // below on every TS version.
  const apiKey: string = key;
  const config = opts.config ?? recallConfigFromEnv(opts.env ?? process.env, opts.publicBaseUrl);
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const base = recallApiBase(config.region);

  /**
   * One request, with the key attached and the body read back on failure.
   *
   * The error message deliberately carries Recall's own response text: a 401
   * here almost always means the key belongs to a DIFFERENT REGION than
   * `RECALL_REGION` names, and that is invisible from a bare status code.
   * It never carries the key — `send` is the only place the key is read, and
   * nothing it throws has been near it.
   */
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        // No `Bearer` prefix — the key is the whole header value.
        Authorization: apiKey,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `recall: ${init.method ?? 'GET'} ${path} failed (${res.status})` +
          `${detail ? `: ${detail.slice(0, 400)}` : ''}` +
          (res.status === 401 ? ` — is RECALL_REGION=${config.region} the key's region?` : ''),
      );
    }
    return res;
  }

  return {
    config,
    async createBot(args: CreateBotArgs): Promise<RecallBot> {
      const res = await send('/v1/bot/', {
        method: 'POST',
        body: JSON.stringify(buildCreateBotBody(config, args)),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) throw new Error('recall: bot create returned no id');
      return { id, status_changes: parseStatusChanges(body.status_changes) };
    },
    async getBot(botId: string): Promise<RecallBot> {
      const res = await send(`/v1/bot/${encodeURIComponent(botId)}/`);
      const body = (await res.json()) as Record<string, unknown>;
      return {
        id: typeof body.id === 'string' ? body.id : botId,
        status_changes: parseStatusChanges(body.status_changes),
      };
    },
    async leaveCall(botId: string): Promise<void> {
      await send(`/v1/bot/${encodeURIComponent(botId)}/leave_call/`, { method: 'POST' });
    },
    async requestRecordingPermission(botId: string): Promise<boolean> {
      try {
        await send(`/v1/bot/${encodeURIComponent(botId)}/request_recording_permission/`, {
          method: 'POST',
        });
        return true;
      } catch (err) {
        // Not fatal, and deliberately not thrown: a meeting where the host
        // never sees the prompt is a meeting that records nothing, but the
        // bot is already in the call and the status events are still the
        // authority on what happened. Losing the invite over this would be
        // worse than reporting it.
        console.error('[recall] request_recording_permission failed:', err);
        return false;
      }
    },
  };
}

function parseStatusChanges(raw: unknown): RecallBotStatusChange[] {
  if (!Array.isArray(raw)) return [];
  const out: RecallBotStatusChange[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.code !== 'string') continue;
    out.push({
      code: rec.code,
      sub_code: typeof rec.sub_code === 'string' ? rec.sub_code : null,
      message: typeof rec.message === 'string' ? rec.message : null,
      ...(typeof rec.created_at === 'string' ? { created_at: rec.created_at } : {}),
    });
  }
  return out;
}
