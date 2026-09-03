/**
 * A session must not receive its own comments back as channel events.
 *
 * Measured 2026-08-24 by four sessions independently: post a comment with
 * `create_thread` / `post_reply`, and the resulting `thread.created` /
 * `thread.replied` frame comes straight back into the AUTHOR's own context as
 * a `<channel source="claude-workspaces" …>` block carrying the full body it
 * just wrote. The wake carries zero information and the cost scales with post
 * length, so a long review comment is thousands of wasted tokens.
 *
 * The hub half of this rule already existed — `emitHubChannelMessage` drops a
 * `task.*` / `decision.*` frame whose `actor.id` is this agent. The doc-shaped
 * half (`thread.*`) had no such gate, which is the defect.
 *
 * EVERY AMBIGUITY RESOLVES TOWARDS DELIVERING. A duplicated wake is a visible
 * annoyance; a dropped one is silence, and an agent cannot tell silence from
 * "nobody commented" — the exact failure class watches exist to close. So an
 * event whose author cannot be positively determined is forwarded.
 */
import { describe, expect, it } from 'vitest';
import { isSelfAuthoredEvent } from '../src/self-authored.ts';

const SELF = 'agent-live-feedback';
const OTHER = 'known-bryan';

const comment = (id: string) => ({ id: 'c1', author: { id, name: 'Whoever' }, text: 'hi', ts: 1 });

describe('thread.replied — the post_reply path, which carries the comment', () => {
  it('suppresses a reply this session authored', () => {
    expect(
      isSelfAuthoredEvent('thread.replied', { docId: 'd', comment: comment(SELF) }, SELF),
    ).toBe(true);
  });

  // The positive control. A suppression bug that drops everything passes the
  // test above on its own, and the failure it causes is invisible.
  it('delivers a reply somebody else authored', () => {
    expect(
      isSelfAuthoredEvent('thread.replied', { docId: 'd', comment: comment(OTHER) }, SELF),
    ).toBe(false);
  });

  // rooms.ts fires `thread.replied` with no comment on the undo-answer path
  // (nothing was said; a stamp was removed). The newest comment in the thread
  // is NOT its author, so there is nothing to match on — deliver.
  it('delivers a reply that carries no comment, whatever the thread holds', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.replied',
        { docId: 'd', thread: { comments: [comment(SELF), comment(SELF)] } },
        SELF,
      ),
    ).toBe(false);
  });
});

describe('thread.created — fires with comment undefined', () => {
  // fireEvent's own comment at rooms.ts says so, and server.ts's
  // queueCommentRows reads the opening comment off the thread for the same
  // reason. This mirrors that fallback rather than inventing a second one.
  it('reads the opening comment off the thread and suppresses its own', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.created',
        { docId: 'd', thread: { comments: [comment(SELF)] } },
        SELF,
      ),
    ).toBe(true);
  });

  it('delivers a thread somebody else opened', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.created',
        { docId: 'd', thread: { comments: [comment(OTHER)] } },
        SELF,
      ),
    ).toBe(false);
  });

  it('delivers a thread whose opening comment has no author id', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.created',
        { docId: 'd', thread: { comments: [{ text: 'hi' }] } },
        SELF,
      ),
    ).toBe(false);
  });
});

describe('thread.resolved / thread.reopened — an actor, not a comment', () => {
  // Same class of wake and the same emptiness: you already know you clicked
  // resolve. The frame carries `actor` precisely because there is no comment
  // on a status change, so the attribution is available and unambiguous.
  it('suppresses a status change this session performed', () => {
    for (const event of ['thread.resolved', 'thread.reopened']) {
      expect(isSelfAuthoredEvent(event, { docId: 'd', actor: { id: SELF } }, SELF)).toBe(true);
    }
  });

  it('delivers a status change somebody else performed', () => {
    for (const event of ['thread.resolved', 'thread.reopened']) {
      expect(isSelfAuthoredEvent(event, { docId: 'd', actor: { id: OTHER } }, SELF)).toBe(false);
    }
  });

  // An older server stamps no actor. A blank attribution is not a match.
  it('delivers a status change from a server that stamps no actor', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.resolved',
        { docId: 'd', thread: { comments: [comment(SELF)] } },
        SELF,
      ),
    ).toBe(false);
  });
});

describe('events this must never touch', () => {
  // The suggesting agent has to hear the VERDICT on its own suggestion —
  // `suggestion.accepted` / `.rejected` carry the SUGGESTER as author, so
  // matching on it would swallow exactly the outcome the agent is waiting
  // for. rooms.ts's fireSuggestionEvent exists to deliver it.
  it('delivers every suggestion verdict, including on its own suggestion', () => {
    for (const event of ['suggestion.created', 'suggestion.accepted', 'suggestion.rejected']) {
      expect(
        isSelfAuthoredEvent(
          event,
          { docId: 'd', sid: 's', suggestion: { author: { id: SELF } } },
          SELF,
        ),
      ).toBe(false);
    }
  });

  it('delivers doc.sync_error and anything else it has no rule for', () => {
    expect(isSelfAuthoredEvent('doc.sync_error', { docId: 'd', path: '/a.md' }, SELF)).toBe(false);
    expect(isSelfAuthoredEvent('replay.gap', { docId: 'd' }, SELF)).toBe(false);
    expect(isSelfAuthoredEvent('something.new', { docId: 'd', comment: comment(SELF) }, SELF)).toBe(
      false,
    );
  });
});

describe('an identity that does not name THIS session never suppresses', () => {
  // `CW_AGENT_NAME` unset resolves every anonymous session to `known-agent`,
  // and a session launched as "Bryan" resolves to `known-bryan` — the very id
  // Bryan's own browser comments carry. Matching on either would let one
  // session swallow another's comments, or an agent swallow the human's.
  // Same rule agent-watches.ts applies to a shared watch set: a category is
  // not somebody.
  it('refuses to suppress under a known-* identity', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.replied',
        { docId: 'd', comment: comment('known-agent') },
        'known-agent',
      ),
    ).toBe(false);
    expect(
      isSelfAuthoredEvent(
        'thread.replied',
        { docId: 'd', comment: comment('known-bryan') },
        'known-bryan',
      ),
    ).toBe(false);
  });

  it('refuses to suppress under an empty identity', () => {
    expect(isSelfAuthoredEvent('thread.replied', { docId: 'd', comment: comment('') }, '')).toBe(
      false,
    );
    expect(
      isSelfAuthoredEvent('thread.replied', { docId: 'd', comment: comment('  ') }, '   '),
    ).toBe(false);
  });
});

describe('garbage in never suppresses', () => {
  it('delivers a payload that is not an object', () => {
    for (const payload of [null, undefined, 'a string', 42, []]) {
      expect(isSelfAuthoredEvent('thread.replied', payload, SELF)).toBe(false);
    }
  });

  it('delivers when the author id is not a string', () => {
    expect(
      isSelfAuthoredEvent(
        'thread.replied',
        { docId: 'd', comment: { author: { id: { nested: true } } } },
        SELF,
      ),
    ).toBe(false);
  });
});

/**
 * That the RENDERER consults this gate is asserted where the renderer now
 * lives: `channel-messages.test.ts` drives `createChannelMessages` with a
 * frame this session authored and reads the notification sink, which is a
 * question three regexes over `mcp.ts` could only approximate. They are gone
 * rather than kept beside it — a source read passes on a handler that was
 * deleted and fails on a rename that kept the feature working, and the two
 * halves of the rule (the doc gate and the hub actor check) are both driven
 * there now.
 */
