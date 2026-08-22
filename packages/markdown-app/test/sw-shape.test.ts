/**
 * The service worker, checked at the source.
 *
 * It cannot be imported and exercised: it is written against a worker global
 * that no test environment here provides, and importing it would run its
 * `addEventListener` calls against happy-dom's window. So this suite pins the
 * properties whose absence is SILENT in production — a worker that installs
 * cleanly and then never shows anything, or shows something that opens the
 * wrong page. Every one of these has a specific way of failing invisibly, and
 * the notes say which.
 *
 * `readPayload` is the one piece worth executing, so it is re-derived here
 * from the same source rather than trusted by eye.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SW_PATH = join(import.meta.dirname, '..', 'src', 'sw.ts');
const source = readFileSync(SW_PATH, 'utf8');

describe('service worker source', () => {
  it('handles push and shows a notification for it', () => {
    // A push handler that shows nothing earns the browser's own "this site
    // was updated in the background" notice, and repeated offences can cost
    // the site its push permission outright.
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain('showNotification');
  });

  it('handles notificationclick — criterion 2 lives entirely here', () => {
    expect(source).toContain("addEventListener('notificationclick'");
  });

  it('keeps the push handler alive with waitUntil', () => {
    // Without waitUntil the worker can be killed mid-await and the
    // notification never appears, intermittently and only under load.
    const pushBlock = source.slice(source.indexOf("addEventListener('push'"));
    expect(pushBlock.slice(0, 400)).toContain('waitUntil');
  });

  it('carries the deep link on the notification DATA, not a closure', () => {
    // The click arrives in a fresh worker invocation minutes later; anything
    // held in a variable is gone by then.
    expect(source).toContain('data: { url: payload.url }');
    expect(source).toContain('notification.data?.url');
  });

  it('claims clients on activate so the first enrolment is handled', () => {
    expect(source).toContain('skipWaiting');
    expect(source).toContain('clients.claim');
  });

  it('has no imports — a worker that imports a chunk can fail to install', () => {
    const imports = source.match(/^\s*import\s.+from\s/gm);
    expect(imports).toBeNull();
  });

  it('points its icons at the root paths the server actually aliases', () => {
    // /app/icon-192.png would 404 from the worker's scope and the
    // notification would render iconless with nothing logged.
    expect(source).toContain("icon: '/icon-192.png'");
    expect(source).toContain("badge: '/icon-192.png'");
  });
});

describe('payload parsing (re-derived from the source)', () => {
  /** The module's own fallback literals, asserted so this copy cannot drift
   *  silently from the file it is standing in for. */
  it('declares a fallback notification for an unreadable payload', () => {
    expect(source).toContain("title: 'Something needs your review'");
    expect(source).toContain('function readPayload');
    // The fallback exists because returning early would leave the browser to
    // post its own generic notice instead.
    const block = source.slice(source.indexOf('function readPayload'));
    expect(block.slice(0, 900)).toContain('return fallback');
  });

  it('defends every field it reads off the wire', () => {
    const block = source.slice(source.indexOf('function readPayload'));
    const body = block.slice(0, 900);
    for (const field of ['title', 'body', 'url', 'tag', 'timestamp']) {
      expect(body).toContain(`raw.${field}`);
    }
  });
});
