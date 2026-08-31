/**
 * Task capture from meeting speech: the prompt contract, the strict reply
 * parse, the deterministic match guards, and the find-or-create pipeline.
 *
 * The guards get most of the assertions because they are the feature's
 * promise: a wrong link in the notes is worse than no link, so every path
 * that could fabricate one — a hallucinated match index, a reference with no
 * words in common with its target, a request that duplicates a tracked task —
 * must come out as silence or as the safer verb.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { NotesTurn } from '../src/meeting-notes.ts';
import {
  MEETING_CAPTURE_ACTOR,
  OVERLAP_MAX_CHARS,
  OVERLAP_MAX_TURNS,
  type TaskCaptureCandidate,
  buildTaskCapturePrompt,
  createHaikuTaskCaptureExtractor,
  overlapWindow,
  parseTaskCaptureReply,
  phraseSpokenOnTick,
  requestMatchesCandidate,
  runTaskCapture,
  speakerOnTick,
  taskCaptureUrl,
  tickMentionsCandidate,
} from '../src/meeting-task-capture.ts';
import type { AddReviewItemResult } from '../src/tasks.ts';

const candidates: TaskCaptureCandidate[] = [
  { id: 't-pop', title: 'Popover loses anchor while scrolling', status: 'in-progress' },
  { id: 't-tun', title: 'Tunnel restart leaves stale socket', status: 'done' },
];

const turns: NotesTurn[] = [
  { turn: 1, text: 'The comment popover still jumps when the doc scrolls underneath it.' },
  { turn: 2, text: 'I am pretty sure we already have a ticket for that one on the board.' },
];

describe('buildTaskCapturePrompt', () => {
  it('carries the numbered candidates, the transcript, and the JSON contract', () => {
    const { system, user } = buildTaskCapturePrompt({ turns, candidates, docTitle: 'Demo prep' });
    expect(user).toContain('0. Popover loses anchor while scrolling');
    expect(user).toContain('1. Tunnel restart leaves stale socket');
    for (const t of turns) expect(user).toContain(t.text);
    expect(user).toContain('Demo prep');
    expect(system).toContain('"items"');
    expect(system).toContain('explicitly asks');
  });

  it('states that an empty items array is the normal answer', () => {
    const { system } = buildTaskCapturePrompt({ turns, candidates: [] });
    expect(system.toLowerCase()).toContain('empty');
  });
});

describe('parseTaskCaptureReply', () => {
  it('reads requests and references out of a well-formed reply', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'reference', match: 0 },
        { kind: 'request', title: 'Strip overlaps navbar on short screens', actionable: true },
      ],
    });
    const items = parseTaskCaptureReply(raw, candidates, turns);
    expect(items).toEqual([
      { kind: 'reference', taskId: 't-pop' },
      { kind: 'request', title: 'Strip overlaps navbar on short screens', actionable: true },
    ]);
  });

  it('unwraps a fenced reply', () => {
    const raw = '```json\n{"items":[{"kind":"reference","match":0}]}\n```';
    expect(parseTaskCaptureReply(raw, candidates, turns)).toEqual([
      { kind: 'reference', taskId: 't-pop' },
    ]);
  });

  it('answers empty on a reply that is not JSON at all', () => {
    expect(parseTaskCaptureReply('I found no tasks.', candidates, turns)).toEqual([]);
  });

  it('drops malformed rows without losing the good ones', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'reference', match: 99 }, // out of range
        { kind: 'reference', match: -1 },
        { kind: 'reference' }, // no match at all
        { kind: 'request', title: '' }, // empty title
        { kind: 'celebration', title: 'nope' }, // unknown kind
        'not even an object',
        { kind: 'request', title: 'A real new task about the navbar' },
      ],
    });
    expect(parseTaskCaptureReply(raw, candidates, turns)).toEqual([
      { kind: 'request', title: 'A real new task about the navbar', actionable: false },
    ]);
  });

  it('drops a reference whose target the transcript never mentioned', () => {
    // The model says "tunnel ticket" but nobody said anything tunnel-shaped:
    // a hallucinated link must not reach the notes.
    const raw = JSON.stringify({ items: [{ kind: 'reference', match: 1 }] });
    expect(parseTaskCaptureReply(raw, candidates, turns)).toEqual([]);
  });

  it('dedupes repeated references and repeated request titles', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'reference', match: 0 },
        { kind: 'reference', match: 0 },
        { kind: 'request', title: 'Strip overlaps navbar' },
        { kind: 'request', title: 'strip overlaps NAVBAR' },
      ],
    });
    expect(parseTaskCaptureReply(raw, candidates, turns)).toHaveLength(2);
  });

  it('clips a runaway request title at a word boundary', () => {
    const raw = JSON.stringify({
      items: [{ kind: 'request', title: `Fix the ${'very '.repeat(40)}long problem` }],
    });
    const items = parseTaskCaptureReply(raw, candidates, turns);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item?.kind !== 'request') throw new Error('expected a request');
    expect(item.title.length).toBeLessThanOrEqual(80);
    // The board's own word-boundary clip, ellipsis included.
    expect(item.title.endsWith('very…')).toBe(true);
  });
});

describe('the match guards', () => {
  it('tickMentionsCandidate needs one significant word in common', () => {
    expect(tickMentionsCandidate(turns, 'Popover loses anchor while scrolling')).toBe(true);
    expect(tickMentionsCandidate(turns, 'Tunnel restart leaves stale socket')).toBe(false);
  });

  it('stopwords and short words never count as a mention', () => {
    const t = [{ turn: 1, text: 'The thing that we should have for it' }];
    expect(tickMentionsCandidate(t, 'The plan that we made for the demo')).toBe(false);
  });

  it('requestMatchesCandidate needs two significant words, not one', () => {
    // One shared word ("popover") is a mention, not the same task.
    expect(
      requestMatchesCandidate(
        'Popover styling looks dated',
        'Popover loses anchor while scrolling',
      ),
    ).toBe(false);
    expect(
      requestMatchesCandidate(
        'Fix the popover jumping while scrolling',
        'Popover loses anchor while scrolling',
      ),
    ).toBe(true);
  });
});

describe('taskCaptureUrl', () => {
  it('is the board deep link the chip renderer already parses', () => {
    expect(taskCaptureUrl('w-board', 't-pop')).toBe('/workspaces/w-board?task=t-pop');
  });
});

/** A board stub that records every write. */
function boardStub(over: { failCreate?: boolean; failReview?: boolean } = {}) {
  const created: Array<import('../src/tasks.ts').CreateTaskOpts> = [];
  const transitions: Array<{ taskId: string; to: string; actor: unknown }> = [];
  const reviews: Array<{ taskId: string; review: ReviewRecord; actor: unknown }> = [];
  // Rows this stub has filed. A real board remembers them, and the pass that
  // runs a tick later has to see them or it would twin what it just created.
  const filedRows: TaskCaptureCandidate[] = [];
  let nextId = 0;
  return {
    created,
    transitions,
    reviews,
    board: {
      listTasks: () => [...candidates, ...filedRows].map((c) => ({ ...c })),
      createTask: (_ws: string, opts: import('../src/tasks.ts').CreateTaskOpts) => {
        if (over.failCreate) return { ok: false as const, error: 'workspace-retired' };
        created.push(opts);
        nextId++;
        const id = `t-new${nextId}`;
        filedRows.push({ id, title: opts.title, status: 'triage' });
        return {
          ok: true as const,
          task: { id, title: opts.title, status: 'triage' },
        };
      },
      transition: (taskId: string, to: string, opts: { actor: unknown }) => {
        transitions.push({ taskId, to, actor: opts.actor });
        return { ok: true as const };
      },
      addReviewItem: (taskId: string, review: unknown, opts: { actor: unknown }) => {
        if (over.failReview) {
          return { ok: false, error: 'bad-review' } as unknown as AddReviewItemResult;
        }
        reviews.push({ taskId, review: review as ReviewRecord, actor: opts.actor });
        return {
          ok: true,
          task: { id: taskId, workspaceId: 'w-board', title: 'filed row' },
          item: { id: `r-${reviews.length}`, review },
        } as unknown as AddReviewItemResult;
      },
    },
  };
}

