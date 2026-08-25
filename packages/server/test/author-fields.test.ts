/**
 * A comment author persisted before the field settled can be a bare STRING —
 * measured on the live corpus: 26 of 1,825 comments, e.g. `"author": "claude"`
 * sitting next to `{ id: 'known-bryan', name: 'Bryan', ... }` in the same
 * thread. The string IS the name, so the information is recoverable and every
 * reader was throwing it away.
 *
 * `classifyActor` was already repaired to not CRASH on one of these. This is
 * the other half: the two readers that never crashed and quietly lost the
 * attribution instead — which lands in `activity.jsonl`, i.e. the stream the
 * weekly review reads.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { emailIdentityId } from '@feedback/core';
import {
  authorFields,
  classifyActor,
  isOwnerActor,
  ownerIdentityIds,
  registerOwnerIdentity,
  resetOwnerIdentities,
} from '../src/activity';
import { eventsForDoc } from '../src/activity-backfill';

describe('authorFields — legacy string authors carry a recoverable name', () => {
  test('reads a bare string author as the name', () => {
    expect(authorFields('claude')).toEqual({ id: undefined, name: 'claude' });
  });

  test('positive control: a well-formed author is passed through unchanged', () => {
    expect(authorFields({ id: 'known-bryan', name: 'Bryan', kind: 'known' })).toEqual({
      id: 'known-bryan',
      name: 'Bryan',
    });
  });

  test('an unreadable author yields no fields rather than throwing', () => {
    expect(authorFields(null)).toEqual({ id: undefined, name: undefined });
    expect(authorFields(undefined)).toEqual({ id: undefined, name: undefined });
    expect(authorFields(42)).toEqual({ id: undefined, name: undefined });
  });

  test('drops non-string id/name rather than passing the wrong type through', () => {
    expect(authorFields({ id: 7, name: { first: 'B' } })).toEqual({
      id: undefined,
      name: undefined,
    });
  });
});

describe('isOwnerActor over the same shapes', () => {
  test('recovers ownership from a legacy string author naming the owner', () => {
    expect(isOwnerActor('Bryan')).toBe(true);
  });

  test('a legacy string author naming an agent is not the owner', () => {
    expect(isOwnerActor('claude')).toBe(false);
  });

  test('an unreadable author is not the owner, and does not throw', () => {
    expect(isOwnerActor(null)).toBe(false);
    expect(isOwnerActor(undefined)).toBe(false);
  });

  test('positive control: both well-formed owner spellings still match', () => {
    expect(isOwnerActor({ id: 'known-bryan', name: 'someone else' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-1', name: 'Bryan' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-1', name: 'Someone' })).toBe(false);
  });
});

/**
 * The check was `id === 'known-bryan' || name === 'Bryan'`, by literal. The
 * moment the owner's identity becomes `user-<hash>` that stops matching and
 * fails SILENTLY — no error, just an owner-activity view that reads empty and
 * a weekly review that under-counts. So the rename is pinned here rather than
 * discovered in production.
 */
