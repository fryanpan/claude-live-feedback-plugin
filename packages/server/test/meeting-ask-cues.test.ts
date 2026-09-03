/**
 * The two spoken cues, and the guard that holds the capture pass to them.
 *
 * The convention (Bryan, 2026-09-02 huddle): "Claude, can you …" asks for
 * something NOW, "create a task …" asks for it LATER, and speech using
 * neither is a note. Three parts, which is the shape of the feature:
 *
 * 1. The detector. Every phrase in both families and every wake-word
 *    variant, and — carrying most of the assertions — the ordinary meeting
 *    talk that must NOT read as an ask. Each of those negatives is paired
 *    with a positive control one word away from it, so a detector that had
 *    simply stopped firing could not pass this file.
 * 2. `cueLineFor`: WHICH line licensed an ask, and the spending that keeps
 *    one cue to one ask within a tick and across the boundary into the next.
 * 3. The downgrade: what `parseTaskCaptureReply` does with an ask no line
 *    cued, and what it still lets through uncued — a reference and a
 *    correction are not asks.
 *
 * Every fixture is invented speech. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  LATER_CUE_EXAMPLES,
  NOW_CUE_EXAMPLES,
  askCueOf,
  askCuesIn,
  hasAskCue,
  laterCueIsPlural,
} from '../src/meeting-ask-cues.ts';
import { cueLineFor, spokenLineFor } from '../src/meeting-capture-guards.ts';
import type { NotesTurn } from '../src/meeting-notes.ts';
import {
  type TaskCaptureCandidate,
  buildTaskCapturePrompt,
  parseTaskCaptureReply,
} from '../src/meeting-task-capture.ts';

const none = { now: false, later: false };

describe('the now cue is "Claude, can you" — the wake word is part of it', () => {
  /**
   * Every one of these was read as an ask to the assistant by the first
   * version of the matcher, which took any clause opening with can/could/
   * would you. They are ordinary meeting talk, and each is paired with the
   * same sentence a wake word away.
   */
  const pairs: Array<[string, string]> = [
    ['Bob, can you pass me the water', 'Claude, can you pass me the water'],
    [
      'Can you believe they shipped that on a Friday',
      'Claude, can you check what shipped on Friday',
    ],
    [
      'Would you rather ship late or ship broken',
      'Claude, would you check whether we shipped late',
    ],
    ['Sorry, could you repeat that', 'Sorry — Claude, could you repeat that'],
    [
      'He asked, can you fix it by Friday, and I said no',
      'Claude, can you find out if it is fixed by Friday',
    ],
    ['Can you imagine the latency on that', 'Claude, can you measure the latency on that'],
    ['so um can you look at the retry loop', 'so um Claude can you look at the retry loop'],
    ['Bryan: can you look at the retry loop', 'Bryan: Claude, can you look at the retry loop'],
  ];

  for (const [talk, ask] of pairs) {
    it(`is talk, not an ask: "${talk}"`, () => {
      expect(askCuesIn(talk)).toEqual(none);
      // The control: the same sentence with the wake word IS an ask, so the
      // line above is a rejection rather than a detector that never fires.
      expect(askCuesIn(ask)).toEqual({ now: true, later: false });
    });
  }

  it('takes the wake word however the transcriber heard it', () => {
    for (const wake of ['claude', 'claud', 'clod', 'cloud']) {
      expect(hasAskCue(`${wake} can you look at the retry loop`, 'now')).toBe(true);
    }
  });

  it('takes the punctuation and greetings around the wake word', () => {
    for (const line of [
      'Claude, can you look at the retry loop',
      'Claude. Can you look at the retry loop',
      'Claude can you look at the retry loop',
      'Hey Claude, could you look at the retry loop',
      'OK Claude — would you look at the retry loop?',
      'Priya: claude, can you pull up the design doc',
    ]) {
      expect(hasAskCue(line, 'now')).toBe(true);
    }
  });

  it('wants the wake word immediately before the modal', () => {
    // The wake word somewhere in the sentence is not the convention; a name
    // said in passing must not license the rest of the paragraph.
    expect(askCuesIn('I told Claude about it yesterday, and can you believe it worked')).toEqual(
      none,
    );
  });

  it('reads each of the three modals', () => {
    for (const modal of NOW_CUE_EXAMPLES) {
      expect(hasAskCue(`Claude, ${modal} look at the retry loop`, 'now')).toBe(true);
    }
  });
});

