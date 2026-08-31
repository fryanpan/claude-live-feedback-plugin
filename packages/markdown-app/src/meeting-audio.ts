/**
 * Microphone capture for a live meeting: raw browser audio in, the wire
 * contract's PCM out.
 *
 * The DSP is pure and exported — `floatToPcm16`, `resampleLinear`,
 * `chunkPcm16` — and the AudioContext sits behind `AudioPumpFactory`, because
 * a test environment has no audio hardware and the parts that are easy to get
 * wrong (the clamp, the phase across a block boundary, a half-full frame) are
 * exactly the parts that need checking.
 *
 * WHY THE BROWSER RESAMPLES. An AudioContext runs at the device's rate — 44.1k
 * or 48k, and on some hardware neither — and the engine wants
 * `MEETING_SAMPLE_RATE`. Doing it here means the socket carries one format
 * whatever machine opened it, so the server never has to ask what it is
 * receiving, and the audio that crosses the network is a third of the size.
 *
 * The secure-context gate and the messages come from `voice-capture.ts`: this
 * is the same microphone, blocked by the same rule, and a second wording of
 * "the mic needs https or localhost" would be a second thing to keep true.
 */

import { type CaptureMode, DEFAULT_CAPTURE_MODE, MEETING_SAMPLE_RATE } from '@feedback/core';
import {
  type OriginFacts,
  defaultOriginFacts,
  insecureOriginMessage,
  recognitionErrorMessage,
} from './voice-capture.ts';

/**
 * Samples per outgoing frame — 100 ms at `MEETING_SAMPLE_RATE`. Small enough
 * that a partial phrase reaches the engine while it is still being said, large
 * enough that a meeting is not tens of thousands of socket writes an hour.
 */
export const MEETING_FRAME_SAMPLES = MEETING_SAMPLE_RATE / 10;

/**
 * The browser's three microphone processors, as one config.
 *
 * They are a config rather than three literals because a ROOM is not the
 * situation any of them was tuned for. Echo cancellation, noise suppression
 * and automatic gain control are built for one near-field talker on a laptop:
 * AGC renormalises level continuously, noise suppression gates the quieter
 * part of the spectrum, and both act on exactly the cues — relative loudness,
 * timbre, the difference between the person at the mic and the person across
 * the table — that a diarizer uses to tell two voices apart. Whether they
 * help or hurt a shared microphone is a MEASUREMENT, not an opinion, and
 * `scripts/room-labels-check.ts` is the instrument; this shape is what lets
 * one recording session vary them.
 */
export interface RoomAudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/**
 * What a solo capture asks for: the three answers this subsystem has always
 * given, kept as their own constant so that moving the ROOM default below
 * cannot reach a case it was never measured on. One person holding a device
 * is not a room, and nothing here has measured it.
 */
const SOLO_AUDIO_PROCESSING: RoomAudioProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * What a room capture asks for, now that the measurement has spoken.
 *
 * Gain control is OFF. Measured through the real engine on one far-field
 * element of the AMI array — one microphone on a table with people around
 * it — it was the worst of the four settings in both windows scored, and the
 * only one that lost against leaving everything alone:
 *
 *     two people, 120s      raw 24.0%   ns 40.2%   agc 19.7%   ns+agc 24.1%
 *     four people, 120s     raw 35.1%   ns 39.3%   agc 31.2%   ns+agc 50.2%
 *
 * (word attribution; `docs/architecture/meeting-assistant.md` prints the
 * scoring settings and the caveats.) There is a mechanism behind the number,
 * which is why it is trusted at this size: telling people apart on ONE
 * microphone leans on how loud each of them is, and gain control exists to
 * remove exactly that difference. Noise suppression stays on — it helped in
 * both windows.
 *
 * Echo cancellation stays on and UNMEASURED: it cancels what the device's own
 * speaker is playing, and an AMI recording has no far-end signal to cancel,
 * so no run here says anything about it either way.
 *
 * These were ffmpeg approximations of a browser's processors, on two windows
 * of one meeting. Bryan's own recording is what confirms them; moving this
 * line back is as cheap as moving it was.
 */
export const ROOM_AUDIO_DEFAULT: RoomAudioProcessing = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

