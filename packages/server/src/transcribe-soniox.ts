/**
 * Soniox real-time STT — the second engine behind the same seam.
 *
 * PROTOCOL, CONFIRMED FROM THE DOCS rather than remembered
 * (https://soniox.com/docs/stt/api-reference/websocket-api and
 * https://soniox.com/docs/stt/rt/real-time-transcription, read 2026-08-31):
 *
 *  - `wss://stt-rt.soniox.com/transcribe-websocket`. The FIRST frame after
 *    the socket opens is a JSON config message, and the key rides IN it as
 *    `api_key` — there is no auth header. The config names the model
 *    (`stt-rt-v5`), the audio shape (`pcm_s16le`, sample rate, one channel)
 *    and the feature flags; like AssemblyAI's URL, it cannot be changed once
 *    the session is open.
 *  - audio goes up as raw binary frames on the same socket.
 *  - the server answers with token batches: `{ tokens: [...] }`, each token
 *    `{ text, start_ms, end_ms, confidence, is_final, speaker? }`. FINAL
 *    tokens are appended once and never re-sent; NON-FINAL tokens are a
 *    provisional tail re-sent in full on every response, each batch's tail
 *    REPLACING the last. That is the same revise-in-place contract the seam
 *    carries — it just arrives as tokens instead of whole turns, so this
 *    adapter is the one that assembles turns.
 *  - with `enable_endpoint_detection` on, the end of an utterance finalizes
 *    everything before it and emits a special `<end>` token
 *    (https://soniox.com/docs/stt/rt/endpoint-detection). That token is the
 *    turn boundary; it never reaches the transcript.
 *  - with `enable_speaker_diarization` on, tokens carry `speaker` as a
 *    NUMBERED string ("1", "2"). Mapped to the letters the rest of the
 *    product speaks ("A", "B") so the rename UI, the roster and the record
 *    read identically whichever engine produced them.
 *  - the client ends a session by sending an EMPTY frame; the server
 *    finalizes everything, answers `{ finished: true }`, and closes. Same
 *    rule as AssemblyAI's Terminate: the wait is what flushes the last turn.
 *  - errors arrive as `{ error_code, error_message }` and the server closes
 *    after sending one.
 *  - one connection carries up to 300 minutes of audio. No rollover is built
 *    here (AssemblyAI's three-hour wall needed one; five hours is beyond any
 *    meeting this product has held) — a session that somehow reaches the cap
 *    surfaces the engine's own `max_duration_reached` error and ends the way
 *    an unexpected close does. Revisit if a real meeting ever gets there.
 *
 * The socket is injected because a test of this mapping must not open one.
 */

import type { MeetingTuning } from '@feedback/core';
import { readKeychainPassword } from './share/keychain.ts';
import type {
  EngineSocket,
  EngineSocketArgs,
  EngineSocketFactory,
} from './transcribe-assemblyai.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from './transcribe.ts';

const STREAM_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

/** The current real-time model. v4 is an alias for it until 2026-06-30. */
export const SONIOX_MODEL = 'stt-rt-v5';

/** Keychain service holding the key. Env override: SONIOX_API_KEY. */
export const SONIOX_KEYCHAIN_SERVICE = 'claude-workspaces-soniox-api-key';
export const SONIOX_ENV_VAR = 'SONIOX_API_KEY';

/** How long to wait for the socket to open before giving up on the session. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long the empty end-of-audio frame gets to produce `finished`. */
const FLUSH_TIMEOUT_MS = 5_000;

/** The token the endpoint detector emits as a turn boundary. Never text. */
export const END_TOKEN = '<end>';

/**
 * Resolve the key: explicit option, then the environment, then Keychain.
 * Same order as AssemblyAI's and for the same reason — the env var is the
 * deliberate per-launch override. Null is "this engine is not configured".
 */