describe('the later cue is an imperative clause opening', () => {
  it('reads each of the four phrasings Bryan named', () => {
    for (const phrase of LATER_CUE_EXAMPLES) {
      expect(askCueOf(`${phrase} for the popover bug`)).toBe('later');
    }
  });

  it('tolerates the determiners, plurals and dropped articles of speech', () => {
    for (const line of [
      'make that a task',
      'file tickets for the next two',
      'add a todo for the export dialog',
      'create task for the retry loop',
      'CREATE A TICKET for the export dialog',
      'can you make tickets for those two',
      'lets create a ticket for the retry loop',
    ]) {
      expect(askCueOf(line)).toBe('later');
    }
  });

  it('takes a wrapping of obligation but not one of capability', () => {
    expect(askCueOf('we should file a ticket for the popover bug')).toBe('later');
    expect(askCueOf('we need to create a task for the popover bug')).toBe('later');
    // "we can add tasks to the sprint later" is a fact about the sprint.
    expect(askCuesIn('we can add tasks to the sprint later')).toEqual(none);
    expect(askCuesIn('we could file tickets for these if we wanted')).toEqual(none);
  });

  it('wants the verb to OPEN the clause', () => {
    for (const [talk, ask] of [
      ['I do not think we should file a ticket for that', 'we should file a ticket for that'],
      ['Nobody filed a ticket for it last week', 'file a ticket for it this week'],
      ['I will make a to-do for that after this', 'make a to-do for that after this'],
    ] as Array<[string, string]>) {
      expect(askCuesIn(talk)).toEqual(none);
      expect(askCueOf(ask)).toBe('later');
    }
  });

  it('wants the noun to END the object, not modify a longer one', () => {
    // "a ticket TYPE" and "a to-do LIST" are things, not asks for things.
    expect(askCuesIn('we should add a ticket type for design work')).toEqual(none);
    expect(askCuesIn('I will make a to-do list after this')).toEqual(none);
    // The control, one word shorter.
    expect(askCueOf('we should add a ticket for design work')).toBe('later');
  });
});

describe('later beats now', () => {
  it('reads an ask carrying both cues as an ask for later, and only later', () => {
    // The speaker named the artefact, so the artefact is what they asked
    // for: file the row, do not start the work — and do not do both.
    expect(askCuesIn('Claude, can you create a task for the popover bug')).toEqual({
      now: false,
      later: true,
    });
    expect(askCuesIn('Claude, could you please file a ticket for that one')).toEqual({
      now: false,
      later: true,
    });
  });
});

describe('neither cue is the ordinary answer', () => {
  const plain = 'The comment popover still jumps when the doc scrolls underneath it';

  it('finds no cue in plain meeting talk', () => {
    expect(askCuesIn(plain)).toEqual(none);
    expect(askCuesIn('go look into why the retry loop wakes it')).toEqual(none);
    expect(askCuesIn('we already have a ticket for that one on the board')).toEqual(none);
    expect(askCuesIn('')).toEqual(none);
  });

  it('finds one in the same passage once a cue is spoken — the control', () => {
    expect(askCuesIn(`Claude, can you look at it. ${plain}`)).toEqual({ now: true, later: false });
    expect(askCuesIn(`${plain}. Create a task for it.`)).toEqual({ now: false, later: true });
  });

  it('answers both when a passage carries one of each', () => {
    expect(
      askCuesIn('Claude, can you check the retry path. And file a ticket for the docs.'),
    ).toEqual({ now: true, later: true });
  });

  it('finds a cue that opens a clause rather than a sentence', () => {
    expect(hasAskCue('Yeah that is rough — Claude, can you look at the retry path?', 'now')).toBe(
      true,
    );
    expect(hasAskCue('that is rough, file a ticket for it', 'later')).toBe(true);
  });

  it('reads through a curly apostrophe and no trailing punctuation', () => {
    expect(hasAskCue('Claude, can you pull up last week’s notes', 'now')).toBe(true);
    expect(hasAskCue('file a ticket for that one', 'later')).toBe(true);
  });
});

