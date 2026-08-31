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
 * The engine's own ceiling on one streaming session.
 *
 * "Sessions are capped at 3 hours" — a session left open is closed by the
 * server with code 3008, "Session Expired: Maximum session duration
 * exceeded", and billed for the full three hours
 * (https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
 * and the streaming API reference, read 2026-08-30). There is no inactivity
 * limit unless one is asked for — `inactivity_timeout` is optional and this
 * adapter does not send it — so a long QUIET session is not the problem; the
 * three-hour wall is, and it is a wall a solo working session reaches.
 *
 * Used only when the engine's `Begin` did not say when this session expires.
 */
const MAX_SESSION_MS = 3 * 60 * 60 * 1_000;

/**
 * How far ahead of expiry a session is replaced. Long enough that the
 * handshake, a retry and the old session's flush all fit inside it.
 */
const ROLLOVER_MARGIN_MS = 60_000;

/** Never schedule a rollover closer than this, however near expiry looks. */
const MIN_ROLLOVER_MS = 1_000;

/**
 * `expires_at` as milliseconds. The engine sends a Unix timestamp; seconds
 * and milliseconds are told apart by size rather than trusted from the docs,
 * because reading seconds as milliseconds would schedule the rollover in
 * 1970 and roll the session over immediately, on repeat.
 */
export function expiryFrom(raw: unknown, now = Date.now()): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return now + MAX_SESSION_MS;
  const ms = raw >= 1e12 ? raw : raw * 1000;
  // A timestamp in the past (a clock skew, a fixture) means "no useful
  // deadline", not "roll over now and forever".
  return ms > now ? ms : now + MAX_SESSION_MS;
}

/**
 * One engine socket. A meeting is a CHAIN of these — a new one is opened
 * before the current one hits its three-hour cap, and turn ids continue
 * across the join because each leg remembers the ids its own turns got.
 */
interface Leg {
  socket: EngineSocket;
  /** This session's `turn_order` to the id the turn left the adapter under. */
  ids: Map<number, number>;
  /** When the engine says this session will be closed for exceeding its cap. */
  expiresAt: number;
  /** Settled turns, by THIS session's order, for `SpeakerRevision`. */
  settled: Map<number, { text: string; speaker?: string }>;
  /** The socket is finished: terminated, closed, or failed. */
  done: boolean;
  /** We sent `Terminate`, so the close that follows is the normal path. */
  terminating: boolean;
}

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
  /** How far before expiry a session is rolled over. Defaults to a minute. */
  rolloverMarginMs?: number;
  /**
   * The rollover timer. Injected so a test fires it instead of waiting three
   * hours; the flush timer is deliberately NOT on this clock, so a test that
   * drives a rollover still exercises the real teardown timing.
   */
  schedule?: (ms: number, fn: () => void) => () => void;
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

/**
 * Where in the engine's stream this frame's last word ends, in milliseconds.
 *
 * This is the correlation key the latency measurement runs on: audio goes up
 * as raw PCM with no sequence number in it, so nothing in a frame can be
 * echoed back — but an offset names the chunk that carried it arithmetically,
 * from the relay's own byte count. Missing or unreadable is `undefined` and
 * costs that frame its sample; an invented number would name the wrong chunk
 * and land in the percentiles looking like a measurement.
 */
