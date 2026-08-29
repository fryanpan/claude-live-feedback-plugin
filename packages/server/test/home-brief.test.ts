/**
 * The Home brief's pure half: deterministic brief, staleness, event
 * filtering, the prompt, and the sidecar store. All fixtures synthetic.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIEF_EVENT_TYPES,
  type BriefEventRow,
  DEFAULT_INSTRUCTIONS,
  DIGEST_MAX_EVENTS,
  FIRST_VISIT_WINDOW_MS,
  HomeBriefStore,
  acceptBrief,
  briefCoverage,
  briefEvents,
  briefIsFresh,
  buildBriefPrompt,
  deterministicBrief,
  effectiveSince,
  homeSidecarPath,
  readEventRows,
  readerKey,
  taskDeepLink,
} from '../src/home-brief.ts';

const NOW = 1_770_000_000_000;

const titles = new Map<string, string>([
  ['t-1', 'Ship the fuzzy matcher'],
  ['t-2', 'Rewrite the retry helper'],
  ['t-3', 'Draft the launch notes'],
]);
const input = (events: BriefEventRow[], total = 0) => ({
  workspaceId: 'ws-1',
  events,
  queue: { total },
  titleOf: (id: string) => titles.get(id),
});

const ev = (event: string, ts: number, rest: Record<string, unknown> = {}): BriefEventRow => ({
  event,
  ts,
  ...rest,
});

/** The coverage of a window nothing was dropped from. */
const uncapped = (since: number) => ({ from: since, capped: false, shown: 0, total: 0 });

describe('briefEvents', () => {
  it('keeps only brief-relevant types, strictly after the marker, oldest first', () => {
    const rows = [
      ev('task.created', NOW + 30, { taskId: 't-1' }),
      ev('agent.heartbeat', NOW + 20),
      ev('server.tick', NOW + 25),
      ev('task.transitioned', NOW + 10, { taskId: 't-2', to: 'done' }),
      ev('task.created', NOW, { taskId: 't-3' }), // at the marker: already read
      ev('voice.request', NOW + 40),
    ];
    const out = briefEvents(rows, NOW);
    expect(out.map((r) => r.event)).toEqual(['task.transitioned', 'task.created']);
    expect(out[0]?.ts).toBe(NOW + 10);
  });

  it('the noisy types are excluded by the allowlist — heartbeats cannot stale a brief', () => {
    // The loop guard: a heartbeat lands every few seconds, so counting it
    // would re-queue a model call on every read forever.
    expect(BRIEF_EVENT_TYPES.has('agent.heartbeat')).toBe(false);
    expect(BRIEF_EVENT_TYPES.has('server.tick')).toBe(false);
    expect(BRIEF_EVENT_TYPES.has('agent.attached')).toBe(false);
    expect(BRIEF_EVENT_TYPES.has('task.transitioned')).toBe(true);
  });

  it('tolerates malformed rows (no ts, non-string event)', () => {
    const out = briefEvents([{ event: 42 }, { event: 'task.created' }, {}], 0);
    expect(out).toEqual([]);
  });
});

describe('effectiveSince', () => {
  it('uses the marker when there is one, a bounded window when there is none', () => {
    expect(effectiveSince(NOW - 5, NOW)).toBe(NOW - 5);
    expect(effectiveSince(0, NOW)).toBe(NOW - FIRST_VISIT_WINDOW_MS);
  });
});

