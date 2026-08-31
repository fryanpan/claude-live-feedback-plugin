/**
 * The research confirmation against the REAL board, not a recorder.
 *
 * The recorder in `meeting-task-capture.test.ts` proves the pipeline calls
 * `addReviewItem` with the shape this module means to send. It cannot prove
 * the store ACCEPTS that shape — `checkReviewPayload` refuses a payload on
 * half a dozen grounds, and a stub that says `ok` to anything would let a
 * research ask file a row with no confirmation on it and no test would
 * notice. So this drives `runTaskCapture` through a real `TaskStore`.
 *
 * The other half is the gate the confirmation leans on: an open review item
 * is what stops the row being dispatched, and `awaiting-answer` is asserted
 * here for the row this pass actually filed.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewItemOpen } from '@feedback/core';
import type { NotesTurn } from '../src/meeting-notes.ts';
import { runTaskCapture } from '../src/meeting-task-capture.ts';
import { TaskStore } from '../src/tasks.ts';

const turns: NotesTurn[] = [
  { turn: 4, speaker: 'Priya', text: 'The offline queue keeps replaying the same batch.' },
  { turn: 5, speaker: 'Priya', text: 'Somebody go look into the offline queue replay, please.' },
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

  it('files a row the store accepts, carrying an OPEN decision item', async () => {
    const ws = store.createWorkspace('Voice research');
    const filed: string[] = [];
    const errors: string[] = [];
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
        onReviewFiled: ({ item }) => filed.push(item.id),
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
    // Never set moving: dispatch works `todo` rows, and this one is unvetted
    // until a person triages it.
    expect(row.status).toBe('triage');
    // And NOT banded out of reach — the store fills in `chores` for a caller
    // that names no goal (`tasks.ts`, `opts.goal ?? CHORES_GOAL_ID`). This
    // assertion exists because an earlier version of this design claimed the
    // absent band was what held the row. It is not; the two lines below are.
    expect(row.goal).toBe('chores');

    // The confirmation is really on the ticket, really a decision, and really
    // open — the three things the gate below reads.
    const items = store.listReviewItems(row.id);
    expect(items).toHaveLength(1);
    const item = items[0];
    if (!item) throw new Error('no review item filed');
    expect(filed).toEqual([item.id]);
    expect(item.review.shape).toBe('decision');
    expect(item.review.options?.map((o) => o.id)).toEqual(['go-ahead', 'not-now']);
    expect(isReviewItemOpen(item)).toBe(true);
    expect(item.createdBy).toBe('Meeting Assistant');
  });

  it('the open item is what holds the row, and answering releases it', async () => {
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
    const item = store.listReviewItems(row.id)[0];
    if (!item) throw new Error('no review item filed');

    // Held while unanswered — this is the enforcement the design leans on,
    // rather than a promise made in a prompt.
    expect(store.reviewState(row.id)?.open).toBe(1);

    const answered = store.answerTaskReview(row.id, item.id, 'Go ahead', {
      actor: { id: 'user-reader', name: 'Reader', kind: 'human' },
      answeredWith: 'go-ahead',
    });
    expect(answered.ok).toBe(true);
    // Released. The row is still in triage — a person places it, the way
    // every other agent-filed row is placed.
    expect(store.reviewState(row.id)?.open).toBe(0);
    expect(store.getTask(row.id)?.status).toBe('triage');
  });
});
