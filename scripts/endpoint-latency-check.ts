/**
 * How long after a speaker STOPS does a turn SETTLE — and which tuning
 * actually shortens it?
 *
 * The meeting strip feels slow exactly at the pause: the person stops
 * talking, and the settled (formatted) turn the notetaker consumes arrives
 * some hundreds of milliseconds later. The adapter sends NO tuning by
 * default, so today that delay is whatever AssemblyAI's own defaults give.
 * This script measures that delay per parameter set so the server-side
 * default can be a measured choice rather than a doc-page guess.
 *
 *   bun run scripts/endpoint-latency-check.ts --mock          # harness only, no key, no bill
 *   bun run scripts/endpoint-latency-check.ts                  # the whole matrix, --repeat 3
 *   bun run scripts/endpoint-latency-check.ts --set baseline --set combo --repeat 5
 *   bun run scripts/endpoint-latency-check.ts --combo '{"end_of_turn_confidence_threshold":0.2}'
 *
 * WHAT IS MEASURED. The fixture is built, not recorded: five short spoken
 * sentences (macOS `say`) with a known 1.2s silence between them, so the
 * byte offset where each sentence's speech ENDS is known from construction
 * (edge silence is trimmed off each sentence before assembly). The audio is
 * streamed at real-time pacing in 100ms frames and the wall clock is read
 * when each frame goes out. Per sentence:
 *
 *   eot latency = arrival of the first `end_of_turn` Turn frame
 *                 MINUS the send time of the frame containing that
 *                 sentence's end-of-speech byte;
 *   fmt latency = the same, for the settled turn (`end_of_turn` AND
 *                 `turn_is_formatted`) — the one the record and the
 *                 notetaker actually consume (see transcribe-assemblyai.ts:
 *                 the unformatted final is superseded, not settled).
 *
 * A turn that only settles AFTER our Terminate goes out was flushed by the
 * teardown, not endpointed — it is reported but kept OUT of the percentiles,
 * which is why the fixture ends with 3s of streamed silence: the last
 * sentence must get the same chance to settle from silence as the others.
 *
 * PARAMETER NAMES ARE PART OF THE QUESTION — and the wire answered it. The
 * docs disagree with each other about which knobs plain Universal Streaming
 * has (one page offers `min_turn_silence`/`max_turn_silence` there, another
 * calls them U3-Pro-only; checked via context7, 2026-09-01). The first real
 * Begin frame settled it for THIS account: a session opened with no
 * `speech_model` comes up as `universal-3-5-pro`, `mode: balanced` — the
 * adapter's "account default" IS the pro model, `turn_is_formatted` mirrors
 * `end_of_turn`, and the live knobs are the pro family's (`mode`,
 * `min_turn_silence`, `max_turn_silence`, `vad_threshold`).
 * `end_of_turn_confidence_threshold` — the knob the "assemblyai" tuning spec
 * leads with — is documented as unused by U3 Pro; the matrix keeps ONE
 * variant of it purely as an inertness probe. See PARAM_SETS for the revised
 * matrix and why `mode` has to travel outside the sanitizer.
 *
 * KEY: resolved exactly the way the adapter resolves it — ASSEMBLYAI_API_KEY,
 * then the `assemblyai-api-key` Keychain entry — via the adapter's own
 * `resolveAssemblyAiKey`, and it travels ONLY in the Authorization header
 * (bare key, no Bearer). It is never printed, and neither is anything derived
 * from it. The connect URL (safe: query params only) IS printed per set so
 * the report shows what the wire was actually asked.
 *
 * COST: sessions bill on wall-clock socket seconds. The fixture is ~21s, so
 * one session is ~25s ≈ $0.001 at the base streaming rate (no speaker
 * labels are requested — diarization is a separate price and a separate
 * question). The default matrix (8 sets x 3 repeats) is ~$0.03 and ~11
 * minutes of pacing. Every session is ended with the `Terminate` message the
 * adapter sends — a socket merely closed leaves the session open and billed.
 *
 * The fixture is cached OUTSIDE the repo (default: a directory under the OS
 * tmpdir; override with --cache) and keyed on the fixture recipe, so edits
 * to the sentences rebuild it.
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

/* ===== The fixture: five sentences with silences known from construction ===== */

interface FixtureSpec {
  lines: readonly string[];
  /** Silence between sentences — the pause the endpoint detector works in. */
  gapMs: number;
  /**
   * Silence after the last line. Longer than the largest max_turn_silence
   * under test, so the LAST line settles from silence like the others rather
   * than being flushed by Terminate and reading as artificially fast.
   */
  tailMs: number;
}

