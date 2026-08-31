/**
 * The browser half of the live-meeting latency measurement: the marks only
 * this side can take, the clock exchange that makes the server's marks
 * comparable, and the small readout that shows the answer while it is being
 * measured.
 *
 * IT EXISTS ONLY WHEN ASKED. `mountMeetingStrip` builds one when the address
 * carries `?timing=1`; on every other page load nothing here is constructed,
 * no clock is read per audio frame, and the strip is the strip. The point of
 * the flag is that the measurement can run on PROD, against a real
 * conversation, without prod carrying it the rest of the time.
 *
 * THE THREE MARKS THAT ARE OURS. The server can see everything from its own
 * receive to its own send; the two ends of the story are here — when the
 * audio frame went out, and when the words it produced were actually on the
 * screen. The paint mark is a `requestAnimationFrame` callback followed by a
 * task: rAF runs BEFORE style, layout and paint of that frame, so marking
 * inside it would time the work up to the frame and call it "painted". The
 * task that runs after it is the first moment the frame is committed.
 *
 * WHAT IT NEVER TOUCHES. No transcript text, no doc id, no title, no URL
 * reaches a sample, a CSV column, or the readout. The measured population is
 * "the last word of a transcript frame", named by its audio offset. Nothing
 * is sent anywhere: the samples live in this tab until someone downloads
 * them.
 */

import {
  type ClockOffset,
  type LatencySample,
  type LatencySummary,
  type MeetingTimingMark,
  type PendingSample,
  bestOffset,
  buildSample,
  offsetFromPong,
  summarize,
  toCsv,
} from '@feedback/core';

/** `?timing=1` — the only way any of this runs. */
export const TIMING_PARAM = 'timing';

/** Whether this address asks for the meeting to be measured. */
export function wantsLatencyTiming(search: string): boolean {
  return new URLSearchParams(search).get(TIMING_PARAM) === '1';
}

/**
 * How many audio frames' emit times are kept. Deliberately the same window
 * the server's ledger keeps, so the two sides forget a chunk together rather
 * than one of them holding half a sample.
 */
const FRAME_HISTORY = 1200;

/** Clock exchanges at the start of a meeting, and how far apart. */
const PING_BURST = 5;
const PING_BURST_MS = 250;
/** And one every so often after that, so a long meeting keeps a fresh RTT. */
const PING_STEADY_MS = 20_000;

/** Where a global handle to the samples is parked, for a headless harvest. */
export const TIMING_GLOBAL = '__meetingTiming';

export interface TimingSessionOpts {
  now?: () => number;
  /** Write a JSON frame to the meeting socket. */
  send: (json: string) => void;
  interval?: (fn: () => void, ms: number) => () => void;
  timeout?: (fn: () => void, ms: number) => void;
  /** Run `fn` after the next frame has been committed. */
  afterPaint?: (fn: () => void) => void;
  /** Hand the CSV to the person. Injected so a test never touches the DOM's
   *  download machinery. */
  saveCsv?: (csv: string) => void;
}

export interface TimingSession {
  /** The readout row; the strip appends it. */
  readonly element: HTMLElement;
  /** A meeting started: forget the last one's samples and re-sync the clock. */
  begin(): void;
  /** One audio frame was written to the socket. */
  frameSent(): void;
  /** A `timing_pong` came back. */
  onPong(
    pong: { id: number; clientMs: number; serverRecvMs: number; serverSendMs: number },
    clientRecvMs: number,
  ): void;
  /** A transcript frame arrived, before the strip renders it. */
  frameReceived(
    msg: { turn: number; final: boolean; timing?: MeetingTimingMark },
    clientRecvMs: number,
  ): void;
  /** The strip has finished writing the DOM for everything received. */
  domUpdated(): void;
  samples(): readonly LatencySample[];
  summary(): LatencySummary;
  destroy(): void;
}

function defaultAfterPaint(fn: () => void): void {
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  if (!raf) {
    setTimeout(fn, 0);
    return;
  }
  // rAF lands before the frame is drawn; the task after it is the first
  // moment the pixels exist.
  raf(() => setTimeout(fn, 0));
}

