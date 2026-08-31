/**
 * Last-Event-ID replay: a reconnect is not allowed to be a silent gap.
 *
 * Before this branch the server's own keepalive comment admitted the failure
 * ("with no `Last-Event-ID` replay on this server, everything broadcast
 * inside those gaps was lost permanently"). The MCP child reconnects within
 * 1.5s and every browser EventSource reconnects on its own — so the fleet
 * looked healthy while every wifi switch, tunnel blip, and deploy dropped
 * whatever was broadcast inside the window.
 *
 * The two headline properties, from the ticket:
 *  1. events broadcast during a disconnect are delivered on reconnect, in
 *     order, then the live feed resumes;
 *  2. an id older than the replay buffer cannot silently pretend
 *     completeness — the client gets an explicit `replay.gap` event telling
 *     it to do a full refetch, and NO partial replay.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { claimReplayMarks, saveReplayMarks } from '../src/sse-marks.ts';
import { REPLAY_MAX_AGE_MS, REPLAY_MAX_EVENTS, SseHub, openSseStream } from '../src/sse.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

type Frame = { event: string; id?: string; data?: Record<string, unknown> };

/** Read an SSE stream, collecting full frames (event name, id line, parsed
 *  data). Unlike the listener in event-id.test.ts this keeps the `id:` line,
 *  because the id ON THE WIRE is the thing under test here. */
function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.data || frame.id || frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const commentText = (f: Frame): string =>
  ((f.data?.thread as { comments?: Array<{ text?: string }> } | undefined)?.comments?.[0]?.text ??
    '') as string;

