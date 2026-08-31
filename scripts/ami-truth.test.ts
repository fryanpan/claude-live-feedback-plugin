import { describe, expect, it } from 'vitest';
import { amiUtterances, amiWindow, busiestWindow, parseAmiWords } from './ami-truth.ts';

/**
 * The AMI reference, parsed and grouped, checked on a fixture small enough to
 * read. The corpus itself is 40 MB a meeting and lives in a cache outside the
 * repo; what belongs here is the arithmetic that turns it into ground truth,
 * because that is what every AMI number depends on.
 *
 * The XML below is the real shape (NXT leaf elements with `starttime` /
 * `endtime`, punctuation as its own `<w punc="true">`, non-speech elements
 * mixed in), with invented words.
 */

const SPEAKER_A = `<?xml version="1.0" encoding="UTF-8"?>
<nite:root xmlns:nite="http://nite.sourceforge.net/" nite:id="TS3003a.A.words">
<w nite:id="TS3003a.A.words0" starttime="1.00" endtime="1.40">Okay</w>
<w nite:id="TS3003a.A.words1" starttime="1.40" endtime="1.60" punc="true">,</w>
<w nite:id="TS3003a.A.words2" starttime="1.60" endtime="2.10">shall</w>
<w nite:id="TS3003a.A.words3" starttime="2.10" endtime="2.50">we</w>
<vocalsound nite:id="TS3003a.A.vocalsounds0" starttime="2.50" endtime="2.80" type="laugh"/>
<w nite:id="TS3003a.A.words4" starttime="9.00" endtime="9.40">I&#39;m</w>
</nite:root>`;

const SPEAKER_B = `<nite:root nite:id="TS3003a.B.words">
<w nite:id="TS3003a.B.words0" starttime="4.00" endtime="4.50">Sure</w>
<w nite:id="TS3003a.B.words1" starttime="4.50" endtime="5.00">thing</w>
</nite:root>`;

describe('parseAmiWords', () => {
  it('takes the spoken words and their times', () => {
    const words = parseAmiWords(SPEAKER_A, 'A');
    expect(words.map((w) => w.text)).toEqual(['Okay', 'shall', 'we', "I'm"]);
    expect(words[0]).toEqual({ speaker: 'A', start: 1, end: 1.4, text: 'Okay' });
  });

  it('decodes the entities the corpus escapes, so an apostrophe is not a miss', () => {
    // ISO-8859-1 source: `I'm` ships as `I&#39;m`. Compared raw against the
    // engine's `I'm` it scores as a mishearing of one of the commonest words
    // in the language.
    expect(parseAmiWords(SPEAKER_A, 'A').at(-1)?.text).toBe("I'm");
  });

  it('drops punctuation and non-speech, which would otherwise become words', () => {
    // A comma as a "word" drags every similarity score down, and a laugh is
    // not something the engine will ever transcribe.
    const words = parseAmiWords(SPEAKER_A, 'A');
    expect(words.some((w) => w.text === ',')).toBe(false);
    expect(words.length).toBe(4);
  });
});

describe('amiUtterances', () => {
  const all = [...parseAmiWords(SPEAKER_A, 'A'), ...parseAmiWords(SPEAKER_B, 'B')];

  it('groups consecutive words of one speaker and splits on a real gap', () => {
    const said = amiUtterances(all);
    expect(said.map((u) => `${u.speaker}: ${u.text}`)).toEqual([
      'A: Okay shall we',
      'B: Sure thing',
      // 6.5s after "we" ended and a different speaker in between: a new
      // utterance, not a continuation.
      "A: I'm",
    ]);
  });

  it('orders by when speech started, so an interruption follows what it interrupts', () => {
    const said = amiUtterances(all);
    expect(said.map((u) => u.start)).toEqual([1, 4, 9]);
  });
});

describe('amiWindow', () => {
  const said = amiUtterances([...parseAmiWords(SPEAKER_A, 'A'), ...parseAmiWords(SPEAKER_B, 'B')]);

  it('keeps only utterances wholly inside the excerpt, rebased to its start', () => {
    // A half-spoken sentence at the edge would be scored against words the
    // engine never heard, which reads as mishearing rather than as cutting.
    const window = amiWindow(said, 3, 4);
    expect(window.map((u) => u.text)).toEqual(['Sure thing']);
    expect(window[0]?.start).toBe(1);
  });

  it('is empty rather than partial when nothing fits', () => {
    expect(amiWindow(said, 6, 1)).toEqual([]);
  });
});

describe('busiestWindow', () => {
  it('prefers the window with more distinct speakers over the wordier one', () => {
    // The opening minutes of a meeting are one person explaining the
    // recording equipment: plenty of words, nothing to tell apart.
    const said = [
      // STRICTLY WORDIER than the two-speaker window that follows, so the
      // speaker term is the only thing that can pick the later one. With the
      // words alone deciding, this window wins — which is what an earlier
      // version of this fixture failed to check.
      {
        speaker: 'A',
        start: 0,
        end: 7,
        text: 'one voice reading out the recording instructions at considerable and unhurried length',
      },
      { speaker: 'A', start: 20, end: 24, text: 'so that is the plan' },
      { speaker: 'B', start: 25, end: 28, text: 'sounds right to me' },
    ];
    expect(busiestWindow(said, 8, 10)).toBe(20);
  });

  it('says nothing when no whole window fits inside the recording', () => {
    // Zero would be a real answer to a different question: a caller that got
    // it would measure the opening seconds believing they had been chosen.
    expect(busiestWindow([{ speaker: 'A', start: 0, end: 4, text: 'hello there' }], 120)).toBe(
      undefined,
    );
  });
});

describe('parseAmiWords on the shapes the corpus actually contains', () => {
  it('does not let a self-closing <w/> swallow the next word', () => {
    // Matched loosely, `<w …/>` runs on to the NEXT `</w>` and steals its
    // text — so a real word arrives attributed to an empty element.
    const xml = `<nite:root>
<w nite:id="x.0" starttime="1.0" endtime="1.2"/>
<w nite:id="x.1" starttime="2.0" endtime="2.4">hello</w>
</nite:root>`;
    expect(parseAmiWords(xml, 'A').map((w) => w.text)).toEqual(['hello']);
  });
});