describe('deterministicBrief', () => {
  it('says quiet when nothing happened, and still renders the queue denominator', () => {
    const md = deterministicBrief(input([], 3));
    expect(md).toContain('Quiet since you last caught up');
    expect(md).toContain('What needs your review is queued below.');
    expect(md).not.toContain('**3**');
  });

  it('an empty queue is stated, not omitted — an absent line reads as an all-clear', () => {
    const md = deterministicBrief(input([], 0));
    expect(md).toContain('Nothing is queued for your review right now.');
  });

  it('groups finished / filed / decided with real titles', () => {
    const md = deterministicBrief(
      input(
        [
          ev('task.transitioned', NOW + 1, { taskId: 't-1', to: 'done' }),
          ev('task.transitioned', NOW + 2, { taskId: 't-2', to: 'in-progress' }),
          ev('task.created', NOW + 3, { taskId: 't-3' }),
          ev('decision.answered', NOW + 4, { taskId: 't-2' }),
          ev('workspace.goals_changed', NOW + 5),
        ],
        2,
      ),
    );
    // Every title is a deep link to its task — the brief renders as markdown
    // on the same page the links point at, so the evidence is one tap away.
    expect(md).toContain(
      '**Finished:** [Ship the fuzzy matcher](/workspaces/ws-1?task=t-1) (1 task).',
    );
    expect(md).toContain('**Started:** [Rewrite the retry helper](/workspaces/ws-1?task=t-2).');
    expect(md).toContain(
      '**Filed:** 1 new task — [Draft the launch notes](/workspaces/ws-1?task=t-3).',
    );
    expect(md).toContain(
      '**Decided:** 1 decision was answered — [Rewrite the retry helper](/workspaces/ws-1?task=t-2).',
    );
    expect(md).toContain('**Goals:** edited once.');
    expect(md).toContain('What needs your review is queued below.');
  });

  it('caps long title lists instead of shipping a wall', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      ev('task.transitioned', NOW + i, { taskId: `t-x${i}`, to: 'done' }),
    );
    const md = deterministicBrief({
      workspaceId: 'ws-1',
      events: many,
      queue: { total: 0 },
      titleOf: (id) => `Task ${id}`,
    });
    expect(md).toContain(', and 4 more');
    expect(md).toContain('(9 tasks)');
  });

  it('events of only quiet kinds still produce a sentence, not silence', () => {
    const md = deterministicBrief(input([ev('task.assigned', NOW + 1, { taskId: 't-1' })], 0));
    expect(md).toContain('1 small change landed');
  });
});

describe('an answer that was taken back is not news', () => {
  /**
   * The fresh-eyes finding: the What's New brief still said "1 decision was
   * answered" after that answer had been undone. The withdrawal writes its
   * own event (`decision.answer_withdrawn`), which the brief neither counted
   * nor read — so the answered row stood alone and the brief asserted a
   * decision the board no longer held.
   */
  const answered = (ts: number, taskId = 't-2') =>
    ev('decision.answered', ts, { taskId, actor: { name: 'Riley' }, answer: 'Ship it.' });
  const withdrawn = (ts: number, taskId = 't-2') =>
    ev('decision.answer_withdrawn', ts, {
      taskId,
      actor: { name: 'Riley' },
      answer: 'Ship it.',
      answeredBy: 'Riley',
    });

  it('the withdrawal is a brief-relevant event — it stales the brief that asserted the answer', () => {
    expect(BRIEF_EVENT_TYPES.has('decision.answer_withdrawn')).toBe(true);
  });

  it('briefEvents pairs a withdrawal with the answer it undid and drops both', () => {
    const out = briefEvents([answered(NOW + 1), withdrawn(NOW + 2)], NOW);
    expect(out).toEqual([]);
  });

  it('the deterministic brief says nothing was decided once the answer is undone', () => {
    const md = deterministicBrief(input(briefEvents([answered(NOW + 1), withdrawn(NOW + 2)], NOW)));
    expect(md).not.toContain('**Decided:**');
    // Positive control: the answer alone is still news.
    expect(deterministicBrief(input(briefEvents([answered(NOW + 1)], NOW)))).toContain(
      '**Decided:** 1 decision was answered',
    );
  });

  it('a second answer after the undo counts once, and only the standing one', () => {
    const rows = briefEvents([answered(NOW + 1), withdrawn(NOW + 2), answered(NOW + 3)], NOW);
    expect(rows.map((r) => r.ts)).toEqual([NOW + 3]);
    expect(deterministicBrief(input(rows))).toContain('**Decided:** 1 decision was answered');
  });

  it('pairs within a task only — undoing one decision leaves another standing', () => {
    const rows = briefEvents([answered(NOW + 1, 't-1'), withdrawn(NOW + 2, 't-2')], NOW);
    expect(rows.map((r) => [r.event, r.taskId])).toEqual([
      ['decision.answered', 't-1'],
      ['decision.answer_withdrawn', 't-2'],
    ]);
  });

  it("pairs with the task's own answer only — an answered review item on the same ticket stands", () => {
    // Only the legacy task-level answer can be withdrawn; a real review row's
    // answer carries `reviewItemId` and has no undo. Pairing by task alone
    // popped the review item's answer and kept asserting the withdrawn one.
    const rowAnswer = ev('decision.answered', NOW + 2, {
      taskId: 't-2',
      reviewItemId: 'r-abc',
      actor: { name: 'Riley' },
      answer: 'Keep disk.',
    });
    const rows = briefEvents([answered(NOW + 1), rowAnswer, withdrawn(NOW + 3)], NOW);
    expect(rows).toEqual([rowAnswer]);
    expect(deterministicBrief(input(rows))).toContain('**Decided:** 1 decision was answered');
    // And a withdrawal with only a review-item answer in the window has
    // nothing to cancel: it stands as a reopening rather than eating the row.
    const lone = briefEvents([rowAnswer, withdrawn(NOW + 3)], NOW);
    expect(lone.map((r) => r.event)).toEqual(['decision.answered', 'decision.answer_withdrawn']);
  });

  it('a withdrawal of an answer given before the window is reported as a reopening', () => {
    const rows = briefEvents([answered(NOW - 5), withdrawn(NOW + 2)], NOW);
    expect(rows.map((r) => r.event)).toEqual(['decision.answer_withdrawn']);
    const md = deterministicBrief(input(rows));
    expect(md).not.toContain('**Decided:**');
    expect(md).toContain(
      '**Reopened:** an answer was taken back on [Rewrite the retry helper](/workspaces/ws-1?task=t-2).',
    );
  });

  it('the digest the model reads carries neither half of an undone answer', () => {
    const rows = briefEvents([answered(NOW + 1), withdrawn(NOW + 2)], NOW);
    const { user } = buildBriefPrompt(input(rows), 'x', uncapped(NOW));
    expect(user).not.toContain('decision.answered');
    expect(user).not.toContain('Ship it.');
    // Positive control: a standing withdrawal is a digest line of its own,
    // and the words it took back ride along so the model can name them.
    const lone = buildBriefPrompt(
      input(briefEvents([withdrawn(NOW + 2)], NOW)),
      'x',
      uncapped(NOW),
    );
    expect(lone.user).toContain('decision.answer_withdrawn');
    expect(lone.user).toContain('answer: "Ship it."');
  });
});

