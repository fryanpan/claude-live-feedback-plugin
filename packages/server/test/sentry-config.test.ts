import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The Sentry half of the monitoring ask (t-scWMQmOZcpu1): the DSN lives in
 * server config on the box — NOT in this public repo — and reaches the
 * browser through a meta tag in the hub shell. The client only loads the
 * Sentry SDK when the tag is present, so an unconfigured install (every
 * test, every stranger's clone) ships zero Sentry bytes and makes zero
 * external requests.
 */
describe('the hub shell carries the Sentry DSN only when configured', () => {
  let withDsn: ServerHandle;
  let without: ServerHandle;
  let dirA: string;
  let dirB: string;
  let wsA: string;
  let wsB: string;

  async function makeWs(base: string): Promise<string> {
    const mk = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sentry board' }),
    });
    return ((await mk.json()) as { workspace: { id: string } }).workspace.id;
  }

  beforeAll(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'sentry-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'sentry-b-'));
    withDsn = createServer({
      port: 0,
      dataDir: dirA,
      sentryDsn: 'https://examplekey@o0.ingest.sentry.io/0',
    });
    without = createServer({ port: 0, dataDir: dirB });
    wsA = await makeWs(`http://localhost:${withDsn.port}`);
    wsB = await makeWs(`http://localhost:${without.port}`);
  });

  afterAll(async () => {
    await withDsn.stop();
    await without.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('configured: the shell names the DSN in a meta tag', async () => {
    const html = await (
      await fetch(`http://localhost:${withDsn.port}/workspaces/${wsA}/home`)
    ).text();
    expect(html).toContain(
      '<meta name="sentry-dsn" content="https://examplekey@o0.ingest.sentry.io/0" />',
    );
  });

  it('unconfigured: no sentry tag at all (the row itself still renders)', async () => {
    const html = await (
      await fetch(`http://localhost:${without.port}/workspaces/${wsB}/home`)
    ).text();
    expect(html).toContain('hub-root'); // positive control: the shell rendered
    expect(html).not.toContain('sentry-dsn');
  });
});
