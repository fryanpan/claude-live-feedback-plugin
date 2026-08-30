/**
 * Sign in before you write — driven through the real route table.
 *
 * The predicates have their own unit file. This one exists because the
 * predicates are not the risk: a gate wired in BELOW a route that already
 * answered would pass every unit test and refuse nothing, and that failure
 * looks exactly like a working gate from the outside. So every assertion
 * here goes over the wire.
 *
 * **The positive control is the point of this file.** "An unsigned write was
 * refused" is worth nothing on its own — a request that fails for an
 * unrelated reason (wrong route, wrong payload shape, a doc that does not
 * exist) is indistinguishable from a gate doing its job. So every refusal
 * below is paired with the SAME request, byte for byte, against a server
 * booted with the flag off, and that pair has to come out 401/200. A probe
 * that cannot produce a success has not demonstrated a refusal.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElementAnchor, type User, prose } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { SIGN_IN_REQUIRED_ERROR } from '../src/middleware/write-gate.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const MSG_SYNC = 0;

/** Distinctive strings, so "did this edit land" is a substring search over
 *  the bound file rather than a guess about markdown serialization. */
const NEEDLE = 'EDIT-FROM-AN-UNSIGNED-BROWSER';
const SIGNED_NEEDLE = 'EDIT-FROM-A-SIGNED-BROWSER';
const AGENT_NEEDLE = 'EDIT-FROM-AN-AGENT';

const reviewer: User = { id: 'known-dana', name: 'Dana', kind: 'known', color: '#2e7dd7' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

const cleanups: Array<() => void | Promise<void>> = [];
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Booted {
  base: string;
  wsBase: string;
  dataDir: string;
  handle: ServerHandle;
}

function boot(requireSignInToWrite: boolean): Booted {
  const dataDir = mkdtempSync(join(tmpdir(), 'write-gate-'));
  const handle = createServer({ port: 0, dataDir, requireSignInToWrite });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    base: `http://localhost:${handle.port}`,
    wsBase: `ws://localhost:${handle.port}`,
    dataDir,
    handle,
  };
}

/**
 * What a BROWSER's request looks like on the wire.
 *
 * Browsers attach these themselves, from privileged code a page cannot
 * reach, on every non-GET. Their absence is what the gate reads as "an
 * agent", so a test that forgot them would be testing the agent path while
 * believing it tested the browser one.
 */
const browserHeaders = (base: string): Record<string, string> => ({
  origin: base,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
});

/** Sign in and return the cookie pair to send back. Fixture addresses only —
 *  no real person's credentials go anywhere near this suite. */
