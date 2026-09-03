/**
 * The deterministic half of "voice requests that work SMOOTHLY" (Bryan,
 * 2026-08-29): the pieces that decide what an utterance MEANS, before any
 * model or any server is involved.
 *
 *  - "Asking to go to an item with only vaguely relevant words has never
 *    worked (eg 'I want to go to the Akash review doc in QB')." A navigation
 *    ask resolves by TITLE SIMILARITY, and when the best two are too close to
 *    call the answer is a question rather than a guess.
 *  - "If I ask for a brief status update, that should be able to show me a
 *    100 word message." Composed from the store and capped, no model.
 *  - "If I'm in a review item, I should be able to reply by voice (choose an
 *    option or add an answer)." An ordinal, a label, or free text.
 *
 * Split out of `voice-smooth.test.ts` (A8), which keeps the route half: the
 * same three promises asserted end to end through a real `createServer`. Two
 * harnesses, and only one of them needs a server, a data dir and a workspace
 * — so this file starts instantly and says which LAYER broke when a promise
 * stops holding. `composeStatus` moved to `voice-status.ts` in A6, which is
 * why this split waited for it.
 *
 * Every fixture phrase is Bryan's own wording. All names are synthetic
 * (jordan@partner.example register); the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  VOICE_STATUS_MAX_WORDS,
  capWords,
  composeStatus,
  countWords,
} from '../src/voice-status.ts';
import {
  answerBody,
  navigationAsk,
  parseOrdinal,
  pickByLabel,
  resolveByTitle,
  spokenKind,
  statusAsk,
  wordsMatch,
} from '../src/voice.ts';

/** The same three titles the route half binds real documents to: a target, a
 *  near-twin that makes the ask ambiguous, and a decoy sharing exactly one
 *  word with it. The shape is the fixture — the strings themselves carry no
 *  meaning beyond it. */
const AKASH = 'Review: Akash — onboarding flow';
const AKASH_TWIN = 'Review: Akash — billing flow';
const DECOY = 'Review: billing export';

// ── Unit: the deterministic pieces ─────────────────────────────────────────

describe('navigationAsk: which utterances are "take me to …"', () => {
  it('extracts the name from Bryan’s phrasing, dropping the board qualifier', () => {
    const q = navigationAsk("I want to go to the 'Akash review doc' in QB", ['QB']);
    expect(q).not.toBeNull();
    expect(q?.toLowerCase()).toContain('akash');
    expect(q?.toLowerCase()).not.toContain('qb');
  });

  it('is not fooled by verbs that change something or ask for status', () => {
    expect(navigationAsk('mark this done')).toBeNull();
    expect(navigationAsk('brief status')).toBeNull();
    expect(navigationAsk('assign this to me')).toBeNull();
  });
});