/** The decision payload the research path files, as the stub records it. */
interface ReviewRecord {
  review_type?: string;
  headline?: string;
  detail?: string;
  options?: Array<{ id: string; label: string; detail?: string }>;
}

function extractorOf(items: unknown) {
  return {
    name: 'stub',
    extract: () => Promise.resolve(items as never),
  };
}

const tickInput = { workspaceId: 'w-board', docId: 'doc-m', docTitle: 'Demo prep', turns };

describe('runTaskCapture', () => {
  it('links a reference to the existing task and creates nothing', async () => {
    const { board, created } = boardStub();
    const links = await runTaskCapture(
      { board, extractor: extractorOf([{ kind: 'reference', taskId: 't-pop' }]) },
      tickInput,
    );
    expect(created).toHaveLength(0);
    expect(links.tasks).toEqual([
      {
        title: 'Popover loses anchor while scrolling',
        url: '/workspaces/w-board?task=t-pop',
        status: 'in-progress',
      },
    ]);
  });

  it('creates an unactionable request in triage, attributed to the capture agent', async () => {
    const { board, created, transitions } = boardStub();
    const wakes: unknown[] = [];
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'request', title: 'Strip overlaps navbar on short screens', actionable: false },
        ]),
        onTaskReady: (w) => wakes.push(w),
      },
      tickInput,
    );
    expect(created).toHaveLength(1);
    const opts = created[0];
    if (!opts) throw new Error('no create recorded');
    // Attribution: a named agent identity — never a minted user id, never the
    // bare generic word the owner gate refuses.
    expect(opts.actor).toEqual(MEETING_CAPTURE_ACTOR);
    expect(opts.actor?.id.startsWith('user-')).toBe(false);
    expect(opts.assignee).not.toBe('agent');
    expect(opts.assigneeKind).toBe('agent');
    expect(opts.origin).toEqual({ kind: 'doc', docId: 'doc-m' });
    // Unvetted work goes through triage: no goal, no transition, no wake.
    expect(opts.goal).toBeUndefined();
    expect(transitions).toHaveLength(0);
    expect(wakes).toHaveLength(0);
    expect(links.tasks).toEqual([
      {
        title: 'Strip overlaps navbar on short screens',
        url: '/workspaces/w-board?task=t-new1',
        status: 'triage',
      },
    ]);
  });

  it('sets an actionable request moving: chores band, todo, and a lead wake', async () => {
    const { board, created, transitions } = boardStub();
    const wakes: Array<{ workspaceId: string; taskId: string; title: string }> = [];
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'request', title: 'Strip overlaps navbar on short screens', actionable: true },
        ]),
        onTaskReady: (w) => wakes.push(w),
      },
      tickInput,
    );
    expect(created[0]?.goal).toBe('chores');
    expect(transitions).toEqual([{ taskId: 't-new1', to: 'todo', actor: MEETING_CAPTURE_ACTOR }]);
    expect(wakes).toEqual([
      {
        workspaceId: 'w-board',
        taskId: 't-new1',
        title: 'Strip overlaps navbar on short screens',
      },
    ]);
    expect(links.tasks[0]?.status).toBe('todo');
  });

  it('files a request that duplicates a tracked task as a reference instead', async () => {
    const { board, created } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'request', title: 'Fix the popover jumping while scrolling', actionable: true },
        ]),
      },
      tickInput,
    );
    expect(created).toHaveLength(0);
    expect(links.tasks[0]?.url).toBe('/workspaces/w-board?task=t-pop');
  });

  it('a failed extract is silence, never a write', async () => {
    const { board, created, transitions } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: { name: 'boom', extract: () => Promise.reject(new Error('over quota')) },
      },
      tickInput,
    );
    expect(links.tasks).toEqual([]);
    expect(created).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it('a refused create drops the link rather than inventing one', async () => {
    const { board } = boardStub({ failCreate: true });
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'request', title: 'Anything at all new', actionable: true },
        ]),
      },
      tickInput,
    );
    expect(links.tasks).toEqual([]);
  });
});

