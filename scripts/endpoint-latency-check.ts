/**
 * How long after a speaker STOPS does a turn SETTLE — and which tuning
 * actually shortens it?
 *
 * The meeting strip feels slow exactly at the pause: the person stops
 * talking, and the settled turn the notetaker consumes arrives some hundreds
 * of milliseconds later. Neither adapter sends ANY endpointing tuning by
 * default, so today that delay is whatever the vendor's own defaults give.
 * This script measures it per parameter set so a server-side default can be
 * a measured choice rather than a doc-page guess.
 *
 *   bun run scripts/endpoint-latency-check.ts --mock             # harness only, no key, no bill
 *   bun run scripts/endpoint-latency-check.ts                     # soniox, whole matrix, --repeat 3
 *   bun run scripts/endpoint-latency-check.ts --engine assemblyai
 *   bun run scripts/endpoint-latency-check.ts --set baseline --set combo --repeat 5
 *   bun run scripts/endpoint-latency-check.ts --combo '{"max_endpoint_delay_ms":900}'
 *
 * BOTH ENGINES, AND SONIOX IS THE DEFAULT ONE. `orderedEngines` puts Soniox
 * first (Bryan, 2026-09-01), so a meeting on this machine settles its turns
 * through `transcribe-soniox.ts` unless somebody chose otherwise in the
 * chooser. A matrix that measured only AssemblyAI would be tuning an engine
 * the product does not run, which is why `--engine` defaults to soniox here.
 *
 * WHAT IS MEASURED. The fixture is built, not recorded: five short spoken
 * sentences (macOS `say`) with a known silence between them, so the byte
 * offset where each sentence's speech ENDS is known from construction (edge
 * silence is trimmed off each sentence before assembly). The audio is
 * streamed at real-time pacing in 100ms frames and the wall clock is read
 * when each frame goes out. Per sentence, two stages:
 *
 *   words   = the engine committed this sentence's TEXT — AssemblyAI's first
 *             `end_of_turn` frame, Soniox's last `is_final` token before the
 *             boundary. The words are settled; the turn is not.
 *   settled = the frame the ADAPTER emits as `final: true`, which is the one
 *             the record and the notetaker consume. AssemblyAI: `end_of_turn`
 *             AND `turn_is_formatted` (the unformatted final is superseded,
 *             not settled). Soniox: the `<end>` token.
 *
 * `settled` is the number the ticket is about; `words` is beside it because
 * the gap between them is a different cost with a different fix (a formatting
 * pass, not an endpoint detector), and only splitting them says which one is
 * being paid.
 *
 * A turn that only settles AFTER our end-of-audio frame goes out was flushed
 * by the teardown, not endpointed — it is reported but kept OUT of the
 * percentiles, which is why the fixture ends with seconds of streamed
 * silence: the last sentence must get the same chance to settle from silence
 * as the others.
 *
 * PARAMETER NAMES ARE PART OF THE QUESTION — and the wire answered it for
 * AssemblyAI. The docs disagree with each other about which knobs plain
 * Universal Streaming has (one page offers `min_turn_silence`/
 * `max_turn_silence` there, another calls them U3-Pro-only; checked via
 * context7, 2026-09-01). The first real Begin frame settled it for THIS
 * account: a session opened with no `speech_model` comes up as
 * `universal-3-5-pro`, `mode: balanced` — the adapter's "account default" IS
 * the pro model, `turn_is_formatted` mirrors `end_of_turn`, and the live
 * knobs are the pro family's. `end_of_turn_confidence_threshold` is
 * documented as unused by U3 Pro; the matrix keeps ONE variant of it purely
 * as an inertness probe.
 *
 * KEYS: resolved exactly the way each adapter resolves its own —
 * `resolveSonioxKey` / `resolveAssemblyAiKey`, env var then Keychain — and
 * each travels the way its protocol demands: AssemblyAI's in the
 * `Authorization` header (bare key, no Bearer), Soniox's inside the first
 * config frame. Neither is ever printed, and neither is anything derived
 * from one. What IS printed per set is the connect parameters with the key
 * excluded, so the report shows what the wire was actually asked.
 *
 * COST: both vendors bill on wall-clock socket seconds. The `complete`
 * fixture is ~21s, so one session is ~25s — roughly $0.001 on AssemblyAI's
 * base streaming rate. No speaker labels are requested: diarization is a
 * separate price and a separate question. A 7-set matrix at 3 repeats is
 * about 9 minutes of pacing and a few cents. Every session is ended with the
 * frame its adapter sends (`Terminate` / the empty frame) — a socket merely
 * closed leaves the session open and billed.
 *
 * The fixture is cached OUTSIDE the repo (default: a directory under the OS
 * tmpdir) and keyed on the fixture recipe, so edits to the sentences rebuild
 * it.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingTuning, sanitizeTuning } from '../packages/core/src/meeting-tuning.ts';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import {
  resolveAssemblyAiKey,
  streamingUrl,
} from '../packages/server/src/transcribe-assemblyai.ts';
import {
  END_TOKEN,
  resolveSonioxKey,
  sonioxConfig,
} from '../packages/server/src/transcribe-soniox.ts';

/* ===== The fixture: five sentences with silences known from construction ===== */

