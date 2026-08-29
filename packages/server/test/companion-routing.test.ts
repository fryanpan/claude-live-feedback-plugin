/**
 * A comment on a diff member's EDITABLE COMPANION reaches whoever watches the
 * member — the diff doc or the review.
 *
 * A live working-tree diff review opens, per `.md` member, a second doc: the
 * prose editor bound to the same file (`openEditableFile`, id
 * `<setId>:edit` + relPath). The reviewer comments wherever they happen to be
 * reading, and the File view is where a prose reviewer reads. But the agent
 * that opened the review holds `watch_doc(<diff member id>)` and the
 * review's own stream — it has never heard the companion's id, because
 * nothing returned it. Measured over 48h of comment traffic (2026-08-28): a
 * companion comment reached nobody, was found ten minutes later after a chat
 * nudge, and three more were never answered.
 *
 * Every absence assertion sits next to a positive control on the same
 * stream: silence from a subscription you never made is indistinguishable
 * from nobody having commented.
 *
 * All fixtures synthetic. No port is bound (port: 0).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

interface Heard {
  events: string[];
  /** `docId` of every data frame, in arrival order. */
  docIds: string[];
  stop: () => void;
}

/** Read an SSE stream, collecting `event:` names and each frame's docId. */
function listen(res: Response): Heard {
  const events: string[] = [];
  const docIds: string[] = [];
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
          if (line.startsWith('data: ')) {
            try {
              const p = JSON.parse(line.slice('data: '.length)) as { docId?: string };
              if (p.docId) docIds.push(p.docId);
            } catch {}
          }
        }
      }
    } catch {}
  })();
  return {
    events,
    docIds,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('companion (:edit) doc comments route to the member watchers', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let baseSha: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  const comment = (docId: string, text: string) =>
    post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text,
      anchor: { kind: 'subject' },
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'companion-routing-'));
    repo = mkdtempSync(join(tmpdir(), 'companion-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), '# Title\n\nBody.\n');
    writeFileSync(join(repo, 'Main.kt'), 'fun main() {}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'README.md'), '# Title\n\nBody changed.\n');
    writeFileSync(join(repo, 'Main.kt'), 'fun main() { println("x") }\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** `create_diff_review` + the reviewer opening the File view on README.md. */
  async function openReview(): Promise<{
    reviewId: string;
    memberId: string;
    companionId: string;
  }> {
    const bind = await post('/api/diffs', { repo, base: baseSha });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      reviewId: string;
      files: Array<{ docId: string; relPath: string }>;
    };
    const memberId = bound.files.find((f) => f.relPath === 'README.md')?.docId ?? '';
    expect(memberId).not.toBe('');
    const open = await post(`/api/reviews/${encodeURIComponent(bound.reviewId)}/editable-file`, {
      relPath: 'README.md',
    });
    expect(open.status).toBe(200);
    const companionId = ((await open.json()) as { docId: string }).docId;
    expect(companionId).not.toBe(memberId);
    return { reviewId: bound.reviewId, memberId, companionId };
  }

  it('watch_doc on the diff member hears a comment on its companion', async () => {
    const { memberId, companionId } = await openReview();
    const stream = await get(`/events/${encodeURIComponent(memberId)}`);
    expect(stream.status).toBe(200);
    await settle(150);
    const heard = listen(stream);

    // Positive control: the member's own stream is live.
    expect((await comment(memberId, 'On the diff line.')).status).toBe(200);
    await settle();
    expect(heard.events).toContain('thread.created');
    expect(heard.docIds).toContain(memberId);

    expect((await comment(companionId, 'On the prose.')).status).toBe(200);
    await settle();
    heard.stop();

    expect(heard.events.filter((e) => e === 'thread.created')).toHaveLength(2);
    expect(heard.docIds).toContain(companionId);
  });

  it('the review stream (create_diff_review auto-watch) hears a companion comment', async () => {
    const { reviewId, memberId, companionId } = await openReview();
    const stream = await get(`/events/workspace/${encodeURIComponent(reviewId)}`);
    expect(stream.status).toBe(200);
    await settle(150);
    const heard = listen(stream);

    expect((await comment(memberId, 'On the diff line.')).status).toBe(200);
    await settle();
    expect(heard.docIds).toContain(memberId);

    expect((await comment(companionId, 'On the prose.')).status).toBe(200);
    await settle();
    heard.stop();

    expect(heard.events.filter((e) => e === 'thread.created')).toHaveLength(2);
    expect(heard.docIds).toContain(companionId);
  });

  it('a comment on the companion is not delivered twice to one stream', async () => {
    // A watcher holding BOTH the member stream and the review stream is the
    // MCP's normal state (auto-watch + an explicit watch_doc). The eid dedup
    // collapses copies across streams; what must not happen is one stream
    // carrying the same frame twice.
    const { memberId, companionId } = await openReview();
    const stream = await get(`/events/${encodeURIComponent(memberId)}`);
    await settle(150);
    const heard = listen(stream);
    expect((await comment(companionId, 'On the prose.')).status).toBe(200);
    await settle();
    heard.stop();
    expect(heard.docIds.filter((d) => d === companionId)).toHaveLength(1);
  });

  it('list_threads on the diff member includes the companion thread, tagged with its docId', async () => {
    const { memberId, companionId } = await openReview();
    expect((await comment(companionId, 'On the prose.')).status).toBe(200);
    expect((await comment(memberId, 'On the diff line.')).status).toBe(200);

    const res = await get(`/api/docs/${encodeURIComponent(memberId)}/threads`);
    expect(res.status).toBe(200);
    const { threads } = (await res.json()) as {
      threads: Array<{ docId?: string; comments: Array<{ text: string }> }>;
    };
    const texts = threads.map((t) => t.comments[0]?.text);
    expect(texts).toContain('On the diff line.');
    expect(texts).toContain('On the prose.');
    // The companion thread names its own doc so a reply lands on the right one.
    const prose = threads.find((t) => t.comments[0]?.text === 'On the prose.');
    expect(prose?.docId).toBe(companionId);
    // A member thread carries the member's id (or none — it is the doc asked).
    const diff = threads.find((t) => t.comments[0]?.text === 'On the diff line.');
    expect(diff?.docId ?? memberId).toBe(memberId);

    // Control: the companion's own listing is unchanged (no reflection back).
    const own = await get(`/api/docs/${encodeURIComponent(companionId)}/threads`);
    const ownTexts = (
      (await own.json()) as { threads: Array<{ comments: Array<{ text: string }> }> }
    ).threads.map((t) => t.comments[0]?.text);
    expect(ownTexts).toEqual(['On the prose.']);
  });
});