describe('buildBriefPrompt', () => {
  it('carries the instructions, the since label, the digest, and a countless queue line', () => {
    const { system, user } = buildBriefPrompt(
      input(
        [
          ev('task.transitioned', NOW + 1, {
            taskId: 't-1',
            from: 'todo',
            to: 'done',
            actor: { name: 'Beacon' },
          }),
        ],
        4,
      ),
      'My standing instructions',
      uncapped(NOW),
    );
    expect(system).toContain('My standing instructions');
    expect(system).toContain('never invent');
    expect(user).toContain(`Covering: everything since ${new Date(NOW).toUTCString()}.`);
    expect(user).toContain(
      'task.transitioned todo→done · [Ship the fuzzy matcher](/workspaces/ws-1?task=t-1) · by Beacon',
    );
    expect(user).toContain(
      "Items needing the reader's review are queued below the brief — never state how many.",
    );
    expect(user).not.toContain('4 item(s)');
  });

  it('a task row carries its deep link; a row with no task carries no link at all', () => {
    // Why: the first brief in the field had no links, and the digest was the
    // reason — it carried titles only, and the prompt forbade inventing links,
    // so a compliant model had nothing linkable to work from. The presence
    // and the absence sit in ONE prompt so the absence is not vacuous.
    const { user } = buildBriefPrompt(
      input([
        ev('task.created', NOW + 1, { taskId: 't-2', actor: 'Beacon' }),
        ev('workspace.goals_changed', NOW + 2, { actor: 'Beacon' }),
      ]),
      'x',
      uncapped(NOW),
    );
    const rows = user.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('[Rewrite the retry helper](/workspaces/ws-1?task=t-2)');
    expect(rows[0]).toContain(taskDeepLink('ws-1', 't-2'));
    expect(rows[1]).toContain('workspace.goals_changed');
    expect(rows[1]).not.toContain('](');
  });

  it('a decision.answered row carries the recorded answer text — a refusal must be readable as one', () => {
    // Why: the brief told a reader he had approved a force-push he had
    // refused. The task title stated the affirmative outcome ("X approves the
    // rollout"), the digest line said only `decision.answered · by <reader>`,
    // and the model composed the two into consent. The answer text is the
    // ONLY carrier of polarity — title and status cannot say which way a
    // decision went — so the digest line must quote it.
    const refusal = ev('decision.answered', NOW + 1, {
      taskId: 't-9',
      actor: { name: 'Riley' },
      answer: 'No, do not roll it out. Review the acceptance criteria first.',
    });
    const approval = ev('decision.answered', NOW + 2, {
      taskId: 't-9',
      actor: { name: 'Riley' },
      answer: 'Yes, ship it.',
    });
    const { user } = buildBriefPrompt(
      {
        workspaceId: 'ws-1',
        events: [refusal, approval],
        queue: { total: 0 },
        titleOf: () => 'Riley approves the rollout',
      },
      'x',
      uncapped(NOW),
    );
    const rows = user.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(2);
    // The refusal and the approval are distinguishable from the digest alone.
    expect(rows[0]).toContain(
      'answer: "No, do not roll it out. Review the acceptance criteria first."',
    );
    expect(rows[1]).toContain('answer: "Yes, ship it."');
  });

  it('answer snippets are bounded and flattened; absent or non-string answers add nothing', () => {
    const long = `First line says no.\n\nThen ${'a very long justification '.repeat(20)}`;
    const { user } = buildBriefPrompt(
      input([
        ev('decision.answered', NOW + 1, { taskId: 't-2', answer: long }),
        ev('decision.answered', NOW + 2, { taskId: 't-2' }), // legacy row, no answer
        ev('decision.answered', NOW + 3, { taskId: 't-2', answer: 42 }), // hostile shape
      ]),
      'x',
      uncapped(NOW),
    );
    const rows = user.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(3); // a multi-line answer must not split its row
    expect(rows[0]).toContain('answer: "First line says no. Then a very long justification');
    expect(rows[0]).toContain(' … ');
    const quoted = rows[0]?.match(/answer: "([^"]*)"/)?.[1] ?? '';
    expect(quoted.length).toBeLessThanOrEqual(140);
    // The positive control above proves the matcher sees answers; these two
    // absences are therefore non-vacuous.
    expect(rows[1]).not.toContain('answer:');
    expect(rows[2]).not.toContain('answer:');
  });

  it('a verdict at the END of a long answer survives the snippet cut', () => {
    // Why: the considerate refusal leads with the hedge — "you've raised fair
    // points … but no". A leading-only cut renders exactly the agreement half
    // and drops the verdict, which is WORSE than no answer: the digest then
    // looks like it carries evidence of consent. The snippet keeps both ends.
    const hedge =
      'You have raised entirely fair points about the acceptance criteria, and the sequencing ' +
      'you laid out makes sense to me, and I appreciate the detailed writeup here, ';
    const answer = `${hedge}but no — do not roll it out until those criteria are met.`;
    expect(answer.length).toBeGreaterThan(140); // the cut must actually bite
    const { user } = buildBriefPrompt(
      input([ev('decision.answered', NOW + 1, { taskId: 't-2', answer })]),
      'x',
      uncapped(NOW),
    );
    const row = user.split('\n').find((l) => l.startsWith('- ')) ?? '';
    expect(row).toContain('do not roll it out until those criteria are met.');
    expect(row).toContain(' … '); // and the truncation is visible, not silent
  });

  it('the guardrail tells the model a truncated answer cannot be read past its visible text', () => {
    // The two-ended snippet keeps most verdicts; this is the fail-safe for
    // the ones that land in the elided middle. Degrading to "an answer was
    // recorded" is correct there; guessing is the incident again.
    const { system } = buildBriefPrompt(input([]), 'x', uncapped(NOW));
    // The prompt wraps its sentences across '\n'-joined lines, so match on a
    // flattened view — the model reads it flowed, not line by line.
    const flowed = system.replace(/\n/g, ' ');
    expect(flowed).toContain('" … " marks an elided middle');
    expect(flowed).toContain('treat the polarity as undeterminable');
  });

  it('the guardrail says polarity lives in the answer text, not in titles or status', () => {
    // "decision.answered + task done" is a legitimate pattern on a healthy
    // board (a refusal resolves the request), so the prompt must forbid the
    // exact composition that produced the false approval.
    const { system } = buildBriefPrompt(input([]), 'x', uncapped(NOW));
    expect(system).toContain('states a goal, not an outcome');
    expect(system).toContain('only the quoted answer text says which way it went');
    expect(system).toContain('may be a refusal');
  });

  it('the guardrail permits copying digest links and forbids inventing them', () => {
    const { system } = buildBriefPrompt(input([]), 'x', uncapped(NOW));
    expect(system).toContain('copied exactly');
    expect(system).toContain('never fabricate a URL');
    // The old flat prohibition — "never invent names, numbers, links" — is
    // what made links impossible; it must not come back.
    expect(system).not.toMatch(/never invent[^.]*\blinks\b/);
    // The word budget belongs to the instructions, so the system prompt must
    // not carry a competing hard number.
    expect(system).not.toContain('under 200 words');
  });

  it('the default instructions ask for evidence links and own the word budget', () => {
    expect(DEFAULT_INSTRUCTIONS).toContain('Show the evidence');
    // 110, not 150 (Bryan, 2026-08-18, the Home-brief ticket). Asserted as the whole
    // phrase, and with the superseded number asserted ABSENT beside it, so a
    // revert cannot pass by leaving both numbers in the text.
    expect(DEFAULT_INSTRUCTIONS).toContain('Under 110 words');
    expect(DEFAULT_INSTRUCTIONS).not.toContain('150 words');
    expect(DEFAULT_INSTRUCTIONS).toContain('Include inline links');
  });

  it('the default instructions are the only place the word budget is stated', () => {
    // A second number anywhere in the prompt contradicts a reader who edits
    // these instructions — which is the whole reason the budget lives here.
    const { system, user } = buildBriefPrompt(input([], 0), DEFAULT_INSTRUCTIONS, uncapped(NOW));
    const budgets = `${system}\n${user}`.match(/\b\d+ words\b/g) ?? [];
    expect(budgets).toEqual(['110 words']);
  });

  it('taskDeepLink is the same relative shape the board opens on load, ids URL-encoded', () => {
    expect(taskDeepLink('ws-1', 't-1')).toBe('/workspaces/ws-1?task=t-1');
    expect(taskDeepLink('ws 1', 't/1&x')).toBe('/workspaces/ws%201?task=t%2F1%26x');
  });

  it('bounds the digest to the newest rows and says so', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      ev('task.created', NOW + i, { taskId: 't-1' }),
    );
    const { user } = buildBriefPrompt(input(many, 0), 'x', briefCoverage(many, NOW));
    expect(user).toContain('(newest 120 of 200)');
    expect(user.split('\n').filter((l) => l.startsWith('- ')).length).toBe(120);
  });

  it("states the digest's REAL start when the cap drops the older half of the window", () => {
    // Bryan, 2026-08-18: "Summary claims to include all work from the start of
    // time ... it seems to be only summarizing the last few days?" The window
    // and the digest are different spans whenever the cap bites, and the prompt
    // used to name the window. Measured on the live board the same day: 553
    // events in the 7-day window, 120 kept, spanning 6.7 hours — so the model
    // was told "the last 7 days" over a third of a day of evidence.
    const stamp = (i: number) => NOW + i * 60_000;
    const many = Array.from({ length: 200 }, (_, i) =>
      ev('task.created', stamp(i), { taskId: 't-1' }),
    );
    const coverage = briefCoverage(many, NOW);
    // The oldest row that survives the cap is the digest's real start.
    expect(coverage.from).toBe(stamp(200 - DIGEST_MAX_EVENTS));
    expect(coverage.from).toBeGreaterThan(NOW);

    const { user } = buildBriefPrompt(input(many, 0), 'x', coverage);
    expect(user).toContain(
      `Covering: the 120 most recent changes, starting ${new Date(coverage.from).toUTCString()}.`,
    );
    expect(user).toContain('(200 in total)');
    expect(user).toContain('never say the brief covers a week, a month');
    // And the window's own start must NOT be presented as the coverage start.
    expect(user).not.toContain(`Covering: everything since ${new Date(NOW).toUTCString()}.`);
  });
});

