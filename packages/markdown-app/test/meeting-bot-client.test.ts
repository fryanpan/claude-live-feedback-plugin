/**
 * The doc's bot client is one endpoint and ONE stream: status and words both
 * arrive on the EventSource it already held, and each reaches its own
 * listeners. The subscribe seam stands in for the EventSource, exactly as
 * the fetch seam stands in for the server.
 */
import type { MeetingBotStatus, MeetingTranscriptEvent } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import {
  type MeetingBotStreamHandlers,
  createMeetingBotClient,
} from '../src/meeting-bot-client.ts';

const status = (state: MeetingBotStatus['state']): MeetingBotStatus => ({
  botId: 'b-1',
  docId: 'doc-1',
  state,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
  speakers: ['Rowan Pike'],
  updatedAt: 1,
});

const frame = (turn: number, text: string, final: boolean): MeetingTranscriptEvent => ({
  event: 'meeting.transcript',
  docId: 'doc-1',
  meetingId: 'm-1',
  turn,
  text,
  final,
  speaker: 'p7',
  speakerName: 'Rowan Pike',
});

function configuredClient() {
  let handlers: MeetingBotStreamHandlers | null = null;
  let subscriptions = 0;
  let unsubscribed = 0;
  const client = createMeetingBotClient({
    docId: 'doc-1',
    fetchJson: () => Promise.resolve({ configured: true, bot: null }),
    subscribe: (_docId, h) => {
      handlers = h;
      subscriptions += 1;
      return () => {
        unsubscribed += 1;
      };
    },
  });
  return {
    client,
    stream: () => {
      if (!handlers) throw new Error('not subscribed');
      return handlers;
    },
    subscriptions: () => subscriptions,
    unsubscribed: () => unsubscribed,
  };
}

describe('the meeting bot client', () => {
  it('delivers live transcript frames from the one stream it holds, in order', async () => {
    const t = configuredClient();
    await t.client.ready;
    expect(t.subscriptions()).toBe(1);
    const seen: MeetingTranscriptEvent[] = [];
    t.client.onTranscript((f) => seen.push(f));
    t.stream().onTranscript(frame(0, 'so the', false));
    t.stream().onTranscript(frame(0, 'So the sync.', true));
    expect(seen.map((f) => [f.turn, f.text, f.final])).toEqual([
      [0, 'so the', false],
      [0, 'So the sync.', true],
    ]);
    expect(seen[0]?.speakerName).toBe('Rowan Pike');
  });

  it('POSITIVE CONTROL: a status frame on the same stream still moves the status', async () => {
    const t = configuredClient();
    await t.client.ready;
    let changes = 0;
    t.client.onChange(() => {
      changes += 1;
    });
    t.stream().onStatus(status('recording'));
    expect(changes).toBe(1);
    expect(t.client.live()?.state).toBe('recording');
    // One subscription carried both; nothing opened a second stream.
    expect(t.subscriptions()).toBe(1);
  });

  it('a cancelled listener hears nothing more; destroy hangs the stream up', async () => {
    const t = configuredClient();
    await t.client.ready;
    let heard = 0;
    const off = t.client.onTranscript(() => {
      heard += 1;
    });
    t.stream().onTranscript(frame(0, 'one', false));
    off();
    t.stream().onTranscript(frame(0, 'two', false));
    expect(heard).toBe(1);
    t.client.destroy();
    expect(t.unsubscribed()).toBe(1);
  });

  it('an unconfigured server opens no stream at all', async () => {
    let subscribed = 0;
    const client = createMeetingBotClient({
      docId: 'doc-1',
      fetchJson: () => Promise.resolve({ configured: false }),
      subscribe: () => {
        subscribed += 1;
        return () => {};
      },
    });
    await client.ready;
    expect(client.configured()).toBe(false);
    expect(subscribed).toBe(0);
  });
});
