import { describe, expect, it } from 'vitest';
import { type RosterTurn, speakerRoster } from './speaker-roster.ts';

describe('speakerRoster — who the reassign popover can offer', () => {
  // Shaped like the transcript rows the API returns — `turn` and `ts` ride
  // along and the roster reads neither, which is the point of the type.
  const turns: RosterTurn[] = [
    { text: 'Move the gate.', speaker: 'A' },
    { text: 'Not before Friday.', speaker: 'B' },
    { text: 'Then Monday.', speaker: 'A' },
    { text: 'Someone coughed.' },
  ];

  it('names every voice that spoke, with the last thing it said', () => {
    expect(speakerRoster(turns, { A: 'Devi' })).toEqual([
      { label: 'A', name: 'Devi', lastSaid: 'Then Monday.' },
      { label: 'B', name: 'Speaker B', lastSaid: 'Not before Friday.' },
    ]);
  });

  it('offers a named voice that has not spoken yet', () => {
    // Naming happens on the strip and can land before that voice's first
    // settled turn. A roster that waited for speech would leave the person
    // unable to reassign to somebody they had just named.
    const roster = speakerRoster(turns, { C: 'Marisol' });
    expect(roster.map((v) => v.label)).toEqual(['A', 'B', 'C']);
    expect(roster[2]).toEqual({ label: 'C', name: 'Marisol', lastSaid: '' });
  });

  it('ignores turns nobody was labelled for — a solo capture offers nothing', () => {
    expect(speakerRoster([{ text: 'Just me talking.' }], {})).toEqual([]);
  });

  it('orders by label so the list does not reshuffle as people speak', () => {
    const spoken = [
      { text: 'first', speaker: 'B' },
      { text: 'second', speaker: 'A' },
    ];
    expect(speakerRoster(spoken, {}).map((v) => v.label)).toEqual(['A', 'B']);
  });

  it('takes the LAST thing said, not the longest or the first', () => {
    const spoken = [
      { text: 'a much longer earlier sentence', speaker: 'A' },
      { text: 'ok', speaker: 'A' },
    ];
    expect(speakerRoster(spoken, {})[0]?.lastSaid).toBe('ok');
  });
});
