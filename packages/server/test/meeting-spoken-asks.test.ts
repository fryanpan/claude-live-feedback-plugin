/**
 * Asks said aloud in a meeting, end to end: words on the audio socket of a
 * huddle doc become — with nobody tapping — a board row, a research row
 * plus its placeholder section, and a review thread with the doc stamped.
 * The extractor is a stub keyed on the words spoken (the model's judgement
 * is `meeting-task-capture.test.ts`'s subject; this is the path after it),
 * the engine is the mock, and the composer writes nothing.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@feedback/core';
import { type TickScheduler, createStubNotesComposer } from '../src/meeting-notes.ts';
import type { CapturedItem, TaskCaptureInput } from '../src/meeting-task-capture.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';

class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

const SCRIPT: readonly MockScriptTurn[] = [
  {
    words: ['make', 'that', 'a', 'task'],
    settled: 'Make that a task: rotate the tunnel token before Friday.',
    speaker: 'A',
  },
  {
    words: ['can', 'you', 'research'],
    settled: 'Can you research the retention sweep for us?',
    speaker: 'B',
  },
  {
    words: ['ask', 'the', 'team'],
    settled: 'Ask the team whether we still need the tunnel.',
    speaker: 'A',
  },
];

/** What the model would have said, per line — keyed on the words. */
const extractor = {
  name: 'stub',
  extract: (input: TaskCaptureInput): Promise<CapturedItem[]> => {
    const said = input.turns.map((t) => t.text).join(' ');
    const items: CapturedItem[] = [];
    if (said.includes('rotate the tunnel token')) {
      items.push({
        kind: 'request',
        title: 'Rotate the tunnel token before Friday',
        actionable: true,
        requester: 'Speaker A',
      });
    }
    if (said.includes('retention sweep'))
      items.push({ kind: 'research', topic: 'retention sweep' });
    if (said.includes('still need the tunnel')) {
      items.push({
        kind: 'review',
        question: 'whether we still need the tunnel',
        requester: 'Speaker A',
      });
    }
    return Promise.resolve(items);
  },
};

const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('spoken asks on a huddle doc', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let docId: string;
  const schedule = new ManualScheduler();
  let ticks = 0;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const docMarkdown = (): string => {
    const room = handle.docStore.get(docId);
    if (!room) throw new Error(`no room for ${docId}`);
    return prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
  };
  const rows = () => handle.tasks.listTasks(workspaceId).filter((t) => t.kind !== 'goal');

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'spoken-asks-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: {
        composer: createStubNotesComposer(),
        taskExtractor: extractor,
        quietMs: 1_000,
        schedule,
        onNotes: () => {
          ticks += 1;
        },
      },
    });
    base = `http://localhost:${handle.port}`;
    workspaceId = (
      (await (await post('/api/workspaces', { name: 'spoken-asks-board' })).json()) as {
        workspace: { id: string };
      }
    ).workspace.id;
    // A lead in the seat, so a research ask has somebody to address.
    const attached = handle.tasks.attachAgent(workspaceId, {
      agentId: 'agent-lead',
      runtime: 'claude-code-local',
    });
    expect(attached.ok).toBe(true);
    expect(handle.tasks.getWorkspace(workspaceId)?.leadAgentId).toBe('agent-lead');
    docId = (
      (await (
        await post(`/api/workspaces/${workspaceId}/huddles`, { kind: 'discussion' })
      ).json()) as { docId: string }
    ).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files the task, the research row with its placeholder, and the review thread', async () => {
    const ws = new WebSocket(`ws://localhost:${handle.port}${meetingSocketPath(docId)}`);
    ws.binaryType = 'arraybuffer';
    const frames: Array<{ type: string; final?: boolean; text?: string }> = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(ev.data as string)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), 'ready');
    const speak = (chunks: number) => {
      for (let i = 0; i < chunks; i++) ws.send(new Uint8Array(640));
    };
    const finals = () => frames.filter((f) => f.type === 'transcript' && f.final === true).length;

    // Turn 1: "make that a task" — a row, todo, on the board, from the doc.
    speak(5);
    await waitFor(() => finals() === 1, 'turn 1');
    schedule.fire();
    await waitFor(() => ticks === 1, 'tick 1');
    await waitFor(() => rows().length === 1, 'the spoken task');
    const task = rows()[0];
    if (!task) throw new Error('no task');
    expect(task.title).toBe('Rotate the tunnel token before Friday');
    expect(task.status).toBe('todo');
    expect(task.origin).toEqual({ kind: 'doc', docId });
    expect(task.body).toContain('Heard in the meeting');
    expect(task.body).toContain('Asked for by Speaker A.');
    expect(task.body).toContain('> ');
    expect(task.body).toContain('Make that a task: rotate the tunnel token before Friday.');
    expect(task.body).toContain(`/docs/${docId})`);
    expect(task.createdBy).toBe('Meeting Assistant');

    // Turn 2: "can you research X" — the lead's row, and the doc's section.
    speak(4);
    await waitFor(() => finals() === 2, 'turn 2');
    schedule.fire();
    await waitFor(() => ticks === 2, 'tick 2');
    await waitFor(() => rows().length === 2, 'the research row');
    const research = rows().find((t) => t.title === 'Research: retention sweep');
    if (!research) throw new Error('no research row');
    expect(research.assignee).toBe('agent-lead');
    expect(research.status).toBe('todo');
    await waitFor(() => docMarkdown().includes('## Research: retention sweep'), 'the placeholder');
    expect(docMarkdown()).toContain(`/workspaces/${workspaceId}?task=${research.id}`);

    // Turn 3: "ask the team whether…" — a subject thread from the assistant,
    // and the doc stamped as review-requested naming it.
    speak(4);
    await waitFor(() => finals() === 3, 'turn 3');
    schedule.fire();
    await waitFor(() => ticks === 3, 'tick 3');
    const threadsOf = async () =>
      (
        (await (await fetch(`${base}/api/docs/${docId}/threads`)).json()) as {
          threads: Array<{
            id: string;
            anchor?: { kind?: string };
            createdBy?: { name?: string };
            comments?: Array<{ text?: string; author?: { name?: string } }>;
          }>;
        }
      ).threads;
    let threads = await threadsOf();
    const deadline = Date.now() + 3_000;
    while (threads.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      threads = await threadsOf();
    }
    expect(threads).toHaveLength(1);
    const thread = threads[0];
    if (!thread) throw new Error('no thread');
    expect(thread.anchor?.kind).toBe('subject');
    expect(thread.createdBy?.name).toBe('Meeting Assistant');
    expect(thread.comments?.[0]?.text).toContain('Speaker A asked in the meeting');
    expect(thread.comments?.[0]?.text).toContain('whether we still need the tunnel');
    const doc = (await (await fetch(`${base}/api/docs/${docId}`)).json()) as {
      meta: { reviewRequestedBy?: string; reviewThreadId?: string };
    };
    expect(doc.meta.reviewRequestedBy).toBe('Meeting Assistant');
    expect(doc.meta.reviewThreadId).toBe(thread.id);
    // Nothing filed twice: three asks, one row each.
    expect(rows()).toHaveLength(2);

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), 'stopped');
    ws.close();
  });
});
