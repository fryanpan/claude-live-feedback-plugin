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
import {
  type CaptureMode,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
} from '@feedback/core';
import { listMeetings, meetingTranscriptPath } from '../src/meetings.ts';
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

  /** Solo by default — the mode a client that never heard of modes gets. */
  start(sampleRate = MEETING_SAMPLE_RATE, mode: CaptureMode = 'solo', engine?: string): void {
    this.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate,
        encoding: MEETING_AUDIO_ENCODING,
        mode,
        ...(engine !== undefined ? { engine } : {}),
      }),
    );
  }

  /** The room HAS been told — never sent with `start`. */

  /** One 20ms frame of silence — the relay only counts chunks, not samples. */
  speak(chunks: number): void {
    for (let i = 0; i < chunks; i++) this.ws.send(new Uint8Array(640));
  }

  stop(): void {
    this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  /**
   * Wait for a frame of this type, or fail loudly with what did arrive.
   *
   * The default budget is generous for the same measured reason
   * ready-nudge-routes.test.ts gives: this board dispatches parallel
   * worktrees, and under a full agent load a round trip that normally takes
   * 3ms has been seen to take seconds. Polling means a healthy machine pays
   * nothing — the first pass returns. Callers that mean "do not wait" still
   * say so by passing 0.
   */
  async waitFor(type: string, timeoutMs = 15_000): Promise<ServerFrame> {
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
    // `stopped` says the AUDIO SOCKET was told. The doc channel is a second,
    // independent delivery, so a fixed 100ms here was a bet on this machine's
    // SSE latency: a late `meeting.stopped` leaves `kinds` one short and the
    // deep-equal below fails on a diff that never touched the meeting code.
    //
    // Hardening, NOT a reproduced fix. This test was reported alternating
    // between runs on 2026-09-04 and the bet did not turn out to be why: 10
    // runs clean, 10 more under load average 12-19 clean, and 5 with this
    // window cut to zero also clean — the broadcast is already in `events`
    // before `stopped` returns. The reported failure fell inside the machine's
    // ENOBUFS window (see fd-contention.ts), which is what the socket probe
    // there now names. Poll anyway: it costs nothing when the frame has
    // arrived, and it removes the one assertion here that a slower machine
    // could still decide.
    const stoppedByDeadline = Date.now() + 15_000;
    while (!events.some((e) => e.event === 'meeting.stopped') && Date.now() < stoppedByDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // THEN a fixed window, which the second half of this test genuinely needs:
    // it asserts that word-rate frames are ABSENT, and an absence proved by
    // looking too early is not proved at all. A poll cannot stand in for it —
    // there is nothing to poll for.
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
 * Who may open a doc's meeting audio socket.
 *
 * It used to be nobody but the owner: `/audio/` was never on the share
 * allowlist, so every visitor was refused. That was correct while a share
 * admitted a READER — reading a board is not a reason to spend money against
 * a doc filed on it. Bryan's 2026-09-03 call makes a share link full access
 * to the board, and holding a meeting is one of the things a board is for, so
 * the socket is now scoped exactly like the doc's own editing socket: the
 * board this member holds, and no other.
 *
 * What did NOT move is the cost. A recording that happened cannot be taken
 * back, unlike a foreign write on the editing socket, which is reverted
 * server-side — so the boundary below is the assertion that matters.
 */
describe('a member opens the audio socket on their board, and on no other', () => {
  const HUB: ShareTarget = { workspaceId: 'hub-1' };
  const OTHER: ShareTarget = { workspaceId: 'ws-a' };
  const workspaceOf = (d: string): string[] =>
    d === 'standup-notes' ? ['ws-a'] : d.startsWith('hub-1:') ? ['hub-1'] : [];

  it('opens /audio/ for a doc on the shared board, however it is addressed', () => {
    expect(shareScopeAllows('/audio/standup-notes', 'GET', OTHER, workspaceOf)).toBe(true);
    expect(shareScopeAllows('/audio/hub-1%3Aplan.md', 'GET', HUB, workspaceOf)).toBe(true);
  });

  it('refuses /audio/ for a doc on a board this share does not cover', () => {
    // Same two paths, the other target each time — so a `false` here is the
    // board boundary and not a fixture that refuses everything.
    expect(shareScopeAllows('/audio/standup-notes', 'GET', HUB, workspaceOf)).toBe(false);
    expect(shareScopeAllows('/audio/hub-1%3Aplan.md', 'GET', OTHER, workspaceOf)).toBe(false);
    // A doc on no board at all is refused by both.
    for (const target of [HUB, OTHER]) {
      expect(shareScopeAllows('/audio/unfiled-doc', 'GET', target, workspaceOf)).toBe(false);
    }
  });

  it('positive control: the same doc IS reachable over the editing socket', () => {
    expect(shareScopeAllows('/y/standup-notes', 'GET', OTHER, workspaceOf)).toBe(true);
  });
});

describe('meeting audio socket with two voices', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-voices-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine([
        { words: ['can', 'you', 'take', 'it'], settled: 'Can you take it?', speaker: 'A' },
        { words: ['sure'], settled: 'Sure.', speaker: 'B' },
      ]),
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
    const path = join(dataDir, 'pairing.md');
    writeFileSync(path, '# pairing\n');
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'pairing', sourceUrl: path, title: 'pairing' }),
    });
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('labels each turn on the wire, and a name given once lands on the record', async () => {
    const client = await AudioClient.open(wsBase, 'pairing');
    // A conversation — labels are what this mode pays for, and the mock
    // diarizes only when the engine was opened for one.
    client.start(MEETING_SAMPLE_RATE, 'conversation');
    const ready = await client.waitFor('ready');
    // Four chunks reveal turn 0, the fifth settles it; one more reveals turn
    // 1 and a seventh settles it.
    client.speak(7);
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      client.of('transcript').filter((f) => f.final === true).length < 2
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const finals = client.of('transcript').filter((f) => f.final === true);
    expect(finals.map((f) => [f.text, f.speaker])).toEqual([
      ['Can you take it?', 'A'],
      ['Sure.', 'B'],
    ]);
    // Partials carry the label too, so the tag is on screen from the first word.
    expect(client.of('transcript')[0]?.speaker).toBe('A');

    client.ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Jordan' }));
    // A name the contract refuses is an unreadable frame, not a crash.
    client.ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: '' }));
    await client.waitFor('error');
    client.stop();
    await client.waitFor('stopped');

    const list = (await (await fetch(`${base}/api/docs/pairing/meetings`)).json()) as {
      meetings: Array<{ meetingId: string; speakers?: Record<string, string> }>;
    };
    expect(list.meetings.find((m) => m.meetingId === ready.meetingId)?.speakers).toEqual({
      A: 'Jordan',
    });
    const one = (await (
      await fetch(`${base}/api/docs/pairing/meetings/${String(ready.meetingId)}`)
    ).json()) as { transcript: Array<{ text: string; speaker?: string }> };
    expect(one.transcript.map((t) => t.speaker)).toEqual(['A', 'B']);
    client.ws.close();
  });
});

