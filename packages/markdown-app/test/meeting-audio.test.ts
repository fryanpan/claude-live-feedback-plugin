import { describe, expect, it, vi } from 'vitest';
import {
  type AudioPump,
  MEETING_CONSTRAINTS,
  MEETING_FRAME_SAMPLES,
  RESAMPLE_START,
  ROOM_AUDIO_DEFAULT,
  captureConstraints,
  chunkPcm16,
  floatToPcm16,
  formatRoomAudio,
  mediaErrorCode,
  parseRoomAudio,
  resampleLinear,
  startMeetingCapture,
} from '../src/meeting-audio.ts';

/**
 * The DSP is pure and the AudioContext is behind a seam, so everything the
 * meeting sends over the wire is checkable without audio hardware: the
 * conversion, the rate change, the framing, and the two refusals that leave
 * someone with a dead button if they are not explained.
 */

describe('floatToPcm16', () => {
  it('maps the float range onto the full signed 16-bit range', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, -16384]);
  });

  it('clamps rather than wrapping — a sample over 1.0 is loud, not inverted', () => {
    const out = floatToPcm16(new Float32Array([2, -2, 1.0001]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767]);
  });
});

describe('resampleLinear', () => {
  it('decimates an integer ratio by picking the samples that line up', () => {
    const first = resampleLinear(new Float32Array([0, 1, 2, 3, 4, 5]), 3, RESAMPLE_START);
    expect(Array.from(first.out)).toEqual([0, 3]);
    // The next block continues the same phase — no restart at the seam.
    const second = resampleLinear(new Float32Array([6, 7, 8, 9, 10, 11]), 3, first.state);
    expect(Array.from(second.out)).toEqual([6, 9]);
  });

  it('interpolates ACROSS a block boundary instead of restarting at zero', () => {
    // ratio 1.5 leaves the read head half a sample past the end of the block,
    // so the first output of the next block sits between the two blocks.
    const first = resampleLinear(new Float32Array([0, 10]), 1.5, RESAMPLE_START);
    expect(Array.from(first.out)).toEqual([0]);
    expect(first.state.offset).toBeCloseTo(-0.5);
    const second = resampleLinear(new Float32Array([20, 30]), 1.5, first.state);
    expect(Array.from(second.out)).toEqual([15, 30]);
  });

  it('leaves the state alone for an empty block', () => {
    const step = resampleLinear(new Float32Array(0), 3, { prev: 4, offset: -0.25 });
    expect(step.out.length).toBe(0);
    expect(step.state).toEqual({ prev: 4, offset: -0.25 });
  });
});

