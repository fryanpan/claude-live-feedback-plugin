/**
 * A scripted meeting with ten planted references, run through the real tick
 * pipeline.
 *
 * WHY A WHOLE MEETING AND NOT TEN CALLS TO THE MATCHER. The unit tests next
 * door (`notes-link-intent.test.ts`) pin the decision; this pins the DELIVERY.
 * Between the decision and the note sit the catalogue assembly, the strict
 * matcher's first refusal, the compose input, the speaker-tag check, the
 * suggestion append and the Yjs merge — and the owner's report was not "the
 * scoring is wrong", it was that asking for a link did nothing. Only the
 * whole chain can answer that.
 *
 * HOW THE FIXTURE WAS WRITTEN, because it decides whether the tally means
 * anything. The board was written FIRST, as ten ordinary tickets with the
 * bodies somebody filing them would write. The speech was written after, as a
 * person talking: a name, an anecdote, and the subject described rather than
 * named. Where a spoken word also appears in a ticket body it is because a
 * ticket about a cracked belt clip says "clip" — not because the sentence was
 * tuned until it passed. Two of the ten share no word at all with their row's
 * title, and most of the rest share exactly one.
 *
 * THE HONEST MEASURE OF WHAT THIS ADDS: run the same ten past the strict
 * matcher alone and it cites ONE of them, because one shared title word can
 * never make the run of two `namesReference` demands. That is the gap the
 * owner was reporting, in a number.
 *
 * AND THE CONTROLS ARE THE OTHER HALF. Four more ticks ask for a link to work
 * this board does not hold, or talk about the board's subjects without asking
 * for anything. A pass that links ten of ten and also links those four is a
 * matcher that says yes to everything, and the tally alone would not show it.
 * Every fixture name is invented; the repo is public.
 */

import { describe, expect, it } from 'vitest';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';

const WORKSPACE = 'w-recorder';
const DOC = 'd-standup';

/** The board, written as tickets before any of the speech below existed. */
const BOARD = [
  {
    id: 't-batt',
    title: 'Battery door latch',
    status: 'todo',
    body: 'The battery door on the underside springs open when the unit is dropped and the cells fall out. Needs a stiffer catch.',
  },
  {
    id: 't-gain',
    title: 'Input gain knob',
    status: 'in_progress',
    body: 'The gain knob turns too freely and gets nudged while the recorder is in a bag. Detents, or a press-to-turn lock.',
  },
  {
    id: 't-card',
    title: 'Card write failures',
    status: 'todo',
    body: 'Writes to the memory card fail part way through a long take on slower cards, and the whole recording is lost.',
  },
  {
    id: 't-clip',
    title: 'Belt clip moulding',
    status: 'todo',
    body: 'The moulded clip on the back cracks along the hinge after a season of daily use.',
  },
  {
    id: 't-wheel',
    title: 'Menu wheel navigation',
    status: 'todo',
    body: 'Scrolling the settings menu with the wheel overshoots; people expect one step per click of the wheel.',
  },
  {
    id: 't-port',
    title: 'Charging port ingress',
    status: 'todo',
    body: 'Dust and rain get into the charging socket. A rubber flap over the port, or a gasket around it.',
  },
  {
    id: 't-ota',
    title: 'Firmware update over the air',
    status: 'todo',
    body: 'Firmware arrives over wifi instead of by copying a file onto the card and holding two buttons at power on.',
  },
  {
    id: 't-wind',
    title: 'Wind noise on the built-in capsules',
    status: 'todo',
    body: 'Outdoors the built-in capsules rumble in any breeze. A foam collar on the housing, or a high pass filter in software.',
  },
  {
    id: 't-price',
    title: 'Retail price point',
    status: 'todo',
    body: 'Two hundred and forty pounds at retail is the number the distributor gave us to design against.',
  },
  {
    id: 't-case',
    title: 'Carry case bundle',
    status: 'todo',
    body: 'Whether a soft case ships inside the box or is sold on its own alongside it.',
  },
] as const;

/**
 * The ten planted references: what somebody says, and the row they mean.
 *
 * Each is one tick's speech. The ask is phrased differently across the ten,
 * because a person does not say it the same way twice.
 */
const PLANTED: ReadonlyArray<{ said: string; expect: string }> = [
  {
    said:
      'Priya dropped hers on the gravel outside and the door underneath sprang open, cells everywhere. ' +
      'Link that to the existing ticket.',
    expect: 't-batt',
  },
  {
    said:
      'The knob keeps getting nudged in my bag, so I arrive and the gain is wrong. ' +
      'Can you attach that to the ticket we already have?',
    expect: 't-gain',
  },
  {
    said:
      'We lost a whole forty minute take last month because the write to the card failed part way through. ' +
      'Link this to the existing task.',
    expect: 't-card',
  },
  {
    said:
      'Marcus has had two of the moulded clips crack along the hinge now. ' +
      'Hook that up to the existing ticket.',
    expect: 't-clip',
  },
  {
    said:
      'Every time I scroll the settings with the wheel it overshoots by one and I have to come back. ' +
      'Tie that to the existing issue.',
    expect: 't-wheel',
  },
  {
    said:
      'Rain got into the charging socket at the festival and it would not take a charge for two days. ' +
      'Link that to the existing ticket please.',
    expect: 't-port',
  },
  {
    said:
      'Nobody is going to copy a file onto a card and hold two buttons down at power on. It should just come over wifi. ' +
      'Associate that with the existing task.',
    expect: 't-ota',
  },
  {
    said:
      'Anything outdoors and the built-in capsules rumble in the slightest breeze — either a foam collar or a high pass. ' +
      'Link that to the existing ticket.',
    expect: 't-wind',
  },
  {
    said:
      'The distributor keeps coming back to two hundred and forty pounds at retail as the number we design against. ' +
      'Link that to the existing task.',
    expect: 't-price',
  },
  {
    said:
      'Do we put the soft case inside the box or sell it on its own alongside? ' +
      'Connect that to the existing ticket.',
    expect: 't-case',
  },
];

