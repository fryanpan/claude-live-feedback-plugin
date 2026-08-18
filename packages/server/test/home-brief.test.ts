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
  FIRST_VISIT_WINDOW_MS,
  HomeBriefStore,
  acceptBrief,
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
    expect(md).toContain('**3** items are queued for your review below.');
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
          ev('workspace.goal_updated', NOW + 5),
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
    expect(md).toContain('**2** items are queued for your review below.');
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

describe('buildBriefPrompt', () => {
  it('carries the instructions, the since label, the digest, and the queue count', () => {
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
      'since Friday',
    );
    expect(system).toContain('My standing instructions');
    expect(system).toContain('never invent');
    expect(user).toContain('Covering: since Friday.');
    expect(user).toContain(
      'task.transitioned todo→done · [Ship the fuzzy matcher](/workspaces/ws-1?task=t-1) · by Beacon',
    );
    expect(user).toContain('4 item(s) are queued');
  });

  it('a task row carries its deep link; a row with no task carries no link at all', () => {
    // Why: the first brief in the field had no links, and the digest was the
    // reason — it carried titles only, and the prompt forbade inventing links,
    // so a compliant model had nothing linkable to work from. The presence
    // and the absence sit in ONE prompt so the absence is not vacuous.
    const { user } = buildBriefPrompt(
      input([
        ev('task.created', NOW + 1, { taskId: 't-2', actor: 'Beacon' }),
        ev('workspace.goal_updated', NOW + 2, { actor: 'Beacon' }),
      ]),
      'x',
      'y',
    );
    const rows = user.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('[Rewrite the retry helper](/workspaces/ws-1?task=t-2)');
    expect(rows[0]).toContain(taskDeepLink('ws-1', 't-2'));
    expect(rows[1]).toContain('workspace.goal_updated');
    expect(rows[1]).not.toContain('](');
  });

  it('the guardrail permits copying digest links and forbids inventing them', () => {
    const { system } = buildBriefPrompt(input([]), 'x', 'y');
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
    expect(DEFAULT_INSTRUCTIONS).toContain('Under 150 words');
    expect(DEFAULT_INSTRUCTIONS).toContain('Include inline links');
  });

  it('taskDeepLink is the same relative shape the board opens on load, ids URL-encoded', () => {
    expect(taskDeepLink('ws-1', 't-1')).toBe('/workspaces/ws-1?task=t-1');
    expect(taskDeepLink('ws 1', 't/1&x')).toBe('/workspaces/ws%201?task=t%2F1%26x');
  });

  it('bounds the digest to the newest rows and says so', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      ev('task.created', NOW + i, { taskId: 't-1' }),
    );
    const { user } = buildBriefPrompt(input(many, 0), 'x', 'y');
    expect(user).toContain('(newest 120 of 200)');
    expect(user.split('\n').filter((l) => l.startsWith('- ')).length).toBe(120);
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
});

describe('briefIsFresh', () => {
  const stored = { markdown: 'md', since: 100, eventCount: 3, generatedAt: NOW };
  it('fresh only when the marker and the event count both match', () => {
    expect(briefIsFresh(stored, 100, 3)).toBe(true);
    expect(briefIsFresh(stored, 200, 3)).toBe(false); // marker moved
    expect(briefIsFresh(stored, 100, 4)).toBe(false); // board moved
    expect(briefIsFresh(undefined, 100, 3)).toBe(false);
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