describe('briefCoverage', () => {
  it('an uncapped window covers itself, and reports its own denominator', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      ev('task.created', NOW + i, { taskId: 't-1' }),
    );
    expect(briefCoverage(rows, NOW)).toEqual({ from: NOW, capped: false, shown: 3, total: 3 });
    // The boundary is inclusive: exactly at the cap nothing is dropped.
    const exact = Array.from({ length: DIGEST_MAX_EVENTS }, (_, i) =>
      ev('task.created', NOW + i, { taskId: 't-1' }),
    );
    expect(briefCoverage(exact, NOW).capped).toBe(false);
    expect(briefCoverage(exact, NOW).from).toBe(NOW);
  });

  it('a capped window starts at the oldest row that survived, not at the marker', () => {
    const stamp = (i: number) => NOW + 1_000 + i;
    const rows = Array.from({ length: DIGEST_MAX_EVENTS + 1 }, (_, i) =>
      ev('task.created', stamp(i), { taskId: 't-1' }),
    );
    const cov = briefCoverage(rows, NOW);
    expect(cov.capped).toBe(true);
    expect(cov.shown).toBe(DIGEST_MAX_EVENTS);
    expect(cov.total).toBe(DIGEST_MAX_EVENTS + 1);
    expect(cov.from).toBe(stamp(1));
    expect(cov.from).not.toBe(NOW);
  });

  it('falls back to the marker when the surviving rows carry no usable ts', () => {
    // briefEvents guarantees numeric ts, but coverage is also handed stored
    // rows; a missing stamp must not produce `from: undefined` on the payload.
    const rows = Array.from({ length: DIGEST_MAX_EVENTS + 1 }, () => ({
      event: 'task.created',
    })) as BriefEventRow[];
    expect(briefCoverage(rows, NOW).from).toBe(NOW);
  });
});

