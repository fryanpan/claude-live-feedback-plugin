/**
 * A slow request leaves a line in the log.
 *
 * Bryan reported Home's recent-activity pane and doc opens taking "a really
 * long time" (2026-08-29) and there was nothing to grep: no per-request
 * timing anywhere in the server, so the investigation had to reproduce from
 * scratch. `[timing]` names the method, path, milliseconds to build the
 * response, status and body size, for anything at or over `slowRequestMs`
 * (default 500 ms). Bytes ride along because the duration alone cannot say
 * which kind of slow it was: a 0 ms route with a 1.2 MB body and a 3 s route
 * with a 4 KB one are different bugs, and only one of them is the handler.
 * Next time this is reported, the log answers it instead of an agent
 * reproducing from nothing.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

let dataDir: string;
let handle: ServerHandle | null = null;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cw-slow-log-'));
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  rmSync(dataDir, { recursive: true, force: true });
});

const timingLines = (calls: unknown[][]): string[] =>
  calls.map((c) => String(c[0])).filter((s) => s.startsWith('[timing]'));

describe('slow request log', () => {
  it('logs method, path, duration, status and bytes at or over the threshold', async () => {
    handle = createServer({ port: 0, dataDir, slowRequestMs: 0 });
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://localhost:${handle.port}/api/docs`);
      expect(res.status).toBe(200);
      const lines = timingLines(err.mock.calls);
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^\[timing\] GET \/api\/docs \d+ms status=200 bytes=\d+$/);
    } finally {
      err.mockRestore();
    }
  });

  it('stays silent under the threshold (default 500 ms)', async () => {
    handle = createServer({ port: 0, dataDir });
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://localhost:${handle.port}/api/docs`);
      expect(res.status).toBe(200);
      expect(timingLines(err.mock.calls)).toEqual([]);
    } finally {
      err.mockRestore();
    }
  });
});
