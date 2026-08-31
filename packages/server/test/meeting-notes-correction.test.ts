/**
 * Correcting a note out loud: which note the words resolve to, what happens
 * when they resolve to nobody's or to two, and the line the correction may
 * never cross — a note a person wrote is proposed on, never overwritten.
 *
 * The integration half runs the REAL notes-doc path — `applyNotesUpdate` to
 * write notes and stock the ownership ledger, `applyNotesCorrection` to
 * correct them — rather than a stub that agrees with everything. A recorder
 * that says ok to every call cannot tell a correction that landed from one
 * that did nothing (the #512 lesson), and the whole feature is about which of
 * those happened.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type DocType, prose, suggestOps } from '@feedback/core';
import * as Y from 'yjs';
import {
  correctNotesSection,
  correctionPhraseUsable,
  correctionSpokenOnTick,
  phraseSites,
} from '../src/meeting-notes-correction.ts';
import {
  MEETING_NOTES_HEADING,
  applyNotesCorrection,
  applyNotesUpdate,
  createNotesLedger,
} from '../src/meeting-notes-doc.ts';
import {
  type NotesOwnership,
  createNotesOwnership,
  findNotesSection,
  itemsInSection,
} from '../src/meeting-notes-merge.ts';
import type { NotesCorrection } from '../src/meeting-notes.ts';

function docFrom(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), markdown);
  return ydoc;
}

function markdownOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/** The doc's words with no markup at all — what a reader actually sees, and
 *  the only view in which a pending suggestion's text is visible. */
function plainTextOf(ydoc: Y.Doc): string {
  return prose.locateMatches(prose.getProseFragment(ydoc), { find: '' }).plainText;
}

/** An ownership ledger that claims every item currently in the section — the
 *  state after a tick the agent wrote the whole of. */
function ownershipClaimingAll(ydoc: Y.Doc): NotesOwnership {
  const ownership = createNotesOwnership();
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, MEETING_NOTES_HEADING);
  if (span) {
    ownership.record(itemsInSection(fragment, span).map((i) => ({ el: i.el, md: i.md })));
  }
  return ownership;
}

describe('phraseSites', () => {
  it('finds whole tokens only, so a correction cannot reach inside a word', () => {
    // "ten" is in "attention" and in "often" — neither is the word anybody
    // corrected, and rewriting them would mangle a sentence.
    expect(phraseSites('we often pay attention to ten things', 'ten')).toEqual([26]);
  });

  it('matches case-insensitively, because speech and notes capitalise apart', () => {
    expect(phraseSites('Ship on Tuesday', 'tuesday')).toEqual([8]);
    expect(phraseSites('ship on tuesday', 'Tuesday')).toEqual([8]);
  });

  it('finds every occurrence, and none at all for a phrase that is absent', () => {
    expect(phraseSites('Tuesday, then Tuesday again', 'Tuesday')).toEqual([0, 14]);
    expect(phraseSites('Ship on Tuesday', 'Thursday')).toEqual([]);
  });

  it('treats an accented letter as part of a word, in any script', () => {
    // Found by codex review. The rename's ASCII boundary reads "n~" as a
    // boundary, so correcting "ana" would rewrite the tail of "manana"
    // written with the tilde. The positive control is the second assertion:
    // the same phrase standing on its own IS found.
    expect(phraseSites('lo hacemos ma\u00f1ana entonces', 'ana')).toEqual([]);
    expect(phraseSites('ana will run it ma\u00f1ana', 'ana')).toEqual([0]);
    // ...and with the same letter written decomposed (n + combining tilde).
    expect(phraseSites('lo hacemos man\u0303ana entonces', 'ana')).toEqual([]);
    // Cyrillic, where every letter is outside [A-Za-z0-9].
    expect(
      phraseSites('\u043f\u043e\u0440\u0430 \u0434\u043e\u043c\u043e\u0439', '\u043e\u0440\u0430'),
    ).toEqual([]);
  });

  it('handles a multi-word phrase with punctuation in it', () => {
    // A plain scan, not a RegExp: the dot would be a wildcard in a pattern.
    expect(phraseSites('due by v1.2 at the latest', 'v1.2')).toEqual([7]);
  });
});

