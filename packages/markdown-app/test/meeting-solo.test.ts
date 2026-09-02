import { describe, expect, it } from 'vitest';
import { othersOnDoc } from '../src/meeting-solo.ts';

/** A presence with these states, the local tab being client 1. */
const presence = (states: Record<number, unknown>) => ({
  clientID: 1,
  getStates: () => new Map(Object.entries(states).map(([k, v]) => [Number(k), v])),
});

const me = { id: 'u-bryan', name: 'Bryan' };

describe('othersOnDoc — who else is on the doc', () => {
  it('is nobody on an empty doc, and nobody when only this tab is here', () => {
    expect(othersOnDoc(presence({}), me)).toEqual([]);
    expect(othersOnDoc(presence({ 1: { user: me } }), me)).toEqual([]);
  });

  it('names another person once, however many tabs they hold', () => {
    const sam = { user: { id: 'u-sam', name: 'Sam' } };
    expect(othersOnDoc(presence({ 1: { user: me }, 2: sam, 3: sam }), me)).toEqual(['Sam']);
  });

  it('does not count the same person in a second tab', () => {
    // By id when both sides carry one…
    expect(
      othersOnDoc(presence({ 1: { user: me }, 2: { user: { id: 'u-bryan', name: 'Bryan' } } }), me),
    ).toEqual([]);
    // …and by name for a tab that predates ids on the wire.
    expect(othersOnDoc(presence({ 1: { user: me }, 2: { user: { name: 'Bryan' } } }), me)).toEqual(
      [],
    );
    // A tab with no id of its own compares by name too.
    expect(
      othersOnDoc(presence({ 2: { user: { id: 'u-bryan', name: 'Bryan' } } }), { name: 'Bryan' }),
    ).toEqual([]);
  });

  it('tells a namesake with a different id apart from the same person', () => {
    expect(othersOnDoc(presence({ 2: { user: { id: 'u-other', name: 'Bryan' } } }), me)).toEqual([
      'Bryan',
    ]);
  });

  it('ignores nameless states — the server’s own, a tab still choosing a name', () => {
    expect(
      othersOnDoc(presence({ 2: {}, 3: { user: {} }, 4: null, 5: { user: { name: '  ' } } }), me),
    ).toEqual([]);
  });

  it('lists several people sorted, for a caller that wants to say who', () => {
    expect(
      othersOnDoc(presence({ 2: { user: { name: 'Zed' } }, 3: { user: { name: 'Ana' } } }), me),
    ).toEqual(['Ana', 'Zed']);
  });
});
