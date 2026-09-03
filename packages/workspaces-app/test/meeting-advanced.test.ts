/**
 * The Advanced Options panel as a unit: its controls agree with the specs the
 * server sanitizes against (the whole point of sharing them), only modified
 * values leave it, and the section's states — collapsed, modified, resetting,
 * mid-recording — read the way the approved mock says they should.
 */
import { tuningSpecsFor } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AdvancedSectionOpts,
  type AdvancedState,
  advancedControls,
  buildAdvancedSection,
  defaultAdvancedState,
  formatRangeValue,
  isDefaultValue,
  modifiedKeys,
  tuningPayload,
} from '../src/meeting-advanced.ts';

const ENGINES = ['soniox', 'assemblyai', 'assemblyai-pro'] as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe('the controls against the shared specs', () => {
  it('offers only knobs the server knows, at ranges it will never clamp', () => {
    for (const engine of ENGINES) {
      const specs = new Map(tuningSpecsFor(engine).map((s) => [s.key, s]));
      for (const ctl of advancedControls(engine)) {
        const spec = specs.get(ctl.key);
        expect(spec, `${engine}: ${ctl.key} is not a spec key`).toBeDefined();
        if (spec?.kind === 'number' && ctl.min !== undefined && ctl.max !== undefined) {
          expect(ctl.min).toBeGreaterThanOrEqual(spec.min);
          expect(ctl.max).toBeLessThanOrEqual(spec.max);
        }
        if (spec?.kind === 'enum' && ctl.choices) {
          for (const choice of ctl.choices) {
            expect(spec.choices).toContain(choice.value);
          }
        }
      }
    }
  });

  it('puts the speaker cap on the AssemblyAI panels only, default uncapped', () => {
    // Bryan's approved mock, round 1: max speakers leaves the top level and
    // lives here; Soniox has no cap to offer.
    for (const engine of ['assemblyai', 'assemblyai-pro'] as const) {
      const cap = advancedControls(engine).find((c) => c.key === 'max_speakers');
      expect(cap).toBeDefined();
      expect(cap?.def).toBeUndefined();
    }
    expect(advancedControls('soniox').some((c) => c.key === 'max_speakers')).toBe(false);
    // And an engine this build has no copy for gets no panel at all.
    expect(advancedControls('mock')).toEqual([]);
  });
});

describe('what leaves the panel', () => {
  it('sends nothing for an untouched panel — the field itself still travels', () => {
    for (const engine of ENGINES) {
      expect(tuningPayload(engine, defaultAdvancedState(engine))).toEqual({});
    }
  });

  it('sends exactly the moved knobs', () => {
    const state = defaultAdvancedState('assemblyai');
    state.vad_threshold = 0.8;
    state.max_speakers = 4;
    state.keyterms_prompt = ['ydoc'];
    expect(tuningPayload('assemblyai', state)).toEqual({
      vad_threshold: 0.8,
      max_speakers: 4,
      keyterms_prompt: ['ydoc'],
    });
    expect(modifiedKeys('assemblyai', state)).toEqual([
      'vad_threshold',
      'max_speakers',
      'keyterms_prompt',
    ]);
  });

  it('treats an emptied term list as default, not as a value', () => {
    const ctl = advancedControls('assemblyai').find((c) => c.key === 'keyterms_prompt');
    if (!ctl) throw new Error('no keyterms control');
    expect(isDefaultValue(ctl, [])).toBe(true);
    expect(isDefaultValue(ctl, ['ydoc'])).toBe(false);
  });

  it('reads a range value at the step’s own precision', () => {
    const eotc = advancedControls('assemblyai')[0];
    if (!eotc) throw new Error('no controls');
    expect(formatRangeValue(eotc, 0.4)).toBe('0.40');
    const silence = advancedControls('assemblyai')[1];
    if (!silence) throw new Error('no controls');
    expect(formatRangeValue(silence, 400)).toBe('400 ms');
  });
});