/** The short spelling the address knob and the measurement report share. */
export function formatRoomAudio(cfg: RoomAudioProcessing): string {
  const bit = (on: boolean) => (on ? '1' : '0');
  return `ec${bit(cfg.echoCancellation)}-ns${bit(cfg.noiseSuppression)}-agc${bit(cfg.autoGainControl)}`;
}

/**
 * A config out of `ec1-ns0-agc0`, or nothing.
 *
 * Nothing for anything unreadable, so a typo in an address bar falls back to
 * the default instead of silently recording under half a setting. Each flag
 * is independent: `ns0` alone leaves the other two at their defaults.
 */
export function parseRoomAudio(raw: string | null | undefined): RoomAudioProcessing | undefined {
  if (!raw) return undefined;
  const flags = /^(?:ec([01])-?)?(?:ns([01])-?)?(?:agc([01]))?$/.exec(raw.trim().toLowerCase());
  if (!flags || flags.slice(1).every((f) => f === undefined)) return undefined;
  const read = (v: string | undefined, fallback: boolean) =>
    v === undefined ? fallback : v === '1';
  return {
    echoCancellation: read(flags[1], ROOM_AUDIO_DEFAULT.echoCancellation),
    noiseSuppression: read(flags[2], ROOM_AUDIO_DEFAULT.noiseSuppression),
    autoGainControl: read(flags[3], ROOM_AUDIO_DEFAULT.autoGainControl),
  };
}

/** What the browser is asked for: one channel of cleaned-up speech. */
export const MEETING_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, ...SOLO_AUDIO_PROCESSING },
};

/**
 * The constraints for a capture, given what its room is doing.
 *
 * A `solo` capture is not a room and takes no config: it is one person at
 * arm's length, which is the case every one of these processors was designed
 * for, and it keeps `MEETING_CONSTRAINTS` exactly as it was.
 */
export function captureConstraints(
  mode: CaptureMode,
  room?: RoomAudioProcessing,
): MediaStreamConstraints {
  if (mode !== 'conversation') return MEETING_CONSTRAINTS;
  return { audio: { channelCount: 1, ...(room ?? ROOM_AUDIO_DEFAULT) } };
}

/**
 * Float samples to signed 16-bit, clamped.
 *
 * The clamp is the point. A sample outside [-1, 1] is legal in the Web Audio
 * graph and arrives whenever gain control overshoots; a bare multiply-and-cast
 * WRAPS it, which turns a loud syllable into a burst of noise the engine hears
 * as a different word. The negative side scales by 32768 and the positive by
 * 32767 because the range is asymmetric.
 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i] ?? 0;
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    out[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return out;
}

/** Where the resampler's read head is between two blocks. */
export interface ResampleState {
  /** The last sample of the previous block — the left-hand partner for an
   *  output sample that falls between the blocks. */
  prev: number;
  /** The next output position, relative to the START of the next block.
   *  Negative (down to -1) means it falls in the seam. */
  offset: number;
}

export const RESAMPLE_START: ResampleState = { prev: 0, offset: 0 };

/**
 * Linear resampling, one block at a time, CONTINUOUS across blocks.
 *
 * `ratio` is input samples per output sample (48000/16000 = 3). Each call
 * consumes as much of the block as it can and hands back where the read head
 * ended up, so the next block picks up mid-stride. Restarting the phase at
 * every block instead — the obvious per-block implementation — puts a
 * discontinuity every few milliseconds, which is a steady buzz under the
 * speech and measurably worse recognition.
 */
export function resampleLinear(
  input: Float32Array,
  ratio: number,
  state: ResampleState,
): { out: Float32Array; state: ResampleState } {
  const last = input.length - 1;
  if (last < 0) return { out: new Float32Array(0), state };
  const count = Math.max(0, Math.ceil((last - state.offset) / ratio) + 1);
  const out = new Float32Array(count);
  let n = 0;
  let p = state.offset;
  for (; p <= last; p += ratio) {
    const i = Math.floor(p);
    const f = p - i;
    const a = i < 0 ? state.prev : (input[i] ?? 0);
    const b = i + 1 <= last ? (input[i + 1] ?? 0) : a;
    out[n++] = a + (b - a) * f;
  }
  return {
    out: n === count ? out : out.subarray(0, n),
    state: { prev: input[last] ?? 0, offset: p - input.length },
  };
}