describe('createHaikuTaskCaptureExtractor', () => {
  it('no key means no extractor — the documented off state', () => {
    expect(createHaikuTaskCaptureExtractor({ apiKey: null })).toBeNull();
  });

  it('posts the prompt with the dedicated key and parses the reply strictly', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          content: [{ text: '{"items":[{"kind":"reference","match":0}]}' }],
          stop_reason: 'end_turn',
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const extractor = createHaikuTaskCaptureExtractor({ apiKey: 'k-test', fetchImpl: impl });
    expect(extractor).not.toBeNull();
    const items = await extractor?.extract({ turns, candidates, docTitle: 'Demo prep' });
    expect(items).toEqual([{ kind: 'reference', taskId: 't-pop' }]);
    const call = calls[0];
    if (!call) throw new Error('no request made');
    expect(call.url).toContain('api.anthropic.com');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-test');
    const body = JSON.parse(String(call.init.body)) as { system: string };
    expect(body.system).toContain('"items"');
  });

  it('an HTTP failure throws and never logs the key', async () => {
    const impl = (async (_url: unknown, _init?: RequestInit) =>
      new Response('nope', { status: 500 })) as typeof fetch;
    const extractor = createHaikuTaskCaptureExtractor({ apiKey: 'k-test', fetchImpl: impl });
    await expect(extractor?.extract({ turns, candidates })).rejects.toThrow('HTTP 500');
  });
});

/**
 * WHO ASKED. The transcript's whole point is that notes and actions land on
 * the right person, so the capture pass sees the speaker prefixes the notes
 * composer already sees — and a requester is guarded exactly as a reference
 * is: the tick must have carried that voice, or the row names nobody.
 *
 * The names here are invented. The repo is public.
 */
const spokenTurns: NotesTurn[] = [
  { turn: 1, text: 'The strip covers the navbar on my phone.', speaker: 'Jordan' },
  { turn: 2, text: 'File a ticket for that one.', speaker: 'Speaker B' },
];