function defaultSaveCsv(csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meeting-latency.csv';
  a.click();
  // Revoked on a later task: revoking synchronously races the download the
  // click just started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One line of the readout: a label and a number that changes. */
function statCell(label: string): { el: HTMLElement; set: (text: string) => void } {
  const el = document.createElement('span');
  el.className = 'meeting-timing-stat';
  const name = document.createElement('span');
  name.className = 'meeting-timing-label';
  name.textContent = label;
  const value = document.createElement('b');
  value.className = 'meeting-timing-value';
  value.textContent = '—';
  el.append(name, value);
  return { el, set: (text) => (value.textContent = text) };
}

export function createTimingSession(opts: TimingSessionOpts): TimingSession {
  const now = opts.now ?? (() => Date.now());
  const interval =
    opts.interval ??
    ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const timeout = opts.timeout ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const afterPaint = opts.afterPaint ?? defaultAfterPaint;
  const saveCsv = opts.saveCsv ?? defaultSaveCsv;

  /** Emit time per frame ordinal — the server's `seq` counts the same frames. */
  const emits = new Map<number, number>();
  let nextSeq = 0;
  const offsets: ClockOffset[] = [];
  let pingId = 0;
  /** Transcript frames received but not yet written to the DOM. */
  let awaitingDom: Array<Omit<PendingSample, 'domMs'>> = [];
  let collected: LatencySample[] = [];
  let stopPings: (() => void) | null = null;
  let disposed = false;

  const element = document.createElement('div');
  element.className = 'meeting-timing-row';
  const live = statCell('spoken→painted p50/p95');
  const legs = statCell('vendor / ours');
  const count = statCell('n');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'meeting-timing-save';
  save.textContent = 'CSV';
  save.title = 'Download the samples as CSV';
  element.append(live.el, legs.el, count.el, save);

  const ms = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : '—');

  function render(): void {
    // The headline is PARTIALS: a partial is the newest word reaching the
    // screen, which is the experience being measured. A final arrives after
    // the engine has decided the turn ended and re-punctuated it, so mixing
    // the two would report a slower pipeline than the one being watched.
    const partials = collected.filter((s) => !s.final);
    const s = summarize(partials);
    live.set(`${ms(s.total.p50)}/${ms(s.total.p95)} ms`);
    legs.set(`${ms(s.vendor.p50)} / ${ms(s.total.p50 - s.vendor.p50)} ms`);
    count.set(
      `${partials.length}${collected.length > partials.length ? `+${collected.length - partials.length}f` : ''}`,
    );
  }

  function publish(): void {
    (globalThis as unknown as Record<string, unknown>)[TIMING_GLOBAL] = {
      samples: collected,
      summary: () => summarize(collected.filter((s) => !s.final)),
      summaryAll: () => summarize(collected),
      csv: () => toCsv(collected),
      offsets: [...offsets],
    };
  }

  function ping(): void {
    if (disposed) return;
    opts.send(JSON.stringify({ type: 'timing_ping', id: ++pingId, clientMs: now() }));
  }

  const session: TimingSession = {
    element,
    begin(): void {
      // A new meeting is a new audio stream, so the old frame ordinals mean
      // nothing to the new server-side ledger. Samples go too: they belong to
      // the meeting that produced them, and mixing two would average across a
      // network that may have changed underneath.
      emits.clear();
      nextSeq = 0;
      awaitingDom = [];
      collected = [];
      offsets.length = 0;
      render();
      publish();
      stopPings?.();
      // A burst first — the lowest round trip of several is a far better
      // offset than one exchange that happened to queue — then a slow drip.
      for (let i = 0; i < PING_BURST; i++) timeout(ping, i * PING_BURST_MS);
      stopPings = interval(ping, PING_STEADY_MS);
    },
    frameSent(): void {
      const seq = nextSeq++;
      emits.set(seq, now());
      if (emits.size > FRAME_HISTORY) {
        const oldest = seq - FRAME_HISTORY;
        for (const k of emits.keys()) {
          if (k > oldest) break;
          emits.delete(k);
        }
      }
    },
    onPong(pong, clientRecvMs): void {
      offsets.push(offsetFromPong(pong, clientRecvMs));
      publish();
    },
    frameReceived(msg, clientRecvMs): void {
      const t = msg.timing;
      if (!t) return;
      const emitMs = emits.get(t.seq);
      // The frame that carried this word has rolled out of the window, so its
      // emit time is gone. Dropping the sample is the honest answer.
      if (emitMs === undefined) return;
      awaitingDom.push({
        seq: t.seq,
        turn: msg.turn,
        final: msg.final,
        audioEndMs: t.audioEndMs,
        chunkAudioEndMs: t.chunkAudioEndMs,
        emitMs,
        recvMs: t.recvMs,
        fwdMs: t.fwdMs,
        engineMs: t.engineMs,
        sendMs: t.sendMs,
        clientRecvMs,
      });
    },
    domUpdated(): void {
      if (awaitingDom.length === 0) return;
      const domMs = now();
      const batch = awaitingDom;
      awaitingDom = [];
      afterPaint(() => {
        const paintMs = now();
        const clock = bestOffset(offsets);
        // No usable exchange yet — the first words of a meeting can beat the
        // first pong home. Priced at a zero offset and marked by an RTT of
        // NaN rather than dropped: the total is right either way, and only
        // the up/down split is unanchored.
        const use: ClockOffset = clock ?? { offsetMs: 0, rttMs: Number.NaN };
        for (const p of batch) collected.push(buildSample({ ...p, domMs }, paintMs, use));
        render();
        publish();
      });
    },
    samples: () => collected,
    summary: () => summarize(collected.filter((s) => !s.final)),
    destroy(): void {
      disposed = true;
      stopPings?.();
      stopPings = null;
      element.remove();
    },
  };

  save.addEventListener('click', () => saveCsv(toCsv(collected)));
  render();
  publish();
  return session;
}
