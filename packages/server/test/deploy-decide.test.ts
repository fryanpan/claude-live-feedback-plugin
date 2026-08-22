/**
 * The pure half of a deploy: given what git says about the deploy source,
 * what are we allowed to do to it?
 *
 * Everything here is a table. The whole point of splitting this out is that
 * the interesting cases — someone committed on the deploy source, a file
 * about to be overwritten is being edited — are the ones a real repo will
 * not reproduce on demand.
 */
import { describe, expect, it } from 'bun:test';
import { decideDeploy, parseAheadBehind } from '../src/deploy.ts';

const base = {
  behind: 0,
  ahead: 0,
  dirtyPaths: [] as string[],
  incomingPaths: [] as string[],
  currentRef: 'aaaaaaa',
};

describe('parseAheadBehind', () => {
  it('reads `git rev-list --left-right --count HEAD...@{u}`', () => {
    // Left is HEAD (ahead), right is upstream (behind). Getting this
    // backwards would turn "somebody committed here" into "we are behind"
    // and fast-forward straight over their work.
    expect(parseAheadBehind('2\t7\n')).toEqual({ ahead: 2, behind: 7 });
    expect(parseAheadBehind('0\t0')).toEqual({ ahead: 0, behind: 0 });
  });

  it('answers null on anything it does not recognise', () => {
    // A null must reach the caller as an error, never as 0/0 — which reads
    // as "up to date" and is the quietest possible way to skip a deploy.
    expect(parseAheadBehind('')).toBeNull();
    expect(parseAheadBehind('fatal: no upstream configured')).toBeNull();
    expect(parseAheadBehind('3')).toBeNull();
    expect(parseAheadBehind('x\ty')).toBeNull();
  });
});

describe('decideDeploy', () => {
  it('nothing to fetch is up-to-date, and up-to-date is not a deploy', () => {
    const d = decideDeploy({ ...base });
    expect(d.kind).toBe('up-to-date');
    expect(d.reason).toContain('aaaaaaa');
  });

  it('behind with a clean tree is a fast-forward', () => {
    const d = decideDeploy({ ...base, behind: 24, incomingPaths: ['packages/server/src/x.ts'] });
    expect(d.kind).toBe('fast-forward');
    expect(d.reason).toContain('24');
  });

  it('refuses when the deploy source has commits origin does not', () => {
    // Someone committed in the primary checkout. A reset or a rebase would
    // destroy that; the only correct move is to say so and stop.
    const d = decideDeploy({ ...base, behind: 3, ahead: 1 });
    expect(d.kind).toBe('refuse-diverged');
    expect(d.reason).toContain('1 commit');
  });

  it('refuses ahead-only too — a restart would deploy unpushed code', () => {
    const d = decideDeploy({ ...base, ahead: 2 });
    expect(d.kind).toBe('refuse-diverged');
  });

  it('refuses when an incoming file is also modified locally, and names it', () => {
    const d = decideDeploy({
      ...base,
      behind: 4,
      dirtyPaths: ['packages/server/src/server.ts', 'docs/plan.md'],
      incomingPaths: ['packages/server/src/server.ts', 'README.md'],
    });
    expect(d.kind).toBe('refuse-dirty');
    if (d.kind !== 'refuse-dirty') throw new Error('unreachable');
    expect(d.blockingPaths).toEqual(['packages/server/src/server.ts']);
    expect(d.reason).toContain('packages/server/src/server.ts');
    // The doc it did NOT block on must not be dressed up as a blocker.
    expect(d.blockingPaths).not.toContain('docs/plan.md');
  });

  it('a modified file the pull does not touch does NOT block the deploy', () => {
    // This is the case that decides whether the feature is usable at all.
    // The deploy source hosts bound review documents, so `docs/**` is
    // modified for hours at a time during ordinary editing. A blanket
    // "refuse while dirty" would refuse almost every real deploy — and
    // `git merge --ff-only` itself only refuses when the incoming change
    // touches a locally-modified file.
    const d = decideDeploy({
      ...base,
      behind: 4,
      dirtyPaths: ['docs/product/plans/live-plan.md'],
      incomingPaths: ['packages/server/src/server.ts'],
    });
    expect(d.kind).toBe('fast-forward');
  });

  it('divergence outranks dirt — the worse fact is the one reported', () => {
    const d = decideDeploy({
      ...base,
      behind: 4,
      ahead: 1,
      dirtyPaths: ['a.ts'],
      incomingPaths: ['a.ts'],
    });
    expect(d.kind).toBe('refuse-diverged');
  });
});

describe('decideDeploy — what the browser is actually running', () => {
  // The question `behind === 0` answers is "is the CHECKOUT current", and
  // that was never the question a deploy is asked. Somebody pulls by hand,
  // does not restart, and the checkout is at origin's tip while the served
  // client is still the bundle built from the older commit.

  it('a checkout at the tip whose served client is older still needs a deploy', () => {
    const d = decideDeploy({ ...base, servedRef: 'older99' });
    expect(d.kind).toBe('restart-only');
    // Both refs, because "needs a deploy" without saying which two things
    // disagree is a sentence that sends someone to read git log.
    expect(d.reason).toContain('older99');
    expect(d.reason).toContain('aaaaaaa');
  });

  it('and a served client built from HEAD is up-to-date', () => {
    // The other direction on the same fixture: a rule that always restarts
    // is as wrong as one that never does, and only this pair catches it.
    const d = decideDeploy({ ...base, servedRef: 'aaaaaaa' });
    expect(d.kind).toBe('up-to-date');
  });

  it('an unreadable served ref is not a match', () => {
    // Nothing published, or a release with no provenance. Claiming the
    // browser is current is claiming something we did not check.
    const d = decideDeploy({ ...base, servedRef: null });
    expect(d.kind).toBe('restart-only');
  });

  it('a deployment that publishes no client keeps the git answer', () => {
    // `servedRef` absent means this server has no release root — dev,
    // staging, a bare bin.ts. There is no served client to be stale, so
    // restarting would bounce every live editor for nothing.
    const d = decideDeploy({ ...base });
    expect(d.kind).toBe('up-to-date');
  });

  it('an unknown current ref is not compared against', () => {
    // git could not say what the checkout is on. Restarting to rebuild from
    // a ref we cannot name is not an improvement on saying nothing.
    const d = decideDeploy({ ...base, currentRef: null, servedRef: 'older99' });
    expect(d.kind).toBe('up-to-date');
  });

  it('a stale served client does not outrank a pull', () => {
    // The fast-forward path restarts anyway, so the two never compete —
    // and reporting `restart-only` here would skip the commits.
    const d = decideDeploy({
      ...base,
      behind: 3,
      incomingPaths: ['packages/server/src/x.ts'],
      servedRef: 'older99',
    });
    expect(d.kind).toBe('fast-forward');
  });

  it('nor a divergence', () => {
    const d = decideDeploy({ ...base, ahead: 1, servedRef: 'older99' });
    expect(d.kind).toBe('refuse-diverged');
  });
});
