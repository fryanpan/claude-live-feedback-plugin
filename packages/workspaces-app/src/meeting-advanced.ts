/**
 * The Advanced Options panel behind the start chooser (and, mid-meeting, the
 * speaker menu): the per-engine transcription knobs, rendered from the same
 * specs the server sanitizes against (`meeting-tuning.ts` in @feedback/core).
 *
 * Layout and copy follow Bryan's approved interactive mock (audio-options
 * mock 2): a collapsed section with a chevron, an amber dot on the header
 * while anything is off its default, "Reset to defaults" once open, a dot
 * beside each modified control, and each value shown against the default it
 * replaced. Max speakers lives HERE — on the two AssemblyAI engines only,
 * default uncapped — not at the top level of the chooser; Soniox has no cap
 * to offer and the chooser says so beside its speaker toggle instead.
 *
 * ONLY MODIFIED VALUES LEAVE THIS PANEL (`tuningPayload`): an untouched knob
 * is the engine's own default, which the UI may render from the documented
 * numbers without ever asserting them on the wire — the vendors' docs
 * disagree about some of them, and a default we never send is one we can
 * never get wrong.
 */

import { type MeetingTuning, liveTuningKeys } from '@feedback/core';

/** What one control holds. `undefined` is the stepper's "uncapped". */
export type AdvancedValue = number | string | boolean | string[] | undefined;

/** Control values by engine parameter key. A plain mutable record. */
export type AdvancedState = Record<string, AdvancedValue>;

export interface AdvancedControl {
  /** The engine parameter name — the same key the server's spec knows. */
  key: string;
  label: string;
  type: 'range' | 'seg' | 'toggle' | 'stepper' | 'chips';
  min?: number;
  max?: number;
  step?: number;
  /** Rendered after the number ('' or ' ms'). */
  unit?: string;
  /** Segmented control entries, in order. */
  choices?: ReadonlyArray<{ value: number | string; label: string }>;
  /** The default the engine runs when the key is never sent. */
  def: AdvancedValue;
  /** Shown instead of the default value ("engine default" on the pro mode). */
  defText?: string;
  placeholder?: string;
  /** The inline note under the control (the stepper's cap explanation). */
  note?: string;
}

const KEYTERMS: AdvancedControl = {
  key: 'keyterms_prompt',
  label: 'Names and jargon to recognize',
  type: 'chips',
  def: [],
  placeholder: 'add a term…',
};

const MAX_SPEAKERS: AdvancedControl = {
  key: 'max_speakers',
  label: 'Max speakers',
  type: 'stepper',
  min: 1,
  max: 10,
  def: undefined,
  note: 'Cap on speaker labels this session hands out (1–10, or uncapped).',
};

/**
 * Ranges, steps and (UI) defaults come from the settings inventory the
 * feature was speced from — tables 1c / 2c / 3c — and stay inside the ranges
 * the server clamps to, so nothing this panel can produce is ever clamped.
 */
const CONTROLS: Record<string, readonly AdvancedControl[]> = {
  soniox: [
    {
      key: 'endpoint_sensitivity',
      label: 'How eagerly a pause ends the sentence',
      type: 'range',
      min: -1,
      max: 1,
      step: 0.1,
      def: 0,
      unit: '',
    },
    {
      key: 'max_endpoint_delay_ms',
      label: 'Longest wait before a line settles after you stop',
      type: 'range',
      min: 500,
      max: 3000,
      step: 100,
      def: 2000,
      unit: ' ms',
    },
    {
      key: 'endpoint_latency_adjustment_level',
      label: 'Snappier finals (may split long sentences)',
      type: 'seg',
      choices: [0, 1, 2, 3].map((n) => ({ value: n, label: String(n) })),
      def: 0,
    },
    {
      key: 'context_terms',
      label: 'Names and jargon to recognize',
      type: 'chips',
      def: [],
      placeholder: 'add a term…',
    },
    {
      key: 'language_hints',
      label: 'Languages spoken in this meeting',
      type: 'chips',
      def: [],
      placeholder: 'add a language…',
    },
  ],
  assemblyai: [
    {
      key: 'end_of_turn_confidence_threshold',
      label: 'How sure before a thought counts as finished',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.4,
      unit: '',
    },
    {
      key: 'min_turn_silence',
      label: 'Shortest pause that can end a turn',
      type: 'range',
      min: 100,
      max: 2000,
      step: 50,
      def: 400,
      unit: ' ms',
    },
    {
      key: 'max_turn_silence',
      label: 'A pause this long always ends the turn',
      type: 'range',
      min: 400,
      max: 5000,
      step: 100,
      def: 1280,
      unit: ' ms',
    },
    {
      key: 'vad_threshold',
      label: 'Background-noise tolerance (raise in noisy rooms)',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.4,
      unit: '',
    },
    MAX_SPEAKERS,
    KEYTERMS,
  ],
  'assemblyai-pro': [
    {
      key: 'mode',
      label: 'Latency vs accuracy preset',
      type: 'seg',
      choices: [
        { value: 'min_latency', label: 'min latency' },
        { value: 'balanced', label: 'balanced' },
        { value: 'max_accuracy', label: 'max accuracy' },
      ],
      def: 'balanced',
      // The docs disagree about pro defaults, so the panel never claims one:
      // an untouched preset reads "engine default" and sends nothing.
      defText: 'engine default',
    },
    {
      key: 'min_turn_silence',
      label: 'Shortest pause that can end a turn',
      type: 'range',
      min: 50,
      max: 1000,
      step: 50,
      def: 100,
      unit: ' ms',
    },
    {
      key: 'max_turn_silence',
      label: 'A pause this long always ends the turn',
      type: 'range',
      min: 400,
      max: 3000,
      step: 100,
      def: 1000,
      unit: ' ms',
    },
    {
      key: 'vad_threshold',
      label: 'Background-noise tolerance',
      type: 'range',
      min: 0,
      max: 1,
      step: 0.05,
      def: 0.3,
      unit: '',
    },
    {
      key: 'continuous_partials',
      label: 'Keep the live line moving during long monologues',
      type: 'toggle',
      def: true,
    },
    MAX_SPEAKERS,
    KEYTERMS,
  ],
};

