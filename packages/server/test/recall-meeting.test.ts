/**
 * The bot meeting end to end, with a fake vendor: an invite, frames arriving
 * on the socket the vendor "dialled", the words landing in the durable
 * transcript under the PLATFORM'S OWN NAMES, and a status webhook ending it.
 *
 * NOTHING HERE REACHES THE NETWORK OR AN LLM. The vendor client is a fake and
 * the notes composer is a stub — the same two seams the microphone path
 * keeps, for the same reason: creating a real bot bills two vendors.
 *
 * Every participant name is invented. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotesComposeInput, NotesComposer, TickScheduler } from '../src/meeting-notes.ts';
import { MeetingStore, readTranscript } from '../src/meetings.ts';
import { BOT_ENGINE_NAME, RecallMeetingRelay } from '../src/recall-meeting.ts';
import type { CreateBotArgs, RecallBot, RecallClient, RecallConfig } from '../src/recall.ts';

const ZOOM_URL = 'https://example.zoom.us/j/1234567890';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const TOKEN = '0123456789abcdef0123456789abcdef';

class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const all = [...this.fns.values()];
    this.fns.clear();
    for (const fn of all) fn();
  }
}

/** A vendor that records what it was asked to do and never leaves the process. */
class FakeRecall implements RecallClient {
  readonly created: CreateBotArgs[] = [];
  readonly left: string[] = [];
  readonly permissionAsked: string[] = [];
  permissionAnswer = true;
  createFails: string | null = null;
  /** Held open to keep a create in flight, so a second invite can race it. */
  gate: Promise<void> | null = null;
  constructor(readonly config: RecallConfig) {}
  createBot(args: CreateBotArgs): Promise<RecallBot> {
    if (this.createFails) return Promise.reject(new Error(this.createFails));
    this.created.push(args);
    const id = `bot_${this.created.length}`;
    return this.gate ? this.gate.then(() => ({ id })) : Promise.resolve({ id });
  }
  getBot(botId: string): Promise<RecallBot> {
    return Promise.resolve({ id: botId });
  }
  leaveCall(botId: string): Promise<void> {
    this.left.push(botId);
    return Promise.resolve();
  }
  requestRecordingPermission(botId: string): Promise<boolean> {
    this.permissionAsked.push(botId);
    return Promise.resolve(this.permissionAnswer);
  }
}

const config = (over: Partial<RecallConfig> = {}): RecallConfig => ({
  region: 'us-east-1',
  publicWsBase: 'wss://example.test',
  retentionHours: 24,
  separateStreams: true,
  botName: 'Meeting Assistant',
  ...over,
});

function transcriptFrame(args: {
  final: boolean;
  id: number;
  name: string | null;
  text: string;
}): string {
  return JSON.stringify({
    event: args.final ? 'transcript.data' : 'transcript.partial_data',
    data: {
      data: {
        words: args.text.split(' ').map((text) => ({ text, start_timestamp: { relative: 0 } })),
        language_code: 'en',
        participant: { id: args.id, name: args.name, is_host: false, platform: 'zoom' },
      },
      bot: { id: 'bot_1', metadata: {} },
      recording: { id: 'rec_1', metadata: {} },
    },
  });
}