describe('who asked for the task', () => {
  it('prefixes the transcript with the speaker and asks for a requester', () => {
    const { system, user } = buildTaskCapturePrompt({ turns: spokenTurns, candidates: [] });
    expect(user).toContain('- Jordan: The strip covers the navbar on my phone.');
    expect(user).toContain('- Speaker B: File a ticket for that one.');
    expect(system).toContain('"requester"');
    // The same law the notes composer states: an unnamed voice stays a label.
    expect(system).toContain('never guess');
  });

  it('leaves the lines bare when the tick carried no labels', () => {
    const { user } = buildTaskCapturePrompt({ turns, candidates: [] });
    expect(user).toContain(`- ${turns[0]?.text}`);
    expect(user).not.toContain('undefined:');
  });

  it('speakerOnTick answers the transcript spelling, or nothing', () => {
    expect(speakerOnTick(spokenTurns, 'jordan')).toBe('Jordan');
    expect(speakerOnTick(spokenTurns, 'Speaker B')).toBe('Speaker B');
    expect(speakerOnTick(spokenTurns, 'Alex')).toBeUndefined();
    expect(speakerOnTick(spokenTurns, '  ')).toBeUndefined();
    expect(speakerOnTick(turns, 'Jordan')).toBeUndefined();
  });

  it('keeps a requester the tick actually heard', () => {
    const raw = JSON.stringify({
      items: [
        {
          kind: 'request',
          title: 'Strip covers the navbar',
          actionable: true,
          requester: 'jordan',
        },
      ],
    });
    expect(parseTaskCaptureReply(raw, candidates, spokenTurns)).toEqual([
      { kind: 'request', title: 'Strip covers the navbar', actionable: true, requester: 'Jordan' },
    ]);
  });

  it('drops a requester the tick never heard, keeping the request itself', () => {
    const raw = JSON.stringify({
      items: [
        { kind: 'request', title: 'Strip covers the navbar', actionable: true, requester: 'Alex' },
        { kind: 'request', title: 'Second row survives too', actionable: false, requester: 42 },
      ],
    });
    expect(parseTaskCaptureReply(raw, candidates, spokenTurns)).toEqual([
      { kind: 'request', title: 'Strip covers the navbar', actionable: true },
      { kind: 'request', title: 'Second row survives too', actionable: false },
    ]);
  });

  it('writes the asker into the created row, and nothing when there is none', async () => {
    const { board, created } = boardStub();
    await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          {
            kind: 'request',
            title: 'Strip covers the navbar',
            actionable: false,
            requester: 'Speaker B',
          },
          { kind: 'request', title: 'Anonymous ask', actionable: false },
        ]),
      },
      { ...tickInput, turns: spokenTurns },
    );
    expect(created).toHaveLength(2);
    expect(created[0]?.body).toContain('Asked for by Speaker B.');
    expect(created[1]?.body).not.toContain('Asked for by');
    // The provenance line the row already carried is not displaced by it.
    expect(created[0]?.body).toContain('meeting assistant');
  });
});

/**
 * THE TICK BOUNDARY. A tick ends where the room went quiet, which is not
 * where an ask ends. Each pass therefore also reads the tail of the one
 * before it, marked as already read. The three cases below are the measured
 * failures, one test each, plus the budget that keeps the overlap cheap.
 *
 * The transcript is invented — a fictional product, fictional voices. The
 * repo is public.
 */
const priorTick: NotesTurn[] = [
  {
    turn: 41,
    speaker: 'Priya',
    text: 'The lantern sync retries every ninety seconds and that is the real cost.',
  },
];
const deicticTick: NotesTurn[] = [
  {
    turn: 42,
    speaker: 'Priya',
    text: 'Can you file a ticket for that one? A small spike would do.',
  },
];