interface FixtureSpec {
  lines: readonly string[];
  /** Silence between sentences — the pause the endpoint detector works in. */
  gapMs: number;
  /**
   * Silence after the last line. Longer than the largest endpoint delay under
   * test, so the LAST line settles from silence like the others rather than
   * being flushed by teardown and reading as artificially fast.
   */
  tailMs: number;
}

/**
 * Two speaking styles, because they exercise DIFFERENT endpoint mechanisms.
 * `complete` sentences end with the model confident the thought is done —
 * the semantic detector fires and the silence knobs barely bind. `trailing`
 * lines stop mid-thought, which is the plan's actual pain case ("an idea or
 * pause happens"): the model is NOT confident, the silence fallback is what
 * ends the turn, and the delay ceiling becomes the binding knob. The gaps
 * are wider there so a slow fallback still fires inside the gap instead of
 * merging into the next line (a merge is a finding, not a measurement).
 */
const FIXTURES: Record<string, FixtureSpec> = {
  complete: {
    lines: [
      'The deploy pipeline finished without any errors this morning.',
      'I think we should measure the latency before changing anything.',
      'Endpoint detection might settle each turn a little faster.',
      'Quality still matters more than raw speed in the notes.',
      'Let us compare the numbers and pick a sensible default.',
    ],
    gapMs: 1200,
    tailMs: 3000,
  },
  trailing: {
    lines: [
      'So the next step would be to, um',
      'I was thinking maybe we could',
      'The other option is, well',
      'And then after that we should probably',
      'Right, so the last thing is sort of',
    ],
    gapMs: 3000,
    tailMs: 4000,
  },
};

const VOICE = 'Samantha';
/** Silence before the first word, so the session is settled when speech starts. */
const LEAD_MS = 300;

const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000; // 32 at 16 kHz PCM16
/** 100ms of PCM16 — the frame size the browser capture sends. */
const FRAME_BYTES = (MEETING_SAMPLE_RATE / 10) * 2;

interface Fixture {
  pcm: Uint8Array;
  /** Byte offset in `pcm` where each sentence's SPEECH ends. */
  endOffsets: number[];
  lines: readonly string[];
}

function run(cmd: string, args: string[]): void {
  const proc = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (proc.status !== 0) {
    throw new Error(`${cmd} failed: ${proc.stderr?.toString('utf8').trim() ?? proc.status}`);
  }
}

