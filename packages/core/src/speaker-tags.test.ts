import { describe, expect, it } from 'vitest';
import {
  MAX_SPEAKER_TAG_TURNS,
  type SpeakerRevisions,
  findSpeakerTags,
  normalizeSpeakerTags,
  parseSpeakerTagHref,
  reattributeSpeakerTags,
  renameSpeakerTags,
  renderSpeakerTag,
  speakerLabelsIn,
  speakerTagHref,
  speakerTagLabel,
} from './speaker-tags.ts';

/** A revision reads better as a literal than as a Map constructor. */
function revisions(entries: Record<number, string | null>): SpeakerRevisions {
  return new Map(Object.entries(entries).map(([turn, label]) => [Number(turn), label]));
}

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
    expect(findSpeakerTags(md)).toEqual([
      {
        start: 2,
        end: 20,
        label: 'B',
        turns: [],
        unsure: false,
        text: '@Devi',
        raw: '[@Devi](speaker:B)',
      },
    ]);
  });

  it('reports every voice a note attributes anything to, once each', () => {
    const md = '[@Devi](speaker:B) disagreed with [@Sam](speaker:A); [@Devi](speaker:B) won.';
    expect(speakerLabelsIn(md)).toEqual(['B', 'A']);
  });

  it('does not read a bracketed phrase inside link text as a tag', () => {
    expect(findSpeakerTags('[see [1] below](speaker:B)')).toEqual([]);
  });
});

