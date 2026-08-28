/**
 * The `/audio/<docId>` socket through the REAL server: the upgrade guard, the
 * `start` → `ready` → words → `stop` sequence, and the transcript that is
 * left on disk afterwards.
 *
 * The engine is always the mock one. Nothing here reaches the network, and
 * nothing here would if `transcription` were omitted either — that is what
 * the no-default seam buys, and one test below asserts exactly it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEETING_AUDIO_ENCODING, MEETING_SAMPLE_RATE, meetingSocketPath } from '@feedback/core';
import { meetingTranscriptPath } from '../src/meetings.ts';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

/** A meeting client: opens the socket, collects the JSON frames it is sent. */
class AudioClient {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {}

  static async open(base: string, docId: string): Promise<AudioClient> {
    const ws = new WebSocket(`${base}${meetingSocketPath(docId)}`);
    ws.binaryType = 'arraybuffer';
    const client = new AudioClient(ws);
    ws.addEventListener('message', (ev) => {
      client.frames.push(JSON.parse(ev.data as string) as ServerFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    return client;
  }

  start(sampleRate = MEETING_SAMPLE_RATE): void {
    this.ws.send(JSON.stringify({ type: 'start', sampleRate, encoding: MEETING_AUDIO_ENCODING }));
  }

  /** One 20ms frame of silence — the relay only counts chunks, not samples. */
  speak(chunks: number): void {
    for (let i = 0; i < chunks; i++) this.ws.send(new Uint8Array(640));
  }

  stop(): void {
    this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  /** Wait for a frame of this type, or fail loudly with what did arrive. */
  async waitFor(type: string, timeoutMs = 2_000): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find((f) => f.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no "${type}" frame; got ${JSON.stringify(this.frames.map((f) => f.type))}`);
  }

  of(type: string): ServerFrame[] {
    return this.frames.filter((f) => f.type === type);
  }
}

describe('meeting audio socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  /** The canonical id behind the `standup-notes` alias, shared by two tests. */
  let standupDocId = '';

  /**
   * Returns the doc's CANONICAL id. The name passed in is an alias — every
   * URL in these tests uses the alias on purpose, because that is what a
   * human hands over, while the transcript files are named after the doc.
   */
  const createDoc = async (docId: string): Promise<string> => {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-socket-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(),
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs a whole meeting: ready, revised words, stop, and a transcript on disk', async () => {
    const canonical = await createDoc('standup-notes');
    standupDocId = canonical;
    const client = await AudioClient.open(wsBase, 'standup-notes');
    client.start();
    const ready = await client.waitFor('ready');
    expect(ready.engine).toBe('mock');
    expect(typeof ready.meetingId).toBe('string');

    // Six chunks reveal the six words of the first scripted turn; the seventh
    // settles it, which is where the correction lands.
    client.speak(7);
    await client.waitFor('stopped', 0).catch(() => undefined);
    // Wait for the settled turn rather than a fixed sleep.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !client.of('transcript').some((f) => f.final === true)) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const transcripts = client.of('transcript');
    const partials = transcripts.filter((f) => f.final === false);
    const finals = transcripts.filter((f) => f.final === true);
    expect(partials.length).toBeGreaterThan(1);
    expect(finals).toHaveLength(1);

    // The revision the whole turn-shaped contract exists for: every partial
    // carries the SAME turn number, and the settled text rewrites a word the
    // reader had already seen.
    expect(new Set(transcripts.map((f) => f.turn))).toEqual(new Set([0]));
    expect(String(partials[partials.length - 1]?.text)).toContain('sink');
    expect(String(finals[0]?.text)).toBe('So the sync is the bottleneck.');

    client.stop();
    const stopped = await client.waitFor('stopped');
    expect(stopped.meetingId).toBe(ready.meetingId);
    expect(typeof stopped.endedAt).toBe('number');

    // The durable half, read off disk and not out of the response.
    const lines = readFileSync(
      meetingTranscriptPath(dataDir, canonical, String(ready.meetingId)),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { turn: number; text: string });
    expect(lines).toEqual([
      expect.objectContaining({ turn: 0, text: 'So the sync is the bottleneck.' }),
    ]);
    client.ws.close();
  });

  it('serves the finished meeting back over REST for a later notes agent', async () => {
    const list = (await (await fetch(`${base}/api/docs/standup-notes/meetings`)).json()) as {
      docId: string;
      meetings: Array<{ meetingId: string; turns?: number; endedAt: number | null }>;
      recording?: string;
    };
    // Addressed by the readable alias, answered with the doc's own id — the
    // same canonicalization every other `/api/docs/<id>` route does.
    expect(list.docId).toBe(standupDocId);
    expect(list.meetings).toHaveLength(1);
    expect(list.recording).toBeUndefined();
    const [meeting] = list.meetings;
    expect(meeting?.endedAt).not.toBeNull();
    expect(meeting?.turns).toBe(1);

    const detail = (await (
      await fetch(`${base}/api/docs/standup-notes/meetings/${meeting?.meetingId}`)
    ).json()) as { transcript: Array<{ turn: number; text: string }>; turns?: number };
    expect(detail.turns).toBe(1);
    expect(detail.transcript.map((t) => t.text)).toEqual(['So the sync is the bottleneck.']);

    const missing = await fetch(`${base}/api/docs/standup-notes/meetings/m-nope-1`);
    expect(missing.status).toBe(404);
  });

  it('flushes the sentence in progress when stop arrives mid-turn', async () => {
    const canonical = await createDoc('cut-off-midway');
    const client = await AudioClient.open(wsBase, 'cut-off-midway');
    client.start();
    const ready = await client.waitFor('ready');
    client.speak(2);
    // Let the partials land before stopping, so the stop is genuinely mid-turn.
    await new Promise((r) => setTimeout(r, 100));
    client.stop();
    await client.waitFor('stopped');
    const stored = readFileSync(
      meetingTranscriptPath(dataDir, canonical, String(ready.meetingId)),
      'utf8',
    ).trim();
    expect(JSON.parse(stored) as { text: string }).toMatchObject({ turn: 0, text: 'so the' });
    client.ws.close();
  });

  it('ends the meeting when the socket just goes away', async () => {
    const canonical = await createDoc('tab-closed');
    const client = await AudioClient.open(wsBase, 'tab-closed');
    client.start();
    const ready = await client.waitFor('ready');
    client.speak(7);
    await new Promise((r) => setTimeout(r, 100));
    client.ws.close();
    // The record must close itself; nothing sent `stop`.
    const deadline = Date.now() + 2_000;
    let meetings: Array<{ endedAt: number | null; turns?: number }> = [];
    while (Date.now() < deadline) {
      const body = (await (await fetch(`${base}/api/docs/tab-closed/meetings`)).json()) as {
        meetings: Array<{ endedAt: number | null; turns?: number }>;
      };
      meetings = body.meetings;
      if (meetings[0]?.endedAt !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.endedAt).not.toBeNull();
    expect(meetings[0]?.turns).toBe(1);
    expect(String(ready.meetingId)).toContain(canonical);
  });

  it('tells a second socket the doc is already recording, and stays open', async () => {
    await createDoc('one-mic-only');
    const first = await AudioClient.open(wsBase, 'one-mic-only');
    first.start();
    await first.waitFor('ready');

    const second = await AudioClient.open(wsBase, 'one-mic-only');
    second.start();
    const refused = await second.waitFor('unavailable');
    expect(refused.reason).toBe('already_recording');
    // Open, not closed: the strip has to be able to render the reason.
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(second.of('ready')).toHaveLength(0);

    first.stop();
    await first.waitFor('stopped');
    first.ws.close();
    second.ws.close();
  });

  it('broadcasts only the lifecycle facts to the doc channel, never the words', async () => {
    await createDoc('sse-watcher');
    const events: Array<{ event: string }> = [];
    const controller = new AbortController();
    const stream = await fetch(`${base}/events/sse-watcher`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('no SSE body');
    const pump = (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
          for (const line of buf.split('\n')) {
            const match = line.match(/^data: (.*)$/);
            if (match?.[1]) events.push(JSON.parse(match[1]) as { event: string });
          }
          buf = buf.slice(buf.lastIndexOf('\n') + 1);
        }
      } catch {
        // The abort below is how this loop ends.
      }
    })();

    const client = await AudioClient.open(wsBase, 'sse-watcher');
    client.start();
    await client.waitFor('ready');
    client.speak(7);
    await new Promise((r) => setTimeout(r, 100));
    client.stop();
    await client.waitFor('stopped');
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pump;
    client.ws.close();

    const kinds = events.map((e) => e.event).filter((e) => e.startsWith('meeting.'));
    expect(kinds).toEqual(['meeting.started', 'meeting.stopped']);
    // The words rode the audio socket. Nothing word-rate reached the hub — a
    // transcript on this channel would evict every real doc event from the
    // 200-event replay buffer.
    expect(events.some((e) => JSON.stringify(e).includes('bottleneck'))).toBe(false);
  });

  it('answers an unreadable frame without ending the connection', async () => {
    await createDoc('bad-frames');
    const client = await AudioClient.open(wsBase, 'bad-frames');
    client.ws.send('{"type":"start","sampleRate":"loads","encoding":"pcm_s16le"}');
    const err = await client.waitFor('error');
    expect(err.message).toBe('unreadable frame');
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    // And the socket is still usable afterwards.
    client.start();
    await client.waitFor('ready');
    client.stop();
    await client.waitFor('stopped');
    client.ws.close();
  });

  it('refuses the upgrade for a foreign origin and for a doc that does not exist', async () => {
    await createDoc('guarded');
    const foreign = await fetch(`${base}${meetingSocketPath('guarded')}`, {
      headers: {
        origin: 'https://evil.example.com',
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(foreign.status).toBe(403);

    const missing = await fetch(`${base}${meetingSocketPath('never-created')}`, {
      headers: {
        upgrade: 'websocket',
        connection: 'upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(missing.status).toBe(404);
  });
});

describe('meeting audio socket with no engine configured', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-off-'));
    // No `transcription`: the default state of every server in this suite,
    // and the reason none of them can open a billed streaming session.
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('says not_configured and keeps the socket open', async () => {
    const path = join(dataDir, 'quiet.md');
    writeFileSync(path, '# quiet\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'quiet', sourceUrl: path, title: 'quiet' }),
    });
    const client = await AudioClient.open(wsBase, 'quiet');
    client.start();
    const frame = await client.waitFor('unavailable');
    expect(frame.reason).toBe('not_configured');
    expect(typeof frame.message).toBe('string');
    expect(client.ws.readyState).toBe(WebSocket.OPEN);

    // Audio after a refusal is dropped, not crashed on.
    client.speak(3);
    await new Promise((r) => setTimeout(r, 50));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(client.of('ready')).toHaveLength(0);

    // And nothing was recorded.
    const list = (await (await fetch(`${base}/api/docs/quiet/meetings`)).json()) as {
      meetings: unknown[];
    };
    expect(list.meetings).toEqual([]);
    client.ws.close();
  });
});

/**
 * The audio socket spends money and opens a microphone, so who may reach it is
 * not the same question as who may read the doc. `shareScopeAllows` is a closed
 * allowlist and `/audio/` was never added to it, so a share visitor has been
 * refused since the route existed — this pins that, because "closed by default"
 * is a property of a file somebody can edit.
 */
describe('a share visitor cannot open a doc’s meeting audio socket', () => {
  const HUB: ShareTarget = { workspaceId: 'hub-1' };
  const OTHER: ShareTarget = { workspaceId: 'ws-a' };
  const workspaceOf = (d: string): string[] =>
    d === 'standup-notes' ? ['ws-a'] : d.startsWith('hub-1:') ? ['hub-1'] : [];

  it('refuses /audio/ for every share, however the doc is addressed', () => {
    // Reading a board is not a reason to be able to spend money against a doc
    // filed on it — and unlike a foreign write on the editing socket, which is
    // reverted server-side, a recording that happened cannot be taken back.
    for (const target of [HUB, OTHER]) {
      expect(shareScopeAllows('/audio/standup-notes', 'GET', target, workspaceOf)).toBe(false);
      expect(shareScopeAllows('/audio/hub-1%3Aplan.md', 'GET', target, workspaceOf)).toBe(false);
    }
  });

  it('positive control: the same doc IS reachable over the editing socket', () => {
    // Without this the refusals above would also pass against a fixture that
    // refuses everything it is handed.
    expect(shareScopeAllows('/y/standup-notes', 'GET', OTHER, workspaceOf)).toBe(true);
  });
});
