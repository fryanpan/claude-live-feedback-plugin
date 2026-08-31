/**
 * The doc's "invite a bot" row: what it shows, what it refuses, and the one
 * thing it must do when the server cannot do this at all — nothing.
 *
 * No network and no EventSource: both are parameters. Participant names are
 * invented; the repo is public.
 */
import type { MeetingBotStatus } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MeetingBotRowHandle, mountMeetingBotRow } from '../src/meeting-bot-row.ts';

const ZOOM_URL = 'https://example.zoom.us/j/1234567890';

const status = (over: Partial<MeetingBotStatus> = {}): MeetingBotStatus => ({
  botId: 'bot_1',
  docId: 'doc-1',
  state: 'joining',
  meetingUrl: ZOOM_URL,
  platform: 'zoom',
  speakers: [],
  updatedAt: 1,
  ...over,
});

let mounted: MeetingBotRowHandle | null = null;
let root: HTMLElement | null = null;

function mount(args: {
  get: unknown;
  onPost?: (url: string, init?: RequestInit) => Promise<unknown>;
  push?: (emit: (s: MeetingBotStatus) => void) => void;
}): { root: HTMLElement; handle: MeetingBotRowHandle; calls: string[] } {
  const calls: string[] = [];
  root = document.createElement('div');
  document.body.append(root);
  const handle = mountMeetingBotRow({
    docId: 'doc-1',
    root,
    fetchJson: (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (!init?.method || init.method === 'GET') return Promise.resolve(args.get);
      return args.onPost ? args.onPost(url, init) : Promise.resolve({});
    },
    subscribe: (_docId, onStatus) => {
      args.push?.(onStatus);
      return () => {};
    },
  });
  mounted = handle;
  return { root, handle, calls };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  mounted?.destroy();
  mounted = null;
  root?.remove();
  root = null;
  vi.restoreAllMocks();
});

describe('the meeting bot row', () => {
  it('renders nothing at all when the server has no Recall key', async () => {
    // A button that always fails is worse than no button: it teaches a person
    // the feature is broken rather than absent.
    const { root } = mount({ get: { configured: false, bot: null } });
    await settle();
    expect(root.querySelector<HTMLElement>('.meeting-bot-row')?.hidden).toBe(true);
  });

  it('offers the form when the server is configured and no bot is out', async () => {
    const { root } = mount({ get: { configured: true, bot: null } });
    await settle();
    expect(root.querySelector<HTMLElement>('.meeting-bot-row')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('.meeting-bot-form')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('.meeting-bot-leave')?.hidden).toBe(true);
  });

  it('refuses a link that is not a meeting, without a round trip', async () => {
    const { root, calls } = mount({ get: { configured: true, bot: null } });
    await settle();
    const input = root.querySelector<HTMLInputElement>('.meeting-bot-url');
    if (!input) throw new Error('no input');
    input.value = 'https://example.com/standup';
    root.querySelector<HTMLFormElement>('.meeting-bot-form')?.requestSubmit();
    await settle();
    expect(root.querySelector('.meeting-bot-error')?.textContent).toContain('Zoom');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
  });

  it('invites a bot and switches to its state', async () => {
    const { root, calls } = mount({
      get: { configured: true, bot: null },
      onPost: () => Promise.resolve({ bot: status({ state: 'joining' }) }),
    });
    await settle();
    const input = root.querySelector<HTMLInputElement>('.meeting-bot-url');
    if (!input) throw new Error('no input');
    input.value = ZOOM_URL;
    root.querySelector<HTMLFormElement>('.meeting-bot-form')?.requestSubmit();
    await settle();
    expect(calls).toContain('POST /api/docs/doc-1/meeting-bot');
    expect(root.querySelector('.meeting-bot-state')?.textContent).toBe('Joining the call');
    expect(root.querySelector<HTMLElement>('.meeting-bot-form')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.meeting-bot-leave')?.hidden).toBe(false);
  });

  it('shows the server’s reason when the invite is refused', async () => {
    const { root } = mount({
      get: { configured: true, bot: null },
      onPost: () => Promise.reject(new Error('This doc is already being recorded.')),
    });
    await settle();
    const input = root.querySelector<HTMLInputElement>('.meeting-bot-url');
    if (!input) throw new Error('no input');
    input.value = ZOOM_URL;
    root.querySelector<HTMLFormElement>('.meeting-bot-form')?.requestSubmit();
    await settle();
    expect(root.querySelector('.meeting-bot-error')?.textContent).toBe(
      'This doc is already being recorded.',
    );
    // And the form comes back, because the person's next move is to retry.
    expect(root.querySelector<HTMLElement>('.meeting-bot-form')?.hidden).toBe(false);
  });

  it('follows the bot live, and names who it has heard', async () => {
    const push: { emit?: (s: MeetingBotStatus) => void } = {};
    const { root } = mount({
      get: { configured: true, bot: status({ state: 'joining' }) },
      push: (fn) => {
        push.emit = fn;
      },
    });
    await settle();
    push.emit?.(status({ state: 'awaiting_permission' }));
    expect(root.querySelector('.meeting-bot-state')?.textContent).toBe(
      'Waiting for the host to allow recording',
    );
    push.emit?.(status({ state: 'recording', speakers: ['Rowan Pike', 'Devi Raman'] }));
    expect(root.querySelector('.meeting-bot-state')?.textContent).toBe(
      'Recording · Rowan Pike, Devi Raman',
    );
  });

  it('keeps a terminal state on screen next to the form that can retry', async () => {
    // "The host declined recording" is the whole reason a person looks here.
    // Clearing it on the state change would take the answer away exactly when
    // it arrived.
    const push: { emit?: (s: MeetingBotStatus) => void } = {};
    const { root } = mount({
      get: { configured: true, bot: status({ state: 'recording' }) },
      push: (fn) => {
        push.emit = fn;
      },
    });
    await settle();
    push.emit?.(status({ state: 'permission_denied' }));
    expect(root.querySelector('.meeting-bot-state')?.textContent).toBe(
      'The host declined recording',
    );
    expect(root.querySelector<HTMLElement>('.meeting-bot-form')?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('.meeting-bot-leave')?.hidden).toBe(true);
  });

  it('sends the bot home on request', async () => {
    const { root, calls } = mount({
      get: { configured: true, bot: status({ state: 'recording' }) },
      onPost: () => Promise.resolve({ ok: true }),
    });
    await settle();
    root.querySelector<HTMLButtonElement>('.meeting-bot-leave')?.click();
    await settle();
    expect(calls).toContain('DELETE /api/docs/doc-1/meeting-bot');
  });

  it('stays silent when the endpoint itself is unreachable', async () => {
    const { root } = mount({ get: Promise.reject(new Error('offline')) });
    await settle();
    // The doc still works; there is simply no row.
    expect(root.querySelector<HTMLElement>('.meeting-bot-row')?.hidden).toBe(true);
  });
});
