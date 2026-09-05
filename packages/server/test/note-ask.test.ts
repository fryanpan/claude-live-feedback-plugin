/**
 * Reading a task note for an ask to a person nobody filed.
 *
 * Two things are under test and they fail differently. The PREFILTER is a
 * table: every fixture below is the shape of a note a live agent actually
 * writes, half of them asks and half of them not, and the table is what says
 * the vocabulary separates them rather than merely matching the asks. The
 * CLASSIFIER is about cost and about what happens when the judge is not
 * there — one call per note ever, a `no` that cancels the finding, and a
 * failure that leaves the prefilter's verdict standing.
 *
 * Fixture texts follow the shapes of the 2026-09-04 incident; every person
 * named other than the board's owner is invented, and the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { NoteAskClassifier, noteReadsAsWaitingOnPerson } from '../src/note-ask.ts';

const PEOPLE = ['Bryan'];

/** Notes that hand work to a person and stop. */
const ASKS: ReadonlyArray<[label: string, text: string]> = [
  [
    'parked on a named person with the options spelled out',
    "R12 std arm is parked on Bryan's (a) build-only / (b) rebuild with the install intent and rerun / (c) harness fix",
  ],
  [
    'waiting on a named person, with the agent saying it has nothing to do',
    'Waiting on Bryan: the four factual corrections sit in the doc as accept/reject suggestions, and the voice items above are his to make. Nothing for the agent to do.',
  ],
  ['handed over for a read, with no name at all', 'Review pack is bound and ready for your read.'],
];

/** Notes that report work, or explicitly deny waiting. */
const NOT_ASKS: ReadonlyArray<[label: string, text: string]> = [
  [
    'opens by denying it, and says the person already answered',
    'Not waiting on a person: Bryan answered (post it to Confluence, do it at 7AM). The post is scheduled for 07:02.',
  ],
  [
    'opens by denying it, and reports a run in flight',
    'Not stalled: the R12 fast-build arm is running (driver alive since 14:42Z, 21 of 34 apps have events).',
  ],
  [
    'plain progress with no waiting vocabulary at all',
    'All three adversarial-review breaks verified real and fixed (rb-04 first-frame ordering…)',
  ],
  [
    'waiting on a MACHINE is work, not an ask',
    'PR open, CI running; waiting on the build to go green.',
  ],
  [
    'blocked on another ticket is a dependency, not an ask',
    'Blocked on the schema migration landing in main.',
  ],
  // The three below are a review finding, not invention. The first draft
  // matched "any waiting phrase anywhere AND any person word anywhere", and
  // read all three as asks on the strength of a pronoun several words from
  // the phrase. With no judge key — a supported state — such a row leaves
  // `in-progress`, drops off the stalled list where `builder-silent` could
  // still have named it, and wakes the lead to file an ask nobody has.
  [
    'a possessive far from the phrase is not the thing being waited on',
    'Blocked on the CI runner outage; the vendor says their fix is rolling out.',
  ],
  [
    'a possessive THING is a thing, even next to the phrase',
    'Waiting for your CI credentials to propagate before the smoke test.',
  ],
  [
    'a dependency, with somebody else’s fixtures mentioned after it',
    'Blocked on the schema migration; I will regenerate their fixtures after.',
  ],
  [
    'waiting on a deploy, with a possessive in the following clause',
    'Waiting on the deploy to finish; their runner is slow today.',
  ],
  [
    'a rebase is not a person, however many pronouns follow',
    'Needs a rebase onto main before you can review it.',
  ],
];

/** Asks whose person is a pronoun or an act, not a name — so the table above
 *  cannot be passing on the board's roster alone. */
const PRONOUN_ASKS: ReadonlyArray<[label: string, text: string]> = [
  ['a possessive ACT is a person acting', 'Waiting on your final call before I touch the schema.'],
  ['handed over, with the name as the object', 'Handed over to Bryan for a decision.'],
  ['needs a sign-off', 'Needs your sign-off before it can merge.'],
  ['the phrase carries both halves on its own', 'Your call: (a) ship it, (b) hold for the audit.'],
];

describe('noteReadsAsWaitingOnPerson — the deterministic prefilter', () => {
  for (const [label, text] of ASKS) {
    it(`reads as an ask: ${label}`, () => {
      expect(noteReadsAsWaitingOnPerson(text, PEOPLE)).toBe(true);
    });
  }

  for (const [label, text] of NOT_ASKS) {
    it(`does not read as an ask: ${label}`, () => {
      expect(noteReadsAsWaitingOnPerson(text, PEOPLE)).toBe(false);
    });
  }

  for (const [label, text] of PRONOUN_ASKS) {
    it(`reads as an ask: ${label}`, () => {
      expect(noteReadsAsWaitingOnPerson(text, PEOPLE)).toBe(true);
    });
  }

  it('the person has to be what the phrase is WAITING FOR, not merely present', () => {
    // One waiting phrase, one pronoun, two readings — the difference is
    // whether the pronoun is the phrase's object or a possession in it.
    expect(noteReadsAsWaitingOnPerson('Waiting for your read on the migration.', PEOPLE)).toBe(
      true,
    );
    expect(noteReadsAsWaitingOnPerson('Waiting for your migration to finish.', PEOPLE)).toBe(false);
  });

  it('needs a PERSON, not just a waiting phrase — the name is what supplies one', () => {
    const text = "R12 std arm is parked on Bryan's build-only run";
    // Positive control first: with the board's person named, it is an ask.
    expect(noteReadsAsWaitingOnPerson(text, ['Bryan'])).toBe(true);
    // The same words with nobody on the board called that: the phrase alone
    // is not enough, or "parked on the release train" would be an ask.
    expect(noteReadsAsWaitingOnPerson(text, [])).toBe(false);
  });

  it('matches a name whole, so a longer word that contains it is not a person', () => {
    expect(noteReadsAsWaitingOnPerson('Waiting on Bryanson to cut the tag', ['Bryan'])).toBe(false);
    expect(noteReadsAsWaitingOnPerson('Waiting on Bryan to cut the tag', ['Bryan'])).toBe(true);
  });

  it('empty and absent text are not asks', () => {
    expect(noteReadsAsWaitingOnPerson(undefined, PEOPLE)).toBe(false);
    expect(noteReadsAsWaitingOnPerson('   ', PEOPLE)).toBe(false);
  });
});

