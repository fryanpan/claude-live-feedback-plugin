/**
 * The attach response has to be readable by the session that receives it.
 *
 * Both fields that mattered on 2026-08-29/30 were present and both read as
 * ordinary: `lead: false` looks the same whether a working peer holds the seat
 * or a dead id does, and an empty watch list looks the same whether you have
 * not subscribed yet or a rename left every subscription on your old id.
 *
 * These notes name the GAP and never the healthy state, because a note on
 * every attach is a note nobody reads by the day it matters.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { attachNotes } from '../src/attach-notes.ts';

const healthySeat = { leadAgentId: 'me', live: true, stale: false };

describe('attachNotes', () => {
  it('says nothing when there is nothing wrong', () => {
    // The control for every assertion below: these notes are a signal, and a
    // signal that fires on the healthy path is noise.
    expect(attachNotes({ lead: true, seat: healthySeat }, 3)).toEqual([]);
  });

  it('says nothing when a LIVE peer holds the seat', () => {
    // Not a gap. Attaching as a bystander to a board somebody is working is
    // the ordinary case, and warning about it would train the reader to skip
    // the one line that matters.
    const notes = attachNotes(
      { lead: false, seat: { leadAgentId: 'peer', live: true, stale: false } },
      2,
    );
    expect(notes).toEqual([]);
  });

  it('names the id it took the seat from', () => {
    const notes = attachNotes(
      { lead: true, seat: healthySeat, seatTakenFrom: 'agent-live-feedback' },
      4,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('agent-live-feedback');
    // A handover a session cannot see is the same class of bug as the one
    // being fixed, so the note says it was recorded.
    expect(notes[0]).toContain('recorded');
  });

  it('carries the seat notice when the seat is stale and was not taken', () => {
    const notes = attachNotes(
      {
        lead: false,
        seat: { leadAgentId: 'ghost', live: false, stale: true, notice: 'GHOST HOLDS THE SEAT' },
      },
      1,
    );
    expect(notes).toEqual(['GHOST HOLDS THE SEAT']);
  });

  it('names an empty watch set, and says what a rename does to it', () => {
    const notes = attachNotes({ lead: true, seat: healthySeat }, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('watching nothing');
    // The diagnosis is the useful half: an empty list is ambiguous, and the
    // note's job is to name the reading nobody made for 4.5 hours.
    expect(notes[0]).toContain('old agent id');
  });

  it('reports both gaps when a rename caused both', () => {
    // The incident's own shape: a new identity with no watches attaching to a
    // board whose seat its old identity still held.
    const notes = attachNotes(
      { lead: true, seat: healthySeat, seatTakenFrom: 'agent-live-feedback' },
      0,
    );
    expect(notes).toHaveLength(2);
  });

  it('names the carry-over call, with the old id filled in, when the board knows one', () => {
    // The session that respawned cannot name its predecessor; the seat it
    // just took can. That id is the whole input the carry-over needs.
    const notes = attachNotes(
      { lead: true, seat: healthySeat, seatTakenFrom: 'agent-live-feedback' },
      0,
    );
    const watches = notes.find((n) => n.includes('watching nothing')) ?? '';
    expect(watches).toContain('/api/agents/agent-live-feedback/merge');
  });

  it('offers the carry-over off a stale seat it did NOT take', () => {
    const notes = attachNotes(
      {
        lead: false,
        seat: { leadAgentId: 'ghost', live: false, stale: true, notice: 'GHOST HOLDS THE SEAT' },
      },
      0,
    );
    expect(notes.find((n) => n.includes('watching nothing'))).toContain('/api/agents/ghost/merge');
  });

  it('does NOT offer a call whose argument the reader would have to guess', () => {
    // No stale seat, no handover: the board knows of no previous identity, so
    // the note stops at re-subscribing rather than naming an id at random.
    // Moving one agent's watches onto another is the failure this avoids.
    const notes = attachNotes({ lead: true, seat: healthySeat }, 0);
    expect(notes[0]).not.toContain('/merge');
    // Positive control that the clause CAN appear at all is the two tests
    // above; this one asserts the condition, not the absence of the code.
    expect(notes[0]).toContain('watching nothing');
  });

  it('does not offer the carry-over off a LIVE seat holder', () => {
    // A live peer's watches are not yours to inherit under any reading.
    const notes = attachNotes(
      { lead: false, seat: { leadAgentId: 'peer', live: true, stale: false } },
      0,
    );
    expect(notes[0]).not.toContain('/merge');
  });
});
