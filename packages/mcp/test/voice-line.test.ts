import { describe, expect, it } from 'vitest';
import { voiceRequestLine } from '../src/voice-line.ts';

/**
 * A `voice.request` row reaches every attached agent's channel. Until the
 * fast path could only NAVIGATE, exactly two things could be true of one: the
 * server answered it (a lookup — drop it, nothing happened), or it needs the
 * agent (render the imperative). The action route is a third thing, and it is
 * the one the old two-way rendering gets wrong in the dangerous direction: a
 * change that ALREADY LANDED on the board, described to the agent as work to
 * do. Re-applying "mark this done" is caught by same-status; re-applying an
 * assignee change or a spoken comment is not — the second one posts the same
 * words twice under the speaker's name.
 */

const SPOKEN = {
  transcript: 'mark this done',
  actor: { id: 'known-jordan', name: 'Jordan' },
  context: { surface: 'task', taskId: 't-a1', visibleHeading: 'Search revamp' },
};

describe('voiceRequestLine', () => {
  describe('an action the server already applied (route: fast-path-action)', () => {
    const applied = {
      ...SPOKEN,
      route: 'fast-path-action',
      ack: 'Heard "mark this done". Moved "Ship the search revamp" to done.',
    };

    // The sentence that must not survive onto this route: it describes work
    // to do, and the work is already done.
    it('never orders the agent to do what the server did', () => {
      expect(voiceRequestLine(applied)).not.toContain('act on it through');
    });

    it('says the board already moved', () => {
      expect((voiceRequestLine(applied) as string).toLowerCase()).toContain('already');
    });

    // Reconcile, not re-do — named in the line, because the line is the only
    // thing the recipient is guaranteed to read.
    it('asks the agent to reconcile rather than repeat it', () => {
      const text = (voiceRequestLine(applied) as string).toLowerCase();
      expect(text).toContain('reconcile');
      expect(text).toContain('do not redo');
    });

    it('carries what was said and what the speaker was told', () => {
      const text = voiceRequestLine(applied) as string;
      expect(text).toContain('mark this done');
      expect(text).toContain('Moved "Ship the search revamp" to done.');
      expect(text).toContain('[voice.request]');
    });

    it('carries the speaker and where they were standing', () => {
      const text = voiceRequestLine(applied) as string;
      expect(text).toContain('Jordan');
      expect(text).toContain('t-a1');
      expect(text).toContain('Search revamp');
    });

    it('never renders "undefined" when the payload is thin', () => {
      const text = voiceRequestLine({ route: 'fast-path-action' }) as string;
      expect(text).not.toContain('undefined');
      expect(text).toContain('[voice.request]');
    });

    it('clips a long ack rather than pasting a paragraph into the channel', () => {
      const text = voiceRequestLine({
        ...applied,
        ack: `Heard "mark this done". ${'x'.repeat(400)}`,
      }) as string;
      expect(text).not.toContain('x'.repeat(200));
      expect(text).toContain('…');
    });
  });

  /**
   * POSITIVE CONTROL, and the assertion that matters most in this file: the
   * route that needs the agent must render EXACTLY what it rendered before
   * this split existed. If extracting the renderer quietly reworded the
   * imperative, every agent on every board would start reading a different
   * instruction for the same event — and no other test here would notice,
   * because they all assert on the new route.
   */
  describe('an utterance the agent still owns (route: agent)', () => {
    const sent = {
      ...SPOKEN,
      transcript: 'file a ticket for the flaky upload',
      route: 'agent',
      ack: 'Heard "file a ticket for the flaky upload". Sent to the workspace agent.',
    };

    it('renders the imperative, unchanged', () => {
      const text = voiceRequestLine(sent) as string;
      expect(text).toBe(
        '[voice.request] by Jordan (at task t-a1, near "Search revamp"): ' +
          '"file a ticket for the flaky upload" — act on it through the task/edit tools; ' +
          'the speaker was told: "Heard "file a ticket for the flaky upload". Sent to the workspace agent."',
      );
    });

    it('does not tell the agent the work is already done', () => {
      const text = voiceRequestLine(sent) as string;
      expect(text.toLowerCase()).not.toContain('already applied');
      expect(text.toLowerCase()).not.toContain('do not redo');
    });

    it('keeps the imperative for a queued utterance too', () => {
      const text = voiceRequestLine({ ...sent, route: 'agent-queued' }) as string;
      expect(text).toContain('act on it through the task/edit tools');
    });

    // A row from a server older than this route field, or one whose route
    // never made it onto the wire, must still reach the agent. Silence is the
    // failure mode with no recovery: the utterance is not replayed.
    it('keeps the imperative when the payload names no route at all', () => {
      const { route: _route, ...unrouted } = sent;
      const text = voiceRequestLine(unrouted) as string;
      expect(text).toContain('act on it through the task/edit tools');
    });
  });

  /**
   * A lookup the server already answered. Nothing moved and nothing is
   * pending, so the row is pure context noise — suppressed since the fast
   * path existed, and the suppression is now stated as its own branch rather
   * than inferred from which routes fall past a guard clause.
   */
  describe('a lookup the server already answered (route: fast-path)', () => {
    it('renders nothing at all', () => {
      expect(voiceRequestLine({ ...SPOKEN, route: 'fast-path', ack: 'Lookup — opening.' })).toBe(
        null,
      );
    });

    // Positive control for the suppression: the SAME payload renders a line
    // on every other route, so the null above is about the route and not
    // about something inert in the payload.
    it('renders a line for that same payload on any other route', () => {
      const payload = { ...SPOKEN, ack: 'Lookup — opening.' };
      expect(voiceRequestLine({ ...payload, route: 'fast-path-action' })).not.toBe(null);
      expect(voiceRequestLine({ ...payload, route: 'agent' })).not.toBe(null);
    });
  });
});