describe('acceptBrief', () => {
  it('refuses null, empty, and absurdly long replies; accepts a real one', () => {
    expect(acceptBrief(null)).toBeNull();
    expect(acceptBrief('')).toBeNull();
    expect(acceptBrief('   \n ')).toBeNull();
    expect(acceptBrief('ok.')).toBeNull(); // an upper bound alone is satisfied by emptiness
    expect(acceptBrief('x'.repeat(5000))).toBeNull();
    const real = '**Finished:** the retry helper rewrite landed.\n\n2 items are queued below.';
    expect(acceptBrief(real)).toBe(real);
  });

  it('refuses a reply that stops inside a markdown token, and accepts the closed twin', () => {
    // The production shape (2026-08-18): a brief cut inside a link URL, which
    // renders as visible `](/workspaces/…?task=t-` in the card. The pairs are
    // written closed-then-cut so the refusal cannot be vacuous — each `null`
    // has a sibling that the same function accepts.
    const closed = '**Finished:** [the retry helper](/workspaces/ws-1?task=t-1) landed today.';
    expect(acceptBrief(closed)).toBe(closed);
    expect(acceptBrief('**Finished:** [the retry helper](/workspaces/ws-1?task=t-')).toBeNull();
    expect(acceptBrief('**Finished:** the helper landed. See [the retry helper')).toBeNull();

    const bold = '**Finished:** the retry helper landed today, and the queue is clear.';
    expect(acceptBrief(bold)).toBe(bold);
    expect(acceptBrief('**Finished:** the retry helper landed. **Started')).toBeNull();

    const code = 'The `retry` helper landed today, and the review queue is clear.';
    expect(acceptBrief(code)).toBe(code);
    expect(acceptBrief('The `retry` helper landed today. Also `resolveThre')).toBeNull();
  });

  it('a parenthesis after the last link does not read as an unclosed one', () => {
    // The guard looks for a `](` with no `)` after it; ordinary prose that
    // uses brackets or parentheses later in the line must survive, or the
    // reader loses a perfectly good brief on every read.
    const md = '**Finished:** [the retry helper](/workspaces/ws-1?task=t-1) (and its tests).';
    expect(acceptBrief(md)).toBe(md);
    const listy = '- [one](/workspaces/ws-1?task=t-1)\n- [two](/workspaces/ws-1?task=t-2)';
    expect(acceptBrief(listy)).toBe(listy);
  });
});

