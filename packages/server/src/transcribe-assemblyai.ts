/**
 * AssemblyAI Universal Streaming — the engine that produces real words.
 *
 * PROTOCOL, CONFIRMED FROM THE DOCS rather than remembered
 * (https://www.assemblyai.com/docs/streaming/message-sequence and
 * https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones, read
 * 2026-08-27):
 *
 *  - `wss://streaming.assemblyai.com/v3/ws`, with the whole session config as
 *    query params — `sample_rate`, `encoding`, `format_turns`. There is no
 *    configuration message; the URL is the configuration.
 *  - the key travels in the `Authorization` header with NO `Bearer` prefix.
 *  - audio goes up as raw binary frames on that same socket. No framing of
 *    ours, no base64, no envelope.
 *  - the server sends `Begin` (session id + expiry), then `Turn` messages,
 *    then `Termination` (audio and session durations).
 *  - a `Turn` carries `turn_order`, `transcript` — the WHOLE turn so far, not
 *    a delta — `end_of_turn` and `turn_is_formatted`. Within one turn each
 *    message supersedes the last, and `turn_order` is monotonic.
 *  - with `format_turns` on, a turn ENDS TWICE at the same `turn_order`: the
 *    unformatted final first, the punctuated one immediately after. So the
 *    settled turn is the one where BOTH flags are true, and the unformatted
 *    final is forwarded as a partial. Treating the first `end_of_turn` as
 *    settled would write the unpunctuated text to disk and then have no way
 *    to correct it.
 *  - the client ends a session by sending `{"type":"Terminate"}` and waiting
 *    for the `Termination` reply. That wait is what flushes the open turn —
 *    closing the socket instead drops whatever was being said.
 *
 * SPEAKER LABELS (https://www.assemblyai.com/docs/streaming/label-speakers-and-separate-channels
 * and the streaming API reference, read 2026-08-29): `speaker_labels=true`
 * on the same URL, supported on every streaming model, +$0.12/hr on top of
 * the session rate — SENT ONLY WHEN THE CAPTURE SAID IT WAS A CONVERSATION,
 * because a session's config is its URL and cannot be changed once open. Each `Turn` then carries `speaker_label` — `"A"`, `"B"`,
 * or a placeholder (`"PENDING"` / `"UNKNOWN"`) for a turn under about a
 * second of audio — and a `SpeakerRevision` arrives before `Termination`
 * listing the turns whose label the full-session pass changed. The
 * placeholder is mapped to "no speaker" rather than shown; the revision is
 * re-emitted through `onTurn` as a settled turn with its text retained, so
 * the relay needs no second channel for it.
 *
 * The socket is injected because a test of this mapping must not open one.
 */

import { readKeychainPassword } from './share/keychain.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from './transcribe.ts';

const STREAM_URL = 'wss://streaming.assemblyai.com/v3/ws';

/** Keychain service holding the key. Env override: ASSEMBLYAI_API_KEY. */
export const KEYCHAIN_SERVICE = 'assemblyai-api-key';
export const ENV_VAR = 'ASSEMBLYAI_API_KEY';

/** The encoding `MEETING_AUDIO_ENCODING` promises, spelled AssemblyAI's way. */
const ENCODING = 'pcm_s16le';

/** How long to wait for `Begin` before giving up on the session. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long `Terminate` gets to produce a `Termination` before we hang up. */
const FLUSH_TIMEOUT_MS = 5_000;

/**
 * The slice of a WebSocket this engine uses, with the handlers supplied at
 * construction rather than attached afterwards.
 *
 * Shaped this way so a fake is a few lines instead of an EventTarget: the
 * test hands back an object with `send` and `close`, keeps the handlers, and
 * drives the engine by calling them. A DOM-shaped `addEventListener` fake
 * costs more to write than the code it is testing.
 */