export function resolveSonioxKey(
  explicit: string | null | undefined,
  env: Record<string, string | undefined>,
  read: (service: string) => string | null,
): string | null {
  if (explicit !== undefined) return explicit || null;
  const fromEnv = env[SONIOX_ENV_VAR];
  if (fromEnv) return fromEnv;
  try {
    const key = read(SONIOX_KEYCHAIN_SERVICE);
    if (key) return key;
  } catch {
    // A missing entry throws. Absent is the normal state, not a failure.
  }
  return null;
}

/**
 * The config frame's non-secret fields, exported so a test reads the real
 * shape rather than a copy. The adapter adds `api_key` when it sends it;
 * the key never appears in anything a test snapshots.
 *
 * `maxSpeakers` has no Soniox counterpart — there is no cap parameter in
 * their config — so the caller's cap is accepted and quietly unused rather
 * than refused: the caller states intent once, whichever engine listens.
 *
 * `tuning` is the person's Advanced Options, already sanitized against this
 * engine's spec (meeting-tuning.ts). All of it rides in this one frame —
 * Soniox has no mid-session update message, so every change here waits for
 * the next recording. Two keys are renamed on the way in: our UI-neutral
 * `context_terms` becomes the `context.terms` object the API takes, and the
 * rest are Soniox's own names already.
 */
export function sonioxConfig(
  sampleRate: number,
  detectSpeakers: boolean,
  tuning?: MeetingTuning,
): Record<string, unknown> {
  const { context_terms: contextTerms, ...rest } = tuning ?? {};
  return {
    model: SONIOX_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: sampleRate,
    num_channels: 1,
    // The boundary this adapter turns into turns; without it nothing ever
    // finalizes until the speaker stops for the model's own long timeout.
    enable_endpoint_detection: true,
    // Who said it. Priced into Soniox's rate rather than surcharged, but the
    // same rule as AssemblyAI holds: a session nobody called a conversation
    // does not ask, so a solo transcript never grows invented voices.
    ...(detectSpeakers ? { enable_speaker_diarization: true } : {}),
    // AFTER the fixed fields it could never be allowed to override — the
    // sanitizer only passes spec keys, and none of them collide, but the
    // order states the intent.
    ...rest,
    ...(Array.isArray(contextTerms) && contextTerms.length > 0
      ? { context: { terms: contextTerms } }
      : {}),
  };
}

/**
 * Soniox numbers its speakers ("1", "2"); the rest of the product — the
 * rename UI, the roster, the record — speaks AssemblyAI's letters ("A",
 * "B"). One deterministic map so a turn's speaker means the same thing
 * whichever engine labelled it; a label past "Z" or non-numeric passes
 * through untouched rather than being invented around.
 */
export function speakerLetter(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 26) return String.fromCharCode(64 + n);
  return s;
}

/** One token as the wire carries it, reduced to what this adapter reads. */
interface SonioxToken {
  text: string;
  isFinal: boolean;
  speaker?: string;
  endMs?: number;
}

function readToken(raw: unknown): SonioxToken | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.text !== 'string') return null;
  const endMs = typeof t.end_ms === 'number' && Number.isFinite(t.end_ms) ? t.end_ms : undefined;
  return {
    text: t.text,
    isFinal: t.is_final === true,
    ...(speakerLetter(t.speaker) !== undefined ? { speaker: speakerLetter(t.speaker) } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
  };
}

export interface SonioxOptions {
  /** Same contract as AssemblyAI's: `null` is explicitly "no key". */
  apiKey?: string | null;
  env?: Record<string, string | undefined>;
  readKey?: (service: string) => string | null;
  socketFactory?: EngineSocketFactory;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
}

function defaultSocketFactory(args: EngineSocketArgs): EngineSocket {
  const ws = new WebSocket(args.url);
  ws.addEventListener('open', () => args.onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    if (typeof ev.data === 'string') args.onMessage(ev.data);
  });
  ws.addEventListener('error', () => args.onError('websocket error'));
  ws.addEventListener('close', () => args.onClose());
  return {
    send(data: string | Uint8Array): void {
      ws.send(data);
    },
    close(): void {
      ws.close();
    },
  };
}

