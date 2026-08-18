import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, User } from '@feedback/core';
import { NEEDS_YOU_CAP } from '../src/landing.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The landing page's "Needs you" band, through the real route.
 *
 * The model's arithmetic is unit-tested in `landing-model.test.ts`. What this
 * file covers is the layer nothing else does: that the route feeds the model
 * the rooms it claims to, that a task discussion on a hub board reaches the
 * band at all, and that the deep links it emits are the ones the rest of the
 * product already navigates to. Every absence asserted here has a presence
 * asserted beside it in the same response.
 */

const AGENT: User = { id: 'agent-one', name: 'One', kind: 'known', color: '#111' };
const PERSON: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#222' };

let handle: ServerHandle;
let dataDir: string;
let srcDir: string;
let base: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'needs-you-data-'));
  srcDir = mkdtempSync(join(tmpdir(), 'needs-you-src-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

async function j<T>(res: Response): Promise<T> {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
}

let docSeq = 0;
async function makeDoc(owner: string, body = '# Doc\n\nthe unique line\n'): Promise<string> {
  const docId = `ny-${docSeq++}`;
  const file = join(srcDir, `${docId}.md`);
  writeFileSync(file, body);
  await j(
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file, owner, title: docId }),
    }),
  );
  return docId;
}

/** `by_find`, never a hand-written anchor: the threads route takes `anchor`
 *  verbatim, and a fixture that invents one plants a malformed RelativePosition
 *  that kills the re-anchor sweep on an unrelated request. */
async function thread(docId: string, author: User, text: string): Promise<string> {
  const { thread } = await j<{ thread: Thread }>(
    await fetch(`${base}/api/docs/${docId}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author, text, find: 'the unique line' }),
    }),
  );
  return thread.id;
}

async function reply(docId: string, threadId: string, author: User, text: string): Promise<void> {
  await j(
    await fetch(`${base}/api/docs/${docId}/threads/${threadId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author, text }),
    }),
  );
}

const landing = async (): Promise<string> => (await fetch(`${base}/`)).text();

describe('the needs-you band, end to end', () => {
  let waitingDoc: string;
  let waitingThread: string;
  let answeredDoc: string;

  it('surfaces an unanswered agent comment and not a thread a person answered', async () => {
    waitingDoc = await makeDoc('/proj/needs');
    waitingThread = await thread(waitingDoc, AGENT, 'the deploy is red — which branch do you want');
    answeredDoc = await makeDoc('/proj/needs');
    const answered = await thread(answeredDoc, AGENT, 'ANSWERED-MARKER question');
    await reply(answeredDoc, answered, PERSON, 'go with main');

    const html = await landing();
    // Present: the waiting row, with the deep link that arrives AT the comment
    // rather than at the top of the doc.
    expect(html).toContain('which branch do you want');
    expect(html).toContain(
      `/review/${encodeURIComponent(waitingDoc)}?thread=${encodeURIComponent(waitingThread)}`,
    );
    // Absent: the answered one. The presence above is its positive control —
    // this response rendered rows, so the absence is a decision.
    expect(html).not.toContain('ANSWERED-MARKER');
    expect(html).toContain('1 of 1 shown');
  });

  it('caps the rows while reporting the true total', async () => {
    const doc = await makeDoc('/proj/many');
    for (let i = 0; i < NEEDS_YOU_CAP + 2; i += 1) {
      await thread(doc, AGENT, `bulk question ${i}`);
    }
    const html = await landing();
    // NEEDS_YOU_CAP bulk rows + the one still waiting from the first test.
    expect(html).toContain(`${NEEDS_YOU_CAP} of ${NEEDS_YOU_CAP + 3} shown`);
    const rows = html.match(/class="need"/g) ?? [];
    expect(rows).toHaveLength(NEEDS_YOU_CAP);
  });
});

/**
 * On its OWN server, deliberately. The band is capped at NEEDS_YOU_CAP rows,
 * so a fixture sharing the bulk-cap server above would have its single task
 * row correctly truncated away — and the test would read as "task threads
 * never reach the band" when what it measured was the cap working.
 */
describe('a task discussion reaches the band', () => {
  let taskHandle: ServerHandle;
  let taskDir: string;
  let taskBase: string;

  beforeAll(() => {
    taskDir = mkdtempSync(join(tmpdir(), 'needs-you-task-'));
    taskHandle = createServer({ port: 0, dataDir: taskDir });
    taskBase = `http://localhost:${taskHandle.port}`;
  });

  afterAll(async () => {
    await taskHandle.stop();
    rmSync(taskDir, { recursive: true, force: true });
  });

  it('links at the task on its board, and counts no artifact for the body room', async () => {
    const ws = await j<{ workspace: { id: string } }>(
      await fetch(`${taskBase}/api/workspaces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Needs-you board', goal: 'Ship it.' }),
      }),
    );
    const wsId = ws.workspace.id;
    const created = await j<{ task: { id: string } }>(
      await fetch(`${taskBase}/api/workspaces/${encodeURIComponent(wsId)}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: AGENT,
          title: 'TASKROW ship the thing',
          assignee: 'One',
          assigneeKind: 'agent',
        }),
      }),
    );
    const taskId = created.task.id;
    // The discussion lives in the task's own `task:<id>` body room — the same
    // door the board's own thread UI uses. `subject` is the anchor a task
    // thread takes when it is about the task rather than a span of its body.
    await j(
      await fetch(`${taskBase}/api/docs/${encodeURIComponent(`task:${taskId}`)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: AGENT,
          text: 'TASKASK which option do you want',
          anchor: { kind: 'subject' },
        }),
      }),
    );

    const html = await (await fetch(`${taskBase}/`)).text();
    expect(html).toContain('TASKASK which option do you want');
    expect(html).toContain(
      `/workspaces/${encodeURIComponent(wsId)}?task=${encodeURIComponent(taskId)}`,
    );
    expect(html).toContain('Needs-you board');
    // A board counts no artifacts — a task body room is a surface the server
    // owns, not something somebody put up for review. The needs-you row above
    // is the positive control: this page was built from real data.
    expect(html).toContain('board ·');
    expect(html).toContain('0 artifacts · 1 open thread');
  });
});

describe('un-retired reviews are made visible, never hidden', () => {
  it('badges a project whose bound source file is gone, and not one still on disk', async () => {
    const goneDoc = await makeDoc('/proj/forgotten');
    await makeDoc('/proj/remembered');
    unlinkSync(join(srcDir, `${goneDoc}.md`));

    const html = await landing();
    const forgotten = html.slice(html.indexOf('forgotten'));
    const rowEnd = forgotten.indexOf('</li>');
    expect(forgotten.slice(0, rowEnd)).toContain('1 source gone');
    // Positive control on the same page: the project whose file is still there
    // is rendered and carries no such badge.
    const remembered = html.slice(html.indexOf('remembered'));
    expect(remembered.slice(0, remembered.indexOf('</li>'))).not.toContain('source gone');
    // Nothing was deleted or hidden — both projects are still listed.
    expect(html).toContain('forgotten');
    expect(html).toContain('remembered');
  });
});