/** A resampler bound to a pair of rates, carrying its own phase. */
export function createResampler(from: number, to: number): (block: Float32Array) => Float32Array {
  const ratio = from / to;
  let state = RESAMPLE_START;
  return (block) => {
    const step = resampleLinear(block, ratio, state);
    state = step.state;
    return step.out;
  };
}

/**
 * Cut a stream of samples into fixed-size frames, holding the remainder back.
 *
 * The audio graph's block size has nothing to do with the frame size the
 * socket wants, and after resampling it is not even a whole number of them —
 * so every call leaves a few samples over. Dropping them (the shortcut) loses
 * a few milliseconds of speech per block, which across a meeting is a word
 * here and there going missing for no visible reason.
 */
export function chunkPcm16(
  pending: Int16Array,
  incoming: Int16Array,
  frame: number,
): { frames: Int16Array[]; rest: Int16Array } {
  const total = pending.length + incoming.length;
  if (total < frame) {
    const rest = new Int16Array(total);
    rest.set(pending, 0);
    rest.set(incoming, pending.length);
    return { frames: [], rest };
  }
  const all = new Int16Array(total);
  all.set(pending, 0);
  all.set(incoming, pending.length);
  const frames: Int16Array[] = [];
  let at = 0;
  for (; at + frame <= total; at += frame) frames.push(all.slice(at, at + frame));
  return { frames, rest: all.slice(at) };
}

/**
 * The audio graph, reduced to what the capture needs of it. `onBlock` is
 * assigned AFTER the pump exists, because the rate it reports is what the
 * resampler has to be built from.
 */
export interface AudioPump {
  readonly sampleRate: number;
  onBlock: ((samples: Float32Array) => void) | null;
  stop(): void;
}

export type AudioPumpFactory = (stream: MediaStream) => Promise<AudioPump>;

/**
 * The worklet, as source rather than a build asset. A separate .js file would
 * be one more thing the server has to serve at a path this module has to
 * guess; a blob URL keeps the processor next to the code that loads it.
 */
const WORKLET_SOURCE = `
class MeetingPcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A copy, not the view: the render quantum's buffer is reused, so a
    // reference posted across the port would be rewritten before it is read.
    if (channel && channel.length) this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPcmProcessor);
`;

/** How many samples the ScriptProcessor fallback batches. ~85ms at 48kHz. */
const SCRIPT_PROCESSOR_BUFFER = 4096;

/**
 * The real audio graph: an AudioWorklet where there is one, and a
 * ScriptProcessor where there is not.
 *
 * The worklet runs on the audio thread, so a busy main thread (a big document
 * re-rendering, say) drops no audio. The fallback exists because
 * `audioWorklet` is unavailable on any page that is not a secure context and
 * on older Safari — and the fallback's node must be CONNECTED to the
 * destination or it is never pulled, so it goes through a muted gain node
 * rather than to the speakers, which would be a feedback loop.
 */
