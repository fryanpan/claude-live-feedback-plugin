/**
 * The real notes composer: prompt shape, reply sanitation, and the HTTP
 * seam — all through a stubbed fetch, because a test that reached
 * api.anthropic.com would spend real money to assert string handling.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  NOTES_MODEL,
  buildNotesPrompt,
  createHaikuNotesComposer,
  sanitizeNotesReply,
} from '../src/meeting-notes-composer.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';

const input: NotesComposeInput = {
  docId: 'doc-a',
  meetingId: 'm-doc-a-1',
  tick: {
    tick: 2,
    reason: 'pause',
    turns: [
      { turn: 3, text: 'The sync is the bottleneck.' },
      { turn: 4, text: 'Measure before rewriting.' },
    ],
  },
  previous: '## Meeting notes\n- earlier point',
  context: {
    docTitle: 'Q3 planning',
    taskTitles: ['Bryan can hear his meeting become notes'],
    repoRoot: '/repo/planning',
  },
};

/** A fetch stub that records the request and answers with `body`. */
function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('notes prompt', () => {
  it('carries the delta, the previous notes, and the project context', () => {
    const { system, user } = buildNotesPrompt(input);
    expect(system).toContain('## Meeting notes');
    for (const turn of input.tick.turns) expect(user).toContain(turn.text);
    expect(user).toContain('## Meeting notes\n- earlier point');
    expect(user).toContain('Q3 planning');
    expect(user).toContain('Bryan can hear his meeting become notes');
    expect(user).toContain('/repo/planning');
  });

  it('says so when there are no notes yet, instead of an empty section', () => {
    const { user } = buildNotesPrompt({ ...input, previous: null, context: undefined });
    expect(user).toContain('none yet');
    expect(user).not.toContain('Project context');
  });
});

describe('sanitizeNotesReply', () => {
  it('unwraps a fenced reply and keeps the heading', () => {
    const out = sanitizeNotesReply('```markdown\n## Meeting notes\n- a\n```');
    expect(out).toBe('## Meeting notes\n- a');
  });

  it('prepends the heading when the model forgot it', () => {
    const out = sanitizeNotesReply('- bare bullet');
    expect(out.startsWith('## Meeting notes\n')).toBe(true);
    expect(out).toContain('- bare bullet');
  });
});

describe('createHaikuNotesComposer', () => {
  it('no key means no composer — the documented off state, not an error', () => {
    expect(createHaikuNotesComposer({ apiKey: null })).toBeNull();
  });

  it('posts the prompt to the API with the dedicated key and returns the notes', async () => {
    const { impl, calls } = stubFetch({
      content: [{ text: '## Meeting notes\n- the sync is the bottleneck' }],
      stop_reason: 'end_turn',
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer).not.toBeNull();
    const notes = await composer?.compose(input);
    expect(notes).toBe('## Meeting notes\n- the sync is the bottleneck');
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-test');
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe(NOTES_MODEL);
    expect(body.messages[0]?.content).toContain('Measure before rewriting.');
  });

  it('an HTTP failure rejects, so the session carries the words forward', async () => {
    const { impl } = stubFetch({ error: 'overloaded' }, 529);
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('529');
  });

  it('a reply cut at the token ceiling rejects rather than truncating the notes', async () => {
    const { impl } = stubFetch({
      content: [{ text: '## Meeting notes\n- cut mid' }],
      stop_reason: 'max_tokens',
    });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('max_tokens');
  });

  it('an empty reply rejects — blank notes must never replace real ones', async () => {
    const { impl } = stubFetch({ content: [{ text: '   ' }], stop_reason: 'end_turn' });
    const composer = createHaikuNotesComposer({ apiKey: 'k-test', fetchImpl: impl });
    expect(composer?.compose(input)).rejects.toThrow('empty');
  });
});

describe('captured task links in the prompt', () => {
  it('offers each link and the instruction to cite it', () => {
    const { user } = buildNotesPrompt({
      ...input,
      taskLinks: [
        { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
      ],
    });
    expect(user).toContain('[Strip overlaps navbar](/workspaces/w-b?task=t-9)');
    expect(user).toContain('todo');
    expect(user.toLowerCase()).toContain('markdown link');
  });

  it('says nothing about tasks when the tick captured none', () => {
    const { user } = buildNotesPrompt(input);
    expect(user.toLowerCase()).not.toContain('markdown link');
  });
});