describe('SSE Last-Event-ID replay', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}`, ...headers } });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sse-replay-'));
    srcDir = mkdtempSync(join(tmpdir(), 'sse-replay-src-'));
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const path = join(srcDir, 'doc-replay.md');
    writeFileSync(path, '# doc-replay\n\nBody.\n');
    await post('/api/docs', { docId: 'doc-replay', sourceUrl: path, title: 'doc-replay' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const comment = (text: string) =>
    post('/api/docs/doc-replay/threads', { author: PERSON, text, anchor: { kind: 'subject' } });

  it('replays events broadcast during a disconnect, in order, then resumes live', async () => {
    // Connected: see one event and remember its wire id.
    const first = listenFrames(await get('/events/doc-replay'));
    await settle(150);
    await comment('Seen live.');
    await settle();
    const seen = first.frames.filter((f) => f.event === 'thread.created');
    expect(seen.length).toBe(1);
    const lastId = seen[0]?.id;
    // Every broadcast frame carries an id on the wire — this is what makes a
    // native EventSource send Last-Event-ID back by itself.
    expect(typeof lastId).toBe('string');
    expect((lastId ?? '').length).toBeGreaterThan(0);
    await first.stop(); // the wifi switch

    // Broadcast into the gap — nobody is listening.
    await comment('Missed one.');
    await comment('Missed two.');
    await settle();

    // Reconnect presenting Last-Event-ID (the header, because that is what a
    // native EventSource sends automatically).
    const second = listenFrames(
      await get('/events/doc-replay', { 'Last-Event-ID': lastId as string }),
    );
    await settle();
    const replayed = second.frames.filter((f) => f.event === 'thread.created');
    expect(replayed.map(commentText)).toEqual(['Missed one.', 'Missed two.']);
    // Replayed frames carry their ids too, so a second drop resumes from the
    // replayed position rather than from before the gap.
    expect(replayed.every((f) => typeof f.id === 'string' && f.id.length > 0)).toBe(true);
    // No gap signal — the buffer covered the disconnect completely.
    expect(second.frames.some((f) => f.event === 'replay.gap')).toBe(false);

    // …then the live feed, on the same connection.
    await comment('Live again.');
    await settle();
    const after = second.frames.filter((f) => f.event === 'thread.created');
    expect(after.map(commentText)).toEqual(['Missed one.', 'Missed two.', 'Live again.']);
    await second.stop();
  });

  it('signals replay.gap for an unknown (pre-restart) id instead of pretending completeness', async () => {
    await comment('Missed while away.');
    await settle();
    // An id minted by a previous server epoch: same shape, never issued by
    // this process. The server cannot know what it missed, so it must say so.
    const s = listenFrames(await get('/events/doc-replay', { 'Last-Event-ID': 'deadbeef:42' }));
    await settle();
    expect(s.frames.some((f) => f.event === 'replay.gap')).toBe(true);
    // And NO partial replay — a half-answer would read as a whole one.
    expect(s.frames.filter((f) => f.event === 'thread.created').length).toBe(0);

    // The gap signal must not end the stream: live events still arrive.
    await comment('Live after gap.');
    await settle();
    const live = s.frames.filter((f) => f.event === 'thread.created');
    expect(live.map(commentText)).toEqual(['Live after gap.']);
    await s.stop();
  });

  it('accepts the id as a query param too (for hand-rolled consumers)', async () => {
    const first = listenFrames(await get('/events/doc-replay'));
    await settle(150);
    await comment('Anchor.');
    await settle();
    const lastId = first.frames.find((f) => f.event === 'thread.created')?.id as string;
    await first.stop();
    await comment('Missed via query.');
    await settle();
    const second = listenFrames(
      await get(`/events/doc-replay?lastEventId=${encodeURIComponent(lastId)}`),
    );
    await settle();
    expect(second.frames.filter((f) => f.event === 'thread.created').map(commentText)).toEqual([
      'Missed via query.',
    ]);
    await second.stop();
  });

  // NEGATIVE CONTROL, and the steady-state case: a keepalive-driven reopen
  // where NOTHING was missed. The current id must answer with an empty, ok
  // replay — no duplicate of the last-seen event, no replay.gap — because a
  // spurious gap here would turn every ordinary reconnect into a full
  // refetch, and a duplicate would re-announce the same comment on every
  // wifi blink. A mutation test showed the other five tests all stay green
  // if `replayAfter` misclassifies the newest id as evicted; this one is
  // what goes red.
  it('reconnecting with the current id is a clean no-op: no replay, no gap, live continues', async () => {
    const first = listenFrames(await get('/events/doc-replay'));
    await settle(150);
    await comment('Nothing after this.');
    await settle();
    const lastId = first.frames.find((f) => f.event === 'thread.created')?.id as string;
    expect(typeof lastId).toBe('string');
    await first.stop();

    // No broadcasts in the gap — the reconnect has nothing to catch up on.
    const second = listenFrames(await get('/events/doc-replay', { 'Last-Event-ID': lastId }));
    await settle();
    expect(second.frames.filter((f) => f.event === 'thread.created').length).toBe(0);
    expect(second.frames.some((f) => f.event === 'replay.gap')).toBe(false);

    // …and the stream is genuinely live, not quietly dead.
    await comment('First new thing.');
    await settle();
    expect(second.frames.filter((f) => f.event === 'thread.created').map(commentText)).toEqual([
      'First new thing.',
    ]);
    await second.stop();
  });
});

describe('SseHub replay buffer bounds', () => {
  it('evicts by count, and an evicted id yields a gap — never a partial replay', () => {
    const hub = new SseHub();
    hub.broadcast('doc-x', { event: 'thread.created', n: 0 } as never);
    const oldest = hub.replayAfter('doc-x', '__none__');
    // Sanity on the probe itself: an id the buffer holds replays cleanly.
    expect(oldest.ok).toBe(false); // unknown id → gap, even on a fresh buffer
    const firstId = hub.lastIdOn('doc-x') as string;
    expect(typeof firstId).toBe('string');
    // Push the first event out of the bounded buffer.
    for (let i = 1; i <= REPLAY_MAX_EVENTS + 5; i++) {
      hub.broadcast('doc-x', { event: 'thread.created', n: i } as never);
    }
    const res = hub.replayAfter('doc-x', firstId);
    expect(res.ok).toBe(false); // evicted → explicit gap
    // POSITIVE CONTROL: an id still inside the buffer replays the exact tail.
    const events = hub.eventsOn('doc-x');
    const anchor = events[events.length - 3];
    const tail = hub.replayAfter('doc-x', (anchor as { id: string }).id);
    expect(tail.ok).toBe(true);
    if (tail.ok) {
      expect(tail.events.length).toBe(2);
      expect(tail.events.map((e) => (e.payload as { n?: number }).n)).toEqual([
        REPLAY_MAX_EVENTS + 4,
        REPLAY_MAX_EVENTS + 5,
      ]);
    }
  });

  it('buffers even when nobody is subscribed — the gap IS the no-subscriber case', () => {
    const hub = new SseHub();
    hub.broadcast('doc-y', { event: 'thread.created', n: 1 } as never);
    hub.broadcast('doc-y', { event: 'thread.created', n: 2 } as never);
    const events = hub.eventsOn('doc-y');
    expect(events.length).toBe(2);
    const res = hub.replayAfter('doc-y', (events[0] as { id: string }).id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events.length).toBe(1);
  });
});

describe('SseHub replay negative control', () => {
  it('the newest id yields an empty ok replay — never a gap, never a duplicate', () => {
    const hub = new SseHub();
    hub.broadcast('doc-nc', { event: 'thread.created', n: 1 } as never);
    hub.broadcast('doc-nc', { event: 'thread.created', n: 2 } as never);
    const current = hub.lastIdOn('doc-nc') as string;
    const res = hub.replayAfter('doc-nc', current);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events).toEqual([]);
  });
});

/**
 * Addressed frames (`sendToAgent`) in the replay buffer. Before this, only
 * `broadcast` buffered — so the one frame with a single accountable
 * recipient (a lead-addressed triage request) was the one frame a reconnect
 * could silently lose: a dead-but-unnoticed socket doesn't throw on enqueue,
 * `sent > 0` read as delivered, and the lead's reconnect came back clean
 * with neither the frame nor a gap.
 */
describe('SseHub addressed-frame replay', () => {
  const CH = 'ws~replay-agent';

  it('replays an addressed frame to its recipient only — anonymous and other-agent streams never see it', () => {
    const hub = new SseHub();
    hub.broadcast(CH, { event: 'task.created', n: 1 } as never);
    const anchor = hub.lastIdOn(CH) as string;
    hub.sendToAgent(CH, 'lead-1', { event: 'triage.requested', kind: 'bucket-review' } as never);
    hub.broadcast(CH, { event: 'task.updated', n: 2 } as never);

    // The addressee catches up on both.
    const lead = hub.replayAfter(CH, anchor, 'lead-1');
    expect(lead.ok).toBe(true);
    if (lead.ok) {
      expect(lead.events.map((e) => e.payload.event)).toEqual(['triage.requested', 'task.updated']);
      // Buffered addressed frames carry ids like any other — a recipient's
      // cursor legitimately advances on them.
      expect(lead.events.every((e) => e.id.length > 0)).toBe(true);
    }
    // A browser tab (no agentId) replays exactly what its live feed carried.
    const anon = hub.replayAfter(CH, anchor);
    expect(anon.ok).toBe(true);
    if (anon.ok) expect(anon.events.map((e) => e.payload.event)).toEqual(['task.updated']);
    // …and so does a different agent.
    const other = hub.replayAfter(CH, anchor, 'lead-2');
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.events.map((e) => e.payload.event)).toEqual(['task.updated']);
  });

  it('an addressed frame id is a valid cursor for its recipient', () => {
    const hub = new SseHub();
    hub.sendToAgent(CH, 'lead-1', { event: 'triage.requested', kind: 'task-review' } as never);
    const cursor = hub.lastIdOn(CH) as string;
    hub.broadcast(CH, { event: 'task.updated', n: 3 } as never);
    const res = hub.replayAfter(CH, cursor, 'lead-1');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events.map((e) => e.payload.event)).toEqual(['task.updated']);
  });

  it('buffers even when the agent holds no stream — sent=0 parks the frame for the reconnect, not the void', () => {
    const hub = new SseHub();
    const sent = hub.sendToAgent(CH, 'lead-1', { event: 'triage.requested' } as never);
    expect(sent).toBe(0); // still the honest answer the caller queues on
    expect(hub.eventsOn(CH).length).toBe(1);
  });

  it('an agent stream reconnecting replays the addressed frame it missed, with its id on the wire', async () => {
    const hub = new SseHub();
    hub.broadcast(CH, { event: 'task.created', n: 1 } as never);
    const anchor = hub.lastIdOn(CH) as string;
    // The disconnect window: the lead holds no stream (or a dead one) while
    // the addressed request goes out.
    hub.sendToAgent(CH, 'lead-1', { event: 'triage.requested', kind: 'bucket-review' } as never);

    const l = listenFrames(openSseStream(hub, CH, undefined, undefined, 'lead-1', anchor));
    await settle(150);
    const replayed = l.frames.filter((f) => f.event === 'triage.requested');
    expect(replayed.length).toBe(1);
    expect(typeof replayed[0]?.id).toBe('string');
    expect((replayed[0]?.id ?? '').length).toBeGreaterThan(0);
    expect(l.frames.some((f) => f.event === 'replay.gap')).toBe(false);
    await l.stop();

    // Control: an anonymous stream presenting the same anchor replays nothing
    // — the addressed frame is not leaked to a browser tab's catch-up.
    const tab = listenFrames(openSseStream(hub, CH, undefined, undefined, undefined, anchor));
    await settle(150);
    expect(tab.frames.filter((f) => f.event === 'triage.requested').length).toBe(0);
    expect(tab.frames.some((f) => f.event === 'replay.gap')).toBe(false);
    await tab.stop();
  });

  it('a live addressed write carries its id, so the recipient cursor advances past it', async () => {
    const hub = new SseHub();
    const l = listenFrames(openSseStream(hub, CH, undefined, undefined, 'lead-1'));
    await settle(150);
    hub.sendToAgent(CH, 'lead-1', { event: 'triage.requested', kind: 'bucket-review' } as never);
    await settle(150);
    const got = l.frames.filter((f) => f.event === 'triage.requested');
    expect(got.length).toBe(1);
    expect(typeof got[0]?.id).toBe('string');
    expect((got[0]?.id ?? '').length).toBeGreaterThan(0);
    await l.stop();
  });
});

/**
 * VACUOUS GAPS — a `replay.gap` for a reconnect that missed nothing.
 *
 * Measured in the field 2026-08-21 by two independent sessions: after every
 * server restart, subscriber sessions received waves of `replay.gap` for their
 * whole watch set — 8+ over 40 minutes for the same doc ids — and every
 * refetch that followed found zero missed events, while real events delivered
 * fine in the same window.
 *
 * The cause is that `replayAfter` had exactly one way to say no. It answered
 * `ok: false` — "I cannot prove completeness" — for the case where it CAN
 * prove it: a cursor naming the newest event a channel has ever carried.
 * Nothing came after that id, so nothing was missed; the buffer holding it had
 * merely aged out under a quiet channel (`REPLAY_MAX_AGE_MS`, then deleted
 * outright once empty), or the process had restarted without that channel
 * being touched.
 *
 * A gap notice is expensive on purpose — it tells an agent to drop its stream
 * and refetch. Firing one where nothing was missed teaches sessions to ignore
 * the signal, which is how a REAL gap gets ignored too. So the fix is a
 * narrowing, and every test below is paired with a positive control: the
 * genuinely-missed event still produces exactly its notice.
 */
describe('vacuous replay gaps — a quiet channel is not a gap', () => {
  it('a cursor at the newest event survives the buffer ageing out: empty ok replay, no gap', () => {
    let now = 1_000_000;
    const hub = new SseHub(() => now);
    hub.broadcast('doc-quiet', { event: 'thread.created', n: 1 } as never);
    const cursor = hub.lastIdOn('doc-quiet') as string;
    expect(typeof cursor).toBe('string');

    // The channel goes quiet for longer than the buffer's age bound. Nothing
    // is broadcast — this is a doc nobody touched, which is most of a watch
    // set most of the time.
    now += REPLAY_MAX_AGE_MS + 60_000;

    const res = hub.replayAfter('doc-quiet', cursor);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events).toEqual([]);
    // The buffer really is gone — this is the state the old code called a gap.
    expect(hub.eventsOn('doc-quiet').length).toBe(0);
  });

  it('POSITIVE CONTROL: an event the cursor never saw still yields a gap after the same ageing', () => {
    let now = 2_000_000;
    const hub = new SseHub(() => now);
    hub.broadcast('doc-real', { event: 'thread.created', n: 1 } as never);
    const cursor = hub.lastIdOn('doc-real') as string;

    // A second event lands — the one this subscriber is about to miss — and
    // THEN everything ages out.
    hub.broadcast('doc-real', { event: 'thread.created', n: 2 } as never);
    now += REPLAY_MAX_AGE_MS + 60_000;

    // Same pruned-to-nothing buffer as the test above (the read below prunes
    // it, as any reconnect would), opposite answer: the cursor is no longer
    // the newest thing this channel carried.
    expect(hub.replayAfter('doc-real', cursor).ok).toBe(false);
    expect(hub.eventsOn('doc-real').length).toBe(0);
  });

  it('a cursor at the newest event is clean even for a channel whose buffer never existed here', () => {
    const hub = new SseHub();
    // What a restart looks like from inside the hub: marks recovered from the
    // previous process, no buffer for the channel because nothing has been
    // broadcast on it since boot.
    hub.restoreMarks({ 'doc-restored': 'oldboot:7' });
    const res = hub.replayAfter('doc-restored', 'oldboot:7');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.events).toEqual([]);
    // POSITIVE CONTROL: any other id on that channel is still a gap.
    expect(hub.replayAfter('doc-restored', 'oldboot:6').ok).toBe(false);
    // …and a channel the marks say nothing about is a gap, not a shrug.
    expect(hub.replayAfter('doc-unknown', 'oldboot:7').ok).toBe(false);
  });

  it('a mark is superseded the moment this process broadcasts on the channel', () => {
    const hub = new SseHub();
    hub.restoreMarks({ 'doc-moved': 'oldboot:7' });
    hub.broadcast('doc-moved', { event: 'task.updated', n: 1 } as never);
    // The recovered cursor is now genuinely behind — the new event is exactly
    // what a reconnect at that id missed.
    expect(hub.replayAfter('doc-moved', 'oldboot:7').ok).toBe(false);
    expect(hub.marks()['doc-moved']).toBe(hub.lastIdOn('doc-moved') as string);
  });

  it('restoreMarks never overwrites what this process already knows', () => {
    const hub = new SseHub();
    hub.broadcast('doc-live', { event: 'task.updated', n: 1 } as never);
    const live = hub.lastIdOn('doc-live') as string;
    hub.restoreMarks({ 'doc-live': 'oldboot:7' });
    expect(hub.marks()['doc-live']).toBe(live);
    expect(hub.replayAfter('doc-live', 'oldboot:7').ok).toBe(false);
  });
});

/**
 * The marks file — the cursor's half of a restart.
 *
 * Trusted ONLY across a clean shutdown, and the flag that says so is written
 * at two moments: `claimReplayMarks` re-stamps the file open as it reads,
 * `saveReplayMarks` closes it on the way out. A process that dies without
 * reaching its shutdown path therefore leaves the file open, and the next boot
 * discards its marks rather than believing a record that stops mid-history.
 * That direction is the whole safety argument: a stale mark that reads as
 * current is a subscriber told "nothing was missed" about events that were.
 */
describe('replay marks across a restart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sse-marks-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a clean shutdown hands its marks to the next boot', () => {
    expect(claimReplayMarks(dir)).toEqual({});
    saveReplayMarks(dir, { 'doc-a': 'boot1:4', 'ws:w-1': 'boot1:9' });
    expect(claimReplayMarks(dir)).toEqual({ 'doc-a': 'boot1:4', 'ws:w-1': 'boot1:9' });
  });

  it('an unclean exit discards them — a mid-history record must not read as current', () => {
    saveReplayMarks(dir, { 'doc-a': 'boot1:4' });
    // Boot, read the marks… and die before the next shutdown. The claim above
    // left the file open, so this is exactly that process's leftovers.
    expect(claimReplayMarks(dir)).toEqual({ 'doc-a': 'boot1:4' });
    expect(claimReplayMarks(dir)).toEqual({});
  });

  it('no file, or an unreadable one, is an empty answer rather than a throw', () => {
    expect(claimReplayMarks(join(dir, 'nope'))).toEqual({});
    writeFileSync(join(dir, 'sse-replay-marks.json'), 'not json');
    expect(claimReplayMarks(dir)).toEqual({});
  });
});

/**
 * End to end, through a real server stopped and restarted on the same data
 * dir — the shape of a deploy. This is the test the ticket asks for: a restart
 * that missed nothing must be silent on every stream, and a restart that DID
 * miss something must still say so exactly once.
 */
describe('a restart is silent when nothing was missed', () => {
  let dataDir: string;
  let srcDir: string;
  let handle: ServerHandle;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}`, ...headers } });
  const comment = (text: string) =>
    post('/api/docs/doc-boot/threads', { author: PERSON, text, anchor: { kind: 'subject' } });

  const boot = async () => {
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sse-boot-'));
    srcDir = mkdtempSync(join(tmpdir(), 'sse-boot-src-'));
    await boot();
    const path = join(srcDir, 'doc-boot.md');
    writeFileSync(path, '# doc-boot\n\nBody.\n');
    await post('/api/docs', { docId: 'doc-boot', sourceUrl: path, title: 'doc-boot' });
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('a reconnect at the pre-restart cursor gets no gap and no duplicate', async () => {
    const first = listenFrames(await get('/events/doc-boot'));
    await settle(150);
    await comment('Before the deploy.');
    await settle();
    const cursor = first.frames.find((f) => f.event === 'thread.created')?.id as string;
    expect(typeof cursor).toBe('string');
    await first.stop();

    // The deploy: clean shutdown, fresh process, same data dir. Event ids are
    // stamped with a per-process boot nonce, so `cursor` is now from an epoch
    // this server never issued — the case that used to be an automatic gap.
    await handle.stop();
    await boot();

    const second = listenFrames(await get('/events/doc-boot', { 'Last-Event-ID': cursor }));
    await settle();
    expect(second.frames.some((f) => f.event === 'replay.gap')).toBe(false);
    expect(second.frames.filter((f) => f.event === 'thread.created').length).toBe(0);

    // …and the stream is live rather than quietly dead.
    await comment('After the deploy.');
    await settle();
    expect(second.frames.filter((f) => f.event === 'thread.created').map(commentText)).toEqual([
      'After the deploy.',
    ]);
    await second.stop();
  });

  it('POSITIVE CONTROL: an event missed across the restart still produces exactly one gap', async () => {
    const first = listenFrames(await get('/events/doc-boot'));
    await settle(150);
    await comment('Seen.');
    await settle();
    const cursor = first.frames.find((f) => f.event === 'thread.created')?.id as string;
    await first.stop();

    // Broadcast into the disconnect, THEN restart. The subscriber's cursor is
    // behind by one event that no buffer survives — a real hole.
    await comment('Missed, then the deploy.');
    await settle();
    await handle.stop();
    await boot();

    const second = listenFrames(await get('/events/doc-boot', { 'Last-Event-ID': cursor }));
    await settle();
    expect(second.frames.filter((f) => f.event === 'replay.gap').length).toBe(1);
    // Still no partial replay — a half-answer would read as a whole one.
    expect(second.frames.filter((f) => f.event === 'thread.created').length).toBe(0);
    await second.stop();
  });
});