async function signIn(base: string, email: string): Promise<string> {
  const before = codes.length;
  const started = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...browserHeaders(base) },
    body: JSON.stringify({ email }),
  });
  expect(started.status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...browserHeaders(base) },
    body: JSON.stringify({ email, code: codes[codes.length - 1] }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** Bind a markdown doc so there is something real to write on. Created over
 *  the AGENT path, which is how docs actually come into being. */
async function bindDoc(b: Booted, docId: string): Promise<string> {
  const file = join(b.dataDir, `${docId}.md`);
  writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
  const created = await fetch(`${b.base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
  });
  expect(created.status).toBe(200);
  return file;
}

/** The ordinary writes a person makes, each as a browser would send it. */
const writes = {
  comment: (b: Booted, docId: string, cookie?: string) =>
    fetch(`${b.base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...browserHeaders(b.base),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        author: reviewer,
        text: 'this needs more detail',
        anchor: fakeAnchor,
      }),
    }),
  createWorkspace: (b: Booted, cookie?: string) =>
    fetch(`${b.base}/api/workspaces`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...browserHeaders(b.base),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ name: 'A board' }),
    }),
  bindDocFromBrowser: (b: Booted, docId: string, cookie?: string) => {
    const file = join(b.dataDir, `${docId}.md`);
    writeFileSync(file, '# Another\n');
    return fetch(`${b.base}/api/docs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...browserHeaders(b.base),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    });
  },
};

async function errorOf(res: Response): Promise<string | undefined> {
  return ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
}

// =========================================================================
// THE POSITIVE CONTROL
// =========================================================================

describe('the gate can refuse, and the probe can see a success', () => {
  it('refuses an unsigned browser comment with the flag ON and accepts the identical one with it OFF', async () => {
    // Same request, same body, same headers, same doc id. The ONLY difference
    // between the two servers is the flag. Anything that made this request
    // fail for its own reasons would fail on both.
    const on = boot(true);
    await bindDoc(on, 'control-doc');
    const refused = await writes.comment(on, 'control-doc');

    const off = boot(false);
    await bindDoc(off, 'control-doc');
    const accepted = await writes.comment(off, 'control-doc');

    expect(refused.status).toBe(401);
    expect(await errorOf(refused)).toBe(SIGN_IN_REQUIRED_ERROR);
    // The control. Without this line the assertion above proves only that
    // something went wrong.
    expect(accepted.status).toBe(200);
  });

  it('refuses an unsigned browser board create with the flag ON and accepts it with it OFF', async () => {
    const on = boot(true);
    const off = boot(false);
    const refused = await writes.createWorkspace(on);
    const accepted = await writes.createWorkspace(off);
    expect(refused.status).toBe(401);
    expect(await errorOf(refused)).toBe(SIGN_IN_REQUIRED_ERROR);
    expect(accepted.status).toBe(200);
  });

  it('refuses an unsigned browser doc bind with the flag ON and accepts it with it OFF', async () => {
    const on = boot(true);
    const off = boot(false);
    const refused = await writes.bindDocFromBrowser(on, 'bound-by-browser');
    const accepted = await writes.bindDocFromBrowser(off, 'bound-by-browser');
    expect(refused.status).toBe(401);
    expect(await errorOf(refused)).toBe(SIGN_IN_REQUIRED_ERROR);
    expect(accepted.status).toBe(200);
  });
});

// =========================================================================
// WHAT THE GATE MUST NOT TOUCH
// =========================================================================

describe('with the gate ON', () => {
  it('accepts the same write once the browser has signed in', async () => {
    const b = boot(true);
    await bindDoc(b, 'signed-doc');
    const cookie = await signIn(b.base, 'reviewer@example.com');
    const res = await writes.comment(b, 'signed-doc', cookie);
    expect(res.status).toBe(200);
  });

  it('refuses a browser whose session cookie does not verify', async () => {
    // A forged value is "no session", not "some session". The fixture is a
    // structurally-valid shape with a deliberately wrong signature.
    const b = boot(true);
    await bindDoc(b, 'forged-doc');
    const res = await writes.comment(b, 'forged-doc', `${SESSION_COOKIE}=v2.user-x.sid.1.nope`);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toBe(SIGN_IN_REQUIRED_ERROR);
  });

  it('leaves an AGENT write alone — no Origin, no session, still accepted', async () => {
    // The regression that would take the whole fleet offline the moment the
    // flag was switched on. Every MCP tool and every webhook writes exactly
    // like this and has no way to sign in.
    const b = boot(true);
    await bindDoc(b, 'agent-doc');
    const res = await fetch(`${b.base}/api/docs/agent-doc/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: reviewer,
        text: 'posted by an agent over loopback',
        anchor: fakeAnchor,
      }),
    });
    expect(res.status).toBe(200);
    // And it really landed, rather than merely not being refused.
    const listed = await fetch(`${b.base}/api/docs/agent-doc/threads`);
    const { threads } = (await listed.json()) as { threads: unknown[] };
    expect(threads.length).toBe(1);
  });

  it('leaves an agent PUT and DELETE alone, and refuses the browser ones', async () => {
    // Not only POST. The gate is method-keyed, so every mutating verb runs
    // the same risk of taking agents offline — and has to refuse a browser.
    const b = boot(true);
    const created = await fetch(`${b.base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent board' }),
    });
    expect(created.status).toBe(200);
    const { workspace } = (await created.json()) as { workspace: { id: string } };
    const workspaceId = workspace.id;

    const agentPut = await fetch(`${b.base}/api/workspaces/${workspaceId}/retired`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retired: true, author: reviewer }),
    });
    expect(agentPut.status).toBe(200);

    const browserPut = await fetch(`${b.base}/api/workspaces/${workspaceId}/retired`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...browserHeaders(b.base) },
      body: JSON.stringify({ retired: false, author: reviewer }),
    });
    expect(browserPut.status).toBe(401);
    expect(await errorOf(browserPut)).toBe(SIGN_IN_REQUIRED_ERROR);

    // DELETE, on a route that destroys nothing a person owns.
    const agentDelete = await fetch(`${b.base}/api/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example.test/fixture' }),
    });
    expect(await errorOf(agentDelete)).not.toBe(SIGN_IN_REQUIRED_ERROR);

    const browserDelete = await fetch(`${b.base}/api/push/subscriptions`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...browserHeaders(b.base) },
      body: JSON.stringify({ endpoint: 'https://push.example.test/fixture' }),
    });
    expect(browserDelete.status).toBe(401);
    expect(await errorOf(browserDelete)).toBe(SIGN_IN_REQUIRED_ERROR);
  });

  it('leaves READS open to an unsigned browser', async () => {
    const b = boot(true);
    await bindDoc(b, 'readable-doc');
    for (const path of ['/api/docs', '/api/docs/readable-doc/threads']) {
      const res = await fetch(`${b.base}${path}`, { headers: browserHeaders(b.base) });
      expect(res.status).toBe(200);
    }
  });

  it('leaves a POST that only reads open to an unsigned browser', async () => {
    // `/api/links/titles` is a POST for its request shape — a batch of URLs
    // does not fit in a query string — and a read in its effect. Gated, an
    // unsigned reader's link chips silently never resolved while the refusal
    // told them "Reading needs no account".
    const b = boot(true);
    const res = await fetch(`${b.base}/api/links/titles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...browserHeaders(b.base) },
      body: JSON.stringify({ urls: [`${b.base}/review/nothing-here`] }),
    });
    expect(res.status).toBe(200);

    // The control, in the same test: an ordinary POST from the SAME unsigned
    // browser on the SAME server is still refused. Without this the 200 above
    // would be equally consistent with a gate that had stopped working.
    const gated = await fetch(`${b.base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...browserHeaders(b.base) },
      body: JSON.stringify({ name: 'A board' }),
    });
    expect(gated.status).toBe(401);
    expect(((await gated.json()) as { error?: string }).error).toBe(SIGN_IN_REQUIRED_ERROR);
  });

  it('leaves the sign-in flow reachable — otherwise the gate is a deadlock', async () => {
    // `signIn` is itself the assertion: it POSTs /api/auth/start and
    // /api/auth/verify as a browser with no session, and expects 200 from
    // both. If the gate caught them, nobody could ever satisfy it.
    const b = boot(true);
    const cookie = await signIn(b.base, 'firsttimer@example.com');
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  });

  it('tells the client it must sign in, before the client offers a surface', async () => {
    const b = boot(true);
    const anon = await fetch(`${b.base}/api/auth/session`, { headers: browserHeaders(b.base) });
    expect(await anon.json()).toMatchObject({ signInToWrite: true, canWrite: false });

    const cookie = await signIn(b.base, 'reviewer@example.com');
    const signed = await fetch(`${b.base}/api/auth/session`, {
      headers: { ...browserHeaders(b.base), cookie },
    });
    expect(await signed.json()).toMatchObject({ signInToWrite: true, canWrite: true });
  });

  it('says canWrite with the flag OFF, whoever is asking', async () => {
    const b = boot(false);
    const res = await fetch(`${b.base}/api/auth/session`, { headers: browserHeaders(b.base) });
    expect(await res.json()).toMatchObject({ signInToWrite: false, canWrite: true });
  });

  it('carries the URL that fixes the refusal', async () => {
    const b = boot(true);
    const res = await writes.createWorkspace(b);
    const body = (await res.json()) as { message?: string; signInUrl?: string };
    expect(body.signInUrl).toBe('/signin');
    expect(body.message).toMatch(/sign in/i);
  });
});

