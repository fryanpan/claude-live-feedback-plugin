import type { ConnectionStatus } from '@feedback/core';
import { describe, expect, it, vi } from 'vitest';
import { parseBuildId, showStaleNotice, watchForStaleClient } from '../src/stale-client.ts';

describe('parseBuildId', () => {
  it('reads the id out of the BUILD_INFO line the build script writes', () => {
    expect(parseBuildId('built 2026-08-13T01:02:03.456Z\n')).toBe('2026-08-13T01:02:03.456Z');
  });

  it('refuses anything that is not that line, rather than inventing an id', () => {
    // A 404 body, an index.html served by a fallback route, an empty file —
    // every one of these must read as "I could not tell", because the caller
    // turns "different id" into a banner. Guessing here is a false positive.
    expect(parseBuildId('')).toBeNull();
    expect(parseBuildId('<!doctype html><title>Not found</title>')).toBeNull();
    expect(parseBuildId('built\n')).toBeNull();
  });
});

/** Drives the status callback the way ws-client does. */
function fakeStatus() {
  const cbs: ((s: ConnectionStatus) => void)[] = [];
  let current: ConnectionStatus = 'open';
  return {
    // ws-client's contract: fires on every transition AND immediately with
    // the current status at subscribe time.
    onStatus: (cb: (s: ConnectionStatus) => void) => {
      cbs.push(cb);
      cb(current);
    },
    set(s: ConnectionStatus) {
      current = s;
      for (const cb of cbs) cb(s);
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('watchForStaleClient', () => {
  it('says nothing while the tab just sits there connected', async () => {
    const status = fakeStatus();
    const fetchBuildInfo = vi.fn(async () => 'built NEW\n');
    const onStale = vi.fn();
    watchForStaleClient({ buildId: 'OLD', onStatus: status.onStatus, fetchBuildInfo, onStale });
    await flush();
    // The immediate 'open' at subscribe time is not a reconnect. Nothing is
    // fetched at all — this is what "costs nothing while idle" means.
    expect(fetchBuildInfo).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('flags the tab when it reconnects to a server serving a different build', async () => {
    const status = fakeStatus();
    const onStale = vi.fn();
    watchForStaleClient({
      buildId: 'OLD',
      onStatus: status.onStatus,
      fetchBuildInfo: async () => 'built NEW\n',
      onStale,
    });
    status.set('closed');
    status.set('open');
    await flush();
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it('stays quiet through a plain restart that serves the same build', async () => {
    // The nag case: the supervisor bounces the server, every open tab
    // reconnects, and none of them has anything to tell anyone.
    const status = fakeStatus();
    const onStale = vi.fn();
    watchForStaleClient({
      buildId: 'SAME',
      onStatus: status.onStatus,
      fetchBuildInfo: async () => 'built SAME\n',
      onStale,
    });
    for (let i = 0; i < 3; i++) {
      status.set('closed');
      status.set('open');
      await flush();
    }
    expect(onStale).not.toHaveBeenCalled();
  });

  it('fires once and then stops asking, however many times it reconnects', async () => {
    const status = fakeStatus();
    const fetchBuildInfo = vi.fn(async () => 'built NEW\n');
    const onStale = vi.fn();
    watchForStaleClient({ buildId: 'OLD', onStatus: status.onStatus, fetchBuildInfo, onStale });
    for (let i = 0; i < 3; i++) {
      status.set('closed');
      status.set('open');
      await flush();
    }
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(fetchBuildInfo).toHaveBeenCalledTimes(1);
  });

  it('treats a failed or unreadable probe as no news, and stays armed', async () => {
    const status = fakeStatus();
    const onStale = vi.fn();
    let attempt = 0;
    const fetchBuildInfo = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('network down mid-restart');
      if (attempt === 2) return '<!doctype html>';
      return 'built NEW\n';
    });
    watchForStaleClient({ buildId: 'OLD', onStatus: status.onStatus, fetchBuildInfo, onStale });
    for (let i = 0; i < 3; i++) {
      status.set('closed');
      status.set('open');
      await flush();
    }
    // Positive control on the same watcher: the first two probes told it
    // nothing, and the third — a real answer — still lands.
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(fetchBuildInfo).toHaveBeenCalledTimes(3);
  });

  it('never probes from a bundle with no baked id, so `bun dev` is not a nag', async () => {
    const status = fakeStatus();
    const fetchBuildInfo = vi.fn(async () => 'built NEW\n');
    const onStale = vi.fn();
    watchForStaleClient({ buildId: '', onStatus: status.onStatus, fetchBuildInfo, onStale });
    status.set('closed');
    status.set('open');
    await flush();
    expect(fetchBuildInfo).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe('showStaleNotice', () => {
  it('adds one notice with a reload affordance, and only one', () => {
    document.body.innerHTML = '';
    const reload = vi.fn();
    showStaleNotice(document, reload);
    showStaleNotice(document, reload);
    const notices = document.querySelectorAll('.stale-client');
    expect(notices.length).toBe(1);
    const btn = notices[0].querySelector('button') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('is dismissible, because a notice you cannot close is a nag', () => {
    document.body.innerHTML = '';
    showStaleNotice(document, vi.fn());
    const dismiss = document.querySelector('.stale-client__dismiss') as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    expect(document.querySelector('.stale-client')).toBeNull();
  });
});
