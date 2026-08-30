/**
 * The link between "a review item was filed" and "a device was told".
 *
 * Every other suite here proves a piece: the crypto encrypts, the store
 * stores, the notifier posts, the routes enrol. All of them can pass while
 * nothing ever calls the notifier — and the symptom of that is a
 * notification nobody is waiting for, so nobody reports it missing. This
 * suite is the only place the whole path runs, from a POST that files a
 * review item to bytes leaving for a push service.
 *
 * The push service itself is a stub (`pushFetch`), because the real one is
 * a third party and a real endpoint is a real device. Everything on this
 * side of it is the production code path.
 *
 * Fixtures are synthetic: invented ids, generic personas, example.com hosts.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '../src/push-crypto.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const AGENT = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'known', color: '#888888' };
const BASE_URL = 'https://reviews.example.com';

const trash: string[] = [];
let handle: ServerHandle | null = null;

afterEach(async () => {
  await handle?.stop();
  handle = null;
  while (trash.length > 0) rmSync(trash.pop() as string, { recursive: true, force: true });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A subscription whose key is a REAL P-256 point. A random 65 bytes behind
 *  an 0x04 byte is not on the curve, and the encryption step rejects it — so
 *  a fake key here would exercise the failure path while claiming the
 *  opposite. */
async function realSubscription(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint,
    keys: {
      p256dh: b64urlEncode(raw),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lf-push-e2e-'));
  trash.push(dataDir);
  const sent: Sent[] = [];
  const server = createServer({
    port: 0,
    dataDir,
    publicBaseUrl: BASE_URL,
    pushFetch: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return new Response(null, { status: 201 });
    },
  });
  handle = server;
  return { base: `http://localhost:${server.port}`, sent };
}

/** The send is fire-and-forget by design — the route answers before the push
 *  service does — so the assertion has to wait for it rather than read it
 *  off the response. */
async function waitForSend(sent: Sent[], ms = 4000): Promise<Sent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (sent.length > 0) return sent[0] as Sent;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nothing was sent to the push service');
}

describe('filing a review item announces it', () => {
  it('posts an encrypted, VAPID-signed notification to every enrolled device', async () => {
    const { base, sent } = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const sub = await realSubscription('https://push.example.com/s/device-1');
    expect((await post('/api/push/subscriptions', { author: AGENT, subscription: sub })).ok).toBe(
      true,
    );

    const { workspace } = (await (
      await post('/api/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' })
    ).json()) as { workspace: { id: string } };
    const { task } = (await (
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
      })
    ).json()) as { task: { id: string } };

    const filed = await post(`/api/tasks/${task.id}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Cache size for the rebuild',
        options: [
          { id: 'o-7f3a', label: 'Keep it' },
          { id: 'o-4b2e', label: 'Halve it' },
        ],
      },
    });
    expect(filed.status).toBe(200);

    const out = await waitForSend(sent);
    expect(out.url).toBe(sub.endpoint);
    // aes128gcm or the push service rejects it, and the browser could not
    // decrypt it if the service didn't.
    expect(out.headers['Content-Encoding']).toBe('aes128gcm');
    expect(out.headers.Authorization?.startsWith('vapid t=')).toBe(true);
    expect(out.headers.TTL).toBeDefined();
    // Encrypted, so the payload must NOT be readable — a body containing the
    // headline would mean the encryption step was skipped entirely.
    expect(out.body.byteLength).toBeGreaterThan(16);
    expect(new TextDecoder().decode(out.body)).not.toContain('Cache size');
  });

  it('sends nothing when no device is enrolled', async () => {
    // The negative control for the test above: with the same route and the
    // same payload and no subscription, the stub must stay untouched — or
    // "it sent something" would not be evidence that enrolment mattered.
    const { base, sent } = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const { workspace } = (await (
      await post('/api/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' })
    ).json()) as { workspace: { id: string } };
    const { task } = (await (
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
      })
    ).json()) as { task: { id: string } };
    await post(`/api/tasks/${task.id}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Cache size for the rebuild',
        options: [
          { id: 'o-7f3a', label: 'Keep it' },
          { id: 'o-4b2e', label: 'Halve it' },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(sent.length).toBe(0);
  });

  it('retires a device the push service reports GONE, without hard-deleting it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'lf-push-e2e-'));
    trash.push(dataDir);
    const seen: string[] = [];
    const server = createServer({
      port: 0,
      dataDir,
      publicBaseUrl: BASE_URL,
      pushFetch: async (url) => {
        seen.push(url);
        return new Response(null, { status: 410 });
      },
    });
    handle = server;
    const base = `http://localhost:${server.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const sub = await realSubscription('https://push.example.com/s/dead-device');
    await post('/api/push/subscriptions', { author: AGENT, subscription: sub });

    const { workspace } = (await (
      await post('/api/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' })
    ).json()) as { workspace: { id: string } };
    const { task } = (await (
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
      })
    ).json()) as { task: { id: string } };
    await post(`/api/tasks/${task.id}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Cache size for the rebuild',
        options: [
          { id: 'o-7f3a', label: 'Keep it' },
          { id: 'o-4b2e', label: 'Halve it' },
        ],
      },
    });

    const deadline = Date.now() + 4000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(seen.length).toBe(1);

    // The row survives with a reason. A 410 means the browser dropped the
    // endpoint, not that the enrolment never happened — and this file is the
    // only record that a device was ever set up.
    const onDisk = await Bun.file(join(dataDir, 'push-subscriptions.json')).json();
    const row = onDisk.subscriptions[sub.endpoint];
    expect(row).toBeDefined();
    expect(row.disabledAt).toBeGreaterThan(0);
    expect(row.disabledReason).toContain('410');
  });
});

