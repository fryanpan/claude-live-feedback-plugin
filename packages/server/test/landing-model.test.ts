import { describe, expect, it } from 'bun:test';
import type { Comment, Thread, User } from '@feedback/core';
import {
  type LandingInputDoc,
  NEEDS_YOU_CAP,
  buildLandingModel,
  threadHref,
} from '../src/landing.ts';

/**
 * The landing model's shaping rules, unit-tested away from HTTP.
 *
 * What is worth pinning here is the arithmetic a person reads off the page and
 * cannot check: which threads count as waiting, how long each has waited, what
 * survives the cap, what the denominator says, and how the workspace rows rank.
 * The HTML e2e (`landing-page.test.ts`) proves the route renders this model;
 * this file proves the model is right.
 */

const AGENT: User = { id: 'agent-one', name: 'One', kind: 'known', color: '#111' };
// `classifyActor` reads the identity axis here: a `known` browser identity
// whose id is not agent-shaped is a person. Asserted below rather than
// assumed — the whole band turns on this classification.
const PERSON: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#222' };

let seq = 0;
function comment(author: User, ts: number, text = 'hello'): Comment {
  seq += 1;
  return { id: `c${seq}`, author, text, ts };
}

function thread(id: string, comments: Comment[], status: 'open' | 'resolved' = 'open'): Thread {
  return {
    id,
    status,
    anchor: { type: 'doc' } as unknown as Thread['anchor'],
    commentCount: comments.length,
    lastActivity: comments.reduce((m, c) => Math.max(m, c.ts), 0),
    createdBy: comments[0]?.author ?? PERSON,
    comments,
  };
}

function doc(over: Partial<LandingInputDoc> & { threads: Thread[] }): LandingInputDoc {
  return {
    groupKey: '/proj/alpha',
    groupLabel: 'alpha',
    groupKind: 'project',
    groupHref: '/projects/alpha',
    name: 'README.md',
    link: { kind: 'doc', docId: 'd1' },
    artifactId: 'd1',
    ...over,
  };
}

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

describe('needs-you band membership', () => {
  it('includes a thread whose newest comment is an agent, and excludes one a person answered', () => {
    const waiting = doc({
      name: 'waiting.md',
      link: { kind: 'doc', docId: 'w' },
      artifactId: 'w',
      threads: [
        thread('t-wait', [comment(PERSON, NOW - 4 * HOUR), comment(AGENT, NOW - 3 * HOUR)]),
      ],
    });
    const answered = doc({
      name: 'answered.md',
      link: { kind: 'doc', docId: 'a' },
      artifactId: 'a',
      threads: [
        thread('t-answered', [comment(AGENT, NOW - 4 * HOUR), comment(PERSON, NOW - 3 * HOUR)]),
      ],
    });

    const model = buildLandingModel([waiting, answered], NOW);

    // Positive control in the same pass: the band CAN see a thread on this
    // fixture, so the answered thread's absence is a decision and not a
    // harness that produced no rows at all.
    expect(model.needsYou.map((r) => r.threadId)).toEqual(['t-wait']);
    expect(model.needsYouTotal).toBe(1);
  });

  it('excludes a RESOLVED thread whose newest comment is an agent, keeping its open twin', () => {
    const d = doc({
      threads: [
        thread('t-open', [comment(AGENT, NOW - 2 * HOUR)]),
        thread('t-resolved', [comment(AGENT, NOW - 5 * HOUR)], 'resolved'),
      ],
    });
    expect(buildLandingModel([d], NOW).needsYou.map((r) => r.threadId)).toEqual(['t-open']);
  });
});

describe('the wait clock', () => {
  it('measures from the START of the unanswered run, not its newest comment', () => {
    // An agent that keeps posting on its own thread must not reset its own
    // clock — the band sorts oldest-first precisely so the thing at most risk
    // of never being answered comes up first.
    const d = doc({
      threads: [
        thread('t', [
          comment(PERSON, NOW - 80 * HOUR),
          comment(AGENT, NOW - 60 * HOUR), // run starts here
          comment(AGENT, NOW - 2 * HOUR), // follow-up, must NOT be the clock
        ]),
      ],
    });
    const row = buildLandingModel([d], NOW).needsYou[0]!;
    expect(row.since).toBe(NOW - 60 * HOUR);
    expect(row.waitedMs).toBe(60 * HOUR);
    // Positive control on the same row: the excerpt DOES come from the newest
    // comment of the run, so `since` differing from it is a choice about the
    // clock and not a row built from the wrong comment throughout.
    expect(row.askedBy).toBe('One');
  });

  it('sorts longest-waiting first', () => {
    const mk = (id: string, agoHours: number) =>
      doc({
        name: id,
        link: { kind: 'doc', docId: id },
        artifactId: id,
        threads: [thread(`t-${id}`, [comment(AGENT, NOW - agoHours * HOUR)])],
      });
    const model = buildLandingModel([mk('fresh', 1), mk('old', 90), mk('mid', 20)], NOW);
    expect(model.needsYou.map((r) => r.threadId)).toEqual(['t-old', 't-mid', 't-fresh']);
  });
});

