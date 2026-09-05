import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * What an agent actually READS when find_and_replace refuses block markdown.
 *
 * The MCP client interpolates the whole response body into the Error it
 * throws, so the refusal reaches the agent as those exact bytes and nothing
 * else. An `error` code on its own is a slug with no next move in it — the
 * test asserts the body text, over the real route, because that is the only
 * place the surfaced wording exists.
 */
describe('find_and_replace refusal names the verb that does the job', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-far-block-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const file = join(dataDir, 'far-block.md');
    writeFileSync(file, 'A paragraph holding the anchor phrase.\n');
    const created = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'far-block', type: 'markdown', sourceUrl: file }),
    });
    expect(created.ok).toBe(true);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function refuse(replace: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${base}/api/docs/far-block/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'anchor phrase', replace }),
    });
    return { status: res.status, text: await res.text() };
  }

  it('a heading replacement is refused with a sentence naming insert_blocks_after_thread', async () => {
    const { status, text } = await refuse('### A heading');
    expect(status).toBe(409);
    expect(text).toContain('insert_blocks_after_thread');
    expect(text).toContain('cannot go inside an existing block');
    expect(text).toContain('### A heading');
  });

  it('a numbered-list replacement is refused the same way', async () => {
    const { status, text } = await refuse('1. First step\n2. Second step');
    expect(status).toBe(409);
    expect(text).toContain('insert_blocks_after_thread');
    expect(text).toContain('1. First step');
  });

  it('an ordinary inline replacement still succeeds', async () => {
    const res = await fetch(`${base}/api/docs/far-block/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'anchor phrase', replace: 'replacement phrase' }),
    });
    expect(res.status).toBe(200);
    const doc = (await (await fetch(`${base}/api/docs/far-block/content`)).json()) as {
      plainText: string;
    };
    expect(doc.plainText).toContain('replacement phrase');
  });
});