describe('an ask that spans two ticks', () => {
  it('case 1 — a deictic ask can be titled from the previous tick', () => {
    const { user } = buildTaskCapturePrompt({
      turns: deicticTick,
      priorTurns: priorTick,
      candidates: [],
    });
    // The subject of "that one" is in the window, and it is marked as read
    // rather than presented as fresh speech.
    expect(user).toContain('Earlier speech (already read):');
    expect(user).toContain('- Priya: The lantern sync retries every ninety seconds');
    expect(user.indexOf('Earlier speech')).toBeLessThan(user.indexOf('New speech'));
    expect(user).toContain('- Priya: Can you file a ticket for that one?');
    // The control: without the carry this pass sees a pointer and no subject,
    // which is the bug — the row came out titled "file a ticket for that one".
    const alone = buildTaskCapturePrompt({ turns: deicticTick, candidates: [] });
    expect(alone.user).not.toContain('lantern');
    expect(alone.user).not.toContain('Earlier speech');
  });

  it('case 1 — the guards vouch for a subject that was spoken one tick ago', () => {
    const board: TaskCaptureCandidate[] = [
      { id: 't-lan', title: 'Lantern sync retries too often', status: 'todo' },
    ];
    const raw = JSON.stringify({
      items: [{ kind: 'reference', match: 0 }],
    });
    // Nothing in THIS tick's words is lantern-shaped, so the reference guard
    // used to drop it as a hallucination.
    expect(parseTaskCaptureReply(raw, board, deicticTick)).toEqual([]);
    expect(parseTaskCaptureReply(raw, board, deicticTick, priorTick)).toEqual([
      { kind: 'reference', taskId: 't-lan' },
    ]);
  });

  it('case 2 — a trigger-first ask captures the requests in the following tick', async () => {
    const trigger: NotesTurn[] = [
      {
        turn: 50,
        speaker: 'Priya',
        text: 'We should file tickets for the next few things I mention.',
      },
    ];
    const subjects: NotesTurn[] = [
      { turn: 51, speaker: 'Priya', text: 'The lantern badge counts stale invites.' },
      { turn: 52, speaker: 'Priya', text: 'And the export dialog forgets the chosen range.' },
    ];
    const { user } = buildTaskCapturePrompt({
      turns: subjects,
      priorTurns: trigger,
      candidates: [],
    });
    expect(user).toContain('We should file tickets for the next few things I mention.');

    // Both rows are filed on THIS pass, and each is attributed to the voice
    // that asked — a voice that spoke only in the earlier lines.
    const reply = JSON.stringify({
      items: [
        {
          kind: 'request',
          title: 'Lantern badge counts stale invites',
          actionable: true,
          requester: 'Priya',
        },
        {
          kind: 'request',
          title: 'Export dialog forgets the chosen range',
          actionable: true,
          requester: 'Priya',
        },
      ],
    });
    const items = parseTaskCaptureReply(reply, [], subjects, trigger);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === 'request' && i.requester === 'Priya')).toBe(true);

    const { board, created } = boardStub();
    const links = await runTaskCapture(
      { board, extractor: extractorOf(items) },
      { workspaceId: 'w-board', docId: 'doc-m', turns: subjects, priorTurns: trigger },
    );
    expect(created.map((c) => c.title)).toEqual([
      'Lantern badge counts stale invites',
      'Export dialog forgets the chosen range',
    ]);
    expect(created[0]?.body).toContain('Asked for by Priya.');
    expect(links.tasks).toHaveLength(2);
  });

  it('case 3 — the overlap is marked, and last pass’s row is linked, not twinned', async () => {
    const { system } = buildTaskCapturePrompt({
      turns: deicticTick,
      priorTurns: priorTick,
      candidates: [],
    });
    // The marking is what the model is told to do with those lines. Read on
    // one line: the prompt is hand-wrapped, so a phrase can straddle a break.
    const rule = system.replace(/\s+/g, ' ');
    expect(rule).toContain('"Earlier speech" was read last pass');
    expect(rule).toContain('Every item must draw part of itself from the new lines.');

    // And the deterministic half: the row the previous pass filed is on the
    // board now, so a re-file of the same ask becomes a link to it.
    const filed = {
      id: 't-lan',
      title: 'Lantern sync retries every ninety seconds',
      status: 'todo' as const,
    };
    const created: Array<{ title: string }> = [];
    const board = {
      listTasks: () => [filed],
      createTask: (_ws: string, opts: import('../src/tasks.ts').CreateTaskOpts) => {
        created.push({ title: opts.title });
        return { ok: true as const, task: { id: 't-twin' } };
      },
      transition: () => ({ ok: true as const }),
      addReviewItem: () => ({ ok: false, error: 'not-found' }) as never,
    };
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'request', title: 'Lantern sync retries every ninety seconds', actionable: true },
        ]),
      },
      { workspaceId: 'w-board', docId: 'doc-m', turns: deicticTick, priorTurns: priorTick },
    );
    expect(created).toHaveLength(0);
    expect(links.tasks).toEqual([
      { title: filed.title, url: '/workspaces/w-board?task=t-lan', status: 'todo' },
    ]);
  });
});

describe('the overlap window', () => {
  it('takes the tail of the previous tick, in spoken order', () => {
    const prior: NotesTurn[] = [
      { turn: 1, text: 'a'.repeat(200) },
      { turn: 2, text: 'The middle sentence.' },
      { turn: 3, text: 'The last sentence.' },
    ];
    const window = overlapWindow(prior, deicticTick);
    expect(window.map((t) => t.turn)).toEqual([2, 3]);
  });

  it('never spends more than the budget, and always keeps the newest line', () => {
    const prior: NotesTurn[] = [{ turn: 9, speaker: 'Priya', text: 'word '.repeat(400).trim() }];
    const window = overlapWindow(prior, deicticTick);
    expect(window).toHaveLength(1);
    const kept = window[0]?.text ?? '';
    // The speaker prefix counts against the budget too, not only the words.
    expect(kept.length + 'Priya: '.length).toBeLessThanOrEqual(OVERLAP_MAX_CHARS);
    // Clipped from the front: what a pointer points at is what was said last.
    expect(kept.startsWith('…')).toBe(true);
  });

  it('holds the budget even for a line with nowhere to break', () => {
    // A URL or an unbroken ASR token has no space to clip at, so the tail is
    // taken whole — and the ellipsis still has to fit inside the budget.
    const prior: NotesTurn[] = [{ turn: 9, text: 'x'.repeat(500) }];
    const kept = overlapWindow(prior, deicticTick)[0]?.text ?? '';
    expect(kept.length).toBe(OVERLAP_MAX_CHARS);
    expect(kept.startsWith('…')).toBe(true);
  });

  it('caps the number of turns as well as the characters', () => {
    const prior: NotesTurn[] = Array.from({ length: 20 }, (_, i) => ({ turn: i, text: 'ok.' }));
    expect(overlapWindow(prior, deicticTick)).toHaveLength(OVERLAP_MAX_TURNS);
  });

  it('a carried turn is new speech, not overlap — it never appears twice', () => {
    // A tick whose compose failed hands its turns to the next tick.
    const carried: NotesTurn[] = [...priorTick, ...deicticTick];
    expect(overlapWindow(priorTick, carried)).toEqual([]);
    const { user } = buildTaskCapturePrompt({
      turns: carried,
      priorTurns: priorTick,
      candidates: [],
    });
    expect(user).not.toContain('Earlier speech');
    // Once, as new speech — not once in each half.
    expect(user.split('lantern sync').length - 1).toBe(1);
  });

  it('costs the prompt a bounded number of characters, however long the tick was', () => {
    const long: NotesTurn[] = Array.from({ length: 40 }, (_, i) => ({
      turn: 100 + i,
      speaker: 'Priya',
      text: `A whole sentence of meeting speech, number ${i}, that nobody needs twice.`,
    }));
    const withOverlap = buildTaskCapturePrompt({
      turns: deicticTick,
      priorTurns: long,
      candidates: [],
    });
    const without = buildTaskCapturePrompt({ turns: deicticTick, candidates: [] });
    const delta =
      withOverlap.system.length +
      withOverlap.user.length -
      (without.system.length + without.user.length);
    // The standing instruction plus a full window. Measured at +92 tokens per
    // tick on the capture model by `scripts/capture-overlap-cost.ts`, which
    // asks the token counter rather than dividing characters by four; this
    // bound is the character ceiling that number was taken at.
    expect(delta).toBeLessThanOrEqual(400);
  });
});