/** Build a section with spies, returning the element and the state. */
function section(
  engineId: string,
  over: Partial<AdvancedSectionOpts> & { state?: AdvancedState } = {},
) {
  const state = over.state ?? defaultAdvancedState(engineId);
  const onToggleOpen = vi.fn();
  const onChange = vi.fn();
  const onReset = vi.fn();
  const el = buildAdvancedSection({
    engineId,
    state,
    open: true,
    recording: false,
    onToggleOpen,
    onChange,
    onReset,
    ...over,
  });
  document.body.append(el);
  return { el, state, onToggleOpen, onChange, onReset };
}

describe('the section', () => {
  it('collapsed is one header row; the dot appears only when something moved', () => {
    const plain = section('assemblyai', { open: false });
    expect(plain.el.querySelector('.meeting-adv-body')).toBeNull();
    expect(plain.el.querySelector('.meeting-adv-moddot')).toBeNull();
    const state = defaultAdvancedState('assemblyai');
    state.vad_threshold = 0.9;
    const moved = section('assemblyai', { open: false, state });
    expect(moved.el.querySelector('.meeting-adv-moddot')).not.toBeNull();
    // Reset only offers itself once the panel is open.
    expect(moved.el.querySelector('.meeting-adv-reset')).toBeNull();
  });

  it('Reset to defaults puts every knob back and names what it put back', () => {
    const state = defaultAdvancedState('assemblyai');
    state.vad_threshold = 0.9;
    state.max_speakers = 3;
    const s = section('assemblyai', { state });
    s.el.querySelector<HTMLButtonElement>('.meeting-adv-reset')?.click();
    // The keys that were off their defaults, so a mid-meeting caller can
    // revert them on the live session too.
    expect(s.onReset).toHaveBeenCalledWith(['vad_threshold', 'max_speakers']);
    expect(modifiedKeys('assemblyai', state)).toEqual([]);
    // The reset is a SIBLING of the header toggle, not a nested button: its
    // click must not bubble into the toggle and collapse the panel over the
    // values it just put back.
    expect(s.onToggleOpen).not.toHaveBeenCalled();
    expect(s.el.querySelector('.meeting-adv-head .meeting-adv-reset')).toBeNull();
  });

  it('a live key the session could not be moved to match says so, over the other notes', () => {
    // `keyterms_prompt` is live-tunable, so it earns no "next recording"
    // note — and an emptied list cannot travel. Without this the control
    // renders an empty box, silently, over terms the engine still runs.
    const state = defaultAdvancedState('assemblyai');
    const s = section('assemblyai', {
      state,
      recording: true,
      stale: new Set(['keyterms_prompt']),
    });
    const note = s.el.querySelector(
      '.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-note',
    );
    expect(note?.textContent).toBe('Cleared here — this recording keeps the terms it already has.');
    expect(note?.classList.contains('is-stale')).toBe(true);
    // A key the session genuinely cannot take still says the other thing.
    // The cap carries its own explanatory note first, so it is the LAST note
    // on the row that the recording adds.
    const capNotes = s.el.querySelectorAll(
      '.meeting-adv-ctl[data-key="max_speakers"] .meeting-adv-note',
    );
    expect(capNotes[capNotes.length - 1]?.textContent).toBe('Applies to the next recording.');
    // And nothing says it before the recording starts.
    const idle = section('assemblyai', { stale: new Set(['keyterms_prompt']) });
    expect(idle.el.querySelector('.meeting-adv-note.is-stale')).toBeNull();
  });

  it('tracks the slider fill as a percentage, because the mobile track paints itself', () => {
    // The mobile tier replaces the native control to size the thumb, which
    // costs the browser's own progress fill; the gradient that replaces it
    // reads this property. A wrong number here is a track that disagrees
    // with the thumb sitting on it.
    const state = defaultAdvancedState('assemblyai');
    const s = section('assemblyai', { state });
    const input = s.el.querySelector<HTMLInputElement>(
      '.meeting-adv-ctl[data-key="vad_threshold"] input[type="range"]',
    );
    if (!input) throw new Error('no range input');
    // vad_threshold runs 0–1 and defaults to 0.4.
    expect(input.style.getPropertyValue('--fill')).toBe('40%');
    input.value = '0.75';
    input.dispatchEvent(new Event('input'));
    expect(input.style.getPropertyValue('--fill')).toBe('75%');

    // A control whose range does not start at zero still reads off its own
    // ends, not off the raw value.
    const silence = s.el.querySelector<HTMLInputElement>(
      '.meeting-adv-ctl[data-key="min_turn_silence"] input[type="range"]',
    );
    if (!silence) throw new Error('no silence input');
    // 100–2000 ms, default 400 → (400-100)/1900.
    expect(silence.style.getPropertyValue('--fill')).toBe(`${((400 - 100) / 1900) * 100}%`);
  });

  it('a modified pro preset reads against "engine default", not a claimed number', () => {
    const state = defaultAdvancedState('assemblyai-pro');
    state.mode = 'max_accuracy';
    const s = section('assemblyai-pro', { state });
    const val = s.el.querySelector('.meeting-adv-ctl[data-key="mode"] .meeting-adv-val');
    expect(val?.textContent).toBe('max accuracy · engine default');
  });

  it('steps the cap down from uncapped to the ceiling, and up past it to uncapped', () => {
    const s = section('assemblyai');
    const row = s.el.querySelector('.meeting-adv-ctl[data-key="max_speakers"]');
    const minus = row?.querySelector<HTMLButtonElement>('button[aria-label^="Fewer"]');
    expect(row?.querySelector('.meeting-adv-stepnum')?.textContent).toBe('uncapped');
    minus?.click();
    expect(s.state.max_speakers).toBe(10);
    // The caller re-renders on commit; here the state is the assertion.
    expect(s.onChange).toHaveBeenCalledWith('max_speakers');
    const capped = section('assemblyai', {
      state: { ...defaultAdvancedState('assemblyai'), max_speakers: 10 },
    });
    capped.el
      .querySelector<HTMLButtonElement>(
        '.meeting-adv-ctl[data-key="max_speakers"] button[aria-label^="More"]',
      )
      ?.click();
    expect(capped.state.max_speakers).toBeUndefined();
  });

  it('adds a term on Enter and removes one from its chip', () => {
    const s = section('assemblyai');
    const input = s.el.querySelector<HTMLInputElement>(
      '.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-chips input',
    );
    if (!input) throw new Error('no chips input');
    input.value = 'Fryanpan';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(s.state.keyterms_prompt).toEqual(['Fryanpan']);
    const withTerms = section('assemblyai', {
      state: { ...defaultAdvancedState('assemblyai'), keyterms_prompt: ['a', 'b'] },
    });
    withTerms.el
      .querySelectorAll<HTMLButtonElement>(
        '.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-chip-x',
      )[0]
      ?.click();
    expect(withTerms.state.keyterms_prompt).toEqual(['b']);
  });

  it('mid-recording, each control says what its change will reach', () => {
    // Live key the server confirmed → "Applied."; live key still unconfirmed
    // → nothing; a key the open session cannot take → "next recording".
    const s = section('assemblyai', {
      recording: true,
      applied: new Set(['vad_threshold']),
    });
    const note = (key: string) =>
      s.el.querySelector(`.meeting-adv-ctl[data-key="${key}"] .meeting-adv-note:last-child`)
        ?.textContent;
    expect(note('vad_threshold')).toBe('Applied.');
    expect(note('max_speakers')).toBe('Applies to the next recording.');
    expect(
      s.el.querySelector('.meeting-adv-ctl[data-key="min_turn_silence"] .meeting-adv-note'),
    ).toBeNull();
    // Soniox can change nothing live: every control says next recording.
    const sx = section('soniox', { recording: true });
    for (const ctl of sx.el.querySelectorAll('.meeting-adv-ctl')) {
      expect(ctl.querySelector('.meeting-adv-note')?.textContent).toBe(
        'Applies to the next recording.',
      );
    }
    // And the footers differ: a live panel explains the split.
    expect(s.el.querySelector('.meeting-adv-foot')?.textContent).toContain('marked “applied”');
    const idle = section('assemblyai');
    expect(idle.el.querySelector('.meeting-adv-foot')?.textContent).toBe(
      'Applied when the recording starts.',
    );
  });
});
