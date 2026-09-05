/**
 * The marker a note's "did you mean this row?" is written with.
 *
 * WHY THIS IS TESTED AT ALL, given how little code it is: the server spells
 * the href and the client reads it back, and the two halves are in different
 * packages and run on different machines. A drift between them fails SILENTLY
 * — the link still opens the right row, and it simply never becomes a
 * citation, which nobody notices until somebody asks why the suggestion did
 * nothing. So the round trips below are the actual contract, and they are
 * written as round trips rather than as expected strings for exactly that
 * reason: what matters is that the reader can undo what the writer did.
 *
 * All URLs here are invented; the repo is public.
 */

import { describe, expect, it } from 'vitest';
import {
  SUGGEST_PARAM,
  acceptedHref,
  isSuggestionHref,
  suggestionHref,
  suggestionLabel,
  titleFromSuggestionLabel,
} from '../src/note-suggestion.ts';

const ROW = '/workspaces/w-recorder?task=t-wheel';

describe('marking a link as a question', () => {
  it('is recognised by the reader, and the plain row link is not', () => {
    expect(isSuggestionHref(suggestionHref(ROW))).toBe(true);
    // The control: without the marker, an ordinary citation must not be
    // mistaken for a question the reader can accept.
    expect(isSuggestionHref(ROW)).toBe(false);
  });

  it('keeps the query a row URL already carries', () => {
    const marked = suggestionHref(ROW);
    const back = new URL(marked, 'http://placeholder.invalid');
    expect(back.searchParams.get('task')).toBe('t-wheel');
    expect(back.searchParams.get(SUGGEST_PARAM)).toBe('1');
  });

  it('marks a URL that has no query at all', () => {
    expect(isSuggestionHref(suggestionHref('/workspaces/w-recorder'))).toBe(true);
  });

  it('reads only its own value as a question', () => {
    // A row whose own link happens to carry the word is not a suggestion;
    // treating it as one would offer a tap that writes a ref nobody asked for.
    expect(isSuggestionHref('/workspaces/w-recorder?suggest=0')).toBe(false);
    expect(isSuggestionHref('/workspaces/w-recorder?suggested=1')).toBe(false);
  });

  it('answers false for something that is not a URL rather than throwing', () => {
    expect(isSuggestionHref('not a url at all')).toBe(false);
  });
});

describe('accepting it', () => {
  it('gives back exactly the link the composer would have written', () => {
    expect(acceptedHref(suggestionHref(ROW))).toBe(ROW);
  });

  it('leaves a link that was never a question alone', () => {
    expect(acceptedHref(ROW)).toBe(ROW);
  });

  it('keeps an absolute URL absolute, and a relative one relative', () => {
    const absolute = 'http://box.local:8787/workspaces/w-recorder?task=t-wheel';
    expect(acceptedHref(suggestionHref(absolute))).toBe(absolute);
    expect(acceptedHref(suggestionHref(ROW)).startsWith('/')).toBe(true);
  });

  it('keeps a fragment', () => {
    const withHash = `${ROW}#activity`;
    expect(acceptedHref(suggestionHref(withHash))).toBe(withHash);
  });

  it('hands back what it was given when the href is unparseable', () => {
    expect(acceptedHref('not a url at all')).toBe('not a url at all');
  });
});

describe('the words the question is written as', () => {
  it('round-trips a row title through the label', () => {
    const title = 'Menu wheel navigation';
    expect(titleFromSuggestionLabel(suggestionLabel(title))).toBe(title);
  });

  it('round-trips a title that itself ends in a question mark', () => {
    const title = 'Why does the wheel skip?';
    expect(titleFromSuggestionLabel(suggestionLabel(title))).toBe(title);
  });

  it('returns null when a person rewrote the words', () => {
    // Their sentence is not ours to replace: the caller keeps what is there
    // rather than substituting a title the reader chose to drop.
    expect(titleFromSuggestionLabel('the wheel one')).toBeNull();
    expect(titleFromSuggestionLabel('related: Menu wheel navigation')).toBeNull();
    expect(titleFromSuggestionLabel('')).toBeNull();
  });
});