describe('briefIsFresh', () => {
  const stored = { markdown: 'md', since: 100, eventCount: 3, generatedAt: NOW };
  it('fresh only when the marker and the event count both match', () => {
    expect(briefIsFresh(stored, 100, 3)).toBe(true);
    expect(briefIsFresh(stored, 200, 3)).toBe(false); // marker moved
    expect(briefIsFresh(stored, 100, 4)).toBe(false); // board moved
    expect(briefIsFresh(undefined, 100, 3)).toBe(false);
  });

  it('a brief persisted mid-link is never fresh, so it stops being served', () => {
    // Sidecars written before the truncation guard hold cut text, and by
    // every other measure they are fresh — same marker, same event count —
    // so without this they render forever. The whole twin is asserted first,
    // which is what makes the refusal a statement about the TEXT.
    const whole = { ...stored, markdown: '**Finished:** [a task](/workspaces/ws-1?task=t-1).' };
    const cut = { ...stored, markdown: '**Finished:** [a task](/workspaces/ws-1?task=t-' };
    expect(briefIsFresh(whole, 100, 3)).toBe(true);
    expect(briefIsFresh(cut, 100, 3)).toBe(false);
  });
});

describe('readerKey', () => {
  it('is the normalized name — the same person on two devices is one reader', () => {
    expect(readerKey('  Bryan ')).toBe('bryan');
    expect(readerKey('BRYAN')).toBe('bryan');
  });
});

