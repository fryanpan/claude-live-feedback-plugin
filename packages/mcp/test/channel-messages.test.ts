/**
 * Every line an agent actually reads, driven rather than grepped.
 *
 * These renderers used to live in `mcp.ts`, which connects a stdio transport
 * at the bottom of the file — so nothing could import them, and the way they
 * were checked was a regex over the source or a spawned bundle. A regex
 * passes on a handler that was deleted and fails on a rename that kept the
 * feature working; a spawned bundle cannot reach the arms no SSE frame
 * arrives for. `createChannelMessages` takes its notification sink, its HTTP
 * client and this session's identity as arguments, so a test can hand it
 * fakes and read the frame it produced.
 *
 * All fixtures synthetic. Nothing here opens a socket or touches a real
 * server.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';

/** A frozen clock, so `sent_at` is an assertion rather than a race. */
const FIXED_MS = Date.UTC(2026, 8, 3, 12, 0, 0);
const FIXED_ISO = new Date(FIXED_MS).toISOString();

const SELF = 'agent-workspaces';

type Sent = { method: string; path: string; body: unknown };

function harness(opts: { authorId?: string } = {}) {
  const frames: ChannelNotification['params'][] = [];
  const sent: Sent[] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      expect(n.method).toBe('notifications/claude/channel');
      frames.push(n.params);
    },
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      return {};
    },
    authorId: opts.authorId ?? SELF,
    now: () => FIXED_MS,
  });
  return { frames, sent, messages };
}

/** The one frame a call produced — fails loudly on zero or two. */
function only(frames: ChannelNotification['params'][]): ChannelNotification['params'] {
  expect(frames).toHaveLength(1);
  return frames[0] as ChannelNotification['params'];
}

describe('a doc-shaped frame becomes one readable line', () => {
  it('renders a comment with its author, its text and its anchor', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 't1',
      comment: { author: { name: 'Bryan' }, text: 'tighten this', ts: FIXED_MS },
      thread: { anchor: { snippet: { text: 'the second paragraph' } } },
    });
    const f = only(frames);
    expect(f.content).toBe('[replied] Bryan: tighten this');
    expect(f.source).toBe('claude-workspaces');
    expect(f.sent_at).toBe(FIXED_ISO);
    expect(f.meta).toMatchObject({
      doc_id: 'plan',
      thread_id: 't1',
      event: 'thread.replied',
      author: 'Bryan',
      anchor_text: 'the second paragraph',
    });
  });

  it('falls back to the outdated anchor when the live snippet is gone', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'plan',
      threadId: 't2',
      thread: {
        anchor: { original: { snippet: { text: 'a line that moved' } } },
        comments: [{ author: { name: 'Bryan' }, text: 'here' }],
      },
    });
    expect(only(frames).meta.anchor_text).toBe('a line that moved');
  });

  it('attributes a resolve to the actor, never to a comment author', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', {
      docId: 'plan',
      threadId: 't3',
      actor: { name: 'Bryan' },
      thread: { comments: [{ author: { name: 'Someone Else' }, text: 'not my words' }] },
    });
    const f = only(frames);
    expect(f.content).toContain('by Bryan');
    expect(f.content).not.toContain('Someone Else');
    expect(f.content).not.toContain('not my words');
  });

  it('leaves the author blank when an older server sends no actor', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', {
      docId: 'plan',
      threadId: 't4',
      thread: { comments: [{ author: { name: 'Someone Else' }, text: 'x' }] },
    });
    expect(only(frames).meta.author).toBe('');
  });

  it('names the review item a comment landed on', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 't5',
      reviewItemId: 'ri-9',
      comment: { author: { name: 'Bryan' }, text: 'ship it' },
    });
    const f = only(frames);
    expect(f.content).toContain('on review item ri-9');
    expect(f.meta.review_item_id).toBe('ri-9');
  });

  it('reads the review item off the anchor on an older server', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 't6',
      comment: { author: { name: 'Bryan' }, text: 'ok' },
      thread: { anchor: { kind: 'review-item', reviewItemId: 'ri-7' } },
    });
    expect(only(frames).meta.review_item_id).toBe('ri-7');
  });

  it('truncates a long anchor rather than pasting the paragraph', async () => {
    const { frames, messages } = harness();
    const long = 'x'.repeat(200);
    await messages.emitChannelMessage('thread.created', {
      docId: 'plan',
      threadId: 't7',
      thread: { anchor: { snippet: { text: long } }, comments: [] },
    });
    const f = only(frames);
    expect(f.content).toContain('…');
    expect(f.content).not.toContain(long);
    // The meta keeps the whole anchor — the truncation is for the reader.
    expect(f.meta.anchor_text).toBe(long);
  });

  it('renders a sync error as a sentence naming the file and the backup', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      path: '/repo/docs/plan.md',
      message: 'external write lost',
      backupPath: '/tmp/plan.md.bak',
    });
    const f = only(frames);
    expect(f.content).toBe('[sync error] /repo/docs/plan.md: external write lost');
    expect(f.meta).toMatchObject({
      doc_id: 'plan',
      event: 'doc.sync_error',
      path: '/repo/docs/plan.md',
      backup_path: '/tmp/plan.md.bak',
    });
  });

  it('renders a suggestion with its snippet and its verdict', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('suggestion.accepted', {
      docId: 'plan',
      sid: 's1',
      suggestion: { author: { name: 'Bryan' }, kind: 'replace', snippet: 'the old wording' },
    });
    const f = only(frames);
    expect(f.content).toBe('[suggestion accepted] Bryan: replace "the old wording"');
    expect(f.meta).toMatchObject({ sid: 's1', event: 'suggestion.accepted' });
  });
});