export function audioEndMsFromTurn(msg: Record<string, unknown>): number | undefined {
  const words = msg.words;
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const last = words[words.length - 1] as Record<string, unknown> | undefined;
  const end = last?.end;
  return typeof end === 'number' && Number.isFinite(end) ? end : undefined;
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
  const rolloverMarginMs = opts.rolloverMarginMs ?? ROLLOVER_MARGIN_MS;
  const schedule = opts.schedule ?? timer;

  return {
    name: 'assemblyai',
    open(sessionOpts: TranscriptionOpenOpts): Promise<TranscriptionSession> {
      return new Promise<TranscriptionSession>((resolve, reject) => {
        /**
         * The leg carrying audio right now. Every other leg is either the one
         * being handed over from (flushing its last turn) or gone.
         */
        let active: Leg | null = null;
        /** `close()` was called: no more rollovers, and this is the last leg. */
        let closing = false;
        /**
         * The next turn id to hand out. Ids are allocated the first time a
         * leg emits a given `turn_order` and remembered per leg, which is
         * what keeps a rollover invisible to everything downstream: a turn id
         * is the identity a transcript revises in place and the key the
         * record is written under, and a fresh AssemblyAI session starts
         * counting at zero again.
         *
         * Allocating on first emission rather than from a per-leg base is
         * what makes the handover safe. The two legs overlap: the old one is
         * flushing while the new one is already carrying audio, and it can
         * still open a turn of its own in that window. A base fixed at
         * rollover time would give that turn the id the new leg's first turn
         * also got, and downstream one would silently overwrite the other.
         */
        let nextId = 0;
        let cancelRollover: (() => void) | null = null;
        /** Resolves `close()` once the last leg says it has flushed. */
        let settleClose: (() => void) | null = null;

        const finishClose = (): void => {
          const fn = settleClose;
          settleClose = null;
          fn?.();
        };

        /**
         * Hand a leg back to AssemblyAI. ALWAYS by `Terminate`, never by
         * closing the socket: an unterminated session stays open on their
         * side until the three-hour cap and is billed for the whole of it,
         * so a rollover that merely dropped the old socket would turn one
         * long meeting into two full sessions' worth of bill.
         */
        const retire = (leg: Leg): void => {
          if (leg.done || leg.terminating) return;
          leg.terminating = true;
          leg.socket.send(JSON.stringify({ type: 'Terminate' }));
          timer(flushTimeoutMs, () => {
            if (leg.done) return;
            leg.done = true;
            leg.socket.close();
            if (leg === active) finishClose();
          });
        };

        /**
         * The id this leg's `turn_order` speaks under, allocated once and
         * then stable: the same order from the same leg is the same turn
         * being revised, and the same order from a DIFFERENT leg is a
         * different turn entirely.
         */
        const idFor = (leg: Leg, order: number): number => {
          const known = leg.ids.get(order);
          if (known !== undefined) return known;
          const id = nextId++;
          leg.ids.set(order, id);
          return id;
        };

        /** Open one leg and resolve when the engine says `Begin`. */
        const connect = (): Promise<Leg> =>
          new Promise<Leg>((resolveLeg, rejectLeg) => {
            let begun = false;
            const leg: Leg = {
              socket: null as unknown as EngineSocket,
              ids: new Map(),
              expiresAt: Date.now() + MAX_SESSION_MS,
              settled: new Map(),
              done: false,
              terminating: false,
            };
            const cancelConnect = timer(connectTimeoutMs, () => {
              if (begun) return;
              leg.done = true;
              leg.socket.close();
              rejectLeg(new Error('assemblyai: no Begin within the connect timeout'));
            });
            const emit = (order: number, text: string, speaker: { speaker?: string }): void => {
              sessionOpts.onTurn({ turn: idFor(leg, order), text, final: true, ...speaker });
            };
            leg.socket = makeSocket({
              url: streamingUrl(sessionOpts.sampleRate, sessionOpts.detectSpeakers),
              // No `Bearer` prefix — the key is the whole header value.
              headers: { Authorization: key },
              onOpen: () => {},
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
                if (msg.type === 'Begin') {
                  if (begun) return;
                  begun = true;
                  cancelConnect();
                  leg.expiresAt = expiryFrom(msg.expires_at);
                  resolveLeg(leg);
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
                  if (final) leg.settled.set(order, { text: transcript, ...speaker });
                  const audioEndMs = audioEndMsFromTurn(msg);
                  sessionOpts.onTurn({
                    turn: idFor(leg, order),
                    text: transcript,
                    final,
                    ...speaker,
                    // Only when the frame actually carried words; a
                    // SpeakerRevision deliberately carries neither, because a
                    // relabel is not a latency event.
                    ...(audioEndMs !== undefined ? { audioEndMs } : {}),
                    engineMs,
                  });
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
                  //
                  // A revision is always this leg's own: it names turn orders
                  // in the session that sent it, so it is looked up in THIS
                  // leg's id map even when a newer leg is already carrying the
                  // audio.
                  const revisions = Array.isArray(msg.revisions) ? msg.revisions : [];
                  for (const rev of revisions as Array<Record<string, unknown>>) {
                    const order = rev.turn_order;
                    if (typeof order !== 'number') continue;
                    const known = leg.settled.get(order);
                    if (!known) continue;
                    const speaker = speakerFromLabel(rev.speaker_label);
                    if (speaker.speaker === known.speaker) continue;
                    leg.settled.set(order, { text: known.text, ...speaker });
                    emit(order, known.text, speaker);
                  }
                  return;
                }
                if (msg.type === 'Termination') {
                  leg.done = true;
                  leg.socket.close();
                  if (leg === active) finishClose();
                  return;
                }
                if (msg.type === 'Error') {
                  const detail = typeof msg.error === 'string' ? msg.error : 'engine error';
                  sessionOpts.onError(`assemblyai: ${detail}`);
                }
              },
              onError: (message) => {
                if (!begun) {
                  leg.done = true;
                  cancelConnect();
                  rejectLeg(new Error(`assemblyai: ${message}`));
                  return;
                }
                // A leg that is no longer carrying audio has been asked to go
                // away; its complaints on the way out are not the meeting's.
                if (leg === active) sessionOpts.onError(`assemblyai: ${message}`);
              },
              onClose: () => {
                if (!begun) {
                  cancelConnect();
                  if (!leg.done) {
                    leg.done = true;
                    rejectLeg(new Error('assemblyai: socket closed before the session began'));
                  }
                  return;
                }
                // A close we did not ask for ends the meeting's words; a close
                // that follows our Terminate is the normal path and must not be
                // reported as a failure. A retired leg is never the meeting.
                if (!leg.done && !leg.terminating && leg === active) {
                  leg.done = true;
                  sessionOpts.onError('assemblyai: session closed unexpectedly');
                }
                leg.done = true;
                if (leg === active) finishClose();
              },
            });
          });

        /**
         * Move the meeting onto a fresh session before this one hits the
         * three-hour cap.
         *
         * The new leg is opened FIRST and only becomes the audio's
         * destination once the engine has answered `Begin`, so there is no
         * window where a spoken word has nowhere to go. The old leg is then
         * terminated, which flushes the turn it was in the middle of — those
         * frames still arrive, and they still carry the ids the old leg
         * already gave them, so a sentence spanning the handover is revised in
         * place rather than lost or duplicated.
         *
         * The two sockets overlap for the length of one handshake, and both
         * are billed for that second or so. That is the price of not cutting
         * a meeting in half at the three-hour mark.
         */
        const rollover = (old: Leg): void => {
          if (closing || old !== active || old.done) return;
          void connect().then(
            (next) => {
              if (closing) {
                // The meeting ended while the handshake was out. The new
                // session is already open and already being billed, so it is
                // terminated rather than dropped.
                retire(next);
                return;
              }
              active = next;
              armRollover(next);
              retire(old);
            },
            (err) => {
              // Not fatal yet: the old session is still carrying audio and
              // still has the margin left to run in. Try again inside it.
              console.error('[assemblyai] session rollover failed, retrying:', err);
              armRetry(old);
            },
          );
        };

        /** Roll this leg over a margin before the engine would close it. */
        const armRollover = (leg: Leg): void => {
          cancelRollover?.();
          const delay = Math.max(leg.expiresAt - rolloverMarginMs - Date.now(), MIN_ROLLOVER_MS);
          cancelRollover = schedule(delay, () => rollover(leg));
        };

        /** A failed rollover, retried inside the margin that is left. */
        const armRetry = (leg: Leg): void => {
          cancelRollover?.();
          const left = leg.expiresAt - Date.now();
          if (left <= MIN_ROLLOVER_MS) return;
          cancelRollover = schedule(Math.max(left / 2, MIN_ROLLOVER_MS), () => rollover(leg));
        };

        const session: TranscriptionSession = {
          send(audio: Uint8Array): void {
            const leg = active;
            if (closing || !leg || leg.done) return;
            leg.socket.send(audio);
          },
          close(): Promise<void> {
            const leg = active;
            if (closing || !leg || leg.done) return Promise.resolve();
            closing = true;
            cancelRollover?.();
            cancelRollover = null;
            return new Promise<void>((resolveClose) => {
              settleClose = resolveClose;
              // Terminate is what flushes the open turn, so we wait for the
              // reply — but never forever: a stop the human pressed has to
              // end the meeting even when the engine has stopped answering.
              retire(leg);
            });
          },
        };

        void connect().then(
          (leg) => {
            active = leg;
            armRollover(leg);
            resolve(session);
          },
          (err) => reject(err),
        );
      });
    },
  };
}