/**
 * Two speaking styles, because they exercise DIFFERENT endpoint mechanisms.
 * `complete` sentences end with the model confident the thought is done —
 * the semantic detector fires and the silence knobs barely bind. `trailing`
 * lines stop mid-thought, which is the plan's actual pain case ("an idea or
 * pause happens"): the model is NOT confident, the silence fallback is what
 * ends the turn, and `max_turn_silence` becomes the binding knob. The gaps
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
   * Sent through `sanitizeTuning('assemblyai', …)` first — the same clamp the
   * relay applies — so the session sees exactly what a shipped default would.
   */
  tuning: Record<string, unknown>;
  /**
   * Bypass the sanitizer and put these on the URL verbatim. Only for probes
   * of parameter names the tuning spec does not know (the legacy spelling);
   * a recommendation can never be a `raw` key without an adapter change.
   */
  raw?: Record<string, string>;
}

/**
 * REVISED after the first real Begin frame (2026-09-01): with NO
 * `speech_model` sent, this account's session comes up as
 * `universal-3-5-pro`, `mode: balanced` — the "account default the original
 * engine has always run on" (adapter comment) IS the pro model. So the live
 * knobs here are the PRO family's: `mode`, `min_turn_silence`,
 * `max_turn_silence`, `vad_threshold`; `end_of_turn_confidence_threshold` is
 * documented as unused by U3 Pro and stays in the matrix only as an
 * inertness probe (the originally planned 0.5/0.7 variants were dropped —
 * on this wire they could only re-prove the same inertness twice).
 * `mode` travels via `raw`: the "assemblyai" engine's tuning spec does not
 * know the key, so sanitize would drop it — shipping it as a default is an
 * adapter/spec change, which is exactly what this row exists to justify.
 */
const PARAM_SETS: ParamSet[] = [
  { label: 'baseline', tuning: {} },
  { label: 'mode_min_latency', tuning: {}, raw: { mode: 'min_latency' } },
  // Inertness probe: if the threshold were live, a value this far below the
  // old default (0.4) would visibly speed endpointing up.
  { label: 'eot_conf_0.2', tuning: { end_of_turn_confidence_threshold: 0.2 } },
  { label: 'min_sil_160', tuning: { min_turn_silence: 160 } },
  { label: 'max_sil_700', tuning: { max_turn_silence: 700 } },
  { label: 'max_sil_1000', tuning: { max_turn_silence: 1000 } },
  { label: 'vad_0.5', tuning: { vad_threshold: 0.5 } },
  // Overridable with --combo '<json>' once the single-knob rows have spoken.
  {
    label: 'combo',
    tuning: { min_turn_silence: 160, max_turn_silence: 700 },
    raw: { mode: 'min_latency' },
  },
];

/* ===== One streaming session, instrumented ===== */

interface TurnRecord {
  order: number;
  /** Wall-clock arrival of the first `end_of_turn` frame for this order. */
  eotAt?: number;
  /** Wall-clock arrival of the settled (`end_of_turn && turn_is_formatted`) frame. */
  fmtAt?: number;
  text: string;
  /** Engine's own audio position (ms) of the last word, for mapping. */
  audioEndMs?: number;
}

interface SessionResult {
  /** Wall-clock send time per 100ms frame index. */
  frameSentAt: number[];
  turns: TurnRecord[];
  terminateAt: number;
  beginText: string;
  errors: string[];
}

function connectUrl(set: ParamSet): string {
  // No speaker labels: this measurement is about endpointing, and diarization
  // changes both the price and (per the adapter notes) the engine's defaults.
  const tuning = sanitizeTuning('assemblyai', set.tuning) as MeetingTuning;
  let url = streamingUrl(MEETING_SAMPLE_RATE, false, undefined, undefined, tuning);
  for (const [k, v] of Object.entries(set.raw ?? {})) {
    url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }
  return url;
}

/** Sleep until an absolute time, so pacing drift does not accumulate. */
const sleepUntil = (t: number) =>
  new Promise<void>((r) => {
    const ms = t - Date.now();
    if (ms <= 0) return r();
    setTimeout(r, ms);
  });