/** The panel an engine gets. Empty for one this build has no copy for. */
export function advancedControls(engineId: string): readonly AdvancedControl[] {
  return CONTROLS[engineId] ?? [];
}

/** A fresh state holding every control's default. */
export function defaultAdvancedState(engineId: string): AdvancedState {
  const state: AdvancedState = {};
  for (const ctl of advancedControls(engineId)) {
    state[ctl.key] = Array.isArray(ctl.def) ? [...ctl.def] : ctl.def;
  }
  return state;
}

export function isDefaultValue(ctl: AdvancedControl, value: AdvancedValue): boolean {
  if (ctl.type === 'chips') return !Array.isArray(value) || value.length === 0;
  return value === ctl.def;
}

/** The keys a person has moved off their defaults, in panel order. */
export function modifiedKeys(engineId: string, state: AdvancedState): string[] {
  return advancedControls(engineId)
    .filter((ctl) => !isDefaultValue(ctl, state[ctl.key]))
    .map((ctl) => ctl.key);
}

/**
 * What the wire carries for this engine: the modified values only, shaped as
 * the server's sanitizer expects them. Defaults are OMITTED — see the file
 * header — and an untouched panel yields `{}`, which still travels: sending
 * the (empty) field is what marks the client as owning the speaker cap.
 */
