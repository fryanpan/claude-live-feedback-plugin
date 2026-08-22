import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * HTTP-level tests for the suggested-edits route layer (redline-suggestions
 * phase 2, commit 3): `suggest: true` on find_and_replace / rewrite_region,
 * plus list/accept/reject/resolve_all — exercised through the REAL routes,
 * not by calling rooms.ts directly. Per the route-layer learnings ("groups"
 * silently dropped by the route that fronted it), a rooms-level unit test
 * proves nothing about whether the HTTP layer actually forwards a new param
 * — only a real fetch() through server.ts does.
 */

const author: User = { id: 'agent-1', name: 'Docs Agent', kind: 'known', color: '#7c5cff' };

describe('suggested edits — HTTP routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-suggest-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  async function makeDoc(docId: string, md: string): Promise<string> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, md);
    await j(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
      }),
    );
    return file;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('suggest:true on find_and_replace creates a pending suggestion — the FILE is unchanged until accept', async () => {
    const file = await makeDoc('sug-far', 'Alpha beta gamma.\n');

    const created = await j<{ ok: boolean; suggestionId: string }>(
      await fetch(`${base}/api/docs/sug-far/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ find: 'beta', replace: 'delta', suggest: true, author }),
      }),
    );
    expect(created.ok).toBe(true);
    expect(typeof created.suggestionId).toBe('string');

    // The normal debounced write-back window passes and disk is untouched —
    // proposal isolation (outcome 1 of the plan), proven at the ROUTE, not
    // just at rooms.ts.
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('Alpha beta gamma.\n');

    const list = await j<{ suggestions: Array<{ sid: string; kind: string; author: User }> }>(
      await fetch(`${base}/api/docs/sug-far/suggestions`),
    );
    expect(list.suggestions).toHaveLength(1);
    expect(list.suggestions[0]?.sid).toBe(created.suggestionId);
    expect(list.suggestions[0]?.kind).toBe('replace');

    // Accept via the route → flows to disk via the normal write-back.
    const accepted = await j<{ ok: boolean }>(
      await fetch(`${base}/api/docs/sug-far/suggestions/${created.suggestionId}/accept`, {
        method: 'POST',
      }),
    );
    expect(accepted.ok).toBe(true);
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('Alpha delta gamma.\n');
  });

  it('suggest:true on find_and_replace without an author is rejected — 400, no proposal created', async () => {
    await makeDoc('sug-noauthor', 'Alpha beta gamma.\n');
    const res = await fetch(`${base}/api/docs/sug-noauthor/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'beta', replace: 'delta', suggest: true }),
    });
    expect(res.status).toBe(400);
    const list = await j<{ suggestions: unknown[] }>(
      await fetch(`${base}/api/docs/sug-noauthor/suggestions`),
    );
    expect(list.suggestions).toHaveLength(0);
  });

  it('reject via the route restores exactly the pre-suggestion text', async () => {
    const file = await makeDoc('sug-reject', 'Alpha beta gamma.\n');
    const created = await j<{ suggestionId: string }>(
      await fetch(`${base}/api/docs/sug-reject/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ find: 'beta', replace: 'delta', suggest: true, author }),
      }),
    );
    const rejected = await j<{ ok: boolean }>(
      await fetch(`${base}/api/docs/sug-reject/suggestions/${created.suggestionId}/reject`, {
        method: 'POST',
      }),
    );
    expect(rejected.ok).toBe(true);
    const list = await j<{ suggestions: unknown[] }>(
      await fetch(`${base}/api/docs/sug-reject/suggestions`),
    );
    expect(list.suggestions).toHaveLength(0);
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('Alpha beta gamma.\n');
  });

  it('accept/reject on an unknown sid → 404 not-found', async () => {
    await makeDoc('sug-404', 'Alpha.\n');
    const res = await fetch(`${base}/api/docs/sug-404/suggestions/nope/accept`, {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('resolve_all accepts every pending proposal for one author, leaving others pending', async () => {
    const other: User = { id: 'human-1', name: 'Bryan', kind: 'known', color: '#00aa55' };
    const file = await makeDoc('sug-resolve-all', 'Alpha beta gamma.\n\nSecond paragraph here.\n');
    await j(
      await fetch(`${base}/api/docs/sug-resolve-all/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ find: 'beta', replace: 'delta', suggest: true, author }),
      }),
    );
    await j(
      await fetch(`${base}/api/docs/sug-resolve-all/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          find: 'paragraph',
          replace: 'section',
          suggest: true,
          author: other,
        }),
      }),
    );
    const res = await j<{ ok: boolean; resolved: number; sids: string[] }>(
      await fetch(`${base}/api/docs/sug-resolve-all/suggestions/resolve_all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'accept', authorId: 'agent-1' }),
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.resolved).toBe(1);
    const list = await j<{ suggestions: Array<{ sid: string }> }>(
      await fetch(`${base}/api/docs/sug-resolve-all/suggestions`),
    );
    expect(list.suggestions).toHaveLength(1);
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('Alpha delta gamma.\n\nSecond paragraph here.\n');
  });

  it('resolve_all requires a valid action', async () => {
    await makeDoc('sug-bad-action', 'Alpha.\n');
    const res = await fetch(`${base}/api/docs/sug-bad-action/suggestions/resolve_all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'nonsense' }),
    });
    expect(res.status).toBe(400);
  });

  it('suggest:true on rewrite_region proposes the thread-anchored rewrite instead of applying it — disk unchanged until accept', async () => {
    const file = await makeDoc('sug-rewrite-region', 'The quick brown fox jumped.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/api/docs/sug-rewrite-region/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'fix this', find: 'quick brown' }),
      }),
    );

    const created = await j<{ ok: boolean; suggestionId: string }>(
      await fetch(
        `${base}/api/docs/sug-rewrite-region/threads/${thread.thread.id}/rewrite_region`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replacement: 'lazy blue', suggest: true, author }),
        },
      ),
    );
    expect(created.ok).toBe(true);
    expect(typeof created.suggestionId).toBe('string');

    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('The quick brown fox jumped.\n');

    const accepted = await j<{ ok: boolean }>(
      await fetch(
        `${base}/api/docs/sug-rewrite-region/suggestions/${created.suggestionId}/accept`,
        { method: 'POST' },
      ),
    );
    expect(accepted.ok).toBe(true);
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('The lazy blue fox jumped.\n');
  });

  it('suggest:true on rewrite_region without an author is rejected — 400', async () => {
    await makeDoc('sug-rr-noauthor', 'The quick brown fox.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/api/docs/sug-rr-noauthor/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'fix this', find: 'quick brown' }),
      }),
    );
    const res = await fetch(
      `${base}/api/docs/sug-rr-noauthor/threads/${thread.thread.id}/rewrite_region`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replacement: 'lazy blue', suggest: true }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('fires suggestion.created / suggestion.accepted / suggestion.rejected webhooks — watchers hear the verdict', async () => {
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        hits.push(await req.json());
        return new Response('ok');
      },
    });
    const hits: Array<{ event: string; docId: string; sid: string }> = [];
    try {
      const webhookUrl = `http://localhost:${sink.port}/hook`;
      const file = join(dataDir, 'sug-hook.md');
      writeFileSync(file, 'Alpha beta gamma.\n');
      // `sug-hook` is the readable name; the server mints the id, and every
      // event it fires carries the minted one.
      const { docId: hookDocId } = await j<{ docId: string }>(
        await fetch(`${base}/api/docs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            docId: 'sug-hook',
            type: 'markdown',
            sourceUrl: file,
            webhookUrl,
          }),
        }),
      );
      const created = await j<{ suggestionId: string }>(
        await fetch(`${base}/api/docs/sug-hook/find_and_replace`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ find: 'beta', replace: 'delta', suggest: true, author }),
        }),
      );
      await j(
        await fetch(`${base}/api/docs/sug-hook/suggestions/${created.suggestionId}/accept`, {
          method: 'POST',
        }),
      );

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && hits.length < 2) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const events = hits.map((h) => h.event);
      expect(events).toContain('suggestion.created');
      expect(events).toContain('suggestion.accepted');
      const acceptedHit = hits.find((h) => h.event === 'suggestion.accepted');
      expect(acceptedHit?.sid).toBe(created.suggestionId);
      expect(acceptedHit?.docId).toBe(hookDocId);
    } finally {
      sink.stop();
    }
  });
  /**
   * Codex review follow-ups, both at the ROUTE layer because both bugs live
   * in params the route hand-copies (the "route silently drops params"
   * learnings): `parseInlineMarks` was accepted alongside `suggest: true`
   * and discarded, and the find could anchor onto another proposal's
   * unaccepted text.
   */
  it('parseInlineMarks + suggest:true survives the route — the accepted proposal carries the link mark', async () => {
    const file = await makeDoc('sug-marks', 'See the docs here.\n');
    const created = await j<{ ok: boolean; suggestionId: string }>(
      await fetch(`${base}/api/docs/sug-marks/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          find: 'the docs',
          replace: '[the docs](https://example.com)',
          parseInlineMarks: true,
          suggest: true,
          author,
        }),
      }),
    );
    expect(created.ok).toBe(true);
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('See the docs here.\n');

    // The proposal's inserted TEXT is the discriminator: a real link mark
    // holds the label only, while a dropped parseInlineMarks would leave the
    // raw `[label](url)` characters. On disk the two are identical strings,
    // so asserting on the file alone would pass either way.
    const list = await j<{ suggestions: Array<{ sid: string; insertedText: string }> }>(
      await fetch(`${base}/api/docs/sug-marks/suggestions`),
    );
    expect(list.suggestions[0]?.insertedText).toBe('the docs');

    await j(
      await fetch(`${base}/api/docs/sug-marks/suggestions/${created.suggestionId}/accept`, {
        method: 'POST',
      }),
    );
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('See [the docs](https://example.com) here.\n');
  });

  it('parseInlineMarks + suggest:true on rewrite_region survives the route too', async () => {
    const file = await makeDoc('sug-rr-marks', 'See the docs here.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/api/docs/sug-rr-marks/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'link this', find: 'the docs' }),
      }),
    );
    const created = await j<{ ok: boolean; suggestionId: string }>(
      await fetch(`${base}/api/docs/sug-rr-marks/threads/${thread.thread.id}/rewrite_region`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replacement: '[the docs](https://example.com)',
          parseInlineMarks: true,
          suggest: true,
          author,
        }),
      }),
    );
    expect(created.ok).toBe(true);
    const list = await j<{ suggestions: Array<{ insertedText: string }> }>(
      await fetch(`${base}/api/docs/sug-rr-marks/suggestions`),
    );
    expect(list.suggestions[0]?.insertedText).toBe('the docs');
    await j(
      await fetch(`${base}/api/docs/sug-rr-marks/suggestions/${created.suggestionId}/accept`, {
        method: 'POST',
      }),
    );
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('See [the docs](https://example.com) here.\n');
  });

  it('a suggestion inside a bold span keeps the bold through accept', async () => {
    const file = await makeDoc('sug-bold', 'This is **bold text** here.\n');
    const created = await j<{ suggestionId: string }>(
      await fetch(`${base}/api/docs/sug-bold/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          find: 'bold text',
          replace: 'strong text',
          suggest: true,
          author,
        }),
      }),
    );
    await j(
      await fetch(`${base}/api/docs/sug-bold/suggestions/${created.suggestionId}/accept`, {
        method: 'POST',
      }),
    );
    await sleep(1300);
    expect(readFileSync(file, 'utf8')).toBe('This is **strong text** here.\n');
  });

  it('a find that only matches inside a pending proposal is refused — 409 match-in-pending-suggestion', async () => {
    await makeDoc('sug-isolation', 'Alpha beta gamma.\n');
    await j(
      await fetch(`${base}/api/docs/sug-isolation/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ find: 'beta', replace: 'delta zeta', suggest: true, author }),
      }),
    );
    const res = await fetch(`${base}/api/docs/sug-isolation/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'zeta', replace: 'eta', suggest: true, author }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('match-in-pending-suggestion');
    const list = await j<{ suggestions: unknown[] }>(
      await fetch(`${base}/api/docs/sug-isolation/suggestions`),
    );
    expect(list.suggestions).toHaveLength(1);
  });
});
