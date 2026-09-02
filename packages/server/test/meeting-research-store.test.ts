/**
 * The research row against the REAL board, not a recorder.
 *
 * The recorder in `meeting-task-capture.test.ts` proves the pipeline hands
 * `createTask` the shape `parseTaskCreate` produced. It cannot prove the
 * store PLACES that shape where the pill's Research lands — lead-addressed
 * and `todo` when the board has a lead, unowned at triage when it has none.
 * So this drives `runTaskCapture` through a real `TaskStore`.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotesTurn } from '../src/meeting-notes.ts';
import { runTaskCapture } from '../src/meeting-task-capture.ts';
import { TaskStore } from '../src/tasks.ts';

const turns: NotesTurn[] = [
  { turn: 4, speaker: 'Priya', text: 'The offline queue keeps replaying the same batch.' },
  { turn: 5, speaker: 'Priya', text: 'Can you research the offline queue replay for us, please.' },
];

const extractorOf = (items: unknown) => ({
  name: 'stub',
  extract: () => Promise.resolve(items as never),
});

describe('a research ask on the real board', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'meeting-research-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('with a lead seated, files the lead a todo the way the pill does', async () => {
    const ws = store.createWorkspace('Voice research', { leadAgentId: 'agent-helper' });
    const errors: string[] = [];
    const filed: string[] = [];
    const links = await runTaskCapture(
      {
        board: store,
        extractor: extractorOf([
          {
            kind: 'research',
            topic: 'offline queue replay',
            question: 'why does the same batch repeat?',
            requester: 'Priya',
          },
        ]),
        onResearchFiled: ({ url }) => filed.push(url),
        onError: (m) => errors.push(m),
      },
      { workspaceId: ws.id, docId: 'doc-meeting', docTitle: 'Queue review', turns },
    );

    // Nothing was refused on the way: not the create, not the payload.
    expect(errors).toEqual([]);
    expect(links.tasks).toHaveLength(1);

    const rows = store.listTasks(ws.id).filter((t) => t.kind !== 'goal');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('no row filed');
    expect(row.title).toBe('Research: offline queue replay');
    // The lead's errand, ready to pick up — the pill's own placement.
    expect(row.assignee).toBe('agent-helper');
    expect(row.assigneeKind).toBe('agent');
    expect(row.status).toBe('todo');
    expect(row.body).toContain('why does the same batch repeat?');
    expect(row.body).toContain('Priya');
    expect(row.body).toContain('> Priya: Can you research the offline queue replay');
    expect(row.origin).toEqual({ kind: 'doc', docId: 'doc-meeting' });
    expect(filed).toEqual([`/workspaces/${ws.id}?task=${row.id}`]);
    expect(links.tasks[0]?.status).toBe('todo');
  });

  it('with no lead, files at triage owned by nobody rather than by the asker', async () => {
    const ws = store.createWorkspace('Voice research');
    await runTaskCapture(
      {
        board: store,
        extractor: extractorOf([{ kind: 'research', topic: 'offline queue replay' }]),
      },
      { workspaceId: ws.id, docId: 'doc-meeting', turns },
    );
    const row = store.listTasks(ws.id).find((t) => t.kind !== 'goal');
    if (!row) throw new Error('no row filed');
    expect(row.status).toBe('triage');
    // Not the meeting assistant's: research is an errand for whoever leads,
    // and with nobody in the seat the row waits for a person to place it.
    expect(row.assignee).not.toBe('Meeting Assistant');
  });
});