/**
 * The consent step's server half is gone — the `announced` frame, its parse
 * branch, and the field it wrote onto the meeting record. This is the
 * negative control for that removal at the socket, which is the layer a
 * removed button cannot speak for: a client built before 2026-09-01 is still
 * out there and will still send the frame.
 */
describe('the announcement frame no longer reaches the record', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  const createDoc = async (docId: string): Promise<string> => {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes.\n`);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-no-consent-'));
    handle = createServer({ port: 0, dataDir, transcription: createMockTranscriptionEngine() });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers an old client’s `announced` frame as unreadable, and records nothing', async () => {
    const canonical = await createDoc('old-client-announces');
    const client = await AudioClient.open(wsBase, 'old-client-announces');
    client.start(MEETING_SAMPLE_RATE, 'conversation');
    await client.waitFor('ready');
    client.ws.send(JSON.stringify({ type: 'announced', by: 'device' }));
    // Unreadable, not fatal: the meeting carries on, which is the half that
    // matters for a peer running a stale bundle mid-conversation.
    await client.waitFor('error');
    client.stop();
    await client.waitFor('stopped');
    const record = listMeetings(dataDir, canonical)[0];
    expect(record && 'announced' in record).toBe(false);
    // The positive control: the meeting really did run and get written, so
    // the assertion above is a missing field and not a missing record.
    expect(record?.mode).toBe('conversation');
  });
});

describe('meeting engine choice', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  /** Returns the doc's CANONICAL id — the record on disk is named after it. */
  const createDoc = async (docId: string): Promise<string> => {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n`);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-engines-'));
    // Three engines under the CLIENT-nameable names, all mocks: the choice is
    // the thing under test, and nothing here may open a billed session. The
    // order mirrors production's (`orderedEngines`): Soniox is the default.
    handle = createServer({
      port: 0,
      dataDir,
      transcription: [
        { ...createMockTranscriptionEngine(), name: 'soniox' },
        { ...createMockTranscriptionEngine(), name: 'assemblyai' },
        { ...createMockTranscriptionEngine(), name: 'assemblyai-pro' },
      ],
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the engines a start may name, default first', async () => {
    const res = await fetch(`${base}/api/meeting-engines`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      engines: ['soniox', 'assemblyai', 'assemblyai-pro'],
      default: 'soniox',
    });
  });

  it('opens the default for a start naming no engine — the old frame, unchanged', async () => {
    await createDoc('default-engine');
    const client = await AudioClient.open(wsBase, 'default-engine');
    client.start();
    const ready = await client.waitFor('ready');
    expect(ready.engine).toBe('soniox');
    client.stop();
    await client.waitFor('stopped');
    client.ws.close();
  });

  it('opens the engine a start names, and stamps the record with it', async () => {
    // Names a NON-default engine, or this would pass on a server that
    // ignored the field and always opened its first.
    const canonical = await createDoc('chosen-engine');
    const client = await AudioClient.open(wsBase, 'chosen-engine');
    client.start(MEETING_SAMPLE_RATE, 'solo', 'assemblyai');
    const ready = await client.waitFor('ready');
    expect(ready.engine).toBe('assemblyai');
    client.stop();
    await client.waitFor('stopped');
    expect(listMeetings(dataDir, canonical)[0]?.engine).toBe('assemblyai');
    client.ws.close();
  });

  it('opens the pro variant when the start names it — three choices, all wired', async () => {
    const canonical = await createDoc('pro-engine');
    const client = await AudioClient.open(wsBase, 'pro-engine');
    client.start(MEETING_SAMPLE_RATE, 'solo', 'assemblyai-pro');
    const ready = await client.waitFor('ready');
    expect(ready.engine).toBe('assemblyai-pro');
    client.stop();
    await client.waitFor('stopped');
    expect(listMeetings(dataDir, canonical)[0]?.engine).toBe('assemblyai-pro');
    client.ws.close();
  });
});