/**
 * The two intents that arrived after requests and references — asking for
 * something to be looked into, and asking for something to be pulled in.
 *
 * They ride the same reply, so most of what is asserted here is that they
 * ride it WITHOUT costing the other two: a malformed research row leaves the
 * request beside it alone, and a lookup nobody can resolve is silence.
 */

/** Speech that asks for research without ever using the word. */
const researchTurns: NotesTurn[] = [
  { turn: 7, speaker: 'Priya', text: 'The offline queue keeps replaying the same batch.' },
  { turn: 8, speaker: 'Priya', text: 'Can somebody go look into the offline queue replay?' },
];

describe('phraseSpokenOnTick', () => {
  it('vouches for a phrase the speech carried', () => {
    expect(phraseSpokenOnTick(researchTurns, 'offline queue replay')).toBe(true);
  });

  it('drops a phrase the speech never carried', () => {
    expect(phraseSpokenOnTick(researchTurns, 'billing webhook signatures')).toBe(false);
  });

  it('needs two significant words when the phrase has two', () => {
    // "queue" alone was said; "throughput" never was — one hit of two.
    expect(phraseSpokenOnTick(researchTurns, 'queue throughput')).toBe(false);
  });

  it('accepts a one-word phrase on its one word', () => {
    expect(phraseSpokenOnTick(researchTurns, 'replay')).toBe(true);
  });

  it('drops a phrase with no significant words to vouch for at all', () => {
    // Every word a stopword: nothing could ever vouch for it, so an empty
    // match must not read as a pass.
    expect(phraseSpokenOnTick(researchTurns, 'that thing')).toBe(false);
  });
});

describe('the research and lookup prompt', () => {
  it('names both intents in the shape and tells the model not to wait for the word', () => {
    const { system } = buildTaskCapturePrompt({ turns: researchTurns, candidates });
    expect(system).toContain('"kind":"research"');
    expect(system).toContain('"kind":"lookup"');
    expect(system).toContain('rarely say the word "research"');
    // The "when" clause is what makes a past meeting reachable at all.
    expect(system).toContain('KEEPING any "when"');
  });
});

describe('parsing the reading intents', () => {
  const parse = (items: unknown) =>
    parseTaskCaptureReply(JSON.stringify({ items }), candidates, researchTurns);

  it('keeps a research ask whose topic was spoken', () => {
    expect(
      parse([{ kind: 'research', topic: 'offline queue replay', question: 'why does it repeat?' }]),
    ).toEqual([
      { kind: 'research', topic: 'offline queue replay', question: 'why does it repeat?' },
    ]);
  });

  it('drops a research ask whose topic nobody said', () => {
    expect(parse([{ kind: 'research', topic: 'Postgres connection pooling' }])).toEqual([]);
  });

  it('attributes a research ask only to a voice the tick carried', () => {
    expect(
      parse([{ kind: 'research', topic: 'offline queue replay', requester: 'priya' }]),
    ).toEqual([{ kind: 'research', topic: 'offline queue replay', requester: 'Priya' }]);
    expect(
      parse([{ kind: 'research', topic: 'offline queue replay', requester: 'Marcus' }]),
    ).toEqual([{ kind: 'research', topic: 'offline queue replay' }]);
  });

  it('keeps a lookup whose query was spoken and drops one that was not', () => {
    expect(parse([{ kind: 'lookup', query: 'the offline queue notes' }])).toEqual([
      { kind: 'lookup', query: 'the offline queue notes' },
    ]);
    expect(parse([{ kind: 'lookup', query: 'the hiring plan' }])).toEqual([]);
  });

  it('drops the same ask twice', () => {
    expect(
      parse([
        { kind: 'research', topic: 'offline queue replay' },
        { kind: 'research', topic: 'Offline Queue Replay' },
      ]),
    ).toHaveLength(1);
  });

  it('lets one malformed intent cost only itself', () => {
    const out = parse([
      { kind: 'research', topic: 42 },
      { kind: 'lookup' },
      { kind: 'research', topic: 'offline queue replay' },
    ]);
    expect(out).toEqual([{ kind: 'research', topic: 'offline queue replay' }]);
  });
});

