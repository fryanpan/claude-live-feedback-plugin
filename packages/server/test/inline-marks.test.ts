import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The layer no unit test covers: `POST /api/docs/:id/find_and_replace` is what
 * the MCP tool actually calls, and the bug this guards was found on a bound
 * doc — where the only durable evidence is what gets written back to the .md.
 * So this asserts on the `**` markers in the FILE, which is exactly how the
 * loss was caught in the field, plus the report field on the HTTP response.
 */
describe('find_and_replace over HTTP keeps the marks on a bound file', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-marks-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bind(docId: string, markdown: string): Promise<string> {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, markdown);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: path }),
    });
    expect(res.ok).toBe(true);
    return path;
  }

  const replace = (docId: string, body: Record<string, unknown>) =>
    fetch(`${base}/api/docs/${docId}/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rewrites a whole bold label without dropping its bold', async () => {
    const path = await bind(
      'marks-1',
      '# Release notes\n\n- **Fast, secure share** - the link expires on its own\n- **Ambient awareness** - see who else is in the doc\n',
    );

    const res = await replace('marks-1', {
      find: 'Fast, secure share',
      replace: 'Fast, secure sharing',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; marksDropped?: string[] };
    expect(body.ok).toBe(true);
    expect(body.marksDropped).toBeUndefined();

    await sleep(1100); // debounced write-back
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('**Fast, secure sharing**');
    // Positive control: the sibling label nobody touched still has its bold,
    // so "the file has ** in it" is not passing for an unrelated reason.
    expect(written).toContain('**Ambient awareness**');
    // The count is the check the field used — plain text was right the whole
    // time and only the marker count moved.
    expect(written.split('**').length - 1).toBe(4);
  });

  it('reports the mark it could not carry instead of returning a bare ok', async () => {
    await bind('marks-2', '# Notes\n\nIntro **bold label** trailing text\n');

    const res = await replace('marks-2', {
      find: 'bold label trailing',
      replace: 'flattened',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; marksDropped?: string[]; warning?: string };
    expect(body.ok).toBe(true);
    expect(body.marksDropped).toEqual(['bold']);
    expect(body.warning).toContain('bold');
  });
});