describe('chunkPcm16', () => {
  it('emits only whole frames and carries the remainder to the next call', () => {
    const a = chunkPcm16(new Int16Array(0), new Int16Array([1, 2, 3, 4, 5]), 2);
    expect(a.frames.map((f) => Array.from(f))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(Array.from(a.rest)).toEqual([5]);
    const b = chunkPcm16(a.rest, new Int16Array([6, 7]), 2);
    expect(b.frames.map((f) => Array.from(f))).toEqual([[5, 6]]);
    expect(Array.from(b.rest)).toEqual([7]);
  });

  it('holds everything back until a frame is full', () => {
    const step = chunkPcm16(new Int16Array(0), new Int16Array([1]), 4);
    expect(step.frames).toEqual([]);
    expect(Array.from(step.rest)).toEqual([1]);
  });

  it('ships 100ms of 16kHz audio per frame', () => {
    expect(MEETING_FRAME_SAMPLES).toBe(1600);
  });
});

describe('mediaErrorCode', () => {
  it('maps getUserMedia rejections onto the codes the shared messages know', () => {
    expect(mediaErrorCode({ name: 'NotAllowedError' })).toBe('not-allowed');
    expect(mediaErrorCode({ name: 'SecurityError' })).toBe('not-allowed');
    expect(mediaErrorCode({ name: 'NotFoundError' })).toBe('audio-capture');
    // Anything else keeps its own name so the message names something real.
    expect(mediaErrorCode({ name: 'NotReadableError' })).toBe('NotReadableError');
    expect(mediaErrorCode(null)).toBe('unknown');
  });
});

const SECURE = {
  isSecureContext: true,
  protocol: 'https:',
  hostname: 'example.test',
  port: '',
  pathname: '/review/d1',
  search: '',
};
const INSECURE = { ...SECURE, isSecureContext: false, protocol: 'http:', port: '8787' };

function fakeStream(applyConstraints = vi.fn(() => Promise.resolve())): MediaStream {
  const track = { stop: vi.fn(), applyConstraints };
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

describe('startMeetingCapture', () => {
  it('refuses on an insecure origin and names the loopback URL that works', async () => {
    const getMedia = vi.fn();
    const started = await startMeetingCapture({
      onFrame: () => {},
      deps: { readOrigin: () => INSECURE, getMedia },
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.kind).toBe('insecure');
    expect(started.message).toContain('http://localhost:8787/review/d1');
    // The mic is never even asked for — the browser would refuse it anyway.
    expect(getMedia).not.toHaveBeenCalled();
  });

  it('explains a refused permission instead of failing silently', async () => {
    const started = await startMeetingCapture({
      onFrame: () => {},
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' })),
      },
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.kind).toBe('denied');
    expect(started.message).toMatch(/Microphone permission refused/);
  });

  it('resamples, converts and frames the pump output before it goes out', async () => {
    const stream = fakeStream();
    const pumps: AudioPump[] = [];
    const frames: Int16Array[] = [];
    const started = await startMeetingCapture({
      onFrame: (f) => frames.push(f),
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.resolve(stream),
        createPump: () => {
          const pump: AudioPump = { sampleRate: 32_000, onBlock: null, stop: vi.fn() };
          pumps.push(pump);
          return Promise.resolve(pump);
        },
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // 32kHz in, 16kHz out: two frames' worth of input makes exactly two frames.
    const block = new Float32Array(MEETING_FRAME_SAMPLES * 4).fill(1);
    pumps[0]?.onBlock?.(block);
    expect(frames.length).toBe(2);
    expect(frames[0]?.length).toBe(MEETING_FRAME_SAMPLES);
    expect(frames[0]?.[0]).toBe(32767);
  });

  it('releases the microphone track as well as the audio graph on stop', async () => {
    const stream = fakeStream();
    const stop = vi.fn();
    const started = await startMeetingCapture({
      onFrame: () => {},
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.resolve(stream),
        createPump: () => Promise.resolve({ sampleRate: 48_000, onBlock: null, stop }),
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    started.capture.stop();
    expect(stop).toHaveBeenCalled();
    // A wedged-open mic is the failure mode: the graph closing is not enough,
    // the track itself keeps the recording indicator lit.
    expect(stream.getTracks()[0]?.stop).toHaveBeenCalled();
  });
});

describe('room audio processing', () => {
  it('leaves a solo capture exactly as it was, whatever the room config says', () => {
    // The processors are tuned for one near-field talker, which is precisely
    // what a solo capture IS. Nothing about the room measurement may move it.
    expect(captureConstraints('solo')).toEqual(MEETING_CONSTRAINTS);
    expect(
      captureConstraints('solo', {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
    ).toEqual(MEETING_CONSTRAINTS);
  });

  it('turns gain control off for a room and leaves it on for solo', () => {
    // The measured result, pinned as a value rather than left to a comment.
    // Noise suppression on beat noise suppression off in all four AMI
    // pairings. Gain control is the split one — it cost on two voices (13.4%
    // of everything said, against 16.4% for changing nothing) and helped on
    // four — and this default is chosen for the two-person room the product
    // is for, not by a majority of the eight numbers.
    expect(ROOM_AUDIO_DEFAULT.autoGainControl).toBe(false);
    expect(ROOM_AUDIO_DEFAULT.noiseSuppression).toBe(true);
    // And solo, which no run here measured, keeps what it always had. The two
    // used to be one constant, so moving the room's default would have
    // silently moved a case the measurement never looked at.
    const solo = captureConstraints('solo').audio as MediaTrackConstraints;
    expect(solo.autoGainControl).toBe(true);
  });

  it('gives a conversation the room config, still on one channel', () => {
    const room = { echoCancellation: true, noiseSuppression: false, autoGainControl: false };
    expect(captureConstraints('conversation', room)).toEqual({
      audio: { channelCount: 1, ...room },
    });
  });

  it('falls back to the one default a conversation gets when nobody chose', () => {
    expect(captureConstraints('conversation')).toEqual({
      audio: { channelCount: 1, ...ROOM_AUDIO_DEFAULT },
    });
  });

  it('reads the knob the measurement writes, in both directions', () => {
    const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    expect(parseRoomAudio('ec0-ns0-agc0')).toEqual(off);
    expect(formatRoomAudio(off)).toBe('ec0-ns0-agc0');
    expect(parseRoomAudio(formatRoomAudio(ROOM_AUDIO_DEFAULT))).toEqual(ROOM_AUDIO_DEFAULT);
    // A flag left out keeps its default, so one run can vary one processor.
    expect(parseRoomAudio('ns0')).toEqual({ ...ROOM_AUDIO_DEFAULT, noiseSuppression: false });
  });

  it('says nothing for a knob it cannot read, rather than half a setting', () => {
    for (const bad of ['', null, undefined, 'ec2', 'nope', 'ec1 ns1']) {
      expect(parseRoomAudio(bad)).toBeUndefined();
    }
  });

  it('asks the browser for the constraints the mode and the room chose', async () => {
    const asked: MediaStreamConstraints[] = [];
    const room = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    const started = await startMeetingCapture({
      onFrame: () => {},
      mode: 'conversation',
      room,
      deps: {
        readOrigin: () => SECURE,
        getMedia: (c) => {
          asked.push(c);
          return Promise.resolve(fakeStream());
        },
        createPump: () => Promise.resolve({ sampleRate: 48_000, onBlock: null, stop: vi.fn() }),
      },
    });
    expect(started.ok).toBe(true);
    // The config is worth nothing if it stops at the edge of this module: the
    // assertion is on what getUserMedia was HANDED.
    expect(asked).toEqual([{ audio: { channelCount: 1, ...room } }]);
  });
});

describe('suspending echo cancellation for the announcement', () => {
  const liveCapture = async (stream: MediaStream) => {
    const started = await startMeetingCapture({
      onFrame: () => {},
      deps: {
        readOrigin: () => SECURE,
        getMedia: () => Promise.resolve(stream),
        createPump: () =>
          Promise.resolve({ sampleRate: 48_000, onBlock: null, stop: vi.fn() } as AudioPump),
      },
    });
    if (!started.ok) throw new Error('capture did not start');
    return started.capture;
  };

  it('re-applies the constraint on the live track, both ways', async () => {
    // The announcement is the device playing something the microphone has to
    // hear, which is exactly what echo cancellation exists to remove.
    const applyConstraints = vi.fn(() => Promise.resolve());
    const stream = fakeStream(applyConstraints);
    const capture = await liveCapture(stream);
    await capture.setEchoCancellation(false);
    expect(applyConstraints).toHaveBeenCalledWith({ echoCancellation: false });
    await capture.setEchoCancellation(true);
    expect(applyConstraints).toHaveBeenLastCalledWith({ echoCancellation: true });
  });

  it('NEVER rejects, whatever the browser thinks of the constraint', async () => {
    // Safari has refused `echoCancellation` on a live track. This is a hedge;
    // a hedge that throws would take the announcement down with it.
    const stream = fakeStream(vi.fn(() => Promise.reject(new Error('OverconstrainedError'))));
    const capture = await liveCapture(stream);
    await expect(capture.setEchoCancellation(false)).resolves.toBeUndefined();
  });
});
