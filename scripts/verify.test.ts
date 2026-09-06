import { describe, expect, it } from 'vitest';
import {
  CI_ONLY,
  MEMBERS,
  type Member,
  ciRunTokens,
  overallExit,
  parityProblems,
  runMembers,
} from './verify.ts';

const member = (id: string): Member => ({ id, title: id, argv: [id], ci: id });

/** A stub clock: each read advances a fixed step, so no assertion below is a
 *  wall-clock assertion — the durations are chosen by the test, not measured. */
function stubClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

describe('runMembers', () => {
  it('reports a failure that CI would report, and keeps going past it', () => {
    const ran: string[] = [];
    const results = runMembers(
      [member('lint'), member('loc:audit'), member('typecheck')],
      (m) => {
        ran.push(m.id);
        return m.id === 'loc:audit' ? 1 : 0;
      },
      { now: stubClock(1000) },
    );

    expect(ran).toEqual(['lint', 'loc:audit', 'typecheck']);
    expect(results.map((r) => [r.member.id, r.exitCode])).toEqual([
      ['lint', 0],
      ['loc:audit', 1],
      ['typecheck', 0],
    ]);
    expect(overallExit(results)).not.toBe(0);
  });

  it('exits zero only when every member did', () => {
    const all = [member('lint'), member('typecheck')];
    expect(overallExit(runMembers(all, () => 0, { now: stubClock(1) }))).toBe(0);
  });

  it('counts a member killed by a signal as a failure, not as a zero', () => {
    // Bun.spawnSync reports exitCode null when a child dies on a signal. A
    // wrapper that passed that through unchanged would report a green run over
    // a suite the OOM killer stopped — the exact "believed pass" this command
    // exists to make impossible.
    const results = runMembers([member('test:server')], () => null, { now: stubClock(1) });
    expect(results[0]?.exitCode).not.toBe(0);
    expect(overallExit(results)).not.toBe(0);
  });

  it('stops at the first failure under --bail, and still reports non-zero', () => {
    const ran: string[] = [];
    const results = runMembers(
      [member('lint'), member('loc:audit'), member('typecheck')],
      (m) => {
        ran.push(m.id);
        return m.id === 'loc:audit' ? 3 : 0;
      },
      { bail: true, now: stubClock(1) },
    );

    expect(ran).toEqual(['lint', 'loc:audit']);
    expect(results).toHaveLength(2);
    expect(overallExit(results)).not.toBe(0);
  });

  it('times each member from the injected clock', () => {
    const results = runMembers([member('lint'), member('typecheck')], () => 0, {
      now: stubClock(500),
    });
    expect(results.map((r) => r.ms)).toEqual([500, 500]);
  });
});

describe('ciRunTokens', () => {
  const workflow = [
    'jobs:',
    '  verify:',
    '    steps:',
    '      - run: bun install --frozen-lockfile',
    '      # Prose about the gates often names one: bun run check:mentioned-in-prose',
    '      - name: A step whose NAME says bun run check:named-not-run',
    '        run: bun run typecheck',
    '      - name: A block scalar',
    '        run: |',
    '          bun run scripts/collector.ts --exclude 1 > out.json',
    '',
    '          # bun run check:commented-inside-a-block',
    '          bun run check:plugin-version --base origin/main',
    '      - run: echo done',
    '  other-job:',
    '    steps:',
    '      - run: bun run notes:eval',
  ].join('\n');

  it('takes commands only from run: values, never from comments or step names', () => {
    expect(ciRunTokens(workflow, 'verify')).toEqual([
      'typecheck',
      'scripts/collector.ts',
      'check:plugin-version',
    ]);
  });

  it('does not reach into the next job', () => {
    expect(ciRunTokens(workflow, 'verify')).not.toContain('notes:eval');
    expect(ciRunTokens(workflow, 'other-job')).toEqual(['notes:eval']);
  });

  it('says so when the job is not there, rather than reporting an empty set', () => {
    // An empty list is the answer that would make parity vacuously pass.
    expect(() => ciRunTokens(workflow, 'renamed-job')).toThrow(/renamed-job/);
  });
});

describe('parityProblems', () => {
  const members = [member('lint'), member('typecheck')];

  it('is quiet when the two sides agree', () => {
    expect(parityProblems(members, ['lint', 'typecheck'])).toEqual([]);
  });

  it('names a gate CI gained that no member covers', () => {
    const problems = parityProblems(members, ['lint', 'typecheck', 'check:invented']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('check:invented');
  });

  it('names a gate a member claims that CI no longer runs', () => {
    const problems = parityProblems(members, ['lint']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('typecheck');
  });

  it('accepts a CI-only gate that carries a written reason', () => {
    const ciOnly = Object.keys(CI_ONLY);
    expect(ciOnly.length).toBeGreaterThan(0);
    expect(parityProblems(members, ['lint', 'typecheck', ...ciOnly])).toEqual([]);
  });
});

describe('MEMBERS', () => {
  it('has no duplicate ids, so --only cannot be ambiguous', () => {
    const ids = MEMBERS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every member a runnable command except parity, which runs in-process', () => {
    for (const m of MEMBERS) {
      if (m.id === 'parity') expect(m.argv).toEqual([]);
      else expect(m.argv.length).toBeGreaterThan(0);
    }
  });
});