describe('a name with markdown in it', () => {
  // Names come from a free-text prompt, so "Sam [PM]" is reachable. Written
  // raw it produces `[@Sam [PM]](speaker:B)`, which the finder cannot see —
  // and an unfindable tag is one normalization skips and every later rename
  // silently fails to update. The doc serializer escapes brackets the same
  // way, so this is the house convention rather than a new one.
  const named = { B: 'Sam [PM]' };

  it('drops the brackets so the tag stays a tag', () => {
    const md = renderSpeakerTag('B', named);
    expect(md).toBe('[@Sam PM](speaker:B)');
    expect(findSpeakerTags(md)).toHaveLength(1);
    expect(speakerLabelsIn(md)).toEqual(['B']);
  });

  it('still finds a tag an older build wrote with escapes in it', () => {
    // Nothing writes this shape any more, but a doc on disk may carry one,
    // and an unfindable tag is one no rename can ever reach again.
    const found = findSpeakerTags('- [@Sam \\[PM\\]](speaker:B) asked.');
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('@Sam [PM]');
    expect(renameSpeakerTags('- [@Sam \\[PM\\]](speaker:B) asked.', 'B', named).replaced).toBe(1);
  });

  it('renames such a voice, where a raw-bracket tag renamed nothing at all', () => {
    const line = `- ${renderSpeakerTag('B', named)} asked.`;
    const out = renameSpeakerTags(line, 'B', { B: 'Sam Patel' });
    expect(out.replaced).toBe(1);
    expect(out.markdown).toBe('- [@Sam Patel](speaker:B) asked.');
  });

  it('leaves an already-canonical escaped tag exactly alone', () => {
    const md = renderSpeakerTag('B', named);
    const out = normalizeSpeakerTags(md, { names: named, known: new Set(['B']) });
    expect(out.markdown).toBe(md);
    expect(out.renamed).toBe(0);
  });

  it('keeps the words when the voice turns out to be unknown', () => {
    const md = renderSpeakerTag('C', { C: 'Sam [PM]' });
    const out = normalizeSpeakerTags(md, { names: {}, known: new Set(['B']) });
    expect(out.markdown).toBe('Sam PM');
    expect(out.unknown).toEqual(['C']);
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

describe('provenance in the href', () => {
  it('carries the turns a mention was composed from, ascending and deduped', () => {
    expect(speakerTagHref('B', { turns: [12, 10, 10] })).toBe('speaker:B?t=10,12');
    expect(renderSpeakerTag('B', { B: 'Devi' }, { turns: [10] })).toBe('[@Devi](speaker:B?t=10)');
  });

  it('round-trips through the parser', () => {
    expect(parseSpeakerTagHref('speaker:B?t=10,12')).toEqual({
      label: 'B',
      turns: [10, 12],
      unsure: false,
    });
    expect(parseSpeakerTagHref('speaker:B?t=10,12&unsure=1')).toEqual({
      label: 'B',
      turns: [10, 12],
      unsure: true,
    });
  });

  it('still answers the only question most callers ask', () => {
    // The editor, the reassign menu and the doc rewrite all want the voice.
    // A tag an older build wrote has no parameters and must parse the same.
    expect(speakerTagLabel('speaker:B?t=10,12')).toBe('B');
    expect(speakerTagLabel('speaker:B')).toBe('B');
    expect(speakerTagLabel('/w/w-1/t/t-1')).toBeNull();
  });

  it('keeps the voice and drops the provenance when a parameter is unreadable', () => {
    // The safe direction: a mention whose provenance cannot be read is one
    // no revision can place, never one attributed to nobody.
    const ref = parseSpeakerTagHref('speaker:B?t=10,oops');
    expect(ref?.label).toBe('B');
    expect(ref?.turns).toEqual([]);
  });

  it('refuses to be unsure about nothing', () => {
    // The flag says the turns behind a mention disagree; with no turns
    // stamped there is nothing for it to mean.
    expect(speakerTagHref('B', { unsure: true })).toBe('speaker:B');
    expect(parseSpeakerTagHref('speaker:B?unsure=1')?.unsure).toBe(false);
  });

  it('stamps nothing past the cap, rather than a list nobody can act on', () => {
    const many = Array.from({ length: MAX_SPEAKER_TAG_TURNS + 1 }, (_, i) => i);
    expect(speakerTagHref('B', { turns: many })).toBe('speaker:B');
  });
});

describe('normalizeSpeakerTags — stamping this tick', () => {
  const known = new Set(['A', 'B']);

  it('stamps a tag the composer has just written with the tick that wrote it', () => {
    const out = normalizeSpeakerTags('- [@Devi](speaker:B) wants the gate moved.', {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=10,12) wants the gate moved.');
    expect(out.stamped).toBe(1);
    expect(out.renamed).toBe(0);
  });

  it('leaves provenance an earlier tick stamped exactly where it was', () => {
    // The composer returns the WHOLE notes every tick, so an old mention
    // comes back through this pass on every one. Restamping it would move
    // its provenance forward to words it was never written from.
    const md = '- [@Devi](speaker:B?t=3) wants the gate moved.';
    const out = normalizeSpeakerTags(md, {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10, 12] },
    });
    expect(out.markdown).toBe(md);
    expect(out.stamped).toBe(0);
  });

  it('renames and keeps the provenance in one pass', () => {
    const out = normalizeSpeakerTags('- [@devi r](speaker:B?t=3) said it.', {
      names: { B: 'Devi' },
      known,
      turnsByLabel: { B: [10] },
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=3) said it.');
    expect(out.renamed).toBe(1);
  });

  it('unwraps an invented voice whatever it claims to have been composed from', () => {
    const out = normalizeSpeakerTags('- [@Priya](speaker:C?t=10) volunteered.', {
      names: {},
      known,
    });
    expect(out.markdown).toBe('- Priya volunteered.');
    expect(out.unknown).toEqual(['C']);
  });
});

describe('reattributeSpeakerTags — the engine changes its mind late', () => {
  const names = { B: 'Devi', C: 'Rowan' };

  it('moves a mention whose every turn moved the same way', () => {
    const md = '- [@Devi](speaker:B?t=10,12) wants the gate moved.';
    const out = reattributeSpeakerTags(md, {
      revisions: revisions({ 10: 'C', 12: 'C' }),
      names,
    });
    expect(out.markdown).toBe('- [@Rowan](speaker:C?t=10,12) wants the gate moved.');
    expect(out.moved).toBe(1);
    expect(out.unsure).toBe(0);
  });

  it('takes the claim off when the words are now attributed to nobody', () => {
    const out = reattributeSpeakerTags('- [@Devi](speaker:B?t=10) asked about staging.', {
      revisions: revisions({ 10: null }),
      names,
    });
    expect(out.markdown).toBe('- Devi asked about staging.');
    expect(out.unwrapped).toBe(1);
  });

  it('marks a mention it cannot place instead of guessing', () => {
    // Turn 10 is still B and turn 12 is now C, so this mention belongs to
    // one of them and the notes do not record which.
    const out = reattributeSpeakerTags('- [@Devi](speaker:B?t=10,12) wants the gate moved.', {
      revisions: revisions({ 12: 'C' }),
      names,
    });
    expect(out.markdown).toBe('- [@Devi](speaker:B?t=10,12&unsure=1) wants the gate moved.');
    expect(out.unsure).toBe(1);
    expect(out.moved).toBe(0);
  });

  it('says nothing more about a mention already marked unsure', () => {
    const md = '- [@Devi](speaker:B?t=10,12&unsure=1) wants the gate moved.';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 12: 'C' }), names });
    expect(out.markdown).toBe(md);
    expect(out.unsure).toBe(0);
  });

  it('leaves a mention no turn of which was revised', () => {
    const md = '- [@Devi](speaker:B?t=10) wants the gate moved.';
    expect(reattributeSpeakerTags(md, { revisions: revisions({ 44: 'C' }), names }).markdown).toBe(
      md,
    );
  });

  it("leaves a person's own reassignment alone — it carries no provenance", () => {
    // `applyReassign` writes a bare `speaker:C`. A human answer is not a
    // guess the engine gets to revisit.
    const md = '- [@Rowan](speaker:C) wants the gate moved.';
    expect(
      reattributeSpeakerTags(md, { revisions: revisions({ 10: 'B', 12: 'B' }), names }).markdown,
    ).toBe(md);
  });

  it('leaves every other voice in the same line alone', () => {
    const md = '- [@Devi](speaker:B?t=10) agreed with [@Rowan](speaker:C?t=11).';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 10: 'C' }), names });
    expect(out.markdown).toBe('- [@Rowan](speaker:C?t=10) agreed with [@Rowan](speaker:C?t=11).');
    expect(out.moved).toBe(1);
  });

  it('keeps two voices with the same name apart, because identity is the label', () => {
    // Both Alexes answer to "Alex". Only the mention whose turn moved is
    // touched, and it takes the OTHER label rather than the other spelling.
    const both = { A: 'Alex', B: 'Alex' };
    const md = '- [@Alex](speaker:A?t=10) proposed it.\n- [@Alex](speaker:B?t=11) objected.';
    const out = reattributeSpeakerTags(md, { revisions: revisions({ 10: 'B' }), names: both });
    expect(out.markdown).toBe(
      '- [@Alex](speaker:B?t=10) proposed it.\n- [@Alex](speaker:B?t=11) objected.',
    );
    expect(out.moved).toBe(1);
    // And the two are still separable afterwards: renaming B alone finds
    // both mentions of B and leaves A's untouched.
    const renamed = renameSpeakerTags(out.markdown, 'B', { A: 'Alex', B: 'Alex Yun' });
    expect(renamed.replaced).toBe(2);
    expect(renamed.markdown).toBe(
      '- [@Alex Yun](speaker:B?t=10) proposed it.\n- [@Alex Yun](speaker:B?t=11) objected.',
    );
  });

  it('a rename carries provenance and the unsure flag through untouched', () => {
    const md = '- [@Speaker B](speaker:B?t=10,12&unsure=1) asked.';
    expect(renameSpeakerTags(md, 'B', { B: 'Devi' }).markdown).toBe(
      '- [@Devi](speaker:B?t=10,12&unsure=1) asked.',
    );
  });
});
