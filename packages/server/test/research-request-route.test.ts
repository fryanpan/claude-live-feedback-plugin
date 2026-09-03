/**
 * The pointer pill's Research press, server side —
 * `POST /api/docs/:docId/research-request`.
 *
 * NOT a task. It was one, and Bryan pressed it on prod and found a board
 * row where the approved mock had a section in the notes (2026-09-01: "it
 * just creates a task — does not follow the flow in the mockups"). The
 * route now files an ordinary thread FROM THE PRESSER, anchored on the
 * selected line, and inserts a "Research: <topic>" placeholder section
 * right after the block that line sits in — the mock's flow. Same channel
 * as plan-request and review-request: a comment every watching agent
 * already hears, naming the section so the answer lands where the person
 * will look.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type User, prose } from '@feedback/core';
import { researchAskComment, researchPlaceholderMarkdown } from '../src/huddle.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

const NOTES = `# Widget rollout

- Notes lag a pause by several seconds; endpoint detection may close that gap.
- Speaker tags only when there is more than one voice.

## Next
`;

interface ThreadRow {
  id: string;
  anchor?: { kind?: string; snippet?: { text?: string } };
  createdBy?: { id?: string; name?: string };
  comments?: Array<{ text: string; author?: { name?: string } }>;
}
interface ResearchResponse {
  docId: string;
  threadId: string;
  section: string;
  placeholder: boolean;
}

describe('POST /api/docs/:docId/research-request', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const newHuddle = async (): Promise<string> => {
    const { docId } = await jj<{ docId: string }>(
      await post(`/api/workspaces/${workspaceId}/huddles`, { kind: 'discussion' }),
    );
    const set = handle.rooms.setDocContent(docId, NOTES);
    expect(set.ok).toBe(true);
    return docId;
  };
  const threadsOf = async (docId: string): Promise<ThreadRow[]> =>
    (await jj<{ threads: ThreadRow[] }>(await local(`/api/docs/${docId}/threads`))).threads;
  const markdownOf = (docId: string): string => {
    const room = handle.rooms.get(docId);
    if (!room) throw new Error('room missing');
    return prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
  };
  /** The selection, as the pill sends it: a text-range over the words. */
  const anchorOver = (docId: string, find: string) => {
    const room = handle.rooms.get(docId);
    if (!room) throw new Error('room missing');
    const r = prose.resolveTextRangeFromFind(room.ydoc, { find });
    if (!r.ok) throw new Error(`anchor: ${r.error}`);
    return {
      kind: 'text-range',
      startRel: Array.from(r.startRel),
      endRel: Array.from(r.endRel),
      snippet: { text: r.snippetText },
    };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'research-request-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
    workspaceId = (
      await jj<{ workspace: { id: string } }>(
        await post('/api/workspaces', { name: 'research-request-board' }),
      )
    ).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('files an anchored ask from the presser and opens a section after the line', async () => {
    const docId = await newHuddle();
    expect(await threadsOf(docId)).toHaveLength(0);
    // Positive control for the placeholder assertion below.
    expect(markdownOf(docId)).not.toContain('Research:');

    const r = await jj<ResearchResponse>(
      await post(`/api/docs/${docId}/research-request`, {
        author: PERSON,
        topic: 'endpoint detection for faster notes',
        anchor: anchorOver(docId, 'endpoint detection may close that gap'),
      }),
    );
    expect(r.docId).toBe(docId);
    expect(r.section).toBe('Research: endpoint detection for faster notes');
    expect(r.placeholder).toBe(true);

    const threads = await threadsOf(docId);
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.id).toBe(r.threadId);
    expect(thread.anchor?.kind).toBe('text-range');
    expect(thread.anchor?.snippet?.text).toBe('endpoint detection may close that gap');
    expect(thread.createdBy?.name).toBe('Jordan');
    expect(thread.comments?.[0]?.text).toBe(
      researchAskComment('endpoint detection for faster notes'),
    );
    expect(thread.comments?.[0]?.text).toContain('"Research: endpoint detection for faster notes"');

    // The section sits right after the block the selection is in — after
    // the bullet list, before "## Next" — the mock's "in place".
    const md = markdownOf(docId);
    const placeholder = researchPlaceholderMarkdown('endpoint detection for faster notes');
    expect(md).toContain(placeholder);
    expect(md.indexOf('Research:')).toBeGreaterThan(md.indexOf('more than one voice'));
    expect(md.indexOf('Research:')).toBeLessThan(md.indexOf('## Next'));
    // And it filed NO task — the row was the whole complaint.
    const { tasks } = await jj<{ tasks: unknown[] }>(
      await local(`/api/workspaces/${workspaceId}/tasks`),
    );
    expect(tasks).toHaveLength(0);
  });

  it('clips a long topic to a heading, without cutting a word', async () => {
    const docId = await newHuddle();
    const topic = `${'whether '.repeat(20)}Access covers the mockup route`;
    const r = await jj<ResearchResponse>(
      await post(`/api/docs/${docId}/research-request`, {
        author: PERSON,
        topic,
        anchor: anchorOver(docId, 'more than one voice'),
      }),
    );
    expect(r.section.length).toBeLessThanOrEqual('Research: '.length + 120);
    expect(r.section.startsWith('Research: whether whether')).toBe(true);
    expect(r.section).not.toMatch(/whethe…$/);
  });

  it('refuses a missing topic, a missing anchor, and an anchor that is not a range', async () => {
    const docId = await newHuddle();
    const anchor = anchorOver(docId, 'more than one voice');
    expect(
      (await post(`/api/docs/${docId}/research-request`, { author: PERSON, anchor })).status,
    ).toBe(400);
    expect(
      (await post(`/api/docs/${docId}/research-request`, { author: PERSON, topic: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await post(`/api/docs/${docId}/research-request`, {
          author: PERSON,
          topic: 'x',
          anchor: { kind: 'subject' },
        })
      ).status,
    ).toBe(400);
    // Nothing landed from any of them.
    expect(await threadsOf(docId)).toHaveLength(0);
    expect(markdownOf(docId)).not.toContain('Research:');
  });

  it('refuses an author naming nobody, and a share visitor', async () => {
    const docId = await newHuddle();
    const anchor = anchorOver(docId, 'more than one voice');
    const category = await post(`/api/docs/${docId}/research-request`, {
      author: { id: 'agent', name: 'agent', kind: 'agent' },
      topic: 'x',
      anchor,
    });
    expect(category.status).toBe(400);
    const share = await mintAccessShare(base, access, workspaceId);
    // Positive control: those same credentials DO read the doc, so the
    // refusal below is the route's rule rather than a rejected visitor.
    expect((await fetch(`${base}/api/docs/${docId}`, { headers: share.headers })).status).toBe(200);
    const visitor = await fetch(`${base}/api/docs/${docId}/research-request`, {
      method: 'POST',
      headers: { ...share.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ author: PERSON, topic: 'x', anchor }),
    });
    expect(visitor.ok).toBe(false);
    expect(await threadsOf(docId)).toHaveLength(0);
  });
});