/** A timer that never holds the process open. */
function timer(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

/**
 * Build the engine, or return null when there is no key — the same
 * "not configured" mechanism as AssemblyAI's, read by the same caller.
 */
export function createSonioxEngine(opts: SonioxOptions = {}): TranscriptionEngine | null {
  const key = resolveSonioxKey(
    opts.apiKey,
    opts.env ?? process.env,
    opts.readKey ?? readKeychainPassword,
  );
  if (!key) return null;

  const makeSocket = opts.socketFactory ?? defaultSocketFactory;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const flushTimeoutMs = opts.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

  return {
    name: 'soniox',
    open(sessionOpts: TranscriptionOpenOpts): Promise<TranscriptionSession> {
      return new Promise<TranscriptionSession>((resolve, reject) => {
        let opened = false;
        let closed = false;
        /** The empty end-of-audio frame went up; the close that follows is normal. */
        let ending = false;
        /** Resolves `close()` once `finished` (or the flush timeout) arrives. */
        let settleClose: (() => void) | null = null;

        /**
         * The turn being assembled. `finalText` only ever grows — final
         * tokens arrive once — while `tail` is replaced wholesale by each
         * batch, which is exactly how the engine revises itself.
         */
        let turn = 0;
        let finalText = '';
        let tail = '';
        let speaker: string | undefined;
        /** End offset of the last final token, for the settled emission. */
        let finalEndMs: number | undefined;
        /** End offset of the last token seen at all, for partials. */
        let lastEndMs: number | undefined;

        const finishClose = (): void => {
          const fn = settleClose;
          settleClose = null;
          fn?.();
        };

        const emit = (final: boolean, engineMs: number): void => {
          const text = (finalText + tail).trim();
          // A turn that never collected a word — an endpoint fired on
          // silence — is not a turn; emitting it would put empty rows in
          // the transcript.
          if (text === '') return;
          const audioEndMs = final ? (finalEndMs ?? lastEndMs) : lastEndMs;
          sessionOpts.onTurn({
            turn,
            text,
            final,
            ...(speaker !== undefined ? { speaker } : {}),
            ...(audioEndMs !== undefined ? { audioEndMs } : {}),
            engineMs,
          });
        };

        /** Settle the current turn and start the next one. */
        const settleTurn = (engineMs: number): void => {
          emit(true, engineMs);
          if (finalText !== '' || tail !== '') turn++;
          finalText = '';
          tail = '';
          speaker = undefined;
          finalEndMs = undefined;
          lastEndMs = undefined;
        };

        const cancelConnect = timer(connectTimeoutMs, () => {
          if (opened) return;
          closed = true;
          socket.close();
          reject(new Error('soniox: the socket did not open within the connect timeout'));
        });

        const socket = makeSocket({
          url: STREAM_URL,
          headers: {},
          onOpen: () => {
            if (opened || closed) return;
            opened = true;
            cancelConnect();
            // The one frame the key rides in, composed at send time and held
            // nowhere else. There is no server ack to wait for — the session
            // is live once this is up, and a refused key comes back as an
            // error frame on the same socket.
            socket.send(
              JSON.stringify({
                api_key: key,
                ...sonioxConfig(
                  sessionOpts.sampleRate,
                  sessionOpts.detectSpeakers,
                  sessionOpts.tuning,
                ),
              }),
            );
            resolve(session);
          },
          onMessage: (text) => {
            // Taken before the parse: the vendor leg ends when the bytes
            // arrive, not when we have finished reading them.
            const engineMs = Date.now();
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(text) as Record<string, unknown>;
            } catch {
              // A frame we cannot read is not a reason to end a meeting.
              return;
            }
            if (typeof msg.error_code === 'number') {
              const detail =
                typeof msg.error_message === 'string' ? msg.error_message : 'engine error';
              sessionOpts.onError(`soniox: ${detail}`);
              return;
            }
            const rawTokens = Array.isArray(msg.tokens) ? msg.tokens : [];
            // Each batch's non-final tokens REPLACE the previous tail —
            // rebuilt from scratch here, appended to only within this batch.
            const sawToken = rawTokens.length > 0;
            let newTail = '';
            let tailSpeaker: string | undefined;
            for (const raw of rawTokens) {
              const token = readToken(raw);
              if (!token) continue;
              if (token.text === END_TOKEN) {
                // The boundary. Whatever provisional tail was standing has
                // either been finalized by the tokens before this one or
                // withdrawn by the engine; it does not survive the turn.
                tail = newTail = '';
                settleTurn(engineMs);
                continue;
              }
              if (token.isFinal) {
                // A settled change of voice is a new turn even without an
                // endpoint: a turn is one speaker saying one thing, and the
                // rename UI names a turn's single label.
                if (
                  token.speaker !== undefined &&
                  speaker !== undefined &&
                  token.speaker !== speaker &&
                  finalText.trim() !== ''
                ) {
                  // Only what had settled belongs to the closing turn; the
                  // batch's provisional tail is the NEW voice's opening
                  // words and stays for the turn that starts here.
                  tail = '';
                  settleTurn(engineMs);
                }
                finalText += token.text;
                if (speaker === undefined) speaker = token.speaker;
                if (token.endMs !== undefined) {
                  finalEndMs = token.endMs;
                  lastEndMs = token.endMs;
                }
              } else {
                newTail += token.text;
                if (tailSpeaker === undefined) tailSpeaker = token.speaker;
                if (token.endMs !== undefined) lastEndMs = token.endMs;
              }
            }
            tail = newTail;
            if (speaker === undefined) speaker = tailSpeaker;
            if (sawToken) emit(false, engineMs);
            if (msg.finished === true) {
              // The end-of-audio flush finalizes everything but sends no
              // `<end>` for the turn it cut off — settled HERE so the
              // meeting's last sentence reaches the record, which keeps
              // only final turns.
              settleTurn(engineMs);
              closed = true;
              socket.close();
              finishClose();
            }
          },
          onError: (message) => {
            if (!opened) {
              closed = true;
              cancelConnect();
              reject(new Error(`soniox: ${message}`));
              return;
            }
            if (!closed && !ending) sessionOpts.onError(`soniox: ${message}`);
          },
          onClose: () => {
            if (!opened) {
              cancelConnect();
              if (!closed) {
                closed = true;
                reject(new Error('soniox: socket closed before the session began'));
              }
              return;
            }
            // A close we did not ask for ends the meeting's words; the one
            // that follows our end-of-audio frame is the normal path.
            if (!closed && !ending) {
              sessionOpts.onError('soniox: session closed unexpectedly');
            }
            closed = true;
            finishClose();
          },
        });

        const session: TranscriptionSession = {
          send(audio: Uint8Array): void {
            if (closed || ending || !opened) return;
            socket.send(audio);
          },
          close(): Promise<void> {
            if (closed || ending) return Promise.resolve();
            ending = true;
            return new Promise<void>((resolveClose) => {
              settleClose = resolveClose;
              // The empty frame is what finalizes the open turn, so we wait
              // for the `finished` reply — but never forever: a stop the
              // human pressed has to end the meeting even when the engine
              // has stopped answering.
              socket.send('');
              timer(flushTimeoutMs, () => {
                if (closed) return;
                // The engine stopped answering; whatever had already
                // arrived is still what was said, and still owed to the
                // record before the meeting is allowed to end.
                settleTurn(Date.now());
                closed = true;
                socket.close();
                finishClose();
              });
            });
          },
        };
      });
    },
  };
}