function runRealSession(apiKey: string, url: string, pcm: Uint8Array): Promise<SessionResult> {
  return new Promise<SessionResult>((resolve, reject) => {
    const result: SessionResult = {
      frameSentAt: [],
      turns: [],
      terminateAt: 0,
      beginText: '',
      errors: [],
    };
    const byOrder = new Map<number, TurnRecord>();
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      result.turns = [...byOrder.values()].sort((a, b) => a.order - b.order);
      err ? reject(err) : resolve(result);
    };

    // Same shape the adapter's defaultSocketFactory uses: Bun's WebSocket
    // takes headers as a second argument; the DOM typing does not know that.
    // The key is the whole Authorization value — no Bearer — and goes nowhere else.
    const ws = new WebSocket(url, { headers: { Authorization: apiKey } } as unknown as string[]);
    const overall = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      finish(new Error('session timed out'));
    }, 120_000);
    overall.unref?.();

    ws.addEventListener('error', () => {
      // The event carries nothing safe to rely on; the message is generic on
      // purpose — nothing from the request (which includes the header) is echoed.
      finish(new Error('websocket error (connect refused, bad params, or network)'));
    });
    ws.addEventListener('close', () => finish());
    ws.addEventListener('message', (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      const now = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'Begin') {
        // The only place the EFFECTIVE session config is ever stated (the
        // adapter logs it for the same reason). No key material rides in it.
        result.beginText = ev.data;
        void stream();
        return;
      }
      if (msg.type === 'Turn') {
        const order = msg.turn_order;
        const transcript = msg.transcript;
        if (typeof order !== 'number' || typeof transcript !== 'string') return;
        const rec = byOrder.get(order) ?? { order, text: '' };
        const words = msg.words;
        if (Array.isArray(words) && words.length > 0) {
          const end = (words[words.length - 1] as Record<string, unknown>)?.end;
          if (typeof end === 'number' && Number.isFinite(end)) rec.audioEndMs = end;
        }
        if (msg.end_of_turn === true) {
          if (rec.eotAt === undefined) rec.eotAt = now;
          if (msg.turn_is_formatted === true && rec.fmtAt === undefined) {
            rec.fmtAt = now;
            rec.text = transcript;
          }
          if (rec.text === '') rec.text = transcript;
        }
        byOrder.set(order, rec);
        return;
      }
      if (msg.type === 'Termination') {
        clearTimeout(overall);
        ws.close();
        finish();
        return;
      }
      if (msg.type === 'Error') {
        // Engine-authored text: safe to show, and the only way to learn a
        // parameter was refused rather than ignored.
        result.errors.push(typeof msg.error === 'string' ? msg.error : 'engine error');
      }
    });

    /** Real-time pacing: one 100ms frame per 100ms, clocked absolutely. */
    async function stream(): Promise<void> {
      try {
        const start = Date.now();
        for (let i = 0, off = 0; off < pcm.length; i++, off += FRAME_BYTES) {
          await sleepUntil(start + i * 100);
          result.frameSentAt.push(Date.now());
          ws.send(pcm.subarray(off, Math.min(off + FRAME_BYTES, pcm.length)));
        }
        // ALWAYS Terminate — a socket merely closed leaves the session open
        // and billed on AssemblyAI's side. Termination (or the 5s cap) closes.
        result.terminateAt = Date.now();
        ws.send(JSON.stringify({ type: 'Terminate' }));
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
 * each sentence's turn ending a fixed 400/550ms after its end-of-speech
 * frame — so the mapping, stats and report can be smoke-tested for free.
 */
function runMockSession(fixture: Fixture): SessionResult {
  const frames = Math.ceil(fixture.pcm.length / FRAME_BYTES);
  const frameSentAt = Array.from({ length: frames }, (_, i) => i * 100);
  const turns: TurnRecord[] = fixture.endOffsets.map((endByte, i) => {
    const sentAt = frameSentAt[Math.min(Math.floor(endByte / FRAME_BYTES), frames - 1)];
    return {
      order: i,
      eotAt: sentAt + 400,
      fmtAt: sentAt + 550,
      text: fixture.lines[i],
      audioEndMs: endByte / BYTES_PER_MS,
    };
  });
  return {
    frameSentAt,
    turns,
    terminateAt: frames * 100,
    beginText: '{"type":"Begin","mock":true}',
    errors: [],
  };
}

/* ===== Scoring: map turns to sentences, latencies, percentiles ===== */

interface Measured {
  sentence: number;
  eotMs?: number;
  fmtMs?: number;
  /** Settled only after Terminate went out — flushed, not endpointed. */
  flushed: boolean;
  text: string;
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
    (t) => (t.eotAt !== undefined || t.fmtAt !== undefined) && t.text.trim() !== '',
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
      eotMs: t.eotAt !== undefined ? t.eotAt - sentAt : undefined,
      fmtMs: t.fmtAt !== undefined ? t.fmtAt - sentAt : undefined,
      flushed: t.fmtAt !== undefined && result.terminateAt > 0 && t.fmtAt > result.terminateAt,
      text: t.text,
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
/** Nearest-rank p95 — honest at the n≈15 this matrix produces. */
const p95 = (xs: number[]) => {
  const s = sorted(xs);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};
const fmt = (n: number) => (Number.isNaN(n) ? '   —' : String(Math.round(n)).padStart(5));

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

  --mock            run the whole path with no key, no network, no bill — and no measurement
  --repeat <n>      sessions per parameter set (default 3)
  --set <label>     run only the named set(s); repeatable (default: all)
  --fixture <name>  complete (default: whole sentences — semantic endpoint fires) or
                    trailing (mid-thought stops — the silence fallback binds)
  --combo <json>    replace the combo set's tuning, e.g. '{"max_turn_silence":700}'
  --cache <dir>     fixture cache, OUTSIDE the repo (default: <tmpdir>/cw-latency-probe)
  --list            print the parameter sets and exit
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.has('help')) {
    console.log(USAGE);
    return 0;
  }
  const sets = [...PARAM_SETS];
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

  const apiKey = mock ? null : resolveAssemblyAiKey(undefined, process.env, readKeychainPassword);
  if (!mock && !apiKey) {
    console.error(
      'No AssemblyAI key. Set ASSEMBLYAI_API_KEY, or add the assemblyai-api-key\n' +
        'Keychain entry, then run this again. Nothing was sent.',
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
    `Fixture "${fixtureName}": ${fixture.lines.length} lines, ${seconds.toFixed(1)}s total, ` +
      `${spec.gapMs}ms gaps, ${spec.tailMs}ms tail (cache: ${cacheDir})`,
  );
  console.log(
    mock
      ? 'MOCK — no key, no network, no bill. The numbers below are fabricated to exercise the report.\n'
      : `${chosen.length} set(s) x ${repeats} run(s), paced at real time: ~${Math.ceil(
          (chosen.length * repeats * (seconds + 4)) / 60,
        )} min, roughly $${(chosen.length * repeats * ((seconds + 5) / 3600) * 0.15).toFixed(3)}.\n`,
  );

  interface SetSummary {
    label: string;
    fmtAll: number[];
    eotAll: number[];
    runMedians: number[];
    notes: string[];
    flushed: number;
  }
  const summaries: SetSummary[] = [];

  for (const set of chosen) {
    const url = connectUrl(set);
    console.log(`\n=== ${set.label} ===`);
    console.log(`  params: ${url.slice(url.indexOf('?') + 1)}`);
    const summary: SetSummary = {
      label: set.label,
      fmtAll: [],
      eotAll: [],
      runMedians: [],
      notes: [],
      flushed: 0,
    };
    for (let r = 1; r <= (mock ? 1 : repeats); r++) {
      let result: SessionResult;
      try {
        result = mock
          ? runMockSession(fixture)
          : await runRealSession(apiKey as string, url, fixture.pcm);
      } catch (err) {
        console.log(`  run ${r}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
        summary.notes.push(`run ${r} failed`);
        continue;
      }
      if (r === 1) console.log(`  Begin: ${result.beginText}`);
      for (const e of result.errors) summary.notes.push(`engine error: ${e}`);
      const { rows, notes } = measure(result, fixture);
      summary.notes.push(...notes.map((n) => `run ${r}: ${n}`));
      const runFmt: number[] = [];
      console.log(`  — run ${r} —`);
      for (const row of rows) {
        const flag = row.flushed ? '  [flushed by Terminate — excluded]' : '';
        console.log(
          `    s${row.sentence + 1}  eot ${fmt(row.eotMs ?? Number.NaN)}ms  fmt ${fmt(row.fmtMs ?? Number.NaN)}ms  "${row.text}"${flag}`,
        );
        if (row.flushed) {
          summary.flushed++;
          continue;
        }
        if (row.eotMs !== undefined) summary.eotAll.push(row.eotMs);
        if (row.fmtMs !== undefined) {
          summary.fmtAll.push(row.fmtMs);
          runFmt.push(row.fmtMs);
        }
      }
      if (runFmt.length > 0) summary.runMedians.push(median(runFmt));
    }
    summaries.push(summary);
  }

  /* ===== The table, and the spread-vs-gap warning ===== */

  console.log('\n================ SUMMARY ================');
  console.log('set                    n   fmt p50  fmt p95  eot p50  eot p95  run-median spread');
  const baseline = summaries.find((s) => s.label === 'baseline');
  for (const s of summaries) {
    const spread =
      s.runMedians.length > 1 ? Math.max(...s.runMedians) - Math.min(...s.runMedians) : 0;
    console.log(
      `${s.label.padEnd(20)} ${String(s.fmtAll.length).padStart(3)}   ${fmt(median(s.fmtAll))}   ${fmt(
        p95(s.fmtAll),
      )}   ${fmt(median(s.eotAll))}   ${fmt(p95(s.eotAll))}   ${fmt(spread)}`,
    );
  }
  if (baseline) {
    for (const s of summaries) {
      if (s === baseline) continue;
      const gap = Math.abs(median(s.fmtAll) - median(baseline.fmtAll));
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
        `notes ${s.label}: ${[...s.notes, s.flushed > 0 ? `${s.flushed} turn(s) flushed by Terminate` : ''].filter(Boolean).join('; ')}`,
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
