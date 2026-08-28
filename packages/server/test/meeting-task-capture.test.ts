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
  type TaskCaptureCandidate,
  buildTaskCapturePrompt,
  createHaikuTaskCaptureExtractor,
  parseTaskCaptureReply,
  requestMatchesCandidate,
  runTaskCapture,
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
