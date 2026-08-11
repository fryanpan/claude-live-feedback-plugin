/**
 * The `summariesEnabled` doc-meta flag — how a browser learns that generated
 * summaries exist AT ALL.
 *
 * The client infers "a summary is being generated" from three facts; two of
 * them (stored summary staleness, recent activity) it can compute alone, but
 * the third — is generation even switched on for this server? — only the
 * server knows. Without the flag, a client pointed at a key-less server would
 * show "Generating summary…" for 30 seconds after every comment, promising a
 * summary that will never come.
 *
 * The flag lives in the ydoc `meta` map because that is the surface every
 * client already syncs; asserting on the ydoc IS asserting on what a browser
 * receives. NOTHING HERE TOUCHES THE NETWORK — stub fetch, literal key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const stubFetch = (async () =>
  new Response(
    JSON.stringify({ content: [{ type: 'text', text: '{"topic":"t","discussion":"d"}' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

async function createDoc(base: string, dataDir: string, docId: string): Promise<void> {
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Doc\n\nsome text\n');
  const res = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
}

describe('summariesEnabled doc-meta flag', () => {
  const priorEnv = process.env.LF_SUMMARIES;

  afterAll(() => {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
    else process.env.LF_SUMMARIES = priorEnv;
  });

  describe('with generation on', () => {
    let handle: ServerHandle;
    let dataDir: string;
    let base: string;
    let summarizer: ThreadSummarizer;

    beforeAll(() => {
      Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
      dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-flag-on-'));
      summarizer = new ThreadSummarizer({
        apiKey: 'test-key-never-sent-anywhere',
        fetchImpl: stubFetch,
        debounceMs: 10 * 60_000,
      });
      handle = createServer({ port: 0, dataDir, summarizer });
      base = `http://localhost:${handle.port}`;
    });

    afterAll(async () => {
      summarizer.dispose();
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('stamps true into the synced meta map on doc creation', async () => {
      await createDoc(base, dataDir, 'flag-on');
      const room = handle.rooms.get('flag-on');
      expect(room?.ydoc.getMap('meta').get('summariesEnabled')).toBe(true);
    });
  });

  describe('with generation off (no key)', () => {
    let handle: ServerHandle;
    let dataDir: string;
    let base: string;
    let summarizer: ThreadSummarizer;

    beforeAll(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-flag-off-'));
      // apiKey: null is "no key" explicitly (omitting consults the Keychain,
      // which RESOLVES on the machine this feature runs on).
      summarizer = new ThreadSummarizer({ apiKey: null, fetchImpl: stubFetch });
      handle = createServer({ port: 0, dataDir, summarizer });
      base = `http://localhost:${handle.port}`;
    });

    afterAll(async () => {
      summarizer.dispose();
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('does not stamp true — a client must not promise a summary that never comes', async () => {
      // Positive control: this summarizer really is off.
      expect(summarizer.enabled).toBe(false);
      await createDoc(base, dataDir, 'flag-off');
      const room = handle.rooms.get('flag-off');
      expect(room?.ydoc.getMap('meta').get('summariesEnabled')).not.toBe(true);
    });
  });
});
