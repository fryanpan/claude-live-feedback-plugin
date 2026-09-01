/**
 * Per-engine advanced options for a transcription session — the one place
 * that knows which knobs each engine has, what range each accepts, and which
 * of them the engine can change on an OPEN session.
 *
 * Shared by the browser (the Advanced Options panel renders from these specs)
 * and the server (the relay sanitizes an inbound frame against them), so the
 * two sides cannot drift: a knob the panel offers is a knob the relay
 * accepts, at exactly the same range.
 *
 * ONLY MODIFIED VALUES TRAVEL. A client sends a key only when the person
 * moved it off the default, and the adapters send the engine only what they
 * were given — an untouched knob is the ENGINE'S default, not a copy of the
 * number our UI happened to print. That matters because the vendors' own
 * docs disagree about some defaults (AssemblyAI's pro pages give two values
 * for `max_turn_silence`); a default we never send is a default we can never
 * get wrong.
 *
 * Values are CLAMPED rather than refused, the same rule `parseRoomSpeakers`
 * follows and for the same reason: these numbers arrive from a UI but travel
 * as JSON anybody can write, and an out-of-range value makes an engine
 * refuse the whole session — which reads as "transcription is broken" — when
 * the meeting is worth more than the typo.
 */

/**
 * The range AssemblyAI accepts for `max_speakers`. Not ours to widen. Lives
 * here rather than meeting.ts — which re-exports it — because this module
 * must import nothing from meeting.ts: meeting.ts imports `parseRawTuning`
 * from here, and a cycle leaves these bindings in their temporal dead zone
 * when the other side loads first.
 */
export const MIN_ROOM_SPEAKERS = 1;
export const MAX_ROOM_SPEAKERS = 10;

/** A tuning value as it travels: JSON-representable, nothing nested deeper. */
export type TuningValue = number | string | boolean | string[];

/**
 * One capture's advanced options, keyed by the engine parameter name. Only
 * the keys a person actually changed; an empty object is a client that knows
 * about tuning and changed nothing — which is NOT the same as the field
 * being absent (see `maxSpeakersFromTuning`).
 */
export type MeetingTuning = Record<string, TuningValue>;

/** What kind of value a parameter takes, and the bounds the engine enforces. */
export type TuningParamSpec =
  | {
      key: string;
      kind: 'number';
      min: number;
      max: number;
      /** Rounded to whole units (milliseconds, levels, speaker counts). */
      integer?: boolean;
      live: boolean;
    }
  | { key: string; kind: 'enum'; choices: readonly string[]; live: boolean }
  | { key: string; kind: 'boolean'; live: boolean }
  | {
      key: string;
      kind: 'terms';
      /** The engine's own list cap (AssemblyAI: 100 key terms). */
      maxTerms: number;
      /** A term is a name or a phrase, never a paragraph. */
      maxTermLength: number;
      live: boolean;
    };

/** How long one term in a terms list may be. One shared rule; see specs. */
const TERM_LENGTH = 100;

/**
 * Soniox stt-rt-v5. Everything rides in the single config frame sent when
 * the socket opens, and the protocol has no mid-session update message — so
 * nothing here is `live`: a change waits for the next recording.
 */
const SONIOX_TUNING: readonly TuningParamSpec[] = [
  { key: 'endpoint_sensitivity', kind: 'number', min: -1, max: 1, live: false },
  { key: 'max_endpoint_delay_ms', kind: 'number', min: 500, max: 3000, integer: true, live: false },
  {
    key: 'endpoint_latency_adjustment_level',
    kind: 'number',
    min: 0,
    max: 3,
    integer: true,
    live: false,
  },
  { key: 'context_terms', kind: 'terms', maxTerms: 100, maxTermLength: TERM_LENGTH, live: false },
  { key: 'language_hints', kind: 'terms', maxTerms: 20, maxTermLength: 24, live: false },
];

/**
 * AssemblyAI Universal Streaming (v3). Config is the connect URL, but the
 * protocol's `UpdateConfiguration` message can change the turn-detection set
 * on the open socket — those are the `live` ones.
 */
const ASSEMBLYAI_TUNING: readonly TuningParamSpec[] = [
  { key: 'end_of_turn_confidence_threshold', kind: 'number', min: 0, max: 1, live: true },
  { key: 'min_turn_silence', kind: 'number', min: 100, max: 2000, integer: true, live: true },
  { key: 'max_turn_silence', kind: 'number', min: 400, max: 5000, integer: true, live: true },
  { key: 'vad_threshold', kind: 'number', min: 0, max: 1, live: true },
  {
    key: 'max_speakers',
    kind: 'number',
    min: MIN_ROOM_SPEAKERS,
    max: MAX_ROOM_SPEAKERS,
    integer: true,
    // Part of the diarization config on the URL; not in the update set.
    live: false,
  },
  { key: 'keyterms_prompt', kind: 'terms', maxTerms: 100, maxTermLength: TERM_LENGTH, live: true },
];