describe('the bot meeting', () => {
  let dataDir: string;
  let store: MeetingStore;
  let events: Array<{ docId: string; payload: Record<string, unknown> }>;
  let notesSeen: NotesComposeInput[];
  let schedule: ManualScheduler;

  const composer: NotesComposer = {
    name: 'stub',
    compose(input) {
      notesSeen.push(input);
      return Promise.resolve('- a note');
    },
  };

  function relayWith(client: RecallClient | null, withNotes = true): RecallMeetingRelay {
    return new RecallMeetingRelay({
      store,
      notes: withNotes ? { composer, quietMs: 1000, schedule, onNotes: () => {} } : null,
      client,
      broadcast: (docId, payload) => events.push({ docId, payload }),
      mintToken: () => TOKEN,
    });
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-recall-'));
    store = new MeetingStore(dataDir);
    events = [];
    notesSeen = [];
    schedule = new ManualScheduler();
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('refuses to invite when there is no key', async () => {
    const relay = relayWith(null);
    expect(relay.configured()).toBe(false);
    const result = await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('refuses to invite when Recall has nowhere to dial back', async () => {
    // The one piece of configuration that cannot be inferred: this server
    // binds to localhost and the vendor calls in from the public internet.
    const relay = relayWith(new FakeRecall(config({ publicWsBase: null })));
    expect(relay.configured()).toBe(false);
    const result = await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    expect(result).toMatchObject({ ok: false, reason: 'not_configured' });
  });

  it('refuses a URL that is not a meeting we support', async () => {
    const relay = relayWith(new FakeRecall(config()));
    for (const url of [
      'https://example.com/standup',
      'not a url',
      'https://zoom.us.evil.test/j/1',
    ]) {
      expect(await relay.invite({ docId: 'doc-1', meetingUrl: url })).toMatchObject({
        ok: false,
        reason: 'unsupported_url',
      });
    }
  });

  it('hands the vendor a realtime URL carrying the per-bot token', async () => {
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    const result = await relay.invite({ docId: 'doc-1', meetingUrl: MEET_URL });
    expect(result.ok).toBe(true);
    expect(vendor.created[0]?.realtimeUrl).toBe(`wss://example.test/recall/${TOKEN}`);
    expect(relay.acceptsToken(TOKEN)).toBe(true);
    expect(relay.acceptsToken('f'.repeat(32))).toBe(false);
    expect(relay.status('doc-1')).toMatchObject({ state: 'requested', platform: 'google_meet' });
  });

  it('refuses a second bot while the first is still in a call', async () => {
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    expect(await relay.invite({ docId: 'doc-1', meetingUrl: MEET_URL })).toMatchObject({
      ok: false,
      reason: 'already_recording',
    });
  });

  it('refuses a bot on a doc a microphone meeting already holds', async () => {
    // One meeting per doc is the STORE's rule, not a second rule invented
    // here — and it is checked before the vendor call, so a refused meeting
    // can never leave a paid bot sitting in a call nothing is listening to.
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    store.start({ docId: 'doc-1', engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    expect(await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL })).toMatchObject({
      ok: false,
      reason: 'already_recording',
    });
    expect(vendor.created).toHaveLength(0);
  });

  it('reports a vendor refusal without inventing a bot', async () => {
    const vendor = new FakeRecall(config());
    vendor.createFails = 'recall: POST /v1/bot/ failed (402)';
    const relay = relayWith(vendor);
    expect(await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL })).toMatchObject({
      ok: false,
      reason: 'vendor_error',
    });
    expect(relay.status('doc-1')).toBeNull();
  });

  it('asks Zoom for native recording permission once, and only on Zoom', async () => {
    // This is what makes Zoom's OWN consent banner fire, which is the point:
    // the room is told it is being recorded by Zoom, not by us.
    const zoomVendor = new FakeRecall(config());
    const zoom = relayWith(zoomVendor);
    await zoom.invite({ docId: 'doc-z', meetingUrl: ZOOM_URL });
    zoom.onStatus({ botId: 'bot_1', state: 'in_call' });
    zoom.onStatus({ botId: 'bot_1', state: 'in_call' });
    await Promise.resolve();
    await Promise.resolve();
    expect(zoomVendor.permissionAsked).toEqual(['bot_1']);
    expect(zoom.status('doc-z')?.state).toBe('awaiting_permission');

    const meetVendor = new FakeRecall(config());
    const meet = relayWith(meetVendor);
    await meet.invite({ docId: 'doc-m', meetingUrl: MEET_URL });
    meet.onStatus({ botId: 'bot_1', state: 'in_call' });
    await Promise.resolve();
    expect(meetVendor.permissionAsked).toEqual([]);
  });

  it('writes the platform names into the durable transcript', async () => {
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: false, id: 7, name: 'Rowan Pike', text: 'so the' }),
    );
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'So the sync.' }),
    );
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 8, name: 'Devi Raman', text: "Let's measure it." }),
    );
    relay.onStatus({ botId: 'bot_1', state: 'left' });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    const meetings = store.list('doc-1');
    expect(meetings).toHaveLength(1);
    const record = meetings[0];
    expect(record?.engine).toBe(BOT_ENGINE_NAME);
    // The label is synthetic and per participant; the NAME map is what
    // carries the platform's own words for who that is.
    expect(record?.speakers).toEqual({ p7: 'Rowan Pike', p8: 'Devi Raman' });
    const turns = readTranscript(dataDir, 'doc-1', record?.meetingId ?? '');
    expect(turns.map((t) => [t.speaker, t.text])).toEqual([
      ['p7', 'So the sync.'],
      ['p8', "Let's measure it."],
    ]);
  });

  it('gives the notes composer the names, never the labels', async () => {
    // A note that said "Speaker p7 raised the sync cost" is the bug this
    // whole label-then-immediately-name design exists to avoid.
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'So the sync.' }),
    );
    schedule.fire();
    await new Promise((r) => setTimeout(r, 10));
    expect(notesSeen).not.toHaveLength(0);
    const speakers = notesSeen.flatMap((i) => i.tick.turns.map((t) => t.speaker));
    expect(speakers).toContain('Rowan Pike');
    expect(speakers.some((s) => s?.includes('p7'))).toBe(false);
  });

  it('starts the meeting on the first WORD, not on the status report', async () => {
    // The two channels are independent and the webhook can be late. Waiting
    // for it would drop the opening sentences on the floor with no meeting to
    // record them into — "the bot joined and the notes never came".
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    expect(store.active('doc-1')).toBeUndefined();
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'Already talking.' }),
    );
    expect(store.active('doc-1')).toBeDefined();
    expect(events.some((e) => e.payload.event === 'meeting.started')).toBe(true);
  });

  it('does not end the meeting when the vendor socket drops', async () => {
    // Recall reconnects a dropped realtime endpoint and the call is still
    // going. This is the opposite of the microphone path's rule, where the
    // socket IS the meeting.
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'Still here.' }),
    );
    relay.onSocketClose(TOKEN);
    expect(store.active('doc-1')).toBeDefined();
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'Reconnected.' }),
    );
    const record = store.list('doc-1')[0];
    expect(readTranscript(dataDir, 'doc-1', record?.meetingId ?? '')).toHaveLength(2);
  });

  it('ends the meeting on a terminal state and stays ended', async () => {
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'Done here.' }),
    );
    relay.onStatus({ botId: 'bot_1', state: 'left' });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.active('doc-1')).toBeUndefined();
    expect(events.filter((e) => e.payload.event === 'meeting.stopped')).toHaveLength(1);

    // A late `in_call` — the two channels are independent and the vendor
    // decides the order — must not resurrect a meeting that has flushed.
    relay.onStatus({ botId: 'bot_1', state: 'in_call' });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.active('doc-1')).toBeUndefined();
    expect(relay.status('doc-1')?.state).toBe('left');
    // And the token is forgotten, so a leaked URL is useless after the call.
    expect(relay.acceptsToken(TOKEN)).toBe(false);
  });

  it('broadcasts the bot state on the doc channel', async () => {
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onStatus({ botId: 'bot_1', state: 'waiting_room' });
    await Promise.resolve();
    const botEvents = events.filter((e) => e.payload.event === 'meeting.bot');
    expect(botEvents.map((e) => e.payload.state)).toContain('waiting_room');
    expect(botEvents.every((e) => e.docId === 'doc-1')).toBe(true);
  });

  it('takes every bot out of its call on shutdown', async () => {
    // A bot that survives this process bills two vendors and delivers
    // nothing: the in-memory token map is gone, so its words have nowhere to
    // arrive. Kicking it out is visible; leaving it running is silent.
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'Mid sentence.' }),
    );
    await relay.dispose();
    expect(vendor.left).toEqual(['bot_1']);
    expect(store.active('doc-1')).toBeUndefined();
    const record = store.list('doc-1')[0];
    expect(readTranscript(dataDir, 'doc-1', record?.meetingId ?? '')).toHaveLength(1);
  });

  it('sends a bot home on request', async () => {
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    expect(await relay.leave('doc-1')).toBe(true);
    expect(vendor.left).toEqual(['bot_1']);
    expect(relay.status('doc-1')?.state).toBe('left');
    expect(await relay.leave('doc-2')).toBe(false);
  });

  it('records a meeting with no notes pipeline at all', async () => {
    // The same no-default seam the microphone path keeps: no composer means
    // transcripts still land, the notes section simply never appears.
    const relay = relayWith(new FakeRecall(config()), false);
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onSocketText(
      TOKEN,
      transcriptFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'No notes here.' }),
    );
    relay.onStatus({ botId: 'bot_1', state: 'left' });
    await new Promise((r) => setTimeout(r, 10));
    const record = store.list('doc-1')[0];
    expect(readTranscript(dataDir, 'doc-1', record?.meetingId ?? '')).toHaveLength(1);
    expect(notesSeen).toHaveLength(0);
  });
  it('keeps the PUNCTUATED text when the provider settles a turn twice', async () => {
    // format_turns ends a turn twice, rough then punctuated, and Recall
    // normalises away the flag that told the two apart. Folding them onto
    // one turn is right — but the durable record used to ignore the second
    // write and keep the rough words forever, while the notes composer
    // worked from the good ones. Raised by review.
    const relay = relayWith(new FakeRecall(config()));
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    const say = (text: string): void => {
      relay.onSocketText(TOKEN, transcriptFrame({ final: true, id: 7, name: 'Devi Raman', text }));
    };
    say('so the sync is the bottleneck');
    say('So the sync is the bottleneck.');
    relay.onStatus({ botId: 'bot_1', state: 'left' });
    await new Promise((r) => setTimeout(r, 10));
    const record = store.list('doc-1')[0];
    const turns = readTranscript(dataDir, 'doc-1', record?.meetingId ?? '');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('So the sync is the bottleneck.');
  });

  it('creates ONE bot when two invites for a doc overlap', async () => {
    // Every guard in `invite` is synchronous, so before the doc was claimed
    // up front both of these passed while the first was still waiting on the
    // vendor — and both got a real bot. The loser overwrote the record and
    // the winner stayed in the call, billing, with nothing able to name it
    // or make it leave.
    const vendor = new FakeRecall(config());
    let release = (): void => {};
    vendor.gate = new Promise<void>((r) => {
      release = r;
    });
    const relay = relayWith(vendor);
    const first = relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    const second = await relay.invite({ docId: 'doc-1', meetingUrl: MEET_URL });
    expect(second).toMatchObject({ ok: false, reason: 'already_recording' });
    expect(vendor.created).toHaveLength(1);
    release();
    expect((await first).ok).toBe(true);
    expect(relay.status('doc-1')?.meetingUrl).toBe(ZOOM_URL);
  });

  it('releases the doc when the vendor refuses the bot', async () => {
    // The reservation is not a lock a failed invite gets to keep.
    const vendor = new FakeRecall(config());
    vendor.createFails = 'no capacity in this region';
    const relay = relayWith(vendor);
    expect(await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL })).toMatchObject({
      ok: false,
      reason: 'vendor_error',
    });
    expect(relay.status('doc-1')).toBeNull();
    expect(relay.acceptsToken(TOKEN)).toBe(false);
    vendor.createFails = null;
    expect((await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL })).ok).toBe(true);
  });

  it('ignores a status change older than the one already applied', async () => {
    // Webhooks are retried and unordered. A re-delivered `joining_call` after
    // `in_call_recording` would walk the strip backwards and, on Zoom, put
    // the consent banner in front of a room already being recorded.
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onStatus({ botId: 'bot_1', state: 'recording', at: 2000 });
    await new Promise((r) => setTimeout(r, 5));
    relay.onStatus({ botId: 'bot_1', state: 'joining', at: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(relay.status('doc-1')?.state).toBe('recording');
    // The positive control: a NEWER event still lands.
    relay.onStatus({ botId: 'bot_1', state: 'left', at: 3000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(relay.status('doc-1')?.state).toBe('left');
  });

  it('asks Zoom for recording permission exactly once', async () => {
    const vendor = new FakeRecall(config());
    const relay = relayWith(vendor);
    await relay.invite({ docId: 'doc-1', meetingUrl: ZOOM_URL });
    relay.onStatus({ botId: 'bot_1', state: 'in_call', at: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(vendor.permissionAsked).toEqual(['bot_1']);
    relay.onStatus({ botId: 'bot_1', state: 'in_call', at: 2000 });
    await new Promise((r) => setTimeout(r, 5));
    expect(vendor.permissionAsked).toEqual(['bot_1']);
  });
});
