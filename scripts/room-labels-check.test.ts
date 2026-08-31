import { describe, expect, it } from 'vitest';
import { emulate } from './room-labels-check.ts';

/**
 * The runner's own failure mode, which cost a measurement.
 *
 * `emulate` used to drop a key it didn't recognise and hand back the audio
 * untouched, while the report went on printing "EMULATED: ns agc". A shell
 * that passed `ns agc` as a single argument — zsh does not word-split an
 * unquoted parameter — therefore produced a clean, plausible measurement of
 * the RAW file under the label of the processed one. The difference between
 * two microphone settings then looked like run-to-run noise, and got written
 * up as such.
 *
 * Nothing here runs ffmpeg: the paths worth pinning are the ones that decide
 * whether the audio is touched at all.
 */
describe('emulate', () => {
  const dir = '/tmp/does-not-need-to-exist';

  it('refuses a key it does not know instead of quietly emulating nothing', () => {
    expect(() => emulate('in.wav', ['nope'], dir)).toThrow(/Unknown --emulate/);
  });

  it('names the key it could not use, including the whole-argument case', () => {
    // The exact shape of the bug: one argument holding two key names.
    expect(() => emulate('in.wav', ['ns agc'], dir)).toThrow(/"ns agc"/);
  });

  it('rejects the whole request when only one key of several is unknown', () => {
    // Partial application would be the same lie in a smaller size: the report
    // would name two processors and the audio would carry one.
    expect(() => emulate('in.wav', ['ns', 'nope'], dir)).toThrow(/Unknown --emulate/);
  });

  it('hands back the input untouched when nothing was asked for', () => {
    // The positive control for the throw: it must not fire on the ordinary
    // no-emulation path, which is how every raw measurement runs.
    expect(emulate('in.wav', [], dir)).toBe('in.wav');
  });
});