export async function createAudioPump(stream: MediaStream): Promise<AudioPump> {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw Object.assign(new Error('no AudioContext'), { name: 'NotSupportedError' });
  const ctx = new Ctor();
  const source = ctx.createMediaStreamSource(stream);
  const pump: AudioPump = {
    sampleRate: ctx.sampleRate,
    onBlock: null,
    stop: () => {},
  };
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'meeting-pcm');
    node.port.onmessage = (ev: MessageEvent) => pump.onBlock?.(ev.data as Float32Array);
    source.connect(node);
    pump.stop = () => {
      node.port.onmessage = null;
      node.disconnect();
      source.disconnect();
      void ctx.close();
    };
    return pump;
  } catch {
    const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (ev) =>
      pump.onBlock?.(new Float32Array(ev.inputBuffer.getChannelData(0)));
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    pump.stop = () => {
      node.onaudioprocess = null;
      node.disconnect();
      mute.disconnect();
      source.disconnect();
      void ctx.close();
    };
    return pump;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/**
 * A getUserMedia rejection, as one of the codes `recognitionErrorMessage`
 * already has words for. Anything it does not recognise keeps its own name, so
 * the message names something a search will find rather than "unknown error".
 */
export function mediaErrorCode(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'not-allowed';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'audio-capture';
  return typeof name === 'string' && name.length > 0 ? name : 'unknown';
}

export interface MeetingCaptureDeps {
  readOrigin?: () => OriginFacts;
  getMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPump?: AudioPumpFactory;
}

export interface MeetingCapture {
  stop(): void;
  /**
   * Turn echo cancellation off for a moment, and back on.
   *
   * WHY THIS EXISTS. `SOLO_AUDIO_PROCESSING` and `ROOM_AUDIO_DEFAULT` both ask for echo cancellation because
   * a meeting on a laptop speaker otherwise transcribes its own output. But
   * echo cancellation exists precisely to remove what the DEVICE is playing
   * from what the microphone hears — and the recording announcement is the
   * device playing something it needs the microphone to hear. Whether a given
   * browser's canceller actually reaches speech synthesis depends on whether
   * synthesis shares the render path it uses as its reference, which differs
   * by platform and is not something the page can ask.
   *
   * So this is a hedge, not a guarantee: best-effort, and every failure is
   * swallowed. `applyConstraints` can reject outright (Safari has refused
   * `echoCancellation` on a live track), and where it does the capture is
   * exactly where it was before. It never rejects, so no caller has to guard
   * an announcement behind it.
   */
  setEchoCancellation(on: boolean): Promise<void>;
}

/** Why a capture did not start, in words the strip can show as they are. */
export type MeetingCaptureStart =
  | { ok: true; capture: MeetingCapture }
  | { ok: false; kind: 'insecure' | 'denied'; message: string };

export interface MeetingCaptureOpts {
  /** One frame of `MEETING_FRAME_SAMPLES` at `MEETING_SAMPLE_RATE`. */
  onFrame: (pcm: Int16Array) => void;
  /** What the microphone is about to hear. Defaults to `solo`. */
  mode?: CaptureMode;
  /** Room processing for a `conversation`; ignored by a solo capture. */
  room?: RoomAudioProcessing;
  deps?: MeetingCaptureDeps;
}

function defaultGetMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) {
    return Promise.reject(Object.assign(new Error('no mediaDevices'), { name: 'NotFoundError' }));
  }
  return devices.getUserMedia(constraints);
}

/**
 * Open the microphone and stream frames until `stop()`.
 *
 * The origin gate runs BEFORE the permission prompt, for the reason
 * `voice-capture` documents: on plain http the browser offers no microphone
 * permission at all, so reacting to the refusal afterwards would send someone
 * into site settings looking for a control that is not there.
 */
export async function startMeetingCapture(opts: MeetingCaptureOpts): Promise<MeetingCaptureStart> {
  const deps = opts.deps ?? {};
  const blocked = insecureOriginMessage((deps.readOrigin ?? defaultOriginFacts)());
  if (blocked) return { ok: false, kind: 'insecure', message: blocked };

  let stream: MediaStream;
  try {
    stream = await (deps.getMedia ?? defaultGetMedia)(
      captureConstraints(opts.mode ?? DEFAULT_CAPTURE_MODE, opts.room),
    );
  } catch (err) {
    return { ok: false, kind: 'denied', message: recognitionErrorMessage(mediaErrorCode(err)) };
  }

  const releaseStream = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  let pump: AudioPump;
  try {
    pump = await (deps.createPump ?? createAudioPump)(stream);
  } catch (err) {
    releaseStream();
    return { ok: false, kind: 'denied', message: recognitionErrorMessage(mediaErrorCode(err)) };
  }

  const resample = createResampler(pump.sampleRate, MEETING_SAMPLE_RATE);
  let pending: Int16Array = new Int16Array(0);
  pump.onBlock = (block) => {
    const step = chunkPcm16(pending, floatToPcm16(resample(block)), MEETING_FRAME_SAMPLES);
    pending = step.rest;
    for (const frame of step.frames) opts.onFrame(frame);
  };

  return {
    ok: true,
    capture: {
      setEchoCancellation: async (on: boolean) => {
        await Promise.all(
          stream.getAudioTracks().map(async (track) => {
            try {
              await track.applyConstraints({ echoCancellation: on });
            } catch {
              // A track that will not take the constraint keeps the one it
              // has. Reporting this would be reporting a hedge that did not
              // apply, which is not a state anybody can act on.
            }
          }),
        );
      },
      stop: () => {
        pump.onBlock = null;
        pump.stop();
        // The graph closing is not enough: the TRACK is what holds the device,
        // and leaving it open keeps the browser's recording indicator lit long
        // after the meeting ended.
        releaseStream();
      },
    },
  };
}
