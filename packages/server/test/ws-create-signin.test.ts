/**
 * Creating a doc over the `/y/` socket is a WRITE, and it is gated like one.
 *
 * The mockup auto-create is the widget's creation path, next to POST
 * /api/docs and the MCP tools. It used to run ABOVE the socket's read-only
 * decision, so a browser that had proven nobody could open
 * `/y/<any-new-id>?type=mockup` and make the server create a doc and file a
 * new row under the board workspace — the read-only carry only stopped the ydoc
 * edits that came afterwards, never the creation itself.
 *
 * Refusing here gates no READ: the doc the socket would have created does not
 * exist for anybody, so there is nothing this refusal keeps a reader from.
 * The pair of tests below is the whole point — the same socket, byte for
 * byte, against a server with the flag off, which must create the doc.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(requireSignInToWrite: boolean): ServerHandle {
  const dataDir = mkdtempSync(join(tmpdir(), 'ws-create-signin-'));
  const handle = createServer({ port: 0, dataDir, requireSignInToWrite });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return handle;
}

/**
 * Open `/y/<docId>?type=mockup` as a BROWSER — `Origin` is what the server
 * reads as "a browser", and the socket is refused outright without an allowed
 * one, so this header is load-bearing twice over.
 *
 * Resolves `true` when the socket opened, `false` when the handshake was
 * refused. Bun's WebSocket takes request headers as its second argument; the
 * DOM lib types that slot as subprotocols, hence the cast.
 */
async function connectAsBrowser(handle: ServerHandle, docId: string): Promise<boolean> {
  const origin = `http://localhost:${handle.port}`;
  WS = await seedBoard(origin);
  const ws = new WebSocket(
    `ws://localhost:${handle.port}/workspaces/${WS}/docs/${docId}/y?type=mockup`,
    {
      headers: { origin },
    } as unknown as string[],
  );
  const opened = await new Promise<boolean>((resolve) => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
    ws.addEventListener('close', () => resolve(false));
  });
  try {
    ws.close();
  } catch {
    // Already closed by the refusal.
  }
  return opened;
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('the /y/ mockup auto-create is behind the sign-in gate', () => {
  it('refuses a signed-out browser: no doc, and no board-workspace row', async () => {
    const handle = boot(true);
    expect(await connectAsBrowser(handle, 'ws-create-refused')).toBe(false);
    expect(handle.docStore.get('ws-create-refused')).toBeUndefined();
    expect(handle.tasks.workspaceOfDoc('ws-create-refused')).toBeFalsy();
  });

  it('positive control: the same socket creates and files the doc with the flag off', async () => {
    const handle = boot(false);
    expect(await connectAsBrowser(handle, 'ws-create-allowed')).toBe(true);
    expect(handle.docStore.get('ws-create-allowed')).toBeTruthy();
    expect(handle.tasks.workspaceOfDoc('ws-create-allowed')).toBeTruthy();
  });
});