describe('meeting engine choice on a server without that engine', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-one-engine-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: { ...createMockTranscriptionEngine(), name: 'assemblyai' },
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists only what it holds, so a chooser can hide the rest', async () => {
    expect(await (await fetch(`${base}/api/meeting-engines`)).json()).toEqual({
      engines: ['assemblyai'],
      default: 'assemblyai',
    });
  });

  it('refuses a start naming the missing engine rather than substituting', async () => {
    // A person who picked an engine must not be silently billed on another.
    const path = join(dataDir, 'wants-soniox.md');
    writeFileSync(path, '# wants-soniox\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'wants-soniox', sourceUrl: path, title: 'wants-soniox' }),
    });
    const client = await AudioClient.open(wsBase, 'wants-soniox');
    client.start(MEETING_SAMPLE_RATE, 'solo', 'soniox');
    const frame = await client.waitFor('unavailable');
    expect(frame.reason).toBe('not_configured');
    expect(String(frame.message)).toContain('soniox');
    expect(client.of('ready')).toHaveLength(0);
    // The refusal marks nothing as recording: the default engine still works
    // on this same socket afterwards.
    client.start();
    const ready = await client.waitFor('ready');
    expect(ready.engine).toBe('assemblyai');
    client.stop();
    await client.waitFor('stopped');
    client.ws.close();
  });
});
