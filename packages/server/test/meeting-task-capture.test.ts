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
  requestMatchesCandidate,
  runTaskCapture,
  speakerOnTick,
  taskCaptureUrl,
  tickMentionsCandidate,
} from '../src/meeting-task-capture.ts';

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
function boardStub(over: { failCreate?: boolean } = {}) {
  const created: Array<import('../src/tasks.ts').CreateTaskOpts> = [];
  const transitions: Array<{ taskId: string; to: string; actor: unknown }> = [];
  let nextId = 0;
  return {
    created,
    transitions,
    board: {
      listTasks: () => candidates.map((c) => ({ ...c })),
      createTask: (_ws: string, opts: import('../src/tasks.ts').CreateTaskOpts) => {
        if (over.failCreate) return { ok: false as const, error: 'workspace-retired' };
        created.push(opts);
        nextId++;
        return {
          ok: true as const,
          task: { id: `t-new${nextId}`, title: opts.title, status: 'triage' },
        };
      },
      transition: (taskId: string, to: string, opts: { actor: unknown }) => {
        transitions.push({ taskId, to, actor: opts.actor });
        return { ok: true as const };
      },
    },
  };
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
    expect(links).toEqual([
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
    expect(links).toEqual([
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
    expect(links[0]?.status).toBe('todo');
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
    expect(links[0]?.url).toBe('/workspaces/w-board?task=t-pop');
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
    expect(links).toEqual([]);
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
    expect(links).toEqual([]);
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
    expect(links).toHaveLength(2);
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
    expect(links).toEqual([
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