describe('NoteAskClassifier — the confirmation, and what happens without one', () => {
  const ASK = { ts: 1_000, text: 'Waiting on Bryan: the voice items above are his to make.' };
  const NOT = { ts: 2_000, text: 'All three review breaks verified real and fixed.' };

  it('with no judge configured, the prefilter decides — which is the no-key state', () => {
    const c = new NoteAskClassifier({ personNames: PEOPLE });
    expect(c.asks(ASK)).toBe(true);
    expect(c.asks(NOT)).toBe(false);
    expect(c.cachedCount()).toBe(0);
  });

  it('a judge that says no cancels the finding on the NEXT reading, and is asked once', async () => {
    const seen: string[] = [];
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      judge: async (text) => {
        seen.push(text);
        return false;
      },
    });
    // The first reading stands on the prefilter — the judge has not answered
    // yet, and this call is synchronous by construction.
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    expect(c.asks(ASK)).toBe(false);
    // Read it twice more: a cached verdict costs no second call.
    expect(c.asks(ASK)).toBe(false);
    await c.settle();
    expect(seen).toHaveLength(1);
  });

  it('a judge that says yes leaves the finding standing, still at one call', async () => {
    let calls = 0;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      judge: async () => {
        calls += 1;
        return true;
      },
    });
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    expect(c.asks(ASK)).toBe(true);
    expect(calls).toBe(1);
  });

  it('a note the prefilter passed over is never sent to the judge', async () => {
    let calls = 0;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      judge: async () => {
        calls += 1;
        return true;
      },
    });
    expect(c.asks(NOT)).toBe(false);
    await c.settle();
    expect(calls).toBe(0);
  });

  it('a judge that throws leaves the prefilter standing and is not retried at once', async () => {
    let calls = 0;
    let clock = 5_000;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      clock: () => clock,
      judge: async () => {
        calls += 1;
        throw new Error('upstream is down');
      },
    });
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    // Still an ask — a judge that cannot answer must not close the door.
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    // …and the failure bought a pause rather than a call per tick.
    expect(calls).toBe(1);
    // Past the backoff it is willing to try again, so an outage is a pause
    // and not a permanent stop.
    clock += 10 * 60_000;
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    expect(calls).toBe(2);
  });

  it('a judge that throws SYNCHRONOUSLY does not escape into the caller', async () => {
    let clock = 5_000;
    let calls = 0;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      clock: () => clock,
      // Not `async`: this throws before any await, which is what turns
      // `Promise.resolve(judge(text))` into a synchronous throw out of asks().
      judge: ((): Promise<boolean | null> => {
        calls += 1;
        throw new Error('bad key');
      }) as () => Promise<boolean | null>,
    });
    expect(() => c.asks(ASK)).not.toThrow();
    await c.settle();
    // The slot was released, so a later reading can still be judged.
    expect(calls).toBe(1);
    clock += 10 * 60_000;
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    expect(calls).toBe(2);
  });

  it('settled confirmations are released, not retained for the process lifetime', async () => {
    const c = new NoteAskClassifier({ personNames: PEOPLE, judge: async () => true });
    for (let i = 0; i < 3; i += 1) c.asks({ ts: 100 + i, text: ASK.text });
    // Positive control: they really were held while running, so the zero
    // below cannot be a promise that was never added.
    expect(c.pendingCount()).toBe(3);
    await c.settle();
    expect(c.pendingCount()).toBe(0);
    expect(c.cachedCount()).toBe(3);
  });

  it('a judge that answers "could not judge" caches nothing', async () => {
    const clock = 5_000;
    let calls = 0;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      clock: () => clock,
      judge: async () => {
        calls += 1;
        return null;
      },
    });
    expect(c.asks(ASK)).toBe(true);
    await c.settle();
    expect(c.cachedCount()).toBe(0);
    expect(c.asks(ASK)).toBe(true);
    expect(calls).toBe(1);
  });

  it('two notes with the same text at different times are judged separately', async () => {
    const seen: number[] = [];
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      judge: async () => {
        seen.push(1);
        return true;
      },
    });
    c.asks(ASK);
    c.asks({ ...ASK, ts: ASK.ts + 60_000 });
    await c.settle();
    expect(seen).toHaveLength(2);
  });

  it('prefilterOnly reads the words and never schedules anything', async () => {
    let calls = 0;
    const c = new NoteAskClassifier({
      personNames: PEOPLE,
      judge: async () => {
        calls += 1;
        return false;
      },
    });
    expect(c.prefilterOnly(ASK)).toBe(true);
    expect(c.prefilterOnly(NOT)).toBe(false);
    await c.settle();
    expect(calls).toBe(0);
  });

  it('the person names can be swapped between boards without clearing the cache', async () => {
    const c = new NoteAskClassifier({ personNames: [], judge: async () => true });
    const named = { ts: 9_000, text: "R12 std arm is parked on Bryan's build-only run" };
    expect(c.asks(named)).toBe(false);
    c.setPersonNames(['Bryan']);
    expect(c.asks(named)).toBe(true);
    await c.settle();
  });
});