/**
 * AssemblyAI `universal-3-5-pro` — same socket, different knobs: turn
 * detection is punctuation-based, so there is no confidence threshold; the
 * `mode` preset and `continuous_partials` exist only here, and both are in
 * the pro update set.
 */
const ASSEMBLYAI_PRO_TUNING: readonly TuningParamSpec[] = [
  { key: 'mode', kind: 'enum', choices: ['min_latency', 'balanced', 'max_accuracy'], live: true },
  { key: 'min_turn_silence', kind: 'number', min: 50, max: 1000, integer: true, live: true },
  { key: 'max_turn_silence', kind: 'number', min: 400, max: 3000, integer: true, live: true },
  { key: 'vad_threshold', kind: 'number', min: 0, max: 1, live: true },
  { key: 'continuous_partials', kind: 'boolean', live: true },
  {
    key: 'max_speakers',
    kind: 'number',
    min: MIN_ROOM_SPEAKERS,
    max: MAX_ROOM_SPEAKERS,
    integer: true,
    live: false,
  },
  { key: 'keyterms_prompt', kind: 'terms', maxTerms: 100, maxTermLength: TERM_LENGTH, live: true },
];

const BY_ENGINE: Record<string, readonly TuningParamSpec[]> = {
  soniox: SONIOX_TUNING,
  assemblyai: ASSEMBLYAI_TUNING,
  'assemblyai-pro': ASSEMBLYAI_PRO_TUNING,
};

/** The knobs an engine has. Empty for one that has none (the mock). */
export function tuningSpecsFor(engineName: string): readonly TuningParamSpec[] {
  return BY_ENGINE[engineName] ?? [];
}

/** The keys the engine can change on an open session. */
export function liveTuningKeys(engineName: string): ReadonlySet<string> {
  return new Set(
    tuningSpecsFor(engineName)
      .filter((s) => s.live)
      .map((s) => s.key),
  );
}

function cleanValue(spec: TuningParamSpec, raw: unknown): TuningValue | undefined {
  switch (spec.kind) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return undefined;
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      return spec.integer ? Math.round(clamped) : clamped;
    }
    case 'enum':
      return typeof raw === 'string' && spec.choices.includes(raw) ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'terms': {
      if (!Array.isArray(raw)) return undefined;
      const seen = new Set<string>();
      const terms: string[] = [];
      for (const item of raw) {
        if (typeof item !== 'string') continue;
        const term = item.trim().slice(0, spec.maxTermLength);
        if (term === '' || seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
        if (terms.length >= spec.maxTerms) break;
      }
      // An empty list is "back to the default", which is the same as never
      // sending the key — so it is dropped rather than sent as `[]`.
      return terms.length > 0 ? terms : undefined;
    }
  }
}

/**
 * Everything usable in `raw` for this engine, clamped into range; unknown
 * keys and unreadable values are dropped without comment — same tolerance as
 * the rest of the meeting frame parsing, because a knob is never worth the
 * meeting.
 */
export function sanitizeTuning(engineName: string, raw: unknown): MeetingTuning {
  const out: MeetingTuning = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const record = raw as Record<string, unknown>;
  for (const spec of tuningSpecsFor(engineName)) {
    if (!(spec.key in record)) continue;
    const value = cleanValue(spec, record[spec.key]);
    if (value !== undefined) out[spec.key] = value;
  }
  return out;
}

/** The subset of an already-sanitized tuning the engine can apply live. */
export function pickLiveTuning(engineName: string, tuning: MeetingTuning): MeetingTuning {
  const live = liveTuningKeys(engineName);
  const out: MeetingTuning = {};
  for (const [key, value] of Object.entries(tuning)) {
    if (live.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The speaker cap a tuning-aware capture asked for, or nothing for uncapped.
 *
 * A client that sends `tuning` at all is one whose Advanced Options panel
 * owns the cap, and there the default is UNCAPPED — the engine's own default
 * (Bryan's approved mock, round 1: "max speakers leaves the top level;
 * default: uncapped"). That deliberately differs from the legacy path, where
 * an absent count falls back to `DEFAULT_ROOM_SPEAKERS`: a legacy client has
 * no way to SAY uncapped, a tuning-aware one says it by omission.
 */
export function maxSpeakersFromTuning(tuning: MeetingTuning): number | undefined {
  const v = tuning.max_speakers;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Shallow-check an inbound `tuning` payload before the engine is even known:
 * keeps it an object of JSON scalars / string lists and caps its size, so a
 * hostile frame cannot park a megabyte on the connection. Returns undefined
 * for anything that is not an object — the field then reads as absent, which
 * is the legacy path.
 */
export function parseRawTuning(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= 32) break;
    const ok =
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (typeof value === 'string' && value.length <= 200) ||
      (Array.isArray(value) &&
        value.length <= 200 &&
        value.every((v) => typeof v === 'string' && v.length <= 200));
    if (!ok) continue;
    out[key] = value;
    kept++;
  }
  return out;
}