describe('HomeBriefStore', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'home-brief-'));

  it('markRead persists per person, survives a fresh store, and reports what it replaced', () => {
    const dir = tmp();
    try {
      const store = new HomeBriefStore(dir);
      expect(store.lastReadAt('w-1', 'Bryan')).toBe(0);
      const first = store.markRead('w-1', 'Bryan', 1000);
      expect(first).toEqual({ lastReadAt: 1000, previous: 0 });
      const second = store.markRead('w-1', 'bryan ', 2000); // same account, other device
      expect(second).toEqual({ lastReadAt: 2000, previous: 1000 });
      // A different person has their own marker.
      expect(store.lastReadAt('w-1', 'Jordan')).toBe(0);
      // Fresh store = fresh process: the marker is on disk, not in memory.
      const reloaded = new HomeBriefStore(dir);
      expect(reloaded.lastReadAt('w-1', 'Bryan')).toBe(2000);
      expect(existsSync(homeSidecarPath(dir, 'w-1'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('undo is expressible: marking read AT the previous value restores it', () => {
    const dir = tmp();
    try {
      const store = new HomeBriefStore(dir);
      store.markRead('w-1', 'Bryan', 1000);
      const moved = store.markRead('w-1', 'Bryan', 2000);
      store.markRead('w-1', 'Bryan', moved.previous);
      expect(store.lastReadAt('w-1', 'Bryan')).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('instructions default, persist, keep history on change, and drop cached briefs', () => {
    const dir = tmp();
    try {
      const store = new HomeBriefStore(dir);
      expect(store.instructions('w-1')).toBe(DEFAULT_INSTRUCTIONS);
      store.storeBrief('w-1', 'Bryan', {
        markdown: 'old brief',
        since: 1,
        eventCount: 1,
        generatedAt: 2,
      });
      store.setInstructions('w-1', 'Be terser.');
      expect(store.instructions('w-1')).toBe('Be terser.');
      // The cached brief was written under the old instructions.
      expect(store.brief('w-1', 'Bryan')).toBeUndefined();
      // The overwritten text is user content: kept, not destroyed.
      store.setInstructions('w-1', 'Be even terser.');
      const raw = JSON.parse(readFileSync(homeSidecarPath(dir, 'w-1'), 'utf8'));
      expect(raw.instructionsHistory).toEqual(['Be terser.']);
      const reloaded = new HomeBriefStore(dir);
      expect(reloaded.instructions('w-1')).toBe('Be even terser.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable sidecar loads as empty instead of taking the pane down', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'workspaces'), { recursive: true });
    writeFileSync(join(dir, 'workspaces', 'w-1.home.json'), 'not json');
    try {
      const store = new HomeBriefStore(dir);
      expect(store.lastReadAt('w-1', 'Bryan')).toBe(0);
      expect(store.instructions('w-1')).toBe(DEFAULT_INSTRUCTIONS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readEventRows', () => {
  it('reads the log tolerant of a torn tail line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-brief-events-'));
    try {
      mkdirSync(join(dir, 'workspaces'), { recursive: true });
      writeFileSync(
        join(dir, 'workspaces', 'w-1.events.jsonl'),
        `${JSON.stringify({ event: 'task.created', ts: 1 })}\n{"event":"task.cr`,
      );
      const rows = readEventRows(dir, 'w-1');
      expect(rows).toEqual([{ event: 'task.created', ts: 1 }]);
      expect(readEventRows(dir, 'w-missing')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