const researchInput = {
  workspaceId: 'w-board',
  docId: 'doc-m',
  docTitle: 'Demo prep',
  turns: researchTurns,
};

describe('runTaskCapture — a research ask confirms before it spends', () => {
  it('files a triage row and a decision item, and sets nothing moving', async () => {
    const { board, created, transitions, reviews } = boardStub();
    const wakes: unknown[] = [];
    const filed: Array<{ taskId: string }> = [];
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'research', topic: 'offline queue replay', question: 'why does it repeat?' },
        ]),
        onTaskReady: (w) => wakes.push(w),
        onReviewFiled: ({ task }) => filed.push({ taskId: task.id }),
      },
      researchInput,
    );

    // The row exists and asks for no band — the same as an unactionable
    // request, because placing it is a person's call at triage. (The STORE
    // fills one in regardless; what keeps the row from being worked is the
    // triage status and the open item, asserted below and in
    // `meeting-research-store.test.ts` against the real store.)
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe('Research: offline queue replay');
    expect(created[0]?.goal).toBeUndefined();
    expect(created[0]?.actor).toEqual(MEETING_CAPTURE_ACTOR);
    expect(created[0]?.origin).toEqual({ kind: 'doc', docId: 'doc-m' });
    // Nothing is spent: no transition out of triage, no lead wake.
    expect(transitions).toHaveLength(0);
    expect(wakes).toHaveLength(0);

    // And the ask itself: a decision with two options, on that row.
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.taskId).toBe('t-new1');
    expect(reviews[0]?.review.review_type).toBe('decision');
    expect(reviews[0]?.review.headline).toContain('offline queue replay');
    expect(reviews[0]?.review.options?.map((o) => o.id)).toEqual(['go-ahead', 'not-now']);
    // The card has to say where to look — an inline link to the row.
    expect(reviews[0]?.review.detail).toContain('/workspaces/w-board?task=t-new1');
    expect(reviews[0]?.review.detail).toContain('why does it repeat?');
    // The caller owes the item its projection and announce.
    expect(filed).toEqual([{ taskId: 't-new1' }]);

    expect(links.tasks).toEqual([
      {
        title: 'Research: offline queue replay',
        url: '/workspaces/w-board?task=t-new1',
        status: 'triage',
      },
    ]);
  });

  it('records who asked, when the tick carried them', async () => {
    const { board, created } = boardStub();
    await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'research', topic: 'offline queue replay', requester: 'Priya' },
        ]),
      },
      researchInput,
    );
    expect(created[0]?.body).toContain('Priya');
  });

  it('links the row it already filed rather than asking a second time', async () => {
    // The same ask twice: once in this tick's reply, and once a whole tick
    // later, when the row from the first pass is a candidate the board
    // returns. Neither may produce a second confirmation to answer.
    const { board, created, reviews } = boardStub();
    const first = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'research', topic: 'offline queue replay' },
          { kind: 'research', topic: 'offline queue replay problem' },
        ]),
      },
      researchInput,
    );
    expect(first.tasks).toHaveLength(1);

    const later = await runTaskCapture(
      { board, extractor: extractorOf([{ kind: 'research', topic: 'offline queue replay' }]) },
      researchInput,
    );
    expect(created).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(later.tasks).toEqual([
      {
        title: 'Research: offline queue replay',
        url: '/workspaces/w-board?task=t-new1',
        status: 'triage',
      },
    ]);
  });

  it('a refused confirmation leaves the row in triage and says so', async () => {
    const { board, created, transitions } = boardStub({ failReview: true });
    const errors: string[] = [];
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([{ kind: 'research', topic: 'offline queue replay' }]),
        onError: (m) => errors.push(m),
      },
      researchInput,
    );
    expect(created).toHaveLength(1);
    // Triage and unbanded is where an unconfirmed ask belongs; the missing
    // card costs it its visibility, never its safety.
    expect(transitions).toHaveLength(0);
    expect(links.tasks[0]?.status).toBe('triage');
    expect(errors[0]).toContain('confirmation refused');
  });
});

