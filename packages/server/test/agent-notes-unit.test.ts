/**
 * The pure half of agent notes (agent-notes.ts): what the route accepts,
 * what it clamps, and what the per-agent ring bounds. The route tests cover
 * the wiring; these cover the two ceilings a tailnet caller could otherwise
 * push past — a client clock nobody checked, and a ring map that grew one
 * entry per invented name.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  AGENT_NOTE_AGENTS_CAP,
  AGENT_NOTE_RING_CAP,
  AT_FUTURE_MS,
  AT_PAST_MS,
  AgentNoteRing,
  NOTE_TEXT_MAX,
  parseAgentNote,
} from '../src/agent-notes.ts';

const NOW = 1_700_000_000_000;
const body = (extra: Record<string, unknown> = {}) => ({
  agent: 'Cartographer',
  kind: 'turn',
  text: 'Shipped it.',
  ...extra,
});

describe('parseAgentNote — the hook clock is trusted only inside a window', () => {
  it('keeps an `at` near the server clock and defaults a missing one to it', () => {
    const kept = parseAgentNote(body({ at: NOW - 60_000 }), NOW);
    expect(kept.ok && kept.note.at).toBe(NOW - 60_000);
    const ahead = parseAgentNote(body({ at: NOW + 60_000 }), NOW);
    expect(ahead.ok && ahead.note.at).toBe(NOW + 60_000);
    const absent = parseAgentNote(body(), NOW);
    expect(absent.ok && absent.note.at).toBe(NOW);
  });
  it('replaces an `at` outside [now - 24h, now + 5min] with the server clock', () => {
    for (const at of [0, -1, 1e308, NOW - AT_PAST_MS - 1, NOW + AT_FUTURE_MS + 1]) {
      const r = parseAgentNote(body({ at }), NOW);
      expect(r.ok && r.note.at, `at=${at}`).toBe(NOW);
    }
    // The window edges themselves are inside it.
    expect(parseAgentNote(body({ at: NOW - AT_PAST_MS }), NOW)).toMatchObject({
      note: { at: NOW - AT_PAST_MS },
    });
    expect(parseAgentNote(body({ at: NOW + AT_FUTURE_MS }), NOW)).toMatchObject({
      note: { at: NOW + AT_FUTURE_MS },
    });
  });
  it('still refuses a non-numeric `at`', () => {
    expect(parseAgentNote(body({ at: 'now' }), NOW)).toMatchObject({ ok: false, error: 'bad-at' });
    expect(parseAgentNote(body({ at: Number.NaN }), NOW)).toMatchObject({ ok: false });
  });
});

describe('AgentNoteRing — bounded per agent AND across agents', () => {
  const note = (agent: string, i: number) => ({
    agent,
    kind: 'turn' as const,
    text: `turn ${i}`,
    at: NOW + i,
  });

  it('caps one agent at the ring size, newest first', () => {
    const ring = new AgentNoteRing();
    for (let i = 1; i <= AGENT_NOTE_RING_CAP + 2; i++) ring.record(note('Nomad', i));
    const got = ring.list('Nomad');
    expect(got).toHaveLength(AGENT_NOTE_RING_CAP);
    expect(got[0]?.text).toBe(`turn ${AGENT_NOTE_RING_CAP + 2}`);
  });

  it('evicts the least recently written agent once the agent cap is passed', () => {
    const ring = new AgentNoteRing();
    for (let i = 0; i < AGENT_NOTE_AGENTS_CAP; i++) ring.record(note(`agent-${i}`, 1));
    expect(ring.size).toBe(AGENT_NOTE_AGENTS_CAP);
    // Writing to the oldest makes it the newest, so the eviction that follows
    // takes agent-1, not agent-0.
    ring.record(note('agent-0', 2));
    ring.record(note('one-too-many', 1));
    expect(ring.size).toBe(AGENT_NOTE_AGENTS_CAP);
    expect(ring.list('agent-1')).toEqual([]);
    expect(ring.list('agent-0').map((n) => n.text)).toEqual(['turn 2', 'turn 1']);
    expect(ring.list('one-too-many')).toHaveLength(1);
    // Positive control: a name just under the cap is still there.
    expect(ring.list(`agent-${AGENT_NOTE_AGENTS_CAP - 1}`)).toHaveLength(1);
  });
});

describe('parseAgentNote — an explicit status is a third kind, and the ceiling fits a full turn', () => {
  it('accepts kind "status" alongside turn and denial', () => {
    const r = parseAgentNote(body({ kind: 'status', text: 'PR open, waiting on CI' }), NOW);
    expect(r.ok && r.note.kind).toBe('status');
    // A kind the store has no meaning for is still refused.
    expect(parseAgentNote(body({ kind: 'shout' }), NOW)).toMatchObject({
      ok: false,
      error: 'bad-kind',
    });
  });
  it('holds a full end-of-turn message: the cap is 4000 and the refusal names it', () => {
    expect(NOTE_TEXT_MAX).toBe(4000);
    const fits = parseAgentNote(body({ text: 'x'.repeat(NOTE_TEXT_MAX) }), NOW);
    expect(fits.ok).toBe(true);
    const over = parseAgentNote(body({ text: 'x'.repeat(NOTE_TEXT_MAX + 1) }), NOW);
    expect(over).toMatchObject({ ok: false, error: 'bad-text' });
    expect(!over.ok && over.message).toContain('4000');
  });
});
