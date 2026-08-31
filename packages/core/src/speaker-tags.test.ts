import { describe, expect, it } from 'vitest';
import {
  findSpeakerTags,
  normalizeSpeakerTags,
  renameSpeakerTags,
  renderSpeakerTag,
  speakerLabelsIn,
  speakerTagHref,
  speakerTagLabel,
} from './speaker-tags.ts';

describe('the tag itself', () => {
  it('is a markdown link whose href carries the label and whose text carries the name', () => {
    expect(renderSpeakerTag('B', { B: 'Devi' })).toBe('[@Devi](speaker:B)');
    expect(renderSpeakerTag('B', {})).toBe('[@Speaker B](speaker:B)');
  });

  it('reads a label back out of its own href, and nothing out of any other', () => {
    expect(speakerTagLabel(speakerTagHref('B'))).toBe('B');
    expect(speakerTagLabel('/w/w-1/t/t-1')).toBeNull();
    expect(speakerTagLabel('https://example.com/speaker:B')).toBeNull();
    // A scheme with nothing after it names no voice.
    expect(speakerTagLabel('speaker:')).toBeNull();
  });
});

describe('findSpeakerTags', () => {
  it('finds tags among ordinary links and leaves the ordinary ones alone', () => {
    const md = '- [@Devi](speaker:B) will file [the ticket](/w/w-1/t/t-1) today.';
    expect(findSpeakerTags(md)).toEqual([{ start: 2, end: 20, label: 'B', text: '@Devi' }]);
  });

  it('reports every voice a note attributes anything to, once each', () => {
    const md = '[@Devi](speaker:B) disagreed with [@Sam](speaker:A); [@Devi](speaker:B) won.';
    expect(speakerLabelsIn(md)).toEqual(['B', 'A']);
  });

  it('does not read a bracketed phrase inside link text as a tag', () => {
    expect(findSpeakerTags('[see [1] below](speaker:B)')).toEqual([]);
  });
});

describe('normalizeSpeakerTags — the gate on what the model claims', () => {
  const known = new Set(['A', 'B']);

  it('re-renders a real voice from the name map rather than trusting the spelling', () => {
    const out = normalizeSpeakerTags('- [@devi r](speaker:B) wants the gate moved.', {
      names: { B: 'Devi' },
      known,
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B) wants the gate moved.');
    expect(out.renamed).toBe(1);
    expect(out.unknown).toEqual([]);
  });

  it('leaves a tag that is already canonical exactly as it is', () => {
    const md = '- [@Devi](speaker:B) wants the gate moved.';
    const out = normalizeSpeakerTags(md, { names: { B: 'Devi' }, known });
    expect(out.markdown).toBe(md);
    expect(out.renamed).toBe(0);
  });

  it('unwraps a voice the meeting never carried, keeping the words and reporting the label', () => {
    const out = normalizeSpeakerTags('- [@Priya](speaker:C) volunteered.', {
      names: {},
      known,
    });
    expect(out.markdown).toBe('- Priya volunteered.');
    expect(out.unknown).toEqual(['C']);
  });

  it('leaves ordinary links untouched', () => {
    const md = '- Filed as [Move the gate](/w/w-1/t/t-1).';
    expect(normalizeSpeakerTags(md, { names: {}, known }).markdown).toBe(md);
  });

  it('leaves a line the person wrote byte for byte alone', () => {
    // The merge recognises a person's line by its exact text, and the
    // composer is asked to reproduce it verbatim. Normalizing it would make
    // the reproduction stop matching and land a second copy beside theirs.
    const mine = '- [@devi r](speaker:B) — my own note, spelled my way';
    const out = normalizeSpeakerTags(`${mine}\n- [@devi r](speaker:B) said it.`, {
      names: { B: 'Devi' },
      known,
      protect: [mine.slice(2)],
    });
    expect(out.markdown.split('\n')[0]).toBe(mine);
    expect(out.markdown.split('\n')[1]).toBe('- [@Devi](speaker:B) said it.');
  });
});

describe('renameSpeakerTags', () => {
  it('renames every mention of one voice and no mention of another', () => {
    const md =
      '- [@Speaker B](speaker:B) asked.\n- [@Speaker A](speaker:A) answered.\n- [@Speaker B](speaker:B) agreed.';
    const out = renameSpeakerTags(md, 'B', { B: 'Devi' });
    expect(out.replaced).toBe(2);
    expect(out.markdown).toBe(
      '- [@Devi](speaker:B) asked.\n- [@Speaker A](speaker:A) answered.\n- [@Devi](speaker:B) agreed.',
    );
  });

  it('separates two voices a person has given the SAME name', () => {
    // The display-name rewrite this replaces could not do it: "Alex" in the
    // notes does not say which Alex, so renaming one would have moved the
    // other's words too. The label does say.
    const md = '- [@Alex](speaker:A) proposed it.\n- [@Alex](speaker:B) objected.';
    const out = renameSpeakerTags(md, 'A', { A: 'Alex Chen', B: 'Alex' });
    expect(out.replaced).toBe(1);
    expect(out.markdown).toBe(
      '- [@Alex Chen](speaker:A) proposed it.\n- [@Alex](speaker:B) objected.',
    );
  });

  it('does not touch prose that merely reads like the old name', () => {
    const md = '- Speaker B is who we mean by [@Speaker B](speaker:B).';
    expect(renameSpeakerTags(md, 'B', { B: 'Devi' }).markdown).toBe(
      '- Speaker B is who we mean by [@Devi](speaker:B).',
    );
  });

  it('is a no-op when the voice is already written that way', () => {
    const md = '- [@Devi](speaker:B) asked.';
    expect(renameSpeakerTags(md, 'B', { B: 'Devi' })).toEqual({ markdown: md, replaced: 0 });
  });
});
