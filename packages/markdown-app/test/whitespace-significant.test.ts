/**
 * Where indentation is syntax, hiding an indentation change hides a
 * BEHAVIOUR change — reindenting a Python statement moves it into or out of
 * an `if` block, and a YAML key's depth is its position in the tree. Those
 * files must not get whitespace suppression by default.
 *
 * Raised by an adversarial review pass. Worth stating plainly: `git diff -w`,
 * and every hide-whitespace diff view built on it, gets this wrong.
 */
import { describe, expect, it } from 'vitest';
import { isWhitespaceSignificant } from '../src/code/languages.ts';

describe('isWhitespaceSignificant', () => {
  it('is true for languages where indentation carries meaning', () => {
    for (const p of [
      'src/thing.py',
      'stubs/thing.pyi',
      'ci/config.yaml',
      '.github/workflows/ci.yml',
      'styles/main.sass',
      'Makefile',
      'build.mk',
      'src/Main.hs',
      'src/Main.elm',
      'app/view.pug',
      'lib/thing.coffee',
    ]) {
      expect(isWhitespaceSignificant(p), p).toBe(true);
    }
  });

  it('is false for the brace languages this feature exists for', () => {
    // Control: if everything came back true the feature would never engage.
    for (const p of [
      'src/app.ts',
      'src/app.tsx',
      'src/app.js',
      'src/main.go',
      'src/lib.rs',
      'Main.java',
      'app.css',
      'index.html',
      'README.md',
      'data.json',
    ]) {
      expect(isWhitespaceSignificant(p), p).toBe(false);
    }
  });

  it('is case-insensitive and path-shaped', () => {
    expect(isWhitespaceSignificant('/abs/path/To/SCRIPT.PY')).toBe(true);
    expect(isWhitespaceSignificant('py')).toBe(true); // bare extension
    expect(isWhitespaceSignificant('')).toBe(false);
  });

  it('does not match a name that merely CONTAINS a significant extension', () => {
    expect(isWhitespaceSignificant('src/pyramid.ts')).toBe(false);
    expect(isWhitespaceSignificant('src/happy.js')).toBe(false);
  });
});