describe('cueLineFor — one cue, one ask', () => {
  const turns: NotesTurn[] = [
    { turn: 1, speaker: 'Bryan', text: 'Create a task for the retry loop' },
    { turn: 2, speaker: 'Alice', text: 'The tunnel keeps dropping on mobile' },
    { turn: 3, speaker: 'Bob', text: 'And the sidebar overlaps the composer on iPad' },
  ];

  it('names the line that carried the cue', () => {
    expect(cueLineFor(turns, 'Fix the retry loop', 'later')?.turn).toBe(1);
  });

  it('finds nothing for the cue the speech did not use', () => {
    expect(cueLineFor(turns, 'Fix the retry loop', 'now')).toBeUndefined();
  });

  it('will not name a line already spent', () => {
    const spent = new Set<number>([1]);
    expect(cueLineFor(turns, 'Fix the retry loop', 'later', spent)).toBeUndefined();
    // The control: unspent, the same call names it.
    expect(cueLineFor(turns, 'Fix the retry loop', 'later', new Set<number>())?.turn).toBe(1);
  });

  it('names a cue line that shares no words with the ask', () => {
    // "Claude, can you go and" / boundary / "look into why the retry loop
    // wakes the sync" is the straddling ask the overlap window exists for,
    // and its cue line names no subject at all.
    const straddle: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'Claude, can you go and' },
      { turn: 2, speaker: 'Bryan', text: 'look into why the retry loop wakes the sync' },
    ];
    expect(cueLineFor(straddle, 'why the retry loop wakes the sync', 'now')?.turn).toBe(1);
  });

  it('prefers the cue line sharing most with the ask when there are several', () => {
    const two: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'Create a task for the tunnel drops' },
      { turn: 2, speaker: 'Bryan', text: 'And create a task for the retry loop' },
    ];
    expect(cueLineFor(two, 'Retry loop wakes the sync', 'later')?.turn).toBe(2);
  });
});

describe('spokenLineFor quotes the line the ask was made in', () => {
  it('quotes the cue line rather than whatever shared a word', () => {
    // The subject was said before the tick boundary, so no NEW line shares
    // any words with the request — the old pick landed on "Alice: sure".
    const window: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'Create a task for the retry loop' },
      { turn: 2, speaker: 'Bryan', text: 'the one where it wakes the sync' },
      { turn: 3, speaker: 'Alice', text: 'sure' },
    ];
    expect(spokenLineFor(window, 'Create a task for the retry loop', 'later')).toBe(
      'Bryan: Create a task for the retry loop',
    );
  });

  it('does not follow a louder line from another speaker', () => {
    const window: NotesTurn[] = [
      { turn: 1, speaker: 'Alice', text: 'the retry loop is completely broken and I hate it' },
      { turn: 2, speaker: 'Bryan', text: 'create a task for that' },
    ];
    expect(spokenLineFor(window, 'retry loop broken', 'later')).toBe(
      'Bryan: create a task for that',
    );
  });

  it('falls back to word overlap when no line carried the cue', () => {
    const window: NotesTurn[] = [
      { turn: 1, speaker: 'Alice', text: 'the retry loop wakes the sync' },
      { turn: 2, speaker: 'Bob', text: 'sure' },
    ];
    expect(spokenLineFor(window, 'retry loop', 'later')).toBe(
      'Alice: the retry loop wakes the sync',
    );
  });
});