describe('correctionSpokenOnTick', () => {
  const turns = [
    { text: 'Let us lock the review for Tuesday then.' },
    { text: 'No, I said Thursday.' },
  ];

  it('vouches for words the tick actually carried', () => {
    expect(correctionSpokenOnTick(turns, 'Thursday')).toBe(true);
  });

  it('refuses words nobody said — the invented-correction guard', () => {
    // The positive control is the assertion above: the same call on the same
    // turns says yes for a phrase that IS there, so a "no" here is the guard
    // working rather than the helper being unable to answer.
    expect(correctionSpokenOnTick(turns, 'Saturday')).toBe(false);
  });

  it('does not accept a phrase that only appears inside a longer word', () => {
    expect(correctionSpokenOnTick([{ text: 'the reviewer signed off' }], 'review')).toBe(false);
  });
});

describe('correctionPhraseUsable', () => {
  it('refuses a phrase too short to identify a note', () => {
    expect(correctionPhraseUsable('on')).toBe(false);
    expect(correctionPhraseUsable('  a ')).toBe(false);
    expect(correctionPhraseUsable('Tue')).toBe(true);
  });

  it('refuses a sentence — that is a rewrite, not a correction', () => {
    expect(correctionPhraseUsable('x'.repeat(61))).toBe(false);
  });
});

const NOTES = (body: string): string => `# Huddle\n\n## ${MEETING_NOTES_HEADING}\n\n${body}`;

