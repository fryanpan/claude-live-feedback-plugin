/**
 * A doc's discussion reaches every BOARD holding it, not just its grouping.
 *
 * The measured gap: an agent that attached to a board and watches
 * `/events/workspace/<boardId>` hears task events and task-body comments, and
 * hears NOTHING from a plain review doc filed on that same board. The fan-out
 * in `rooms.ts` is keyed on `meta.workspaceId` — the GROUPING tag a diff
 * review or folder bind sets — and a board link is not that tag. So a doc
 * created after the agent took its seat is silent, and silence from a
 * subscription you never made is indistinguishable from nobody commenting.
 *
 * Every absence assertion here sits next to a positive control on the same
 * stream, because that indistinguishability is the whole failure class.
 *
 * Resolution happens at BROADCAST time against the board's `docIds`, which is
 * why "and anything created later" needs no new call and no new field.
 *
 * All fixtures synthetic. No port is bound (port: 0); no production server is
 * touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId, workspaceRoomId } from '../src/task-projection.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Read an SSE stream, collecting `event:` names until stop(). */
function listen(res: Response): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
        }
      }
    } catch {}
  })();
  return {
    events,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

const countOf = (events: string[], name: string) => events.filter((e) => e === name).length;

describe('a doc thread reaches the boards holding the doc', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-doc-events-'));
    srcDir = mkdtempSync(join(tmpdir(), 'board-doc-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  /** A hub board with `agentId` seated as its lead, then a live SSE listener
   *  on the board channel — exactly what `attach_agent` + the MCP watch do. */
  async function seatLead(
    name: string,
    agentId = 'agent-board-lead',
  ): Promise<{ workspaceId: string; heard: ReturnType<typeof listen> }> {
    const w = await post('/api/workspaces', { name, goal: 'Ship the index.' });
    const { workspace } = (await w.json()) as { workspace: { id: string } };

    const att = await post(`/api/workspaces/${workspace.id}/attachments`, {
      agentId,
      runtime: 'claude-code-local',
    });
    expect(att.status).toBe(200);
    expect(((await att.json()) as { lead?: boolean }).lead).toBe(true);

    const stream = await get(`/events/workspace/${encodeURIComponent(workspace.id)}`);
    expect(stream.status).toBe(200);
    await settle(150);
    return { workspaceId: workspace.id, heard: listen(stream) };
  }

  /** `create_review_doc(docId, path, hubWorkspaceId)` over the real route. */
  async function makeDoc(docId: string, hubWorkspaceId?: string): Promise<void> {
    const path = join(srcDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nFirst paragraph.\n`);
    const res = await post('/api/docs', {
      docId,
      sourceUrl: path,
      title: docId,
      ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
    });
    expect(res.status).toBe(200);
    if (hubWorkspaceId) {
      expect(((await res.json()) as { hubWorkspaceId?: string }).hubWorkspaceId).toBe(
        hubWorkspaceId,
      );
    }
  }

  const comment = (docId: string, text: string) =>
    post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text,
      anchor: { kind: 'subject' },
    });

  /**
   * (a) The ticket's headline: the doc did not exist when the agent attached.
   * Nothing registered it against the board's channel, and it still arrives —
   * because the board's `docIds` is read at broadcast time.
   */
  it('a doc created AFTER the lead attached, filed on its board, reaches the board channel', async () => {
    const { workspaceId, heard } = await seatLead('index-revamp');

    // Control on the same stream, before the doc exists: it is live.
    await post(`/api/workspaces/${workspaceId}/tasks`, { author: PERSON, title: 'Control task' });
    await settle();
    expect(heard.events).toContain('task.created');

    await makeDoc('plan-doc', workspaceId);
    await settle(150);
    expect((await comment('plan-doc', 'This contradicts the goal.')).status).toBe(200);
    await settle();
    heard.stop();

    expect(heard.events).toContain('thread.created');
    expect(countOf(heard.events, 'thread.created')).toBe(1);
  });

  /**
   * (b) A diff review / folder bind puts ONE row on the board — the GROUPING —
   * and its member docs carry the grouping tag, never the board. That is the
   * one hop `shareWorkspacesOf` already documents, and the events need it too.
   */
  it('a member doc of a grouping filed on the board reaches it via the grouping hop', async () => {
    const { workspaceId, heard } = await seatLead('review-board');

    writeFileSync(join(srcDir, 'README.md'), '# Bound folder\n\nBody.\n');
    const bound = await post('/api/workspaces', {
      folderPath: srcDir,
      hubWorkspaceId: workspaceId,
    });
    expect(bound.status).toBe(200);
    const boundJson = (await bound.json()) as {
      workspaceId: string;
      hubWorkspaceId: string;
      files: Array<{ docId: string }>;
    };
    // The GROUPING is what went on the board — the member is not a row.
    expect(boundJson.hubWorkspaceId).toBe(workspaceId);
    const memberDocId = boundJson.files[0]?.docId;
    if (!memberDocId) throw new Error('folder bind produced no entry doc');
    expect(handle.rooms.get(memberDocId)?.meta.workspaceId).toBe(boundJson.workspaceId);

    const before = heard.events.length;
    await settle(150);
    expect((await comment(memberDocId, 'This hunk is wrong.')).status).toBe(200);
    await settle();
    heard.stop();

    expect(heard.events.slice(before)).toContain('thread.created');
    expect(countOf(heard.events, 'thread.created')).toBe(1);
  });

  /**
   * (c) POSITIVE CONTROL A — the pre-existing task-body path is untouched.
   * It must still arrive exactly once, and it must still refresh the row's
   * comment count, which no store event would otherwise move.
   */
  it('POSITIVE CONTROL: a task body thread still arrives once AND refreshes the row count', async () => {
    const { workspaceId, heard } = await seatLead('task-board');
    const t = await post(`/api/workspaces/${workspaceId}/tasks`, {
      author: PERSON,
      title: 'Wire the index',
    });
    const { task } = (await t.json()) as { task: { id: string } };
    await settle();

    const boardRoom = handle.rooms.get(workspaceRoomId(workspaceId));
    if (!boardRoom) throw new Error('board room missing');
    const projected = () =>
      boardRoom.ydoc.getMap('tasks').get(task.id) as { commentCount?: number };
    expect(projected().commentCount ?? 0).toBe(0);

    await comment(taskBodyDocId(task.id), 'Is this still above the API work?');
    await settle();
    heard.stop();

    expect(countOf(heard.events, 'thread.created')).toBe(1);
    expect(projected().commentCount).toBe(1);
  });

  /**
   * (d) POSITIVE CONTROL B — this is a widening, not a firehose. A doc filed
   * on somebody ELSE's board stays off this one.
   */
  it('POSITIVE CONTROL: a doc filed on a DIFFERENT board does not reach this one', async () => {
    const { workspaceId: w1, heard } = await seatLead('board-one', 'agent-lead-one');
    const { workspaceId: w2, heard: heardTwo } = await seatLead('board-two', 'agent-lead-two');
    expect(w1).not.toBe(w2);

    await makeDoc('other-doc', w2);
    await settle(150);
    const before = heard.events.length;
    await comment('other-doc', 'Filed on the other board.');
    await settle();
    heard.stop();
    heardTwo.stop();

    // The event fired — the board that HOLDS the doc heard it.
    expect(heardTwo.events).toContain('thread.created');
    // …and this board, which does not, heard nothing new at all.
    expect(heard.events.slice(before)).toEqual([]);
  });

  /**
   * (e) POSITIVE CONTROL C — the grouping channel `rooms.ts` already serves
   * must not double up now that a second resolver runs over the same event.
   */
  it('POSITIVE CONTROL: a grouping channel still gets the event exactly once', async () => {
    writeFileSync(join(srcDir, 'README.md'), '# Bound folder\n\nBody.\n');
    const bound = await post('/api/workspaces', { folderPath: srcDir });
    expect(bound.status).toBe(200);
    const boundJson = (await bound.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    const groupingId = boundJson.workspaceId;
    const memberDocId = boundJson.files[0]?.docId;
    if (!memberDocId) throw new Error('folder bind produced no entry doc');

    const stream = await get(`/events/workspace/${encodeURIComponent(groupingId)}`);
    expect(stream.status).toBe(200);
    const heard = listen(stream);
    await settle(150);

    await comment(memberDocId, 'Grouped docs already fan out.');
    await settle();
    heard.stop();

    expect(countOf(heard.events, 'thread.created')).toBe(1);
  });
});