describe('resolveByTitle: vague words against the index', () => {
  const doc = (id: string, title: string) => ({ id, kind: 'doc' as const, title });
  const task = (id: string, title: string) => ({ id, kind: 'task' as const, title });

  it('Bryan’s phrase finds the Akash review over a decoy sharing one word', () => {
    const r = resolveByTitle('akash review', [doc('d-akash', AKASH), doc('d-decoy', DECOY)]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('d-akash');
  });

  it('two near-identical titles are AMBIGUOUS, never a coin toss', () => {
    const r = resolveByTitle('akash review', [
      doc('d-akash', AKASH),
      doc('d-twin', AKASH_TWIN),
      doc('d-decoy', DECOY),
    ]);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.matches.map((m) => m.id).sort()).toEqual(['d-akash', 'd-twin']);
    }
  });

  it('words that match nothing resolve to nothing — the model gets its turn', () => {
    const r = resolveByTitle('flux capacitor', [doc('d-akash', AKASH), doc('d-decoy', DECOY)]);
    expect(r.kind).toBe('none');
  });

  it('a slip in a LONG word still matches (speech is not typing); a short one does not', () => {
    // "onbording" — one letter dropped from a ten-letter word — is still the
    // word. Below five letters a slip is not tolerated at all: "akesh" is a
    // different name, not a mis-heard "akash", and guessing there is how a
    // four-letter "test" used to open "Testimonials".
    const r = resolveByTitle('onbording flow', [doc('d-akash', AKASH), doc('d-decoy', DECOY)]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('d-akash');
    expect(wordsMatch('onbording', 'onboarding')).toBe(true);
    expect(wordsMatch('akash', 'akesh')).toBe(false);
  });

  it('a four-letter prefix is not a match: "test" opens neither Testing nor Testimonials', () => {
    expect(wordsMatch('test', 'testimonials')).toBe(false);
    expect(wordsMatch('test', 'testing')).toBe(false);
    // Plural-length prefixes still are: the shorter word is long enough to
    // be its own evidence.
    expect(wordsMatch('placeholder', 'placeholders')).toBe(true);
    const r = resolveByTitle('test doc', [
      doc('d-testing', 'Testing the widget'),
      doc('d-quotes', 'Testimonials page'),
    ]);
    expect(r.kind).toBe('none');
  });

  it('a spoken "doc" / "task" filters by kind: "the mobile doc" is not the task called Mobile', () => {
    const r = resolveByTitle('mobile doc', [
      task('t-mobile', 'Mobile'),
      doc('d-layouts', 'Design: mobile layouts'),
    ]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('d-layouts');
    const t = resolveByTitle('mobile task', [
      task('t-mobile', 'Mobile'),
      doc('d-layouts', 'Design: mobile layouts'),
    ]);
    expect(t.kind).toBe('hit');
    if (t.kind === 'hit') expect(t.match.id).toBe('t-mobile');
  });

  it('"page" is a title word, not a kind word: "the results page" still finds the TASKS', () => {
    expect(spokenKind('the results page')).toBeUndefined();
    const r = resolveByTitle('results page', [
      task('t-wire', 'Wire the results page'),
      task('t-fold', 'Fold the plan into the results page'),
      doc('d-notes', 'Onboarding notes'),
    ]);
    // Two tasks cover it: a question, as before — never "nothing" because a
    // doc exists on the board.
    expect(r.kind).toBe('ambiguous');
  });

  it('two titles that both cover the query are a QUESTION, not a tie-break on length', () => {
    const r = resolveByTitle('results page', [
      task('t-wire', 'Wire the results page'),
      task('t-fold', 'Fold the plan into the results page'),
    ]);
    expect(r.kind).toBe('ambiguous');
  });
});

describe('navigationAsk: the board qualifier', () => {
  it('strips a trailing "in <board>" only for a board it KNOWS the name of', () => {
    // "open sign in flow" used to lose " in flow" and tie with "Signals".
    expect(navigationAsk('open sign in flow', ['QB'])).toBe('sign in flow');
    expect(navigationAsk("I want to go to the 'Akash review doc' in QB", ['QB'])).toBe(
      'the Akash review doc',
    );
    expect(navigationAsk('open the akash doc in the QB board', ['QB'])).toBe('the akash doc');
    expect(navigationAsk('open the akash doc in QB')).toBe('the akash doc in QB');
  });
});

describe('parseOrdinal: "the second one"', () => {
  it('reads ordinals, numerals and "last"', () => {
    expect(parseOrdinal('pick the second one', 3)).toBe(1);
    expect(parseOrdinal('option 2', 3)).toBe(1);
    expect(parseOrdinal('the first', 3)).toBe(0);
    expect(parseOrdinal('choose the last one', 3)).toBe(2);
    expect(parseOrdinal('number three', 3)).toBe(2);
  });

  it('refuses an ordinal past the end, and a label', () => {
    expect(parseOrdinal('the third one', 2)).toBeNull();
    expect(parseOrdinal('choose keep placeholders', 2)).toBeNull();
  });

  it('survives navigation filler — "go to the second one" answers a "which one?"', () => {
    expect(parseOrdinal('go to the second one', 2)).toBe(1);
    expect(parseOrdinal('open the second one', 2)).toBe(1);
    expect(parseOrdinal('show me the first one', 2)).toBe(0);
    expect(parseOrdinal('take me to the first', 2)).toBe(0);
  });
});

describe('countWords / capWords: one counter', () => {
  it('a dash or an arrow is not a word to either of them', () => {
    // capWords used to count "—" as a word while countWords did not, so a
    // brief that countWords called 100 words could still end in "…".
    expect(capWords('one — two → three', 3)).toBe('one — two → three');
    const dashed = Array.from({ length: 100 }, (_, i) => (i % 10 === 9 ? `w${i} —` : `w${i}`)).join(
      ' ',
    );
    expect(countWords(dashed)).toBe(100);
    expect(capWords(dashed, VOICE_STATUS_MAX_WORDS)).toBe(dashed);
    expect(capWords('a — b → c d', 2)).toBe('a — b…');
    expect(countWords(capWords('a — b → c d', 2))).toBe(2);
  });
});

describe('pickByLabel: the words must BE the label', () => {
  const options = [
    { id: 'keep', label: 'Keep placeholders' },
    { id: 'drop', label: 'Drop placeholders' },
  ];
  it('a negation is a leftover word, so it is not a pick of the thing negated', () => {
    expect(pickByLabel("don't drop the placeholders", options)).toBeNull();
    expect(pickByLabel('never drop placeholders', options)).toBeNull();
    expect(pickByLabel('not keep placeholders', options)).toBeNull();
    expect(pickByLabel('choose keep placeholders', options)?.id).toBe('keep');
    expect(pickByLabel('go with the drop one', options)?.id).toBe('drop');
  });
  it('filler is stripped from the OPENER only, never from inside a label', () => {
    const doors = [
      { id: 'open', label: 'Open door' },
      { id: 'close', label: 'Close door' },
    ];
    expect(pickByLabel('choose open door', doors)?.id).toBe('open');
    expect(pickByLabel('pick the close door', doors)?.id).toBe('close');
  });
});

describe('answerBody: "answer: …" carries the words after the colon', () => {
  it('strips the spoken prefix and nothing else', () => {
    expect(answerBody('answer: yes but only for the auth task')).toBe(
      'yes but only for the auth task',
    );
    expect(answerBody('Reply, ship it Monday')).toBe('ship it Monday');
  });
  it('a sentence with no prefix is not an answer by itself', () => {
    expect(answerBody('yes but only for the auth task')).toBeNull();
  });
});

describe('statusAsk', () => {
  it('hears Bryan’s spellings of "brief status"', () => {
    for (const s of [
      'brief status',
      'status update',
      'where are we',
      'give me a brief status update',
      "what's the status",
      'catch me up',
    ]) {
      expect(statusAsk(s), s).toBe(true);
    }
  });
  it('does not hear a lookup of a doc that happens to be called status', () => {
    expect(statusAsk('open the status doc')).toBe(false);
    expect(statusAsk('mark this done')).toBe(false);
  });
});

describe('composeStatus: the cap holds on a busy board', () => {
  const now = Date.now();
  const tasks = Array.from({ length: 14 }, (_, i) => ({
    id: `t-${i}`,
    title: `Task number ${i} with a fairly long title about the search index`,
    status: (['in-progress', 'todo', 'done', 'triage'] as const)[i % 4] ?? 'todo',
    assignee: i % 2 === 0 ? 'Jordan' : 'Search Revamp',
    doneAt: i % 4 === 2 ? now - i * 3_600_000 : undefined,
  }));
  const queue = Array.from({ length: 6 }, (_, i) => ({
    title: `Task number ${i}`,
    ask: `Is option ${i} acceptable for the launch, given the migration risk we discussed?`,
    askedBy: 'Search Revamp',
  }));

  it('never exceeds VOICE_STATUS_MAX_WORDS and still names the three things', () => {
    const text = composeStatus({ workspaceName: 'search-revamp', tasks, queue, now });
    expect(countWords(text)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
    expect(countWords(text)).toBeGreaterThan(20);
    expect(text).toContain('in progress');
    expect(text.toLowerCase()).toContain('waiting on you');
    expect(text.toLowerCase()).toContain('done');
  });

  it('an empty board is still an answer', () => {
    const text = composeStatus({ workspaceName: 'quiet', tasks: [], queue: [], now });
    expect(countWords(text)).toBeGreaterThan(2);
    expect(countWords(text)).toBeLessThanOrEqual(VOICE_STATUS_MAX_WORDS);
  });
});