/** What the fixture is made of; a changed recipe is a different cache entry. */
function fixtureHash(spec: FixtureSpec): string {
  return createHash('sha256')
    .update(JSON.stringify({ spec, VOICE, LEAD_MS, MEETING_SAMPLE_RATE }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build (or reuse) the fixture. Each sentence is spoken, its leading and
 * trailing silence TRIMMED (say pads both ends, and an untrimmed tail would
 * move every "speech ended here" offset late by an unknown amount), then the
 * sentences are laid down with exact runs of zero-bytes between them. The
 * end-of-speech offsets are therefore construction facts, not estimates.
 */
function buildFixture(cacheDir: string, spec: FixtureSpec): Fixture {
  mkdirSync(cacheDir, { recursive: true });
  const pcmPath = join(cacheDir, `fixture-${fixtureHash(spec)}.raw`);
  const metaPath = join(cacheDir, `fixture-${fixtureHash(spec)}.json`);
  if (existsSync(pcmPath) && existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { endOffsets: number[] };
    return {
      pcm: new Uint8Array(readFileSync(pcmPath)),
      endOffsets: meta.endOffsets,
      lines: spec.lines,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'endpoint-fixture-'));
  try {
    const spoken: Uint8Array[] = [];
    spec.lines.forEach((line, i) => {
      const aiff = join(dir, `s${i}.aiff`);
      const raw = join(dir, `s${i}.raw`);
      run('say', ['-v', VOICE, '-o', aiff, line]);
      // Trim edge silence on BOTH ends (areverse trick for the tail), then
      // down to the meeting wire's own format: 16 kHz mono PCM16.
      run('ffmpeg', [
        '-y',
        '-i',
        aiff,
        '-af',
        'silenceremove=start_periods=1:start_threshold=-45dB,' +
          'areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
        '-ac',
        '1',
        '-ar',
        String(MEETING_SAMPLE_RATE),
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        raw,
      ]);
      spoken.push(new Uint8Array(readFileSync(raw)));
    });

    const silence = (ms: number) => new Uint8Array(2 * Math.round((ms * BYTES_PER_MS) / 2));
    const parts: Uint8Array[] = [silence(LEAD_MS)];
    const endOffsets: number[] = [];
    let at = parts[0].length;
    spoken.forEach((bytes, i) => {
      parts.push(bytes);
      at += bytes.length;
      endOffsets.push(at); // speech ends exactly here, by construction
      parts.push(silence(i === spoken.length - 1 ? spec.tailMs : spec.gapMs));
      at += parts[parts.length - 1].length;
    });
    const pcm = new Uint8Array(at);
    let off = 0;
    for (const p of parts) {
      pcm.set(p, off);
      off += p.length;
    }
    writeFileSync(pcmPath, pcm);
    writeFileSync(metaPath, JSON.stringify({ endOffsets }, null, 2));
    return { pcm, endOffsets, lines: spec.lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ===== The parameter sets under test ===== */

interface ParamSet {
  label: string;
  /**
   * Sent through `sanitizeTuning(<engine>, …)` first — the same clamp the
   * relay applies — so the session sees exactly what a shipped default would.
   */
  tuning: Record<string, unknown>;
  /**
   * Bypass the sanitizer and put these on the wire verbatim. Only for probes
   * of parameter names the tuning spec does not know; a recommendation can
   * never be a `raw` key without a spec change to go with it.
   */
  raw?: Record<string, string>;
}

/**
 * SONIOX — the default engine, and the one the adapter configures with
 * `enable_endpoint_detection: true` and nothing else. Its three latency
 * knobs, with the vendor defaults the Advanced Options panel prints
 * (`meeting-advanced.ts`): `endpoint_sensitivity` 0, `max_endpoint_delay_ms`
 * 2000, `endpoint_latency_adjustment_level` 0.
 *
 * The ceiling is the one worth doubting. Two full seconds is the longest a
 * line may wait after the speaker stops, and every one of those seconds is
 * paid again by the notes clock waiting on the settled turn — so the matrix
 * walks it down, and pairs it with the "snappier finals" level whose whole
 * documented purpose is this trade.
 */
const SONIOX_SETS: ParamSet[] = [
  { label: 'baseline', tuning: {} },
  { label: 'adj_1', tuning: { endpoint_latency_adjustment_level: 1 } },
  { label: 'adj_2', tuning: { endpoint_latency_adjustment_level: 2 } },
  { label: 'adj_3', tuning: { endpoint_latency_adjustment_level: 3 } },
  { label: 'delay_1200', tuning: { max_endpoint_delay_ms: 1200 } },
  { label: 'delay_700', tuning: { max_endpoint_delay_ms: 700 } },
  { label: 'sens_0.5', tuning: { endpoint_sensitivity: 0.5 } },
  // Overridable with --combo '<json>' once the single-knob rows have spoken.
  { label: 'combo', tuning: { endpoint_latency_adjustment_level: 2, max_endpoint_delay_ms: 1200 } },
];

/**
 * ASSEMBLYAI, as the `assemblyai` engine opens it: no `speech_model`, which
 * on this account IS `universal-3-5-pro` (see the header). So the live knobs
 * are the pro family's — `mode`, `min_turn_silence`, `max_turn_silence`,
 * `vad_threshold` — and `end_of_turn_confidence_threshold` stays only as an
 * inertness probe. `mode` travels via `raw`: the "assemblyai" tuning spec
 * does not know the key, so sanitize would drop it, and shipping it as a
 * default is a spec change this row exists to justify.
 */
const ASSEMBLYAI_SETS: ParamSet[] = [
  { label: 'baseline', tuning: {} },
  { label: 'mode_min_latency', tuning: {}, raw: { mode: 'min_latency' } },
  // Inertness probe: if the threshold were live, a value this far below the
  // old default (0.4) would visibly speed endpointing up.
  { label: 'eot_conf_0.2', tuning: { end_of_turn_confidence_threshold: 0.2 } },
  { label: 'min_sil_160', tuning: { min_turn_silence: 160 } },
  { label: 'max_sil_700', tuning: { max_turn_silence: 700 } },
  { label: 'max_sil_1000', tuning: { max_turn_silence: 1000 } },
  { label: 'vad_0.5', tuning: { vad_threshold: 0.5 } },
  {
    label: 'combo',
    tuning: { min_turn_silence: 160, max_turn_silence: 700 },
    raw: { mode: 'min_latency' },
  },
];

/* ===== One streaming session, instrumented ===== */

interface TurnRecord {
  order: number;
  /** Wall-clock arrival of the frame that committed this turn's WORDS. */
  wordsAt?: number;
  /** Wall-clock arrival of the frame the adapter would emit as `final: true`. */
  settledAt?: number;
  text: string;
  /** Engine's own audio position (ms) of the last word, for mapping. */
  audioEndMs?: number;
}

/** Everything one session's frame handler writes into. */
interface TurnSink {
  byOrder: Map<number, TurnRecord>;
  errors: string[];
  /** The engine's own statement of the session config, printed once. */
  hello: string;
}

/** What one inbound frame told us about the session's lifecycle. */
type FrameVerdict = 'ready' | 'done' | 'none';

/** One engine's session: how to connect, how to read it, how to end it. */
interface SessionDriver {
  url: string;
  headers: Record<string, string>;
  /** Sent as the first frame once the socket opens (Soniox's config). */
  openFrame?: string;
  /** May audio start the moment the socket opens, or only after `ready`? */
  streamOnOpen: boolean;
  onFrame(msg: Record<string, unknown>, now: number, sink: TurnSink): FrameVerdict;
  /** The frame that asks the engine to flush and end. */
  terminateFrame: string;
}

interface EngineSpec {
  label: string;
  sets: ParamSet[];
  resolveKey(): string | null;
  keyHelp: string;
  /** The connect parameters, with nothing secret in them. */
  describe(set: ParamSet): string;
  open(apiKey: string, set: ParamSet): SessionDriver;
  /** Fabricated stage latencies for --mock, so the report can be exercised. */
  mock: { words: number; settled: number };
}

function tuningFor(engine: string, set: ParamSet): MeetingTuning {
  return sanitizeTuning(engine, set.tuning) as MeetingTuning;
}

/* --- AssemblyAI ------------------------------------------------------- */

function assemblyAiUrl(set: ParamSet): string {
  // No speaker labels: this measurement is about endpointing, and diarization
  // changes both the price and (per the adapter notes) the engine's defaults.
  let url = streamingUrl(
    MEETING_SAMPLE_RATE,
    false,
    undefined,
    undefined,
    tuningFor('assemblyai', set),
  );
  for (const [k, v] of Object.entries(set.raw ?? {})) {
    url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }
  return url;
}

const ASSEMBLYAI: EngineSpec = {
  label: 'assemblyai',
  sets: ASSEMBLYAI_SETS,
  resolveKey: () => resolveAssemblyAiKey(undefined, process.env, readKeychainPassword),
  keyHelp: 'Set ASSEMBLYAI_API_KEY, or add the assemblyai-api-key Keychain entry',
  describe: (set) => {
    const url = assemblyAiUrl(set);
    return url.slice(url.indexOf('?') + 1);
  },
  mock: { words: 400, settled: 550 },
  open: (apiKey, set) => ({
    url: assemblyAiUrl(set),
    // No `Bearer` prefix — the key is the whole header value.
    headers: { Authorization: apiKey },
    streamOnOpen: false,
    terminateFrame: JSON.stringify({ type: 'Terminate' }),
    onFrame(msg, now, sink) {
      if (msg.type === 'Begin') {
        // The only place the EFFECTIVE session config is ever stated (the
        // adapter logs it for the same reason). No key material rides in it.
        sink.hello = JSON.stringify(msg);
        return 'ready';
      }
      if (msg.type === 'Termination') return 'done';
      if (msg.type === 'Error') {
        // Engine-authored text: safe to show, and the only way to learn a
        // parameter was refused rather than ignored.
        sink.errors.push(typeof msg.error === 'string' ? msg.error : 'engine error');
        return 'none';
      }
      if (msg.type !== 'Turn') return 'none';
      const order = msg.turn_order;
      const transcript = msg.transcript;
      if (typeof order !== 'number' || typeof transcript !== 'string') return 'none';
      const rec = sink.byOrder.get(order) ?? { order, text: '' };
      const words = msg.words;
      if (Array.isArray(words) && words.length > 0) {
        const end = (words[words.length - 1] as Record<string, unknown>)?.end;
        if (typeof end === 'number' && Number.isFinite(end)) rec.audioEndMs = end;
      }
      if (msg.end_of_turn === true) {
        if (rec.wordsAt === undefined) rec.wordsAt = now;
        // The adapter's own rule: with `format_turns` on, the settled turn is
        // the one where BOTH flags are true. On the pro model
        // `turn_is_formatted` mirrors `end_of_turn`, so the two stages land
        // on the same frame — which the report then shows as a zero gap.
        if (msg.turn_is_formatted === true && rec.settledAt === undefined) {
          rec.settledAt = now;
          rec.text = transcript;
        }
        if (rec.text === '') rec.text = transcript;
      }
      sink.byOrder.set(order, rec);
      return 'none';
    },
  }),
};

/* --- Soniox ----------------------------------------------------------- */

/**
 * Soniox has no turn numbers on the wire — the adapter assembles turns from
 * the token stream, so the probe has to assemble them the same way or it
 * would be measuring a different thing than the product emits. Mirrors
 * `transcribe-soniox.ts`: final tokens append and never re-arrive, the
 * non-final tail is replaced wholesale by each batch, and the `<end>` token
 * is the boundary that settles the turn. Diarization is off here, so the
 * adapter's speaker-change split has nothing to fire on.
 */
function sonioxFrameReader(): SessionDriver['onFrame'] {
  let order = 0;
  let finalText = '';
  let tail = '';
  let lastFinalAt: number | undefined;
  let audioEndMs: number | undefined;
  return (msg, now, sink) => {
    if (typeof msg.error_code === 'number') {
      sink.errors.push(typeof msg.error_message === 'string' ? msg.error_message : 'engine error');
      return 'none';
    }
    const settle = (): void => {
      const text = (finalText + tail).trim();
      // A boundary that fired on silence collected no words and is not a
      // turn — the adapter drops it too, so neither may reach the stats.
      if (text !== '') {
        sink.byOrder.set(order, {
          order,
          text,
          ...(lastFinalAt !== undefined ? { wordsAt: lastFinalAt } : {}),
          settledAt: now,
          ...(audioEndMs !== undefined ? { audioEndMs } : {}),
        });
        order++;
      }
      finalText = '';
      tail = '';
      lastFinalAt = undefined;
      audioEndMs = undefined;
    };
    const tokens = Array.isArray(msg.tokens) ? msg.tokens : [];
    let newTail = '';
    for (const raw of tokens) {
      if (typeof raw !== 'object' || raw === null) continue;
      const t = raw as Record<string, unknown>;
      if (typeof t.text !== 'string') continue;
      if (t.text === END_TOKEN) {
        tail = newTail = '';
        settle();
        continue;
      }
      if (t.is_final === true) {
        finalText += t.text;
        lastFinalAt = now;
        if (typeof t.end_ms === 'number' && Number.isFinite(t.end_ms)) audioEndMs = t.end_ms;
      } else {
        newTail += t.text;
      }
    }
    tail = newTail;
    if (msg.finished === true) {
      // The end-of-audio flush finalizes everything but sends no `<end>`.
      settle();
      return 'done';
    }
    return 'none';
  };
}

const SONIOX: EngineSpec = {
  label: 'soniox',
  sets: SONIOX_SETS,
  resolveKey: () => resolveSonioxKey(undefined, process.env, readKeychainPassword),
  keyHelp: 'Set SONIOX_API_KEY, or add the claude-workspaces-soniox-api-key Keychain entry',
  // The config frame minus its `api_key`, which is the whole of what is
  // secret about it: `sonioxConfig` never puts the key in what it returns.
  describe: (set) =>
    JSON.stringify(sonioxConfig(MEETING_SAMPLE_RATE, false, tuningFor('soniox', set))),
  mock: { words: 300, settled: 900 },
  open: (apiKey, set) => ({
    // The URL carries no configuration at all; the first frame does.
    url: 'wss://stt-rt.soniox.com/transcribe-websocket',
    headers: {},
    openFrame: JSON.stringify({
      api_key: apiKey,
      ...sonioxConfig(MEETING_SAMPLE_RATE, false, tuningFor('soniox', set)),
    }),
    // There is no server ack: the session is live once the config is up.
    streamOnOpen: true,
    // The EMPTY frame is Soniox's end-of-audio, and the wait for `finished`
    // is what flushes the open turn.
    terminateFrame: '',
    onFrame: sonioxFrameReader(),
  }),
};

const ENGINES: Record<string, EngineSpec> = { soniox: SONIOX, assemblyai: ASSEMBLYAI };

/* ===== Driving one session ===== */

interface SessionResult {
  /** Wall-clock send time per 100ms frame index. */
  frameSentAt: number[];
  turns: TurnRecord[];
  terminateAt: number;
  hello: string;
  errors: string[];
}

/** Sleep until an absolute time, so pacing drift does not accumulate. */
const sleepUntil = (t: number) =>
  new Promise<void>((r) => {
    const ms = t - Date.now();
    if (ms <= 0) return r();
    setTimeout(r, ms);
  });

function runRealSession(driver: SessionDriver, pcm: Uint8Array): Promise<SessionResult> {
  return new Promise<SessionResult>((resolve, reject) => {
    const sink: TurnSink = { byOrder: new Map(), errors: [], hello: '' };
    const result: SessionResult = {
      frameSentAt: [],
      turns: [],
      terminateAt: 0,
      hello: '',
      errors: sink.errors,
    };
    let settled = false;
    let streaming = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      result.turns = [...sink.byOrder.values()].sort((a, b) => a.order - b.order);
      result.hello = sink.hello;
      err ? reject(err) : resolve(result);
    };

    // Same shape both adapters' default socket factories use: Bun's WebSocket
    // takes headers as a second argument; the DOM typing does not know that.
    // A key in there goes nowhere else, and is never read back out.
    const ws = new WebSocket(driver.url, {
      headers: driver.headers,
    } as unknown as string[]);
    const overall = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      finish(new Error('session timed out'));
    }, 120_000);
    overall.unref?.();

    ws.addEventListener('error', () => {
      // The event carries nothing safe to rely on; the message is generic on
      // purpose — nothing from the request (which may include a key) is echoed.
      finish(new Error('websocket error (connect refused, bad params, or network)'));
    });
    ws.addEventListener('close', () => finish());
    ws.addEventListener('open', () => {
      if (driver.openFrame !== undefined) ws.send(driver.openFrame);
      if (driver.streamOnOpen) void stream();
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const now = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      const verdict = driver.onFrame(msg, now, sink);
      if (verdict === 'ready' && !streaming) {
        void stream();
        return;
      }
      if (verdict === 'done') {
        clearTimeout(overall);
        ws.close();
        finish();
      }
    });

    /** Real-time pacing: one 100ms frame per 100ms, clocked absolutely. */
    async function stream(): Promise<void> {
      if (streaming) return;
      streaming = true;
      try {
        const start = Date.now();
        for (let i = 0, off = 0; off < pcm.length; i++, off += FRAME_BYTES) {
          await sleepUntil(start + i * 100);
          result.frameSentAt.push(Date.now());
          ws.send(pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length)));
        }
        // ALWAYS send the engine's own end-of-audio frame — a socket merely
        // closed leaves the session open and billed on the vendor's side.
        result.terminateAt = Date.now();
        ws.send(driver.terminateFrame);
        const cap = setTimeout(() => {
          try {
            ws.close();
          } catch {}
          finish();
        }, 5_000);
        cap.unref?.();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
}

/**
 * The mock session: no key, no socket, no pacing, no measurement. It walks
 * the identical bookkeeping on a virtual clock — frames "sent" 100ms apart,
 * each sentence's stages a fixed distance after its end-of-speech frame — so
 * the mapping, stats and report can be smoke-tested for free.
 */
function runMockSession(fixture: Fixture, engine: EngineSpec): SessionResult {
  const frames = Math.ceil(fixture.pcm.length / FRAME_BYTES);
  const frameSentAt = Array.from({ length: frames }, (_, i) => i * 100);
  const turns: TurnRecord[] = fixture.endOffsets.map((endByte, i) => {
    const sentAt = frameSentAt[Math.min(Math.floor(endByte / FRAME_BYTES), frames - 1)];
    return {
      order: i,
      wordsAt: sentAt + engine.mock.words,
      settledAt: sentAt + engine.mock.settled,
      text: fixture.lines[i],
      audioEndMs: endByte / BYTES_PER_MS,
    };
  });
  return {
    frameSentAt,
    turns,
    terminateAt: frames * 100,
    hello: '{"mock":true}',
    errors: [],
  };
}

/* ===== Scoring: map turns to sentences, latencies, percentiles ===== */

interface Measured {
  sentence: number;
  wordsMs?: number;
  settledMs?: number;
  /** Settled only after the end-of-audio frame — flushed, not endpointed. */
  flushed: boolean;
  text: string;
  /** Word-level accuracy against the sentence this turn was mapped to. */
  accuracy: number;
}

/**
 * Words as a comparison sees them: lowercase, no punctuation. A tuning that
 * bought speed by cutting the end off a sentence has to show up somewhere,
 * and this is where — "does not regress" is a claim only if something can
 * falsify it.
 */
function normalizedWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/**
 * Fraction of the expected words the engine got, in order — a plain
 * longest-common-subsequence recall, not a full edit distance. Insertions are
 * deliberately unpunished: the failure this guards against is a turn cut
 * short by an eager endpoint, which is a DROP.
 */
function accuracyOf(expected: string, heard: string): number {
  const a = normalizedWords(expected);
  const b = normalizedWords(heard);
  if (a.length === 0) return 1;
  // Rolling one-row LCS: the sentences are short and this runs per turn.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/**
 * Map settled turns onto sentences. When the counts match (the healthy case)
 * order is identity. When they do not — a merge or a split, which is itself a
 * quality verdict on the setting — each turn goes to the nearest sentence end
 * by the engine's own audio clock, and the mismatch is reported.
 */
function measure(result: SessionResult, fixture: Fixture): { rows: Measured[]; notes: string[] } {
  const notes: string[] = [];
  const sentenceEndMs = fixture.endOffsets.map((b) => b / BYTES_PER_MS);
  const sentAtFor = (sentence: number): number | undefined => {
    const idx = Math.floor(fixture.endOffsets[sentence] / FRAME_BYTES);
    return result.frameSentAt[Math.min(idx, result.frameSentAt.length - 1)];
  };
  const turns = result.turns.filter(
    (t) => (t.wordsAt !== undefined || t.settledAt !== undefined) && t.text.trim() !== '',
  );
  if (turns.length !== fixture.lines.length) {
    notes.push(
      `turn count ${turns.length} != ${fixture.lines.length} sentences — merged or split turns; mapping by audio position`,
    );
  }
  const rows: Measured[] = [];
  const taken = new Set<number>();
  turns.forEach((t, i) => {
    let sentence: number;
    if (turns.length === fixture.lines.length) {
      sentence = i;
    } else {
      const at = t.audioEndMs;
      sentence =
        at === undefined
          ? Math.min(i, fixture.lines.length - 1)
          : sentenceEndMs.reduce(
              (best, ms, s) => (Math.abs(ms - at) < Math.abs(sentenceEndMs[best] - at) ? s : best),
              0,
            );
      if (taken.has(sentence)) notes.push(`two turns mapped to sentence ${sentence + 1}`);
    }
    taken.add(sentence);
    const sentAt = sentAtFor(sentence);
    if (sentAt === undefined) return;
    rows.push({
      sentence,
      wordsMs: t.wordsAt !== undefined ? t.wordsAt - sentAt : undefined,
      settledMs: t.settledAt !== undefined ? t.settledAt - sentAt : undefined,
      flushed:
        t.settledAt !== undefined && result.terminateAt > 0 && t.settledAt > result.terminateAt,
      text: t.text,
      accuracy: accuracyOf(fixture.lines[sentence] as string, t.text),
    });
  });
  for (let s = 0; s < fixture.lines.length; s++) {
    if (!taken.has(s)) notes.push(`sentence ${s + 1} produced no settled turn`);
  }
  return { rows, notes };
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const median = (xs: number[]) => {
  const s = sorted(xs);
  return s.length === 0
    ? Number.NaN
    : s.length % 2
      ? s[(s.length - 1) / 2]
      : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
/** Nearest-rank p90 — honest at the n≈15 this matrix produces. */
const p90 = (xs: number[]) => {
  const s = sorted(xs);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
};
const fmt = (n: number) => (Number.isNaN(n) ? '   —' : String(Math.round(n)).padStart(5));
const delta = (n: number) =>
  Number.isNaN(n) ? '     —' : `${n > 0 ? '+' : ''}${Math.round(n)}`.padStart(6);

/* ===== CLI ===== */

/** `--flag value` pairs and bare `--flag`s — the parser room-labels-check uses. */
function parseArgs(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let key: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      key = arg.slice(2);
      if (!out.has(key)) out.set(key, []);
    } else if (key) {
      out.get(key)?.push(arg);
    }
  }
  return out;
}

const USAGE = `endpoint-latency-check — stop-of-speech to settled-turn latency, per tuning set

  --engine <name>   soniox (default — the engine the product runs) or assemblyai
  --mock            run the whole path with no key, no network, no bill — and no measurement
  --repeat <n>      sessions per parameter set (default 3)
  --set <label>     run only the named set(s); repeatable (default: all)
  --fixture <name>  complete (default: whole sentences — semantic endpoint fires) or
                    trailing (mid-thought stops — the silence fallback binds)
  --combo <json>    replace the combo set's tuning, e.g. '{"max_endpoint_delay_ms":900}'
  --cache <dir>     fixture cache, OUTSIDE the repo (default: <tmpdir>/cw-latency-probe)
  --list            print the parameter sets and exit
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const engineName = args.get('engine')?.[0] ?? 'soniox';
  const engine = ENGINES[engineName];
  if (!engine) {
    console.error(`Unknown --engine ${engineName}; known: ${Object.keys(ENGINES).join(', ')}`);
    return 1;
  }
  const sets = [...engine.sets];
  const comboJson = args.get('combo')?.[0];
  if (comboJson) {
    const combo = sets.find((s) => s.label === 'combo');
    if (combo) combo.tuning = JSON.parse(comboJson) as Record<string, unknown>;
  }
  const wanted = args.get('set') ?? [];
  const chosen = wanted.length > 0 ? sets.filter((s) => wanted.includes(s.label)) : sets;
  if (args.has('list') || chosen.length === 0) {
    for (const s of sets)
      console.log(`  ${s.label.padEnd(20)} ${JSON.stringify({ ...s.tuning, ...s.raw })}`);
    return chosen.length === 0 ? 1 : 0;
  }
  const mock = args.has('mock');
  const repeats = Math.max(1, Number(args.get('repeat')?.[0] ?? '3'));
  const cacheDir = args.get('cache')?.[0] ?? join(tmpdir(), 'cw-latency-probe');

  const apiKey = mock ? null : engine.resolveKey();
  if (!mock && !apiKey) {
    console.error(
      `No ${engine.label} key. ${engine.keyHelp}, then run this again. Nothing was sent.`,
    );
    return 1;
  }

  const fixtureName = args.get('fixture')?.[0] ?? 'complete';
  const spec = FIXTURES[fixtureName];
  if (!spec) {
    console.error(`Unknown --fixture ${fixtureName}; known: ${Object.keys(FIXTURES).join(', ')}`);
    return 1;
  }
  const fixture = buildFixture(cacheDir, spec);
  const seconds = fixture.pcm.length / 2 / MEETING_SAMPLE_RATE;
  console.log(
    `Engine "${engine.label}", fixture "${fixtureName}": ${fixture.lines.length} lines, ` +
      `${seconds.toFixed(1)}s total, ${spec.gapMs}ms gaps, ${spec.tailMs}ms tail (cache: ${cacheDir})`,
  );
  console.log(
    mock
      ? 'MOCK — no key, no network, no bill. The numbers below are fabricated to exercise the report.\n'
      : `${chosen.length} set(s) x ${repeats} run(s), paced at real time: ~${Math.ceil(
          (chosen.length * repeats * (seconds + 4)) / 60,
        )} min of streamed audio.\n`,
  );

  interface SetSummary {
    label: string;
    settledAll: number[];
    wordsAll: number[];
    /** Per-turn word recall against the fixture line — the accuracy guard. */
    accuracyAll: number[];
    runMedians: number[];
    notes: string[];
    flushed: number;
  }
  const summaries: SetSummary[] = [];

  for (const set of chosen) {
    console.log(`\n=== ${set.label} ===`);
    console.log(`  asked: ${engine.describe(set)}`);
    const summary: SetSummary = {
      label: set.label,
      settledAll: [],
      wordsAll: [],
      accuracyAll: [],
      runMedians: [],
      notes: [],
      flushed: 0,
    };
    for (let r = 1; r <= (mock ? 1 : repeats); r++) {
      let result: SessionResult;
      try {
        result = mock
          ? runMockSession(fixture, engine)
          : await runRealSession(engine.open(apiKey as string, set), fixture.pcm);
      } catch (err) {
        console.log(`  run ${r}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
        summary.notes.push(`run ${r} failed`);
        continue;
      }
      if (r === 1 && result.hello !== '') console.log(`  hello: ${result.hello}`);
      for (const e of result.errors) summary.notes.push(`engine error: ${e}`);
      const { rows, notes } = measure(result, fixture);
      summary.notes.push(...notes.map((n) => `run ${r}: ${n}`));
      const runSettled: number[] = [];
      console.log(`  — run ${r} —`);
      for (const row of rows) {
        const flag = row.flushed ? '  [flushed by end-of-audio — excluded]' : '';
        const acc = row.accuracy < 1 ? `  acc ${(row.accuracy * 100).toFixed(0)}%` : '';
        console.log(
          `    s${row.sentence + 1}  words ${fmt(row.wordsMs ?? Number.NaN)}ms  settled ${fmt(
            row.settledMs ?? Number.NaN,
          )}ms  "${row.text}"${acc}${flag}`,
        );
        if (row.flushed) {
          summary.flushed++;
          continue;
        }
        summary.accuracyAll.push(row.accuracy);
        if (row.wordsMs !== undefined) summary.wordsAll.push(row.wordsMs);
        if (row.settledMs !== undefined) {
          summary.settledAll.push(row.settledMs);
          runSettled.push(row.settledMs);
        }
      }
      if (runSettled.length > 0) summary.runMedians.push(median(runSettled));
    }
    summaries.push(summary);
  }

  /* ===== The table, and the spread-vs-gap warning ===== */

  console.log('\n================ SUMMARY ================');
  console.log(
    'set                    n  settled50  settled90  words50  words90  vs base  spread   acc',
  );
  const baseline = summaries.find((s) => s.label === 'baseline');
  const baseMedian = baseline ? median(baseline.settledAll) : Number.NaN;
  for (const s of summaries) {
    const spread =
      s.runMedians.length > 1 ? Math.max(...s.runMedians) - Math.min(...s.runMedians) : 0;
    const acc =
      s.accuracyAll.length === 0
        ? '   —'
        : `${((s.accuracyAll.reduce((a, b) => a + b, 0) / s.accuracyAll.length) * 100).toFixed(0)}%`;
    console.log(
      `${s.label.padEnd(20)} ${String(s.settledAll.length).padStart(3)}   ${fmt(
        median(s.settledAll),
      )}      ${fmt(p90(s.settledAll))}    ${fmt(median(s.wordsAll))}    ${fmt(
        p90(s.wordsAll),
      )}   ${delta(median(s.settledAll) - baseMedian)}   ${fmt(spread)}  ${acc.padStart(4)}`,
    );
  }
  if (baseline) {
    for (const s of summaries) {
      if (s === baseline) continue;
      const gap = Math.abs(median(s.settledAll) - baseMedian);
      const spread = Math.max(
        s.runMedians.length > 1 ? Math.max(...s.runMedians) - Math.min(...s.runMedians) : 0,
        baseline.runMedians.length > 1
          ? Math.max(...baseline.runMedians) - Math.min(...baseline.runMedians)
          : 0,
      );
      if (Number.isFinite(gap) && spread >= gap && gap > 0) {
        console.log(
          `WARNING: ${s.label} vs baseline gap ${Math.round(gap)}ms is within run-to-run spread ` +
            `${Math.round(spread)}ms — this difference is NOT established; raise --repeat`,
        );
      }
    }
  }
  for (const s of summaries) {
    if (s.notes.length > 0 || s.flushed > 0) {
      console.log(
        `notes ${s.label}: ${[...s.notes, s.flushed > 0 ? `${s.flushed} turn(s) flushed by end-of-audio` : ''].filter(Boolean).join('; ')}`,
      );
    }
  }
  if (mock) console.log('\nMOCK run — harness proven, nothing measured.');
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