describe('a session never hears its own act come back', () => {
  it('drops a comment this session authored', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 't8',
      comment: { author: { id: SELF, name: 'Workspaces' }, text: 'mine' },
    });
    expect(frames).toHaveLength(0);
  });

  it('delivers the same frame to a different session', async () => {
    const { frames, messages } = harness({ authorId: 'agent-somebody-else' });
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 't8',
      comment: { author: { id: SELF, name: 'Workspaces' }, text: 'mine' },
    });
    expect(frames).toHaveLength(1);
  });

  it('drops a hub event this session is the actor of', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.transitioned', {
      workspaceId: 'w1',
      taskId: 'k1',
      from: 'todo',
      to: 'in-progress',
      actor: { id: SELF, name: 'Workspaces' },
    });
    expect(frames).toHaveLength(0);
  });
});

describe('hub events route to the hub renderer', () => {
  it('renders a created task with its goal and assignee', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.created', {
      workspaceId: 'w1',
      taskId: 'k1',
      task: { title: 'Test the entry file' },
      goal: 'Coverage',
      assignee: 'Builder',
    });
    const f = only(frames);
    expect(f.content).toBe('[task.created] "Test the entry file" → Coverage (assignee Builder)');
    expect(f.meta).toMatchObject({ workspace_id: 'w1', task_id: 'k1', event: 'task.created' });
  });

  it.each([
    [
      'task.transitioned',
      { taskId: 'k1', from: 'todo', to: 'done', note: 'shipped', actor: { name: 'Bryan' } },
      '[task.transitioned] k1: todo → done by Bryan — shipped',
    ],
    [
      'task.assigned',
      { taskId: 'k1', from: 'nobody', to: 'Builder', actor: { name: 'Bryan' } },
      '[task.assigned] k1: nobody → Builder by Bryan',
    ],
    [
      'task.regrouped',
      { taskId: 'k1', fromGoal: 'Backlog', toGoal: 'Coverage' },
      '[task.regrouped] k1: Backlog → Coverage',
    ],
    [
      'task.retitled',
      { titleFrom: 'Old name', titleTo: 'New name', reason: 'clearer' },
      '[task.retitled] "Old name" → "New name" — clearer',
    ],
    [
      'task.body_edited',
      { titleFrom: 'Old', titleTo: 'New' },
      '[task.body_edited] reshaped "Old" → "New"',
    ],
    ['task.body_edited', { taskId: 'k2' }, '[task.body_edited] k2'],
    [
      'task.gate_refused',
      { taskId: 'k1', riskTier: 'high', reason: 'no review', to: 'done' },
      '[task.gate_refused] k1: high-tier no review — → done did NOT happen',
    ],
    ['agent.attached', { agentId: 'agent-peer' }, '[agent.attached] agent-peer'],
    ['agent.detached', { agentId: 'agent-peer' }, '[agent.detached] agent-peer'],
  ])('renders %s', async (event, payload, expected) => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(event, { workspaceId: 'w1', ...payload });
    expect(only(frames).content).toBe(expected);
  });

  it('tells the lead when the seat became theirs', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('workspace.lead_changed', {
      workspaceId: 'w1',
      leadAgentId: SELF,
      actor: { name: 'Bryan' },
    });
    expect(only(frames).content).toContain('you are now the lead agent');
  });

  it('names the other agent when the seat went elsewhere', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('workspace.lead_changed', {
      workspaceId: 'w1',
      leadAgentId: 'agent-peer',
      actor: { name: 'Bryan' },
    });
    expect(only(frames).content).toBe(
      '[workspace.lead_changed] by Bryan: lead agent is now agent-peer',
    );
  });

  it('says how many rows a goal edit sent back to Backlog', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('workspace.goals_changed', {
      workspaceId: 'w1',
      kind: 'reorder',
      movedToChores: ['k1', 'k2'],
    });
    expect(only(frames).content).toContain('2 task(s) moved to Backlog');
  });

  it('falls back to a bare slug for an event it has no case for', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('task.something_new', { workspaceId: 'w1', taskId: 'k9' });
    expect(only(frames).content).toBe('[task.something_new] task k9');
  });

  it.each(['agent.heartbeat', 'task.noted'])('never forwards %s', async (event) => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage(event, { workspaceId: 'w1', actor: { id: 'agent-peer' } });
    expect(frames).toHaveLength(0);
  });

  it('renders the three wake events through their own line modules', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('workspace.ready_idle', {
      workspaceId: 'w1',
      readyCount: 3,
      idleMs: 900_000,
    });
    await messages.emitChannelMessage('workspace.stalled', {
      workspaceId: 'w1',
      stalledCount: 1,
      rows: [{ taskId: 'k1', title: 'A row', assignee: 'Builder' }],
    });
    await messages.emitChannelMessage('workspace.review_item_held', {
      workspaceId: 'w1',
      reviewItemId: 'ri-1',
      taskId: 'k1',
      reason: 'no criteria',
    });
    await messages.emitChannelMessage('workspace.review_answered', {
      workspaceId: 'w1',
      taskId: 'k1',
      answer: 'yes',
    });
    expect(frames.map((f) => f.content.slice(0, f.content.indexOf(']') + 1))).toEqual([
      '[workspace.ready_idle]',
      '[workspace.stalled]',
      '[workspace.review_item_held]',
      '[workspace.review_answered]',
    ]);
  });

  it('renders an answered decision', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('decision.answered', {
      workspaceId: 'w1',
      taskId: 'k1',
      answer: 'go ahead',
    });
    expect(only(frames).content).toContain('[decision.answered]');
  });
});