describe('the cap and its denominator', () => {
  it('renders at most NEEDS_YOU_CAP rows while reporting the full total', () => {
    const docs: LandingInputDoc[] = [];
    for (let i = 0; i < NEEDS_YOU_CAP + 5; i += 1) {
      docs.push(
        doc({
          name: `f${i}.md`,
          link: { kind: 'doc', docId: `d${i}` },
          artifactId: `d${i}`,
          threads: [thread(`t${i}`, [comment(AGENT, NOW - (i + 1) * HOUR)])],
        }),
      );
    }
    const model = buildLandingModel(docs, NOW);
    expect(model.needsYouTotal).toBe(NEEDS_YOU_CAP + 5);
    expect(model.needsYou).toHaveLength(NEEDS_YOU_CAP);
    // The cap keeps the OLDEST, which is the whole point of the ordering —
    // truncating the sorted-wrong end would silently drop the rows the band
    // exists for.
    expect(model.needsYou[0]!.threadId).toBe(`t${NEEDS_YOU_CAP + 4}`);
  });
});

describe('the ask excerpt', () => {
  it('flattens and clips a long comment, and leaves a short one whole', () => {
    const long = 'x'.repeat(500);
    const d = doc({
      threads: [
        thread('t-long', [comment(AGENT, NOW - HOUR, `**bold**\n\nline\n${long}`)]),
        thread('t-short', [comment(AGENT, NOW - 2 * HOUR, 'short one')]),
      ],
    });
    const rows = buildLandingModel([d], NOW).needsYou;
    const short = rows.find((r) => r.threadId === 't-short')!;
    const clipped = rows.find((r) => r.threadId === 't-long')!;
    expect(short.ask).toBe('short one');
    expect(clipped.ask.length).toBeLessThanOrEqual(160);
    expect(clipped.ask.endsWith('…')).toBe(true);
    expect(clipped.ask).not.toContain('**');
    expect(clipped.ask).not.toContain('\n');
  });
});

describe('deep links', () => {
  it('opens a doc thread AT the comment and a task thread AT the task', () => {
    expect(threadHref({ kind: 'doc', docId: 'a b' }, 'th 1')).toBe('/review/a%20b?thread=th%201');
    expect(threadHref({ kind: 'task', workspaceId: 'w 1', taskId: 't 1' }, 'th')).toBe(
      '/workspaces/w%201?task=t%201',
    );
  });
});

describe('group rows', () => {
  it('ranks by needs-you count, then by real thread recency', () => {
    const g = (key: string, waiting: number, lastTs: number) =>
      doc({
        groupKey: key,
        groupLabel: key,
        groupHref: `/projects/${key}`,
        name: `${key}.md`,
        link: { kind: 'doc', docId: key },
        artifactId: key,
        threads: [
          ...Array.from({ length: waiting }, (_, i) =>
            thread(`t-${key}-${i}`, [comment(AGENT, lastTs - i * 1000)]),
          ),
          thread(`t-${key}-quiet`, [comment(PERSON, lastTs)]),
        ],
      });
    // The two criteria are made to DISAGREE: `b` has the most waiting items and
    // the OLDEST activity, so an implementation that ranked on recency alone
    // would put it last. A fixture where the busiest group is also the freshest
    // passes either way and proves nothing about the primary key.
    const model = buildLandingModel(
      [g('a', 1, NOW - 50 * HOUR), g('b', 3, NOW - 80 * HOUR), g('c', 1, NOW - 2 * HOUR)],
      NOW,
    );
    expect(model.groups.map((r) => r.label)).toEqual(['b', 'c', 'a']);
    expect(model.groups[0]!.needsYou).toBe(3);
    // Recency is the newest thread activity, which is what separates c from a
    // once their equal needs-you counts have tied.
    expect(model.groups[1]!.lastActivity).toBe(NOW - 2 * HOUR);
  });

  it('counts an artifact once however many member docs it has, and never counts a task room', () => {
    const member = (rel: string) =>
      doc({
        name: rel,
        link: { kind: 'doc', docId: rel },
        artifactId: 'ws-1',
        threads: [],
      });
    // No `artifactId` at all — a task body room is not an artifact. Built
    // literally rather than through `doc()`, whose default supplies one.
    const task: LandingInputDoc = {
      groupKey: 'w-9',
      groupLabel: 'Board',
      groupKind: 'workspace',
      groupHref: '/workspaces/w-9',
      name: 'Ship the thing',
      link: { kind: 'task', workspaceId: 'w-9', taskId: 't-9' },
      threads: [thread('t-task', [comment(AGENT, NOW - HOUR)])],
    };

    const model = buildLandingModel([member('a.md'), member('b.md'), task], NOW);
    const proj = model.groups.find((r) => r.label === 'alpha')!;
    const board = model.groups.find((r) => r.label === 'Board')!;
    // Positive control: the project's two member docs DID arrive (they are one
    // artifact, not zero), so the board's zero is an exclusion and not an
    // empty run.
    expect(proj.artifacts).toBe(1);
    expect(board.artifacts).toBe(0);
    expect(board.needsYou).toBe(1);
    expect(model.totalArtifacts).toBe(1);
  });

  it('counts docs whose bound source file is gone, and not the ones still there', () => {
    const gone = doc({
      name: 'gone.md',
      link: { kind: 'doc', docId: 'g' },
      artifactId: 'g',
      sourceMissing: true,
      threads: [],
    });
    const here = doc({
      name: 'here.md',
      link: { kind: 'doc', docId: 'h' },
      artifactId: 'h',
      threads: [],
    });
    const row = buildLandingModel([gone, here], NOW).groups[0]!;
    expect(row.artifacts).toBe(2);
    expect(row.missingSources).toBe(1);
  });

  it('reports zero recency for a group whose docs have no threads at all', () => {
    const row = buildLandingModel([doc({ threads: [] })], NOW).groups[0]!;
    expect(row.lastActivity).toBe(0);
    expect(row.openThreads).toBe(0);
  });
});