export function tuningPayload(engineId: string, state: AdvancedState): MeetingTuning {
  const out: MeetingTuning = {};
  for (const ctl of advancedControls(engineId)) {
    const value = state[ctl.key];
    if (isDefaultValue(ctl, value) || value === undefined) continue;
    out[ctl.key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/** How a range value reads beside its slider — the step's own precision. */
export function formatRangeValue(ctl: AdvancedControl, value: number): string {
  const step = String(ctl.step ?? 1);
  const dot = step.indexOf('.');
  const decimals = dot === -1 ? 0 : step.length - dot - 1;
  return `${value.toFixed(decimals)}${ctl.unit ?? ''}`;
}

export interface AdvancedSectionOpts {
  engineId: string;
  state: AdvancedState;
  open: boolean;
  /** The chevron toggled; the caller re-renders. */
  onToggleOpen: () => void;
  /** A control changed (state is already updated). The caller re-renders. */
  onChange: (key: string) => void;
  /**
   * Reset pressed (state is already reset). `wasModified` names the keys the
   * reset just put back — mid-meeting, the caller reverts the live ones on
   * the open session too, or the panel would claim defaults the engine is
   * not running. The caller re-renders.
   */
  onReset: (wasModified: string[]) => void;
  /**
   * A meeting is RUNNING on this engine: keys outside the live set carry an
   * "applies to the next recording" note, and keys inside it may flash the
   * `applied` confirmation below. False in the start chooser.
   */
  recording: boolean;
  /** Keys whose last change the server confirmed applying to the live session. */
  applied?: ReadonlySet<string>;
  /**
   * Live keys the panel has moved but the open session could NOT be moved to
   * match — today only a term list emptied mid-meeting, which has no wire
   * form (the sanitizer reads `[]` as "no change"). The control says so
   * rather than showing an empty box over terms the engine is still running.
   */
  stale?: ReadonlySet<string>;
}

/**
 * Build the whole collapsed section. The caller owns state and re-renders
 * the popover it lives in after every callback — except slider drags, which
 * update their own value readout in place and only call `onChange` when the
 * drag settles, so the thumb is never rebuilt under the finger.
 */
export function buildAdvancedSection(opts: AdvancedSectionOpts): HTMLElement {
  const controls = advancedControls(opts.engineId);
  const live = liveTuningKeys(opts.engineId);
  const modified = modifiedKeys(opts.engineId, opts.state);

  const section = document.createElement('div');
  section.className = `meeting-adv${opts.open ? ' is-open' : ''}`;

  // The reset link is a SIBLING of the toggle button, not a child: a button
  // inside a button is invalid HTML, and the nested click bubbled into the
  // toggle — pressing Reset collapsed the panel over the values it had just
  // put back, so nobody saw them snap.
  const headRow = document.createElement('div');
  headRow.className = 'meeting-adv-headrow';
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'meeting-adv-head';
  head.setAttribute('aria-expanded', opts.open ? 'true' : 'false');
  const chev = document.createElement('span');
  chev.className = 'meeting-adv-chev';
  chev.textContent = opts.open ? '▾' : '▸';
  const title = document.createElement('span');
  title.textContent = 'Advanced Options';
  head.append(chev, title);
  if (modified.length > 0) {
    const dot = document.createElement('span');
    dot.className = 'meeting-adv-moddot';
    dot.setAttribute('aria-label', 'Some options are changed from their defaults');
    head.append(dot);
  }
  head.addEventListener('click', () => opts.onToggleOpen());
  headRow.append(head);

  if (opts.open && modified.length > 0) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'meeting-adv-reset';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      const wasModified = modifiedKeys(opts.engineId, opts.state);
      Object.assign(opts.state, defaultAdvancedState(opts.engineId));
      opts.onReset(wasModified);
    });
    headRow.append(reset);
  }
  section.append(headRow);

  if (!opts.open) return section;

  const body = document.createElement('div');
  body.className = 'meeting-adv-body';
  for (const ctl of controls) {
    body.append(buildControl(ctl, opts, live));
  }
  const foot = document.createElement('div');
  foot.className = 'meeting-adv-foot';
  foot.textContent = opts.recording
    ? 'Changes marked “applied” reach this recording; the rest start with the next one.'
    : 'Applied when the recording starts.';
  body.append(foot);
  section.append(body);
  return section;
}