describe('a voice row is acknowledged only after it has been delivered', () => {
  it('emits the line, then posts the receipt', async () => {
    const frames: ChannelNotification['params'][] = [];
    const sent: Sent[] = [];
    const order: string[] = [];
    const traced = createChannelMessages({
      notify: async (n) => {
        order.push('notify');
        frames.push(n.params);
      },
      http: async (method, path, body) => {
        order.push('ack');
        sent.push({ method, path, body });
        return {};
      },
      authorId: SELF,
      now: () => FIXED_MS,
    });
    await traced.emitChannelMessage('voice.request', {
      workspaceId: 'w1',
      queueId: 'q1',
      route: 'agent',
      transcript: 'move the card',
      ack: 'passing it on',
    });
    expect(order).toEqual(['notify', 'ack']);
    expect(sent).toEqual([
      { method: 'POST', path: '/api/workspaces/w1/voice-queue/q1/ack', body: {} },
    ]);
    expect(only(frames).content).toContain('move the card');
  });

  it('drops a lookup the server already answered, and acks nothing', async () => {
    const { frames, sent, messages } = harness();
    await messages.emitChannelMessage('voice.request', {
      workspaceId: 'w1',
      queueId: 'q2',
      route: 'fast-path',
      transcript: 'what is on the board',
    });
    expect(frames).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('says the board already moved on a fast-path action', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('voice.request', {
      workspaceId: 'w1',
      route: 'fast-path-action',
      transcript: 'mark it done',
      ack: 'Moved it to done',
    });
    expect(only(frames).content).toContain('ALREADY applied');
  });

  it('keeps the line when the receipt fails', async () => {
    const frames: ChannelNotification['params'][] = [];
    const messages = createChannelMessages({
      notify: async (n) => {
        frames.push(n.params);
      },
      http: async () => {
        throw new Error('server down');
      },
      authorId: SELF,
      now: () => FIXED_MS,
    });
    await messages.emitChannelMessage('voice.request', {
      workspaceId: 'w1',
      queueId: 'q3',
      route: 'agent',
      transcript: 'still delivered',
    });
    expect(only(frames).content).toContain('still delivered');
  });

  it('sends no receipt when the frame carries no queue row', async () => {
    const { sent, messages } = harness();
    await messages.emitChannelMessage('voice.request', {
      workspaceId: 'w1',
      route: 'agent',
      transcript: 'older server',
    });
    expect(sent).toHaveLength(0);
  });
});