// =========================================================================
// THE DOC EDIT — the one write that is not an HTTP write
// =========================================================================

/**
 * Open a `/y/<docId>` socket the way a browser does, run the sync handshake,
 * and hand back the local Y.Doc plus a way to push an edit.
 *
 * `asBrowser` controls the Origin header, which is the whole distinction the
 * gate turns on — an agent's socket has none.
 */
function connectDoc(
  url: string,
  opts: { asBrowser: string | null; cookie?: string },
): {
  ydoc: Y.Doc;
  ready: Promise<void>;
  close: () => void;
} {
  const ydoc = new Y.Doc();
  const headers: Record<string, string> = {};
  if (opts.asBrowser !== null) headers.origin = opts.asBrowser;
  if (opts.cookie) headers.cookie = opts.cookie;
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate) {
      resolveReady?.();
    }
  });
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });

  return { ydoc, ready, close: () => ws.close() };
}

/**
 * What actually reached the SERVER, read off the bound file the plugin
 * flushes to disk — not off the local Y.Doc, which holds every edit this tab
 * made whether or not any of them were accepted. Telling those two apart is
 * the whole assertion.
 */
async function serverText(file: string, expected: string, want: boolean): Promise<string> {
  let disk = '';
  for (let i = 0; i < 40; i++) {
    disk = readFileSync(file, 'utf8');
    if (disk.includes(expected) === want) break;
    await Bun.sleep(50);
  }
  return disk;
}