describe('the capture prompt states the convention it is guarded by', () => {
  it('names both cue families, the wake word, and the neither case', () => {
    // Read off the same tables the guard matches on: a prompt that taught a
    // different convention from the one enforced would spend output tokens
    // on asks that can never land.
    const { system } = buildTaskCapturePrompt({ turns: [], candidates: [] });
    // Read with the line wrapping collapsed: the prompt is built from
    // hand-wrapped lines, and a phrase that happens to straddle two of them
    // is still in the prompt the model reads.
    const said = system.replace(/\s+/g, ' ');
    for (const phrase of NOW_CUE_EXAMPLES) expect(said).toContain(phrase);
    for (const phrase of LATER_CUE_EXAMPLES) expect(said).toContain(phrase);
    expect(said).toContain('the speaker says "Claude"');
    expect(said).toContain('A bare "can you" to another person in the room is NOT it');
    expect(said).toContain('Speech with NEITHER cue asks for nothing');
    expect(said).toContain('carrying both ("Claude, can you create a task") is LATER');
    expect(said).toContain('Never return two asks for one cued line');
  });
});

describe('parseTaskCaptureReply licenses each ask on its own cue line', () => {
  const candidates: TaskCaptureCandidate[] = [
    { id: 't-retry', title: 'Retry loop wakes the sync too often', status: 'todo' },
  ];
  const reply = (items: unknown[]): string => JSON.stringify({ items });
  const request = { kind: 'request', title: 'Retry loop wakes the sync', actionable: true };
  const research = { kind: 'research', topic: 'retry loop' };
  const lookup = { kind: 'lookup', query: 'the retry loop notes' };
  const review = { kind: 'review', question: 'whether the retry loop still needs the sync' };

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

  it('drops a request when no line asked for a task', () => {
    expect(parseTaskCaptureReply(reply([request]), candidates, uncued)).toEqual([]);
  });

  it('keeps the same request once a line says the later cue — the control', () => {
    expect(parseTaskCaptureReply(reply([request]), candidates, laterCued)).toEqual([
      { kind: 'request', title: 'Retry loop wakes the sync', actionable: true },
    ]);
  });

  it('drops the three acting-now intents when no line said the now cue', () => {
    expect(parseTaskCaptureReply(reply([research, lookup, review]), candidates, uncued)).toEqual(
      [],
    );
  });

  it('does not let one cue license the other kind of ask', () => {
    expect(parseTaskCaptureReply(reply([request]), candidates, nowCued)).toEqual([]);
    expect(parseTaskCaptureReply(reply([research]), candidates, laterCued)).toEqual([]);
  });

  it('spends one cue on ONE ask, whatever else the room went on to say', () => {
    // The bug this replaced: one "create a task for the retry loop" filed a
    // row for the tunnel and a row for the sidebar as well.
    const turns: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'Create a task for the retry loop' },
      { turn: 2, speaker: 'Alice', text: 'The tunnel keeps dropping on mobile' },
      { turn: 3, speaker: 'Bob', text: 'And the sidebar overlaps the composer on iPad' },
    ];
    const items = parseTaskCaptureReply(
      reply([
        { kind: 'request', title: 'Fix the retry loop', actionable: true },
        { kind: 'request', title: 'Tunnel drops on mobile', actionable: true },
        { kind: 'request', title: 'Sidebar overlaps composer on iPad', actionable: true },
      ]),
      candidates,
      turns,
    );
    expect(items).toEqual([{ kind: 'request', title: 'Fix the retry loop', actionable: true }]);
  });

  it('lets a PLURAL ask stand for the rows that follow it', () => {
    // "file tickets for the next few things I mention" is one sentence
    // asking for however many rows come next, measured doing exactly that
    // across a tick boundary. It is the one cue that is not spent on its
    // first ask.
    expect(laterCueIsPlural('We should file tickets for the next few things I mention.')).toBe(
      true,
    );
    expect(laterCueIsPlural('Create a task for the retry loop')).toBe(false);
    const trigger: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'File tickets for the next few things I mention.' },
    ];
    const subjects: NotesTurn[] = [
      { turn: 2, speaker: 'Bryan', text: 'The lantern badge counts stale invites.' },
      { turn: 3, speaker: 'Bryan', text: 'And the export dialog forgets the chosen range.' },
    ];
    const items = parseTaskCaptureReply(
      reply([
        { kind: 'request', title: 'Lantern badge counts stale invites', actionable: true },
        { kind: 'request', title: 'Export dialog forgets the chosen range', actionable: true },
      ]),
      candidates,
      subjects,
      trigger,
    );
    expect(items).toHaveLength(2);
  });

  it('gives each ask its own cue line when the room asked twice', () => {
    const turns: NotesTurn[] = [
      { turn: 1, speaker: 'Bryan', text: 'Create a task for the retry loop' },
      { turn: 2, speaker: 'Bryan', text: 'And file a ticket for the tunnel drops on mobile' },
    ];
    const items = parseTaskCaptureReply(
      reply([
        { kind: 'request', title: 'Fix the retry loop', actionable: true },
        { kind: 'request', title: 'Tunnel drops on mobile', actionable: true },
      ]),
      candidates,
      turns,
    );
    expect(items).toHaveLength(2);
  });

  it('does not let a neighbour’s social "can you" license an ask', () => {
    const turns: NotesTurn[] = [
      { turn: 1, speaker: 'Alice', text: 'Bob, can you pass me the water' },
      {
        turn: 2,
        speaker: 'Bob',
        text: 'The retry loop wakes the sync every ninety seconds and nobody knows why',
      },
    ];
    const items = parseTaskCaptureReply(
      reply([{ kind: 'research', topic: 'why the retry loop wakes the sync' }]),
      candidates,
      turns,
    );
    expect(items).toEqual([]);
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
});