export interface EngineSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface EngineSocketArgs {
  url: string;
  headers: Record<string, string>;
  onOpen: () => void;
  /** Only text frames; the engine never receives binary. */
  onMessage: (text: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export type EngineSocketFactory = (args: EngineSocketArgs) => EngineSocket;

export interface AssemblyAiOptions {
  /**
   * Supply a key directly instead of consulting env and Keychain (tests).
   * `null` means "there is no key" explicitly and skips the lookup, so a test
   * that wants the not-configured state can ask for it on a machine where the
   * real entry exists.
   */
  apiKey?: string | null;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to the Keychain reader. A parameter so the ORDER is testable. */
  readKey?: (service: string) => string | null;
  /** Defaults to a real WebSocket. Injected so no test reaches the network. */
  socketFactory?: EngineSocketFactory;
  connectTimeoutMs?: number;
  flushTimeoutMs?: number;
}

/**
 * Resolve the key: explicit option, then the environment, then Keychain.
 *
 * Env before Keychain because the env var is the deliberate per-launch
 * override — a `bun run staging` that wants a different account should not
 * have to move a keychain item to get one. Returning null is the documented
 * "transcription not configured" state, not an error: the strip renders it.
 */
export function resolveAssemblyAiKey(
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
 * The connect URL, exported so a test reads the real one rather than a copy.
 *
 * `detectSpeakers` is the whole diarization decision and it is a PARAMETER,
 * not a constant: the parameter is priced per session-hour on top of the base
 * rate, so a session that nobody said was a conversation must not carry it.
 * There is no way to add it to a session already open — the URL IS the
 * configuration — which is why the mode is chosen before the mic starts.
 */
export function streamingUrl(sampleRate: number, detectSpeakers: boolean): string {
  const params = new URLSearchParams({
    sample_rate: String(sampleRate),
    encoding: ENCODING,
    // The punctuated final. Without it every turn settles as lowercase,
    // unpunctuated text, and the transcript a notes agent reads later is the
    // rough draft rather than the sentence.
    format_turns: 'true',
  });
  // Who said it. Priced per session hour on top of the base rate (see the
  // header); without it every turn reads as one voice, which is the right
  // answer when there IS one voice.
  if (detectSpeakers) params.set('speaker_labels', 'true');
  return `${STREAM_URL}?${params.toString()}`;
}

/** Labels the engine uses to mean "not decided yet" — never a speaker. */
const PLACEHOLDER_LABELS = new Set(['PENDING', 'UNKNOWN']);

/** The `speaker` field for a Turn's `speaker_label`, or nothing. */
export function speakerFromLabel(label: unknown): { speaker?: string } {
  if (typeof label !== 'string' || label === '' || PLACEHOLDER_LABELS.has(label)) return {};
  return { speaker: label };
}

function defaultSocketFactory(args: EngineSocketArgs): EngineSocket {
  // Bun's WebSocket takes request headers as a second argument; the DOM
  // typing in `lib` only knows about subprotocols, hence the cast.
  const ws = new WebSocket(args.url, { headers: args.headers } as unknown as string[]);
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
 * Build the engine, or return null when there is no key.
 *
 * Null is the whole "transcription not configured" mechanism: the caller in
 * `bin.ts` spreads it conditionally, `createServer` gets no engine, and the
 * meeting socket answers `unavailable` with a reason a human can read. No
 * separate enabled flag exists to disagree with the key.
 */
export function createAssemblyAiEngine(opts: AssemblyAiOptions = {}): TranscriptionEngine | null {
  const key = resolveAssemblyAiKey(
    opts.apiKey,
    opts.env ?? process.env,
    opts.readKey ?? readKeychainPassword,
  );
  if (!key) return null;

  const makeSocket = opts.socketFactory ?? defaultSocketFactory;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const flushTimeoutMs = opts.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;

  return {
    name: 'assemblyai',
    open(sessionOpts: TranscriptionOpenOpts): Promise<TranscriptionSession> {
      return new Promise<TranscriptionSession>((resolve, reject) => {
        let began = false;
        let done = false;
        /**
         * We sent `Terminate` and are waiting for the flush. Without this, the
         * socket closing after a Terminate — which is the NORMAL end of every
         * meeting — is indistinguishable from a mid-sentence disconnect, and
         * every clean stop reports an error the strip would show the speaker.
         */
        let terminating = false;
        /** Resolves `close()` once the engine says it has flushed. */
        let settleClose: (() => void) | null = null;
        /**
         * Every settled turn's text and label, kept so a `SpeakerRevision`
         * — which names a turn but does not repeat its words — can be
         * re-emitted as a whole turn. A meeting's worth of sentences is
         * small next to the audio that produced them.
         */
        const settled = new Map<number, { text: string; speaker?: string }>();

        const cancelConnect = timer(connectTimeoutMs, () => {
          if (began) return;
          done = true;
          socket.close();
          reject(new Error('assemblyai: no Begin within the connect timeout'));
        });

        const finishClose = (): void => {
          const fn = settleClose;
          settleClose = null;
          fn?.();
        };

        const socket = makeSocket({
          url: streamingUrl(sessionOpts.sampleRate, sessionOpts.detectSpeakers),
          // No `Bearer` prefix — the key is the whole header value.
          headers: { Authorization: key },
          onOpen: () => {},
          onMessage: (text) => {
            let msg: Record<string, unknown>;
            try {
              msg = JSON.parse(text) as Record<string, unknown>;
            } catch {
              // A frame we cannot read is not a reason to end a meeting.
              return;
            }
            if (msg.type === 'Begin') {
              if (began) return;
              began = true;
              cancelConnect();
              resolve(session);
              return;
            }
            if (msg.type === 'Turn') {
              const order = msg.turn_order;
              const transcript = msg.transcript;
              if (typeof order !== 'number' || typeof transcript !== 'string') return;
              // Both flags, for the reason at the top of this file: with
              // `format_turns` on the unformatted final arrives first and
              // is superseded.
              const final = msg.end_of_turn === true && msg.turn_is_formatted === true;
              const speaker = speakerFromLabel(msg.speaker_label);
              if (final) settled.set(order, { text: transcript, ...speaker });
              sessionOpts.onTurn({ turn: order, text: transcript, final, ...speaker });
              return;
            }
            if (msg.type === 'SpeakerRevision') {
              // The whole-session pass relabelled some turns. Re-emit each
              // as the settled turn it already was, with the text we kept,
              // so a revised label rides the same path as a revised word.
              //
              // The array is `revisions`, NOT `turns` — checked against both
              // the guide and streaming/api-spec/streaming-websocket, which
              // give the same payload. A reviewer has already called this a
              // P1 for reading the wrong field; it reads the right one, and
              // a "fix" to `turns` would silently drop every revision.
              // Entries carry `turn_order` and `speaker_label` (plus `words`,
              // which we do not need — text is never revised by this pass).
              const revisions = Array.isArray(msg.revisions) ? msg.revisions : [];
              for (const rev of revisions as Array<Record<string, unknown>>) {
                const order = rev.turn_order;
                if (typeof order !== 'number') continue;
                const known = settled.get(order);
                if (!known) continue;
                const speaker = speakerFromLabel(rev.speaker_label);
                if (speaker.speaker === known.speaker) continue;
                settled.set(order, { text: known.text, ...speaker });
                sessionOpts.onTurn({ turn: order, text: known.text, final: true, ...speaker });
              }
              return;
            }
            if (msg.type === 'Termination') {
              done = true;
              socket.close();
              finishClose();
              return;
            }
            if (msg.type === 'Error') {
              const detail = typeof msg.error === 'string' ? msg.error : 'engine error';
              sessionOpts.onError(`assemblyai: ${detail}`);
            }
          },
          onError: (message) => {
            if (!began) {
              done = true;
              cancelConnect();
              reject(new Error(`assemblyai: ${message}`));
              return;
            }
            sessionOpts.onError(`assemblyai: ${message}`);
          },
          onClose: () => {
            if (!began) {
              cancelConnect();
              if (!done) {
                done = true;
                reject(new Error('assemblyai: socket closed before the session began'));
              }
              return;
            }
            // A close we did not ask for ends the meeting's words; a close
            // that follows our Terminate is the normal path and must not be
            // reported as a failure.
            if (!done && !terminating) {
              done = true;
              sessionOpts.onError('assemblyai: session closed unexpectedly');
            }
            finishClose();
          },
        });

        const session: TranscriptionSession = {
          send(audio: Uint8Array): void {
            if (done) return;
            socket.send(audio);
          },
          close(): Promise<void> {
            if (done) return Promise.resolve();
            return new Promise<void>((resolveClose) => {
              settleClose = resolveClose;
              terminating = true;
              socket.send(JSON.stringify({ type: 'Terminate' }));
              // Terminate is what flushes the open turn, so we wait for the
              // reply — but never forever: a stop the human pressed has to
              // end the meeting even when the engine has stopped answering.
              timer(flushTimeoutMs, () => {
                if (done) return;
                done = true;
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