describe('owner recognition survives the email rename', () => {
  afterEach(() => resetOwnerIdentities());

  test('a registered email identity is the owner', () => {
    const id = emailIdentityId('owner@example.com');
    // Before registering: the very shape that will arrive on every comment
    // once the owner signs in by email is NOT recognized.
    expect(isOwnerActor({ id, name: 'Owner' })).toBe(false);
    registerOwnerIdentity(id);
    expect(isOwnerActor({ id, name: 'Owner' })).toBe(true);
  });

  test('positive control: both pre-email spellings still match afterwards', () => {
    registerOwnerIdentity(emailIdentityId('owner@example.com'));
    expect(isOwnerActor({ id: 'known-bryan', name: 'whoever' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-1', name: 'Bryan' })).toBe(true);
    expect(isOwnerActor('Bryan')).toBe(true);
  });

  test('negative control: another email identity is not the owner', () => {
    registerOwnerIdentity(emailIdentityId('owner@example.com'));
    const other = emailIdentityId('someone-else@example.com');
    expect(isOwnerActor({ id: other, name: 'Someone Else' })).toBe(false);
    expect(isOwnerActor({ id: 'anon-1', name: 'Someone Else' })).toBe(false);
  });

  test('registering blank changes nothing', () => {
    registerOwnerIdentity('   ');
    expect(ownerIdentityIds()).toEqual(['known-bryan']);
    expect(isOwnerActor({ id: '', name: '' })).toBe(false);
  });
});

describe('classifyActor is UNCHANGED by the normalization', () => {
  // The string authors in the corpus already classified as 'agent' — by luck,
  // via the `kind == null` fallthrough rather than by reading the name. Pin
  // that, so a normalization that starts feeding `name` in cannot silently
  // move any of them across the person/agent line.
  test('a legacy string author still classifies as agent', () => {
    expect(classifyActor('claude')).toBe('agent');
    expect(classifyActor('Bryan')).toBe('agent');
  });

  test('positive control: every well-formed classification is unchanged', () => {
    expect(classifyActor({ id: 'known-bryan', name: 'Bryan', kind: 'known' })).toBe('person');
    expect(classifyActor({ id: 'anon-9', name: 'Visitor', kind: 'anon' })).toBe('person');
    expect(classifyActor({ id: 'known-agent', name: 'x' })).toBe('agent');
    expect(classifyActor({ id: 'agent-7', name: 'x' })).toBe('agent');
    expect(classifyActor({ id: 'x', name: 'Agent' })).toBe('agent');
    expect(classifyActor({ id: 'x', name: 'y', kind: 'agent' })).toBe('agent');
  });
});

/**
 * The unit tests above are true and prove nothing about the caller — the
 * defect being fixed lives in what `eventsForDoc` WRITES, and a normalizer
 * nobody called would pass every one of them. So drive the real emitter over a
 * thread shaped like the corpus row that prompted this: Bryan's well-formed
 * comment and the agent's legacy string reply, in one thread.
 */
describe('eventsForDoc — the activity stream keeps the legacy attribution', () => {
  const TS = Date.parse('2026-06-01T12:00:00Z');
  const meta = { docId: 'd1', title: 'README', kind: 'markdown' } as never;
  const thread = {
    id: 't1',
    status: 'open',
    lastActivity: TS + 1000,
    createdBy: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
    comments: [
      {
        id: 'c1',
        author: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
        text: 'why?',
        ts: TS,
      },
      { id: 'c2', author: 'claude', text: 'because x', ts: TS + 1000 },
    ],
  } as never;

  test('the string-author reply names its actor instead of nobody', () => {
    const events = eventsForDoc(meta, [thread]);
    const reply = events.find((e) => e.type === 'reply');
    expect(reply?.actorName).toBe('claude');
    expect(reply?.actor).toBe('agent');
    expect(reply?.isOwner).toBe(false);
  });

  test('positive control: the well-formed comment beside it is unchanged', () => {
    const events = eventsForDoc(meta, [thread]);
    const first = events.find((e) => e.type === 'comment');
    expect(first?.actorId).toBe('known-bryan');
    expect(first?.actorName).toBe('Bryan');
    expect(first?.actor).toBe('person');
    expect(first?.isOwner).toBe(true);
  });
});

describe('eventsForDoc — a resolved thread whose createdBy is legacy-shaped', () => {
  // `thread.createdBy` is persisted in the CRDT the same way `comment.author`
  // is, so it can be a bare string too. The resolve event is attributed from
  // it, and it is emitted on a different code path from the comment loop.
  const TS = Date.parse('2026-06-01T12:00:00Z');
  const meta = { docId: 'd2', title: 'README', kind: 'markdown' } as never;

  test('the resolve event still names its actor', () => {
    const thread = {
      id: 't2',
      status: 'resolved',
      lastActivity: TS + 5000,
      createdBy: 'Bryan',
      comments: [{ id: 'c1', author: 'claude', text: 'done', ts: TS }],
    } as never;
    const resolve = eventsForDoc(meta, [thread]).find((e) => e.type === 'resolve');
    expect(resolve?.actorName).toBe('Bryan');
    expect(resolve?.isOwner).toBe(true);
  });

  test('positive control: a well-formed createdBy is unchanged', () => {
    const thread = {
      id: 't3',
      status: 'resolved',
      lastActivity: TS + 5000,
      createdBy: { id: 'known-bryan', name: 'Bryan', kind: 'known' },
      comments: [{ id: 'c1', author: { id: 'known-bryan', name: 'Bryan' }, text: 'done', ts: TS }],
    } as never;
    const resolve = eventsForDoc(meta, [thread]).find((e) => e.type === 'resolve');
    expect(resolve?.actorId).toBe('known-bryan');
    expect(resolve?.actorName).toBe('Bryan');
  });
});