/**
 * The controls. Two ask for a link to work this board does not hold, and two
 * talk about the board's own subjects without asking for anything. None may
 * produce a link.
 */
const CONTROLS: readonly string[] = [
  'The catering invoice from last month is still unpaid. Link that to the existing task.',
  'Somebody needs to book the anechoic chamber for March. Attach that to the existing ticket.',
  'The gain knob came up again in the user interviews and people liked it where it is.',
  'Right, shall we break for ten minutes and pick this up after?',
];

/** The scripted composer: one bullet per turn, the shape the real one returns. */
const bullets = (input: NotesComposeInput): string =>
  ['## Meeting notes', '', ...input.tick.turns.map((t) => `- ${t.text}`)].join('\n');

function meeting(): ReturnType<typeof createNotesTickHarness> {
  return createNotesTickHarness({
    docId: DOC,
    workspaceId: WORKSPACE,
    tasks: BOARD.map((t) => ({ ...t })),
    compose: (input) => bullets(input),
  });
}

describe('a spoken "link that to the existing task", over a scripted meeting', () => {
  it('links at least nine of ten planted references and none of them wrong', async () => {
    const harness = meeting();
    const linked: string[] = [];
    const missed: string[] = [];
    const wrong: Array<{ said: string; got: string; wanted: string }> = [];

    for (const planted of PLANTED) {
      const before = harness.taskLinks.length;
      await harness.speak(planted.said);
      const made = harness.taskLinks.slice(before);
      if (made.length === 0) {
        missed.push(planted.expect);
        continue;
      }
      for (const link of made) {
        if (link.taskId === planted.expect) linked.push(link.taskId);
        else wrong.push({ said: planted.said, got: link.taskId, wanted: planted.expect });
      }
    }

    // Reported rather than merely asserted: a tally in the output is what
    // makes the PR body's number checkable by somebody re-running this.
    console.log(
      `planted references: ${linked.length} linked, ${missed.length} missed, ${wrong.length} wrong` +
        (missed.length > 0 ? ` — missed ${missed.join(', ')}` : '') +
        (wrong.length > 0 ? ` — wrong ${JSON.stringify(wrong)}` : ''),
    );

    expect(wrong).toEqual([]);
    expect(linked.length).toBeGreaterThanOrEqual(9);
    expect(harness.errors).toEqual([]);
  });

  it('links nothing when the ask names work this board does not hold', async () => {
    const harness = meeting();
    for (const said of CONTROLS) await harness.speak(said);
    expect(harness.taskLinks).toEqual([]);
  });

  it('writes the row into the note as a link the reader can follow', async () => {
    const harness = meeting();
    const shot = await harness.speak(PLANTED[0]!.said);
    // The compose input is where the citation is handed to the note-taker,
    // and it carries the row's real URL — not a title for the model to
    // reconstruct a link from.
    const cited = shot.input?.references?.map((r) => r.url) ?? [];
    expect(cited).toContain(`/workspaces/${WORKSPACE}?task=t-batt`);
  });

  it('gives the row its own backlink, so the work is findable from either end', async () => {
    const harness = meeting();
    await harness.speak(PLANTED[2]!.said);
    expect(harness.taskLinks).toEqual([{ taskId: 't-card', docId: DOC }]);
  });
});

describe('a probable match nobody asked about', () => {
  it('reaches the note as a question the reader can accept', async () => {
    const harness = meeting();
    // No ask anywhere in this, and not one word of the row's title in it
    // either — "Card write failures" against somebody describing a lost take.
    // The strict matcher cannot see this and is not meant to.
    const shot = await harness.speak(
      'We lost a whole forty minute take last month because the write to the memory card failed part way through.',
    );
    expect(harness.taskLinks).toEqual([]);
    expect(shot.notes).toContain('related: Card write failures?');
    expect(shot.notes).toContain('task=t-card&suggest=1');
  });

  it('says nothing at all when nothing on the board is probable', async () => {
    const harness = meeting();
    const shot = await harness.speak('Shall we break for ten minutes and pick this up after?');
    expect(shot.notes).not.toContain('related:');
  });

  it('does not ask about a row the note already cites', async () => {
    const harness = meeting();
    // The ask links this row, so the note carries it. Being asked to confirm
    // a link already in the note is the one shape of question worth nothing.
    const shot = await harness.speak(PLANTED[2]!.said);
    expect(harness.taskLinks).toEqual([{ taskId: 't-card', docId: DOC }]);
    expect(shot.notes).not.toContain('related:');
  });
});