describe('correctNotesSection', () => {
  const correct = (ydoc: Y.Doc, ownership: NotesOwnership, wrong: string, right: string) =>
    correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, { wrong, right });

  it('rewrites the agent note the words point at, and nothing else in it', () => {
    const ydoc = docFrom(NOTES('- Ship the gate on Tuesday, ahead of the review.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'revised', sites: 1 });
    expect(markdownOf(ydoc)).toContain('- Ship the gate on Thursday, ahead of the review.');
  });

  it('adds no second note — the whole point of the intent', () => {
    const ydoc = docFrom(NOTES('- Ship the gate on Tuesday.\n'));
    correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday');
    const md = markdownOf(ydoc);
    expect(md.split('- Ship the gate').length).toBe(2); // exactly one bullet
    expect(md).not.toContain('Tuesday');
  });

  it('matches the note case-insensitively and writes the words as spoken', () => {
    const ydoc = docFrom(NOTES('- Ship on tuesday.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    expect(markdownOf(ydoc)).toContain('- Ship on Thursday.');
  });

  it('two agent notes carrying the phrase is ambiguous, and nothing moves', () => {
    // Which one did they mean? Fixing the newest leaves a stale one behind
    // and the choice looks arbitrary; fixing both is a wider edit than two
    // spoken words asked for. So: neither.
    const ydoc = docFrom(NOTES('- Ship on Tuesday.\n- Design review Tuesday.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'ambiguous' });
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship on Tuesday.');
    expect(md).toContain('- Design review Tuesday.');
    expect(md).not.toContain('Thursday');
  });

  it('corrects every occurrence WITHIN the one note it resolved to', () => {
    // Two sites in one bullet are the same mistake said twice, not two notes.
    const ydoc = docFrom(NOTES('- Tuesday for the gate, and Tuesday for the review.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'revised', sites: 2 });
    expect(markdownOf(ydoc)).toContain('- Thursday for the gate, and Thursday for the review.');
  });

  it('a phrase in no note does nothing — the ordinary answer for a misheard ask', () => {
    const ydoc = docFrom(NOTES('- Ship the gate on Tuesday.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Wednesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'no-match' });
    expect(markdownOf(ydoc)).toContain('Tuesday');
  });

  it('a doc with no notes section says so rather than writing one', () => {
    const ydoc = docFrom('# Huddle\n\nSome agenda a person typed.\n');
    const res = correct(ydoc, createNotesOwnership(), 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'no-section' });
    expect(markdownOf(ydoc)).not.toContain('Thursday');
  });

  it('lands on the right characters after a letter that changes length when lowered', () => {
    // `\u0130`.toLowerCase() is TWO code units, so a lowercased copy of the
    // note is no longer index-aligned with the note itself. Matching on that
    // copy drifts every offset after it, and the drift is not a miss — it is
    // a delete one character to the right of the word.
    const ydoc = docFrom(NOTES('- \u0130stanbul ships on Tuesday.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    expect(markdownOf(ydoc)).toContain('\u0130stanbul ships on Thursday.');
  });

  it('never reaches prose outside the notes section', () => {
    const ydoc = docFrom(
      [
        '# Agenda',
        '',
        'We meet on Tuesday.',
        '',
        `## ${MEETING_NOTES_HEADING}`,
        '',
        '- Ship it.',
        '',
        '## Next steps',
        '',
        '- Tuesday again.',
        '',
      ].join('\n'),
    );
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday');
    expect(res).toEqual({ applied: 'none', reason: 'no-match' });
    const md = markdownOf(ydoc);
    expect(md).toContain('We meet on Tuesday.');
    expect(md).toContain('- Tuesday again.');
  });

  it('refuses a site inside a speaker tag — attribution does not move this way', () => {
    // Rewriting the tag's text while its href still names voice B would leave
    // the tag claiming B is called something B is not. Attribution moves by
    // the reassign gesture; never by a correction of the words around it.
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B) will run the gate.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Marisol', 'Priya');
    expect(res).toEqual({ applied: 'none', reason: 'attribution' });
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B)');
    expect(md).not.toContain('Priya');
  });

  it('still corrects the words BESIDE a tag, in the same note', () => {
    // The positive control for the test above: the tag is off limits, the
    // sentence around it is not.
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B) will ship it on Tuesday.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B)');
    expect(md).toContain('on Thursday.');
  });

  // A tag now carries the turns it was composed from — `speaker:B?t=10,12`,
  // and `&unsure=1` when the engine could not place them. That provenance is
  // what a late reattribution reads to decide which mentions move, so a
  // correction has to leave it exactly as it found it. The first of these is
  // the control: if the href with a query did not parse as a tag at all, the
  // refusal would not fire and the test would fail rather than pass emptily.
  it('refuses a site inside a tag that carries its turns', () => {
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B?t=10,12) will run the gate.\n'));
    const res = correct(ydoc, ownershipClaimingAll(ydoc), 'Marisol', 'Priya');
    expect(res).toEqual({ applied: 'none', reason: 'attribution' });
    expect(markdownOf(ydoc)).toContain('[@Marisol](speaker:B?t=10,12)');
  });

  it('leaves a turn-carrying href intact when it revises the words beside it', () => {
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B?t=10,12) will ship it on Tuesday.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    const md = markdownOf(ydoc);
    // Whole href, not a truncation of it: a mention that lost `?t=` still
    // reads as a tag and can never be moved again.
    expect(md).toContain('[@Marisol](speaker:B?t=10,12)');
    expect(md).toContain('on Thursday.');
    // And the words the correction wrote did not inherit the link.
    expect(md).not.toContain('[Thursday]');
  });

  it('writes the new words in the formatting the old ones wore', () => {
    // The other half of the mark question: a correction that landed inside
    // emphasis has to come out inside it, or the note loses the mark a
    // person put there. Replacing the whole emphasised word is the case
    // where a plain insert quietly drops it.
    const ydoc = docFrom(NOTES('- We ship on **Tuesday** for sure.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    expect(markdownOf(ydoc)).toContain('**Thursday**');
  });

  it('does not let the tag bleed onto a word written right after it', () => {
    // The adjacency that actually risks it: the corrected word begins where
    // the link ends, so an insert that inherited the left neighbour's marks
    // would swallow the new word into the tag — a mention naming a day.
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B?t=10,12) Tuesday is the day.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Marisol](speaker:B?t=10,12) Thursday is the day.');
    expect(md).not.toContain('Thursday](speaker:');
  });

  it('keeps an unsure tag unsure — a revision says nothing about who spoke', () => {
    const ydoc = docFrom(NOTES('- [@Marisol](speaker:B?t=10,12&unsure=1) ships on Tuesday.\n'));
    expect(correct(ydoc, ownershipClaimingAll(ydoc), 'Tuesday', 'Thursday').applied).toBe(
      'revised',
    );
    expect(markdownOf(ydoc)).toContain('[@Marisol](speaker:B?t=10,12&unsure=1)');
  });
});

describe('correctNotesSection — a person’s note', () => {
  it('proposes on it instead of overwriting it', () => {
    // AC2. The ledger claims nothing, so every item reads as a person's.
    const ydoc = docFrom(NOTES('- My own line: the gate ships Tuesday.\n'));
    const res = correctNotesSection(ydoc, MEETING_NOTES_HEADING, createNotesOwnership(), {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'suggested' });

    // The ACCEPTED text is untouched: their words still say what they wrote.
    expect(markdownOf(ydoc)).toContain('- My own line: the gate ships Tuesday.');
    // And the proposal is really there, as a redline they can answer.
    expect(plainTextOf(ydoc)).toContain('Thursday');
    const pending = suggestOps.scanSuggestions(prose.getProseFragment(ydoc));
    expect(pending.size).toBe(1);
  });

  it('proposes on a note the AGENT wrote and the person then edited', () => {
    // Ownership is element AND text: an item that no longer reads as the
    // agent left it is theirs from then on. So the correction proposes.
    const ydoc = docFrom(NOTES('- Ship the gate on Tuesday.\n'));
    const ownership = ownershipClaimingAll(ydoc);
    const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
      (el) => el.nodeName === 'bulletList',
    )!;
    const li = list.toArray()[0] as Y.XmlElement;
    const text = (li.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    ydoc.transact(() => {
      text.delete(0, text.length);
      prose.insertTextWithMarks(text, 0, 'MY wording: the gate ships Tuesday', {
        parseInlineMarks: true,
      });
    }, 'browser');

    const res = correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'suggested' });
    expect(markdownOf(ydoc)).toContain('MY wording: the gate ships Tuesday');
  });

  it('the agent’s own note wins when both carry the phrase, and theirs is untouched', () => {
    const ydoc = docFrom(NOTES('- Ship the gate on Tuesday.\n'));
    const ownership = ownershipClaimingAll(ydoc);
    // A person adds a line of their own that happens to say Tuesday too.
    const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
      (el) => el.nodeName === 'bulletList',
    )!;
    const li = new Y.XmlElement('listItem');
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    li.insert(0, [p]);
    p.insert(0, [t]);
    ydoc.transact(() => {
      list.insert(list.length, [li]);
      prose.insertTextWithMarks(t, 0, 'I am away Tuesday, for what it is worth', {});
    }, 'browser');

    const res = correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'revised', sites: 1 });
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship the gate on Thursday.');
    expect(md).toContain('- I am away Tuesday, for what it is worth');
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(0);
  });

  it('does not stack a second redline on a proposal they have not answered', () => {
    // One pending proposal per item at a time: somebody who has not answered
    // the first must not collect a fresh one every tick. A DIFFERENT phrase,
    // so the guard is doing the work rather than the boundary rule below.
    const ydoc = docFrom(NOTES('- My line: the gate ships Tuesday, owner Marcus.\n'));
    const ownership = createNotesOwnership();
    expect(
      correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, {
        wrong: 'Tuesday',
        right: 'Thursday',
      }).applied,
    ).toBe('suggested');
    const second = correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, {
      wrong: 'Marcus',
      right: 'Priya',
    });
    expect(second).toEqual({ applied: 'none', reason: 'unsuggestable' });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(1);
  });

  it('will not re-propose the same correction, because it reads as already made', () => {
    // A pending redline leaves the accepted word and the proposed one flush
    // against each other ("TuesdayThursday"), so the whole-token rule finds
    // no "Tuesday" to correct on the next tick. Belt to the guard's braces —
    // and the reason is the honest one: the note no longer spells the phrase.
    const ydoc = docFrom(NOTES('- My line: the gate ships Tuesday.\n'));
    const ownership = createNotesOwnership();
    const ask = { wrong: 'Tuesday', right: 'Thursday' };
    expect(correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, ask).applied).toBe(
      'suggested',
    );
    expect(correctNotesSection(ydoc, MEETING_NOTES_HEADING, ownership, ask)).toEqual({
      applied: 'none',
      reason: 'no-match',
    });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(1);
  });

  it('two of a person’s notes carrying the phrase is ambiguous too', () => {
    const ydoc = docFrom(NOTES('- My line about Tuesday.\n- My other line about Tuesday.\n'));
    const res = correctNotesSection(ydoc, MEETING_NOTES_HEADING, createNotesOwnership(), {
      wrong: 'Tuesday',
      right: 'Thursday',
    });
    expect(res).toEqual({ applied: 'none', reason: 'ambiguous' });
    expect(suggestOps.scanSuggestions(prose.getProseFragment(ydoc)).size).toBe(0);
  });
});