describe('runTaskCapture — a lookup reaches docs and past meetings', () => {
  const lookupTurns: NotesTurn[] = [
    { turn: 3, speaker: 'Marcus', text: 'Can you pull in the offline queue notes from last week?' },
  ];
  const lookupInput = {
    workspaceId: 'w-board',
    docId: 'doc-m',
    docTitle: 'Demo prep',
    turns: lookupTurns,
  };
  const NOW = new Date(2026, 7, 26, 15, 0, 0).getTime();
  const lastWeek = new Date(2026, 7, 19, 10, 0, 0).getTime();
  const lookup = {
    docs: () => [
      { docId: 'd-queue', title: 'Offline queue notes', meetingAt: lastWeek },
      { docId: 'd-charter', title: 'Team charter' },
    ],
  };

  it('links a past meeting found by name, dated rather than paraphrased', async () => {
    const { board } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'lookup', query: 'the offline queue notes from last week' },
        ]),
        lookup,
        now: () => NOW,
      },
      lookupInput,
    );
    // The TITLE is what matched, so the date is the only thing that can be
    // said honestly: a doc found by name may not have been last week's.
    expect(links.docs).toEqual([
      {
        title: 'Offline queue notes',
        url: '/workspaces/w-board/docs/d-queue',
        when: '2026-08-19',
      },
    ]);
    expect(links.tasks).toEqual([]);
  });

  it('reaches a past meeting by when alone, in the speaker’s own frame', async () => {
    // "last week's notes" names no title — every doc is "notes" and "week"
    // is a stopword. The window is the only thing that resolves it, so the
    // window's own words are what the link may be labelled with.
    const { board } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([{ kind: 'lookup', query: "last week's notes" }]),
        lookup,
        now: () => NOW,
      },
      {
        ...lookupInput,
        turns: [{ turn: 3, speaker: 'Marcus', text: "Pull in last week's notes for me." }],
      },
    );
    expect(links.docs).toEqual([
      {
        title: 'Offline queue notes',
        url: '/workspaces/w-board/docs/d-queue',
        when: 'last week',
      },
    ]);
  });

  it('never asks for the meeting doc it is already in', async () => {
    const { board } = boardStub();
    const asked: Array<[string, string]> = [];
    await runTaskCapture(
      {
        board,
        extractor: extractorOf([{ kind: 'lookup', query: 'the offline queue notes' }]),
        lookup: {
          docs: (ws, except) => {
            asked.push([ws, except]);
            return lookup.docs();
          },
        },
        now: () => NOW,
      },
      lookupInput,
    );
    expect(asked).toEqual([['w-board', 'doc-m']]);
  });

  it('sends a lookup that lands on a board row down the task path', async () => {
    const { board } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([{ kind: 'lookup', query: 'the popover anchor scrolling ticket' }]),
        lookup,
        now: () => NOW,
      },
      {
        ...lookupInput,
        turns: [
          { turn: 3, text: 'Bring up the popover anchor scrolling ticket while we are here.' },
        ],
      },
    );
    expect(links.docs).toEqual([]);
    expect(links.tasks[0]?.url).toBe('/workspaces/w-board?task=t-pop');
  });

  it('links one doc once, however many ways it was asked for', async () => {
    const { board } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'lookup', query: 'the offline queue notes' },
          { kind: 'lookup', query: 'the offline queue notes from last week' },
        ]),
        lookup,
        now: () => NOW,
      },
      lookupInput,
    );
    expect(links.docs).toHaveLength(1);
  });

  it('a row filed earlier in the same tick is found, not twinned', async () => {
    // A tick can carry the ask twice in two shapes — "go look into the queue
    // replay", then a plain "somebody should fix the queue replay". The
    // candidate list was read before either existed, so without carrying the
    // new row forward the second item files a second card for one ask.
    const { board, created, reviews } = boardStub();
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'research', topic: 'offline queue replay' },
          { kind: 'request', title: 'Offline queue replay' },
        ]),
      },
      researchInput,
    );
    expect(created).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(links.tasks).toHaveLength(1);
    expect(links.tasks[0]?.title).toBe('Research: offline queue replay');
  });

  it('resolves nothing with no lookup source wired, and does not throw', async () => {
    const { board } = boardStub();
    const links = await runTaskCapture(
      { board, extractor: extractorOf([{ kind: 'lookup', query: 'the offline queue notes' }]) },
      lookupInput,
    );
    expect(links).toEqual({ tasks: [], docs: [] });
  });

  it('a lookup source that throws costs the link, not the pass', async () => {
    const { board } = boardStub();
    const errors: string[] = [];
    const links = await runTaskCapture(
      {
        board,
        extractor: extractorOf([
          { kind: 'lookup', query: 'the offline queue notes' },
          { kind: 'reference', taskId: 't-pop' },
        ]),
        lookup: {
          docs: () => {
            throw new Error('doc index unreadable');
          },
        },
        onError: (m) => errors.push(m),
        now: () => NOW,
      },
      {
        ...lookupInput,
        turns: [
          {
            turn: 3,
            text: 'Pull in the offline queue notes; the popover anchor scrolling one too.',
          },
        ],
      },
    );
    expect(links.docs).toEqual([]);
    // The reference beside it still landed.
    expect(links.tasks[0]?.url).toBe('/workspaces/w-board?task=t-pop');
    expect(errors).toEqual(['doc index unreadable']);
  });
});
