import { describe, expect, it } from 'bun:test';
import { classifyActor } from '../src/activity';

/**
 * `classifyActor` reads `author.id` and `author.name` off a value that the
 * TYPES say is a `User` and that the DATA does not guarantee. Comment authors
 * are persisted in the CRDT by whatever wrote them, going back months and
 * across several shapes of the field, so a legacy comment can carry an author
 * with no `id` at all — or an author that is a bare string.
 *
 * That was latent for as long as the function was only ever called on threads
 * from one live workspace. Calling it across every doc on the server (the
 * landing page's needs-you band) reached the old rows and took `GET /` to a
 * 500 in production:
 *
 *   TypeError: undefined is not an object (evaluating 'author.id.startsWith')
 *     at classifyActor (activity.ts:160)
 *     at unansweredRun (review-queue.ts:152)
 *     at buildLandingModel (landing.ts:201)
 *
 * The guard is deliberately NOT a behaviour change for well-formed input:
 * every case below that has a usable id/name/kind must classify exactly as it
 * did before, which is what the positive-control block asserts.
 */
describe('classifyActor over malformed authors', () => {
  // POSITIVE CONTROL — if these ever change, the guard has altered real
  // behaviour rather than only absorbing junk.
  it('still classifies every well-formed author exactly as before', () => {
    expect(classifyActor({ id: 'u1', name: 'Bryan', kind: 'person' })).toBe('person');
    expect(classifyActor({ id: 'agent-live-feedback', name: 'Live Feedback', kind: 'known' })).toBe(
      'agent',
    );
    expect(classifyActor({ id: 'known-agent', name: 'x', kind: 'known' })).toBe('agent');
    expect(classifyActor({ id: 'u2', name: 'Agent', kind: 'known' })).toBe('agent');
    expect(classifyActor({ id: 'u3', name: 'Someone', kind: 'Agent' })).toBe('agent');
    // No `kind` at all is the documented "assume agent" fallthrough.
    expect(classifyActor({ id: 'u4', name: 'Someone' })).toBe('agent');
  });

  it('does not throw when id is missing', () => {
    expect(() =>
      classifyActor({ name: 'Someone' } as unknown as Parameters<typeof classifyActor>[0]),
    ).not.toThrow();
  });

  it('does not throw when name is missing', () => {
    expect(() =>
      classifyActor({ id: 'u5' } as unknown as Parameters<typeof classifyActor>[0]),
    ).not.toThrow();
  });

  it('does not throw when the author is undefined or a bare string', () => {
    expect(() =>
      classifyActor(undefined as unknown as Parameters<typeof classifyActor>[0]),
    ).not.toThrow();
    expect(() =>
      classifyActor('Bryan' as unknown as Parameters<typeof classifyActor>[0]),
    ).not.toThrow();
  });

  it('keeps the safe direction for an unclassifiable author', () => {
    // An author we cannot read declares nothing, which is the same state as
    // `kind == null` — and that already resolves to `agent`, deliberately:
    // an agent misfiled as a person launders the audit log and can resurrect
    // a thread a human just resolved, while the reverse only over-filters.
    expect(classifyActor({} as unknown as Parameters<typeof classifyActor>[0])).toBe('agent');
    expect(classifyActor(undefined as unknown as Parameters<typeof classifyActor>[0])).toBe(
      'agent',
    );
  });
});
