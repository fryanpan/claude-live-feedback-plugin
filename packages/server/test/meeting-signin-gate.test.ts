/**
 * A meeting is a WRITE and a SPEND, so it needs a signed-in person.
 *
 * The `/audio/<docId>` upgrade is a GET, so `isGatedWrite` — which is keyed
 * on method — cannot see it, and before this gate existed a signed-out
 * browser on any origin the local surface admits could open the socket, send
 * `{type:'start'}`, open a billed transcription session and write notes into
 * somebody's doc.
 *
 * **Every refusal below is paired with a positive control**: the same frames,
 * byte for byte, from a caller that IS allowed to record — an agent (no
 * browser headers) on the same server, and a browser on a server booted with
 * the flag off. A probe that cannot produce a `ready` has not demonstrated
 * that anything was refused.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEETING_AUDIO_ENCODING, MEETING_SAMPLE_RATE, meetingSocketPath } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

interface Booted {
  handle: ServerHandle;
  base: string;
  wsBase: string;
  dataDir: string;
}

const booted: Booted[] = [];

function boot(requireSignInToWrite: boolean): Booted {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-signin-'));
  const handle = createServer({
    port: 0,
    dataDir,
    requireSignInToWrite,
    transcription: createMockTranscriptionEngine(),
  });
  const b: Booted = {
    handle,
    dataDir,
    base: `http://localhost:${handle.port}`,
    wsBase: `ws://localhost:${handle.port}`,
  };
  booted.push(b);
  return b;
}

/** Bind a doc the way an agent does — no browser headers, so the binding
 *  route's own browser refusal is not what this file is measuring. */
async function createDoc(b: Booted, docId: string): Promise<string> {
  const path = join(b.dataDir, `${docId}.md`);
  writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
  const res = await fetch(`${b.base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { docId: string }).docId;
}

/**
 * Open the audio socket. `asBrowser` attaches the header a page cannot forge
 * or suppress — its absence is what the server reads as "an agent", so a test
 * that forgot it would exercise the agent path while believing otherwise.
 */
async function openAudio(
  b: Booted,
  docId: string,
  opts: { asBrowser: boolean },
): Promise<{ frames: ServerFrame[]; ws: WebSocket }> {
  // Bun's WebSocket accepts request headers as its second argument; the DOM
  // lib types that slot as subprotocols, hence the cast. Sending `Origin` is
  // the whole point — it is what the server reads as "a browser".
  const init = opts.asBrowser
    ? ({ headers: { origin: b.base } } as unknown as string[])
    : undefined;
  const ws = new WebSocket(`${b.wsBase}${meetingSocketPath(docId)}`, init);
  const frames: ServerFrame[] = [];
  ws.addEventListener('message', (ev) => {
    frames.push(JSON.parse(ev.data as string) as ServerFrame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('audio socket refused the upgrade')));
  });
  return { frames, ws };
}

function start(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    }),
  );
}

async function waitForFrame(
  frames: ServerFrame[],
  type: string,
  timeoutMs = 2_000,
): Promise<ServerFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find((f) => f.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no "${type}" frame; got ${JSON.stringify(frames.map((f) => f.type))}`);
}

/** How many meetings this doc has on the server — the durable half, so a
 *  refusal is measured by what was NOT written rather than by a frame. */
async function meetingCount(b: Booted, docId: string): Promise<number> {
  const res = await fetch(`${b.base}/api/docs/${encodeURIComponent(docId)}/meetings`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { meetings: unknown[] }).meetings.length;
}

describe('meeting audio socket: the sign-in gate', () => {
  let gated: Booted;
  let ungated: Booted;

  beforeAll(() => {
    gated = boot(true);
    ungated = boot(false);
  });

  afterAll(async () => {
    for (const b of booted.splice(0)) {
      await b.handle.stop();
      rmSync(b.dataDir, { recursive: true, force: true });
    }
  });

  it('refuses `start` from a signed-out browser, opens no session, and writes no meeting', async () => {
    const docId = await createDoc(gated, 'gated-standup');
    const { frames, ws } = await openAudio(gated, docId, { asBrowser: true });
    start(ws);
    const err = await waitForFrame(frames, 'error');
    expect(String(err.message)).toContain('Sign in');
    // The refusal is a settled state, not a slow success: no engine session
    // was opened, so no `ready` can arrive after it.
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.map((f) => f.type)).not.toContain('ready');
    expect(await meetingCount(gated, docId)).toBe(0);
    ws.close();
  });

  it('positive control: an agent on the SAME server records normally', async () => {
    const docId = await createDoc(gated, 'agent-standup');
    const { frames, ws } = await openAudio(gated, docId, { asBrowser: false });
    start(ws);
    const ready = await waitForFrame(frames, 'ready');
    expect(ready.engine).toBe('mock');
    ws.close();
  });

  it('positive control: the same browser frames record when the flag is off', async () => {
    const docId = await createDoc(ungated, 'ungated-standup');
    const { frames, ws } = await openAudio(ungated, docId, { asBrowser: true });
    start(ws);
    const ready = await waitForFrame(frames, 'ready');
    expect(ready.engine).toBe('mock');
    ws.close();
  });
});