/** Append a paragraph the way a person typing in the editor would. */
function typeParagraph(ydoc: Y.Doc, text: string): void {
  const frag = prose.getProseFragment(ydoc);
  const para = new Y.XmlElement('paragraph');
  para.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [para]);
}

describe('the doc-editing socket with the gate ON', () => {
  it('lets an unsigned browser READ the doc and declines its edits — with the positive control', async () => {
    const on = boot(true);
    const onFile = await bindDoc(on, 'ws-doc');
    const off = boot(false);
    const offFile = await bindDoc(off, 'ws-doc');

    const gated = connectDoc(`${on.wsBase}/y/ws-doc`, { asBrowser: on.base });
    const ungated = connectDoc(`${off.wsBase}/y/ws-doc`, { asBrowser: off.base });
    await Promise.all([gated.ready, ungated.ready]);

    // READING IS UNCHANGED. The gated socket completed the handshake and the
    // doc's real prose arrived on it — a refused upgrade would have gated
    // reading, which this design must never do.
    for (const c of [gated, ungated]) {
      for (let i = 0; i < 50 && prose.getProseFragment(c.ydoc).length < 2; i++) {
        await Bun.sleep(20);
      }
      expect(prose.getProseFragment(c.ydoc).length).toBeGreaterThanOrEqual(2);
    }

    typeParagraph(gated.ydoc, NEEDLE);
    typeParagraph(ungated.ydoc, NEEDLE);

    // Wait for the ungated one to LAND before judging the gated one. Polling
    // both against the same clock is what stops "not there yet" from reading
    // as "refused".
    const ungatedDisk = await serverText(offFile, NEEDLE, true);
    const gatedDisk = await serverText(onFile, NEEDLE, false);
    gated.close();
    ungated.close();

    // The control first: the identical edit over the identical code path DOES
    // reach disk with the flag off, so the refusal below is about the gate
    // and not about a sync handshake that never worked.
    expect(ungatedDisk).toContain(NEEDLE);
    expect(gatedDisk).not.toContain(NEEDLE);
  });

  it("accepts a signed browser's edits", async () => {
    const b = boot(true);
    const file = await bindDoc(b, 'signed-ws-doc');
    const cookie = await signIn(b.base, 'editor@example.com');
    const c = connectDoc(`${b.wsBase}/y/signed-ws-doc`, { asBrowser: b.base, cookie });
    await c.ready;
    for (let i = 0; i < 50 && prose.getProseFragment(c.ydoc).length < 2; i++) await Bun.sleep(20);
    typeParagraph(c.ydoc, SIGNED_NEEDLE);
    const disk = await serverText(file, SIGNED_NEEDLE, true);
    c.close();
    expect(disk).toContain(SIGNED_NEEDLE);
  });

  it("accepts an agent's edits — no Origin, no session", async () => {
    const b = boot(true);
    const file = await bindDoc(b, 'agent-ws-doc');
    const c = connectDoc(`${b.wsBase}/y/agent-ws-doc`, { asBrowser: null });
    await c.ready;
    for (let i = 0; i < 50 && prose.getProseFragment(c.ydoc).length < 2; i++) await Bun.sleep(20);
    typeParagraph(c.ydoc, AGENT_NEEDLE);
    const disk = await serverText(file, AGENT_NEEDLE, true);
    c.close();
    expect(disk).toContain(AGENT_NEEDLE);
  });
});
