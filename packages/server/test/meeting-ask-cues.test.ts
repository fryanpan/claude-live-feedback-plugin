/**
 * The two spoken cues, and the guard that holds the capture pass to them.
 *
 * The convention (Bryan, 2026-09-02 huddle): "Claude, can you …" asks for
 * something NOW, "create a task …" asks for it LATER, and speech using
 * neither is a note. The tests below are in three parts, which is the shape
 * of the feature:
 *
 * 1. The pure detector — every phrase in both families, the wake word, the
 *    punctuation transcription actually produces, and the *neither* case with
 *    a positive control beside it, so a false "no cue" cannot pass for the
 *    rule working.
 * 2. The turn-level guard, whose one job beyond the detector is not to
 *    manufacture a cue across a line boundary.
 * 3. The downgrade: what `parseTaskCaptureReply` does with an ask the speaker
 *    never cued, and what it still lets through uncued — a reference and a
 *    correction are not asks.
 *
 * Every fixture is invented speech. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  LATER_CUE_EXAMPLES,
  NOW_CUES,
  askCueOfUtterance,
  askCuesIn,
  hasAskCue,
} from '../src/meeting-ask-cues.ts';
import { cueSpokenOnTick } from '../src/meeting-capture-guards.ts';
import type { NotesTurn } from '../src/meeting-notes.ts';
import {
  type TaskCaptureCandidate,
  buildTaskCapturePrompt,
  parseTaskCaptureReply,
} from '../src/meeting-task-capture.ts';

describe('askCueOfUtterance — the now cue', () => {
  it('reads each of the three phrasings', () => {
    expect(askCueOfUtterance('can you look at the retry loop')).toBe('now');
    expect(askCueOfUtterance('could you look at the retry loop')).toBe('now');
    expect(askCueOfUtterance('would you look at the retry loop')).toBe('now');
  });

  it('takes the wake word, with or without a greeting or a comma', () => {
    expect(askCueOfUtterance('Claude, can you look at the retry loop')).toBe('now');
    expect(askCueOfUtterance('claude can you look at the retry loop')).toBe('now');
    expect(askCueOfUtterance('Hey Claude, could you look at the retry loop')).toBe('now');
    expect(askCueOfUtterance('OK Claude — would you look at the retry loop?')).toBe('now');
  });

  it('is case-insensitive and survives the noises people open with', () => {
    expect(askCueOfUtterance('CAN YOU look at the retry loop?')).toBe('now');
    expect(askCueOfUtterance('So, yeah, ok, can you look at the retry loop?')).toBe('now');
  });

  it('wants "you" — an ask to the room is not an ask to the assistant', () => {
    expect(askCueOfUtterance('can we look into the retry loop')).toBeUndefined();
    expect(askCueOfUtterance('should somebody look into the retry loop')).toBeUndefined();
  });
});

describe('askCueOfUtterance — the later cue', () => {
  it('reads each of the four phrasings Bryan named', () => {
    expect(askCueOfUtterance('create a task for the popover bug')).toBe('later');
    expect(askCueOfUtterance('make a task for the popover bug')).toBe('later');
    expect(askCueOfUtterance('file a ticket for the popover bug')).toBe('later');
    expect(askCueOfUtterance('add a ticket for the popover bug')).toBe('later');
  });

  it('tolerates the determiners and plurals speech puts in the middle', () => {
    expect(askCueOfUtterance('make that a task')).toBe('later');
    expect(askCueOfUtterance('file tickets for the next two')).toBe('later');
    expect(askCueOfUtterance('add a todo for the export dialog')).toBe('later');
    expect(askCueOfUtterance('CREATE A TICKET for the export dialog')).toBe('later');
  });

  it('takes the framings a request gets wrapped in', () => {
    expect(askCueOfUtterance("let's make a task for the popover bug")).toBe('later');
    expect(askCueOfUtterance('we should file a ticket for the popover bug')).toBe('later');
    expect(askCueOfUtterance('please create a task for the popover bug')).toBe('later');
  });

  it('strips lead-ins from the FRONT only, so a denial is not an ask', () => {
    // The whole reason the lead-in list is a prefix rule rather than a
    // search: this sentence contains "we should file a ticket" and asks for
    // nothing at all.
    expect(askCueOfUtterance('I do not think we should file a ticket for that')).toBeUndefined();
  });
});

describe('askCueOfUtterance — later beats now', () => {
  it('reads an ask carrying both cues as an ask for later', () => {
    // The speaker named the artefact, so the artefact is what they asked
    // for: file the row, do not start the work.
    expect(askCueOfUtterance('Claude, can you create a task for the popover bug')).toBe('later');
    expect(askCueOfUtterance('could you please file a ticket for that one')).toBe('later');
  });
});

describe('askCuesIn — neither cue is the ordinary answer', () => {
  const plain = 'The comment popover still jumps when the doc scrolls underneath it';

  it('finds no cue in a plain statement', () => {
    expect(askCuesIn(plain)).toEqual({ now: false, later: false });
  });

  it('finds one in the same sentence once a cue is spoken — the control', () => {
    // Without this the test above would pass just as well on a detector that
    // never fires at all.
    expect(askCuesIn(`Claude, can you look at it. ${plain}`)).toEqual({ now: true, later: false });
    expect(askCuesIn(`${plain}. Create a task for it.`)).toEqual({ now: false, later: true });
  });

  it('finds no cue in speech that merely sounds like an ask', () => {
    expect(askCuesIn('go look into why the retry loop wakes it')).toEqual({
      now: false,
      later: false,
    });
    expect(askCuesIn('we already have a ticket for that one on the board')).toEqual({
      now: false,
      later: false,
    });
  });

  it('answers both when a passage carries both', () => {
    expect(askCuesIn('Can you check the retry path. And file a ticket for the docs.')).toEqual({
      now: true,
      later: true,
    });
  });
});

describe('askCuesIn — the punctuation transcription actually produces', () => {
  it('finds a cue that opens a clause rather than a sentence', () => {
    expect(hasAskCue('Yeah that is rough, can you look at the retry path?', 'now')).toBe(true);
  });

  it('reads through a speaker prefix and a curly apostrophe', () => {
    expect(hasAskCue('Priya: can you pull up last week’s notes', 'now')).toBe(true);
  });

  it('needs no trailing punctuation at all', () => {
    expect(hasAskCue('claude can you look at the retry loop', 'now')).toBe(true);
    expect(hasAskCue('file a ticket for that one', 'later')).toBe(true);
  });
});

describe('cueSpokenOnTick', () => {
  const cued: NotesTurn[] = [
    { turn: 1, speaker: 'Priya', text: 'The retry loop wakes the sync every ninety seconds.' },
    { turn: 2, speaker: 'Priya', text: 'Claude, can you look into why it does that?' },
  ];

  it('reads a cue off any line of the tick', () => {
    expect(cueSpokenOnTick(cued, 'now')).toBe(true);
    expect(cueSpokenOnTick(cued, 'later')).toBe(false);
  });

  it('does not manufacture a cue across a line boundary', () => {
    // One line ending in "can" and the next opening with "you" is two people
    // talking, not somebody using the convention.
    const split: NotesTurn[] = [
      { turn: 1, speaker: 'Priya', text: 'I am not sure the retry loop can' },
      { turn: 2, speaker: 'Marcus', text: 'you know, settle on its own.' },
    ];
    expect(cueSpokenOnTick(split, 'now')).toBe(false);
    expect(cueSpokenOnTick(split, 'later')).toBe(false);
  });

  it('answers false for an empty tick', () => {
    expect(cueSpokenOnTick([], 'now')).toBe(false);
    expect(cueSpokenOnTick([], 'later')).toBe(false);
  });
});

describe('the capture prompt states the convention it is guarded by', () => {
  it('names both cue families and says neither-cue speech is a note', () => {
    // Read off the same tables the guard matches on: a prompt that taught a
    // different convention from the one enforced would spend output tokens
    // on asks that can never land.
    const { system } = buildTaskCapturePrompt({ turns: [], candidates: [] });
    for (const phrase of NOW_CUES) expect(system).toContain(phrase);
    for (const phrase of LATER_CUE_EXAMPLES) expect(system).toContain(phrase);
    expect(system).toContain('NEITHER cue');
    expect(system).toContain('is LATER');
  });
});

describe('parseTaskCaptureReply downgrades an ask the speaker never cued', () => {
  const candidates: TaskCaptureCandidate[] = [
    { id: 't-retry', title: 'Retry loop wakes the sync too often', status: 'todo' },
  ];
  /** Real speech about real work, asking for nothing. */
  const uncued: NotesTurn[] = [
    { turn: 1, speaker: 'Priya', text: 'The retry loop wakes the sync every ninety seconds.' },
    { turn: 2, speaker: 'Priya', text: 'Go look into why it does that, it is the real cost.' },
  ];
  const nowCued: NotesTurn[] = [
    { turn: 1, speaker: 'Priya', text: 'The retry loop wakes the sync every ninety seconds.' },
    { turn: 2, speaker: 'Priya', text: 'Claude, can you look into why the retry loop does that?' },
  ];
  const laterCued: NotesTurn[] = [
    { turn: 1, speaker: 'Priya', text: 'The retry loop wakes the sync every ninety seconds.' },
    { turn: 2, speaker: 'Priya', text: 'Create a task for the retry loop, we will get to it.' },
  ];
  const reply = (items: unknown[]): string => JSON.stringify({ items });

  const request = { kind: 'request', title: 'Retry loop wakes the sync', actionable: true };
  const research = { kind: 'research', topic: 'retry loop' };
  const lookup = { kind: 'lookup', query: 'the retry loop notes' };
  const review = { kind: 'review', question: 'whether the retry loop still needs the sync' };

  it('drops a request when nobody asked for a task', () => {
    expect(parseTaskCaptureReply(reply([request]), candidates, uncued)).toEqual([]);
  });

  it('keeps the same request once the later cue is spoken — the control', () => {
    expect(parseTaskCaptureReply(reply([request]), candidates, laterCued)).toEqual([
      { kind: 'request', title: 'Retry loop wakes the sync', actionable: true },
    ]);
  });

  it('drops the three acting-now intents when nobody used the now cue', () => {
    expect(parseTaskCaptureReply(reply([research, lookup, review]), candidates, uncued)).toEqual(
      [],
    );
  });

  it('keeps all three once the now cue is spoken — the control', () => {
    const items = parseTaskCaptureReply(reply([research, lookup, review]), candidates, nowCued);
    expect(items.map((i) => i.kind)).toEqual(['research', 'lookup', 'review']);
  });

  it('does not let one cue license the other kind of ask', () => {
    // A now cue asks for something in the meeting; it never files a row.
    expect(parseTaskCaptureReply(reply([request]), candidates, nowCued)).toEqual([]);
    // And a later cue files a row; it never starts the work.
    expect(parseTaskCaptureReply(reply([research]), candidates, laterCued)).toEqual([]);
  });

  it('still reads a reference and a correction off uncued speech', () => {
    // Neither is an ask: one names work the board already tracks, the other
    // fixes a note already written, so neither has a now or a later.
    expect(
      parseTaskCaptureReply(reply([{ kind: 'reference', match: 0 }]), candidates, uncued),
    ).toEqual([{ kind: 'reference', taskId: 't-retry' }]);
    const correcting: NotesTurn[] = [
      { turn: 3, speaker: 'Priya', text: 'No — I said ninety seconds, not nineteen.' },
    ];
    expect(
      parseTaskCaptureReply(
        reply([{ kind: 'correction', wrong: 'nineteen seconds', right: 'ninety seconds' }]),
        candidates,
        correcting,
      ),
    ).toEqual([{ kind: 'correction', wrong: 'nineteen seconds', right: 'ninety seconds' }]);
  });

  it('takes a cue from the marked overlap, so an ask may straddle a tick', () => {
    // "Claude, can you" lands before the boundary and the subject after it —
    // the case `overlapWindow` exists for, and a guard reading only the
    // quoted line would throw away exactly these.
    const prior: NotesTurn[] = [{ turn: 1, speaker: 'Priya', text: 'Claude, can you go and' }];
    const after: NotesTurn[] = [
      { turn: 2, speaker: 'Priya', text: 'look into why the retry loop wakes the sync.' },
    ];
    expect(parseTaskCaptureReply(reply([research]), candidates, after, prior)).toEqual([
      { kind: 'research', topic: 'retry loop' },
    ]);
    // Without the earlier line the same reply has no cue behind it.
    expect(parseTaskCaptureReply(reply([research]), candidates, after)).toEqual([]);
  });
});