function buildControl(
  ctl: AdvancedControl,
  opts: AdvancedSectionOpts,
  live: ReadonlySet<string>,
): HTMLElement {
  const { state } = opts;
  const value = state[ctl.key];
  const isDefault = isDefaultValue(ctl, value);
  const row = document.createElement('div');
  row.className = `meeting-adv-ctl${isDefault ? '' : ' is-modified'}`;
  row.dataset.key = ctl.key;

  const labelRow = document.createElement('div');
  labelRow.className = 'meeting-adv-label';
  const dot = document.createElement('span');
  dot.className = 'meeting-adv-ctldot';
  const lab = document.createElement('span');
  lab.className = 'meeting-adv-labtext';
  lab.textContent = ctl.label;
  labelRow.append(dot, lab);
  row.append(labelRow);

  const val = document.createElement('span');
  val.className = 'meeting-adv-val';

  const commit = (): void => opts.onChange(ctl.key);

  if (ctl.type === 'range') {
    const shown = typeof value === 'number' ? value : (ctl.def as number);
    const defShown = formatRangeValue(ctl, ctl.def as number);
    const paint = (v: number, nowDefault: boolean): void => {
      val.innerHTML = nowDefault
        ? `<b>${formatRangeValue(ctl, v)}</b> · default`
        : `<b>${formatRangeValue(ctl, v)}</b> · default ${defShown}`;
    };
    paint(shown, isDefault);
    labelRow.append(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(ctl.min);
    input.max = String(ctl.max);
    input.step = String(ctl.step);
    input.value = String(shown);
    // How much of the track reads as filled. The mobile tier paints its own
    // track (it has to, to size the thumb to the mock's 24px) and Chrome
    // offers no `::-webkit-slider-progress` to fill it, so the percentage
    // travels as a custom property the track's gradient reads. Desktop keeps
    // the native control, where this is simply unused.
    const paintFill = (v: number): void => {
      const min = ctl.min ?? 0;
      const max = ctl.max ?? 1;
      const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
      input.style.setProperty('--fill', `${pct}%`);
    };
    paintFill(shown);
    // The readout and the dot follow the drag in place; the popover is only
    // re-rendered when the drag settles, so the thumb survives the gesture.
    input.addEventListener('input', () => {
      const v = Number(input.value);
      state[ctl.key] = v;
      const nowDefault = isDefaultValue(ctl, v);
      paint(v, nowDefault);
      paintFill(v);
      row.classList.toggle('is-modified', !nowDefault);
    });
    input.addEventListener('change', commit);
    row.append(input);
  } else if (ctl.type === 'seg') {
    // With a `defText` the control never claims a concrete default (the pro
    // mode preset), so the modified readout says "· engine default" rather
    // than the clumsy "· default engine default".
    val.innerHTML = isDefault
      ? (ctl.defText ?? `<b>${segLabel(ctl, value)}</b> · default`)
      : `<b>${segLabel(ctl, value)}</b> · ${ctl.defText ?? `default ${segLabel(ctl, ctl.def)}`}`;
    labelRow.append(val);
    const seg = document.createElement('div');
    seg.className = 'meeting-adv-seg';
    for (const choice of ctl.choices ?? []) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = choice.value === value ? 'is-on' : '';
      btn.textContent = choice.label;
      btn.addEventListener('click', () => {
        state[ctl.key] = choice.value;
        commit();
      });
      seg.append(btn);
    }
    row.append(seg);
  } else if (ctl.type === 'toggle') {
    labelRow.append(val);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = `meeting-adv-toggle${value === true ? ' is-on' : ''}`;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', value === true ? 'true' : 'false');
    toggle.setAttribute('aria-label', ctl.label);
    toggle.addEventListener('click', () => {
      state[ctl.key] = value !== true;
      commit();
    });
    labelRow.append(toggle);
  } else if (ctl.type === 'stepper') {
    val.textContent = value === undefined ? 'default' : 'default uncapped';
    labelRow.append(val);
    const stepper = document.createElement('div');
    stepper.className = 'meeting-adv-stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', `Fewer ${ctl.label.toLowerCase()}`);
    const num = document.createElement('span');
    num.className = 'meeting-adv-stepnum';
    num.textContent = value === undefined ? 'uncapped' : String(value);
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', `More ${ctl.label.toLowerCase()}`);
    minus.addEventListener('click', () => {
      // Down from uncapped lands on the cap's ceiling, then counts down.
      state[ctl.key] =
        value === undefined ? (ctl.max ?? 10) : Math.max(ctl.min ?? 1, (value as number) - 1);
      commit();
    });
    plus.addEventListener('click', () => {
      // Up past the ceiling is uncapped again.
      state[ctl.key] =
        value === undefined || (value as number) >= (ctl.max ?? 10)
          ? undefined
          : (value as number) + 1;
      commit();
    });
    stepper.append(minus, num, plus);
    row.append(stepper);
    if (ctl.note) {
      const note = document.createElement('div');
      note.className = 'meeting-adv-note';
      note.textContent = ctl.note;
      row.append(note);
    }
  } else {
    // chips
    labelRow.append(val);
    const terms = Array.isArray(value) ? value : [];
    const chips = document.createElement('div');
    chips.className = 'meeting-adv-chips';
    for (const [i, term] of terms.entries()) {
      const chip = document.createElement('span');
      chip.className = 'meeting-adv-chip';
      const text = document.createElement('span');
      text.textContent = term;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'meeting-adv-chip-x';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${term}`);
      x.addEventListener('click', () => {
        const next = terms.slice();
        next.splice(i, 1);
        state[ctl.key] = next;
        commit();
      });
      chip.append(text, x);
      chips.append(chip);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = ctl.placeholder ?? '';
    input.setAttribute('aria-label', ctl.label);
    input.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ',') && input.value.trim() !== '') {
        ev.preventDefault();
        state[ctl.key] = [...terms, input.value.trim()];
        commit();
      }
    });
    chips.addEventListener('click', (ev) => {
      if (ev.target === chips) input.focus();
    });
    chips.append(input);
    row.append(chips);
  }

  // Mid-meeting: a knob the live session cannot take says so, and one the
  // server just confirmed says that instead — quietly, under the control.
  if (opts.recording) {
    if (opts.applied?.has(ctl.key)) {
      const ok = document.createElement('div');
      ok.className = 'meeting-adv-note is-applied';
      ok.textContent = 'Applied.';
      row.append(ok);
    } else if (opts.stale?.has(ctl.key)) {
      // The panel and the engine disagree and the wire cannot settle it, so
      // the control admits it instead of letting the empty box imply a
      // clearing that never reached the session.
      const diverged = document.createElement('div');
      diverged.className = 'meeting-adv-note is-stale';
      diverged.textContent = 'Cleared here — this recording keeps the terms it already has.';
      row.append(diverged);
    } else if (!live.has(ctl.key)) {
      const wait = document.createElement('div');
      wait.className = 'meeting-adv-note';
      wait.textContent = 'Applies to the next recording.';
      row.append(wait);
    }
  }

  return row;
}

function segLabel(ctl: AdvancedControl, value: AdvancedValue): string {
  return ctl.choices?.find((c) => c.value === value)?.label ?? String(value);
}