describe('applyNotesCorrection — through the real notes-doc path', () => {
  const roomsWith = (docId: string, type: DocType, markdown: string) => {
    const ydoc = docFrom(markdown);
    return {
      rooms: { get: (id: string) => (id === docId ? { ydoc, meta: { type } } : undefined) },
      ydoc,
    };
  };
  const ask = (docId: string, wrong: string, right: string): NotesCorrection => ({
    docId,
    meetingId: 'm-1',
    wrong,
    right,
  });

  it('corrects a note the notes pipeline itself wrote, and keeps owning it', () => {
    // The freeze test. The correction edits the agent's own bullet in place,
    // so the ledger has to learn its new wording — otherwise the note-taker
    // has silently handed that line to the person, and the NEXT tick can only
    // propose on it. That is what the second tick below proves.
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', '# Huddle\n');
    const ledger = createNotesLedger();
    let n = 0;
    const tick = (notes: string) =>
      applyNotesUpdate(
        rooms,
        {
          docId: 'doc-a',
          meetingId: 'm-1',
          tick: { tick: ++n, reason: 'pause', turns: [] },
          notes,
        },
        ledger,
      );

    tick(`## ${MEETING_NOTES_HEADING}\n\n- Ship the gate on Tuesday.\n`);
    expect(applyNotesCorrection(rooms, ask('doc-a', 'Tuesday', 'Thursday'), ledger)).toBe(
      'revised',
    );
    expect(markdownOf(ydoc)).toContain('- Ship the gate on Thursday.');

    // Still the agent's: the next compose REVISES the corrected line rather
    // than laying a second one beside it.
    tick(`## ${MEETING_NOTES_HEADING}\n\n- Ship the gate on Thursday, before the review.\n`);
    const md = markdownOf(ydoc);
    expect(md).toContain('- Ship the gate on Thursday, before the review.');
    expect(md).not.toContain('- Ship the gate on Thursday.\n');
    expect(md.split('Ship the gate').length).toBe(2);
  });

  it('a line the person made theirs is proposed on, not reclaimed by the correction', () => {
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', '# Huddle\n');
    const ledger = createNotesLedger();
    applyNotesUpdate(
      rooms,
      {
        docId: 'doc-a',
        meetingId: 'm-1',
        tick: { tick: 1, reason: 'pause', turns: [] },
        notes: `## ${MEETING_NOTES_HEADING}\n\n- Ship the gate on Tuesday.\n`,
      },
      ledger,
    );
    const list = (prose.getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
      (el) => el.nodeName === 'bulletList',
    )!;
    const li = list.toArray()[0] as Y.XmlElement;
    const text = (li.toArray()[0] as Y.XmlElement).toArray()[0] as Y.XmlText;
    ydoc.transact(() => {
      text.delete(0, text.length);
      prose.insertTextWithMarks(text, 0, 'MY wording: gate ships Tuesday', {});
    }, 'browser');

    expect(applyNotesCorrection(rooms, ask('doc-a', 'Tuesday', 'Thursday'), ledger)).toBe(
      'suggested',
    );
    expect(markdownOf(ydoc)).toContain('MY wording: gate ships Tuesday');
  });

  it('a gone doc and a flat doc are both none, never a throw', () => {
    const { rooms } = roomsWith('doc-a', 'markdown', NOTES('- Ship on Tuesday.\n'));
    expect(
      applyNotesCorrection(rooms, ask('doc-gone', 'Tuesday', 'Thursday'), createNotesLedger()),
    ).toBe('none');
    const flat = roomsWith('doc-b', 'diff', NOTES('- Ship on Tuesday.\n'));
    expect(
      applyNotesCorrection(flat.rooms, ask('doc-b', 'Tuesday', 'Thursday'), createNotesLedger()),
    ).toBe('none');
    expect(markdownOf(flat.ydoc)).toContain('Tuesday');
  });

  it('a restarted server claims nothing, so it proposes rather than rewriting', () => {
    // A fresh ledger reads every item in the section as somebody else's —
    // the safe direction, and the correction inherits it.
    const { rooms, ydoc } = roomsWith('doc-a', 'markdown', NOTES('- Ship on Tuesday.\n'));
    expect(
      applyNotesCorrection(rooms, ask('doc-a', 'Tuesday', 'Thursday'), createNotesLedger()),
    ).toBe('suggested');
    expect(markdownOf(ydoc)).toContain('- Ship on Tuesday.');
  });
});