/**
 * A WITHDRAWN item must not buzz anybody's phone.
 *
 * The announce call is shared with /revise, and reusing it here was the
 * natural thing to write — which is how a retraction ends up sending the
 * reader a notification whose title IS the ask that was just taken off their
 * queue. The first test below is the positive control the second one needs:
 * without proving a push happens on this exact route with this exact
 * subscription, "nothing was sent" is not evidence of anything.
 */
describe('withdrawing a doc-thread review item', () => {
  const AUTHOR = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

  async function threadWithItem() {
    const { base, sent } = await start();
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const sub = await realSubscription('https://push.example.com/s/device-1');
    expect((await post('/api/push/subscriptions', { author: AGENT, subscription: sub })).ok).toBe(
      true,
    );
    const dataDir = mkdtempSync(join(tmpdir(), 'lf-push-doc-'));
    trash.push(dataDir);
    const file = join(dataDir, 'notes.md');
    writeFileSync(file, '# Notes\n\nThe phone layout holds together.\n');
    const { docId } = (await (
      await post('/api/docs', { docId: 'push-notes', type: 'markdown', sourceUrl: file })
    ).json()) as { docId: string };
    const { thread } = (await (
      await post(`/api/docs/${docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: 'Checked this at 430px.',
        author: AUTHOR,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Does the call to action need moving?',
          detail: 'At 430px it falls below the fold. Worth moving it above the gallery?',
        },
      })
    ).json()) as { thread: { id: string; comments: Array<{ id: string }> } };
    return {
      post,
      sent,
      docId,
      threadId: thread.id,
      commentId: (thread.comments[0] as { id: string }).id,
    };
  }

  it('POSITIVE CONTROL: raising one on this route does reach the device', async () => {
    const { sent } = await threadWithItem();
    const out = await waitForSend(sent);
    expect(out.url).toBe('https://push.example.com/s/device-1');
  });

  it('sends nothing on the way out, and announces again on the way back', async () => {
    const { post, sent, docId, threadId, commentId } = await threadWithItem();
    await waitForSend(sent);
    const afterRaise = sent.length;

    const gone = await post(`/api/docs/${docId}/threads/${threadId}/withdraw`, {
      author: AUTHOR,
      commentId,
      reason: 'Superseded — I measured it wrong.',
    });
    expect(gone.status).toBe(200);
    // Long enough that a send would have landed: the control above arrives
    // well inside this window.
    await new Promise((r) => setTimeout(r, 500));
    expect(sent.length).toBe(afterRaise);

    const back = await post(`/api/docs/${docId}/threads/${threadId}/withdraw/undo`, {
      author: AUTHOR,
      commentId,
    });
    expect(back.status).toBe(200);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && sent.length === afterRaise) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sent.length).toBeGreaterThan(afterRaise);
  });
});