describe('a cue line is spent for the meeting, not for the tick', () => {
  const candidates: TaskCaptureCandidate[] = [];
  const reply = (items: unknown[]): string => JSON.stringify({ items });
  const askedFor = { kind: 'lookup', query: 'the design doc' };
  const newSubject = { kind: 'research', topic: 'why the retry loop wakes the sync' };

  const cueTick: NotesTurn[] = [
    { turn: 1, speaker: 'Bryan', text: 'Claude, can you pull up the design doc' },
  ];
  const nextTick: NotesTurn[] = [
    { turn: 2, speaker: 'Bryan', text: 'The retry loop wakes the sync every ninety seconds' },
  ];

  it('will not act twice on the cue the marked overlap shows again', () => {
    const spent = new Set<number>();
    expect(parseTaskCaptureReply(reply([askedFor]), candidates, cueTick, undefined, spent)).toEqual(
      [{ kind: 'lookup', query: 'the design doc' }],
    );
    // Next tick the same line reappears as marked overlap. It already acted.
    expect(
      parseTaskCaptureReply(reply([newSubject]), candidates, nextTick, cueTick, spent),
    ).toEqual([]);
  });

  it('acts on the same second tick when that cue was never spent — the control', () => {
    // Same lines, same reply, a memory that never saw the first tick: the
    // drop above is the spending, not the words.
    expect(
      parseTaskCaptureReply(reply([newSubject]), candidates, nextTick, cueTick, new Set<number>()),
    ).toEqual([{ kind: 'research', topic: 'why the retry loop wakes the sync' }]);
  });

  it('still rescues an ask that straddles the boundary', () => {
    // The cue line licensed nothing on its own tick — it names no subject —
    // so it is still live when the subject arrives on the next one.
    const spent = new Set<number>();
    const fragment: NotesTurn[] = [{ turn: 1, speaker: 'Bryan', text: 'Claude, can you go and' }];
    const subject: NotesTurn[] = [
      { turn: 2, speaker: 'Bryan', text: 'look into why the retry loop wakes the sync' },
    ];
    expect(parseTaskCaptureReply(reply([]), candidates, fragment, undefined, spent)).toEqual([]);
    expect(
      parseTaskCaptureReply(reply([newSubject]), candidates, subject, fragment, spent),
    ).toEqual([{ kind: 'research', topic: 'why the retry loop wakes the sync' }]);
  });
});
