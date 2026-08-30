import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  captureServerError,
  flushServerSentry,
  initServerSentry,
  isServerSentryActive,
  resetServerSentryForTest,
  routePatternForSpan,
  scrubEventForPrivacy,
  withRouteSpan,
} from '../src/sentry.ts';

/**
 * Server-side Sentry: today's ask is "observe it, don't trust the `if`
 * statement" — so this points a real DSN at a local capture
 * server we control and asserts on what actually crossed the wire, both
 * when Sentry is unconfigured (must be nothing at all) and when it is
 * (must be a slow-request transaction, a captured error, both stamped with
 * the release, both naming the route pattern — never the raw path).
 */

type CapturedRequest = { path: string; headers: Record<string, string>; text: string };

function startCaptureServer(): {
  dsn: string;
  hits: () => CapturedRequest[];
  stop: () => void;
} {
  const hits: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const buf = await req.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Sentry's transport may or may not gzip the envelope body depending
      // on payload size; detect the gzip magic bytes rather than trusting
      // content-encoding, so this test doesn't quietly stop reading bodies
      // if that changes.
      const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      const text = new TextDecoder().decode(isGzip ? Bun.gunzipSync(bytes) : bytes);
      hits.push({
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        text,
      });
      return new Response('{}', { status: 200 });
    },
  });
  return {
    dsn: `http://examplekey@127.0.0.1:${server.port}/1`,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('routePatternForSpan: default-deny redaction', () => {
  it('keeps known literal route keywords', () => {
    expect(routePatternForSpan('/api/workspaces/w-abc123/tasks')).toBe('/api/workspaces/:id/tasks');
    expect(routePatternForSpan('/api/tasks/t-xyz/transition')).toBe('/api/tasks/:id/transition');
    expect(routePatternForSpan('/y/w-abc123')).toBe('/y/:id');
    expect(routePatternForSpan('/')).toBe('/');
  });

  it('redacts a docId shaped like a bound file path or a task alias — never leaks it', () => {
    // docIds are caller-chosen and can embed a bound file's relative path
    // (binds.ts: `${groupId}:${relPath.replaceAll('/', '~')}`) or a
    // `task:<taskId>` alias (see workspace-board.md). Both must vanish.
    const withFilePath = routePatternForSpan('/api/docs/g1:secret~internal~roadmap.md/content');
    expect(withFilePath).toBe('/api/docs/:id/content');
    expect(withFilePath).not.toContain('secret');
    expect(withFilePath).not.toContain('roadmap');

    const withTaskAlias = routePatternForSpan('/api/docs/task:t-hidden1/threads');
    expect(withTaskAlias).toBe('/api/docs/:id/threads');
    expect(withTaskAlias).not.toContain('hidden1');
  });

  it('redacts an unknown segment anywhere, not just where an id is expected', () => {
    // Default-deny: a route this file doesn't know about degrades to `:id`
    // segments rather than ever emitting free text.
    expect(routePatternForSpan('/some/future/route')).toBe('/:id/:id/:id');
  });
});

describe('scrubEventForPrivacy: a floor beneath withRouteSpan, proven with a negative that can fail', () => {
  // withRouteSpan / routePatternForSpan is the primary defense: it never
  // hands a raw path to Sentry in the first place. scrubEventForPrivacy is
  // the floor underneath it, for whatever withRouteSpan didn't see — a
  // future default integration, or the SDK's own request handling, that
  // attaches a URL somewhere on its own. A scrub test that only ever passes
  // proves nothing (docs/process/learnings.md: "a negative probe needs a
  // positive control") — so each case below first proves the raw fixture
  // DOES contain the secret, then proves the scrub removes it.

  it('the raw fixture actually contains the secret — the check has something to catch', () => {
    const secret = crypto.randomUUID();
    const raw = {
      request: { url: `http://localhost/api/docs/${secret}/content`, cookies: { session: secret } },
      contexts: {
        trace: {
          data: { 'url.full': `http://localhost/${secret}`, 'http.url': `http://x/${secret}` },
        },
      },
      breadcrumbs: [{ category: 'fetch', data: { url: `http://x/${secret}` } }],
    };
    // If this assertion is ever false, the fixture below stopped exercising
    // a real leak and the "scrub removes it" test next to it would pass
    // vacuously — same failure mode as the BunServer discovery that started
    // this whole floor.
    expect(JSON.stringify(raw)).toContain(secret);
  });

  it('scrubEventForPrivacy removes the secret from every url/cookie/referrer-shaped key', () => {
    const secret = crypto.randomUUID();
    const raw = {
      request: { url: `http://localhost/api/docs/${secret}/content`, cookies: { session: secret } },
      contexts: {
        trace: {
          data: { 'url.full': `http://localhost/${secret}`, 'http.url': `http://x/${secret}` },
        },
      },
      breadcrumbs: [
        { category: 'fetch', data: { url: `http://x/${secret}`, referrer: `http://x/${secret}` } },
      ],
    };
    const scrubbed = scrubEventForPrivacy(raw);
    expect(JSON.stringify(scrubbed)).not.toContain(secret);
  });

  it('leaves an unrelated, non-url-keyed field alone — proving the scrub is targeted, not a blanket wipe', () => {
    // The most important negative case: a stack-trace file path is an
    // absolute path into OUR OWN source tree (not user content), and it's
    // exactly the kind of string a blind "starts with /" scrub would have
    // mangled. Keying on the ATTRIBUTE NAME instead of the string shape is
    // what keeps this useful for debugging.
    const raw = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: '/repo/packages/server/src/server.ts', function: 'route' }],
            },
          },
        ],
      },
      tags: { phase: 'ws.message' },
    };
    const scrubbed = scrubEventForPrivacy(raw) as typeof raw;
    expect(scrubbed.exception.values[0].stacktrace.frames[0].filename).toBe(
      '/repo/packages/server/src/server.ts',
    );
    expect(scrubbed.tags.phase).toBe('ws.message');
  });

  it('redacts a minted id inside an exception message — an ordinary VALUE under an ordinary key', () => {
    // The key-targeted pass alone does nothing here: `message` isn't
    // url/cookie/referrer-shaped, so a docId or taskId interpolated into a
    // thrown Error's text (a real, plausible mistake — "doc t-... not
    // found") sailed straight through it. This is exactly the gap
    // MINTED_ID_SHAPE exists to close.
    const secretId = `t-${crypto.randomUUID()}`;
    const raw = { exception: { values: [{ type: 'Error', value: `doc ${secretId} not found` }] } };
    expect(JSON.stringify(raw)).toContain(secretId); // fixture actually leaks first

    const scrubbed = scrubEventForPrivacy(raw) as typeof raw;
    expect(JSON.stringify(scrubbed)).not.toContain(secretId);
    expect(scrubbed.exception.values[0].value).toBe('doc [id] not found');
  });

  it('redacts a minted id inside a span/transaction name — in case anything ever names one by raw path', () => {
    const secretId = `w-${crypto.randomUUID()}`;
    const raw = {
      transaction: `GET /api/workspaces/${secretId}/home`,
      spans: [{ description: secretId }],
    };
    expect(JSON.stringify(raw)).toContain(secretId); // fixture actually leaks first

    const scrubbed = scrubEventForPrivacy(raw) as typeof raw;
    expect(JSON.stringify(scrubbed)).not.toContain(secretId);
    expect(scrubbed.transaction).toBe('GET /api/workspaces/[id]/home');
  });
});

describe('server Sentry: silent with no DSN', () => {
  let capture: ReturnType<typeof startCaptureServer>;

  beforeAll(() => {
    capture = startCaptureServer();
  });

  afterAll(() => {
    capture.stop();
  });

  afterEach(() => {
    resetServerSentryForTest();
  });

  it('never initialized: isServerSentryActive is false', () => {
    expect(isServerSentryActive()).toBe(false);
  });

  it('withRouteSpan and captureServerError run as plain passthroughs and open no socket', async () => {
    const req = new Request('http://localhost/api/workspaces/w-quiet/home');
    const result = await withRouteSpan(req, '/api/workspaces/w-quiet/home', async () => {
      await sleep(10);
      return 'handled';
    });
    expect(result).toBe('handled');

    captureServerError(new Error('should go nowhere — sentry never initialized'));

    // flush is a documented no-op when unconfigured; awaiting it also gives
    // any errant async send a moment to arrive before we check.
    expect(await flushServerSentry(200)).toBe(true);
    await sleep(300);

    expect(capture.hits()).toEqual([]);
  });
});

describe('server Sentry: configured — reaches Sentry end to end', () => {
  let capture: ReturnType<typeof startCaptureServer>;
  // Shaped like a real sourceRef (deploy-source.ts: a short git-describe
  // output, optionally `-dirty`) rather than a minted id — a real release
  // tag is a hex SHA and never matches MINTED_ID_SHAPE's all-lowercase-
  // letters-before-the-dash prefix, so this fixture stays realistic instead
  // of accidentally exercising a collision that production doesn't have.
  const release = 'a822618-dirty';

  beforeAll(async () => {
    capture = startCaptureServer();
    await initServerSentry({ dsn: capture.dsn, release });
  });

  afterAll(async () => {
    await flushServerSentry(2000);
    resetServerSentryForTest();
    capture.stop();
  });

  it('is active once initialized with a DSN', () => {
    expect(isServerSentryActive()).toBe(true);
  });

  it('a deliberately slow request produces a transaction naming the route pattern, stamped with the release', async () => {
    // Generated at runtime, never written anywhere as a literal — Sentry's
    // ContextLines integration attaches source snippets around a stack
    // frame, and a hardcoded "secret" sitting a few lines from a throw would
    // show up via THAT (our own source text), giving a false leak positive
    // that has nothing to do with request data actually escaping. A random
    // id can only appear in the payload if it genuinely flowed through.
    const docId = `w-${crypto.randomUUID()}`;
    const pathname = `/api/docs/${docId}/content`;
    const req = new Request(`http://localhost${pathname}`, { method: 'GET' });
    const response = await withRouteSpan(req, pathname, async () => {
      await sleep(60); // the "deliberately slow" request
      return new Response('ok');
    });
    expect(response.status).toBe(200);

    await flushServerSentry(5000);

    const bodies = capture.hits().map((h) => h.text);
    const joined = bodies.join('\n');
    expect(joined).toContain('GET /api/docs/:id/content');
    expect(joined).toContain(release);
    // The whole point: the raw docId never left the process.
    expect(joined).not.toContain(docId);
  });

  it('a deliberately thrown error is captured with the release stamp and the route pattern', async () => {
    capture.hits().length = 0; // isolate this assertion from the transaction above
    const taskId = `t-${crypto.randomUUID()}`; // see note above: random, not a literal
    const pathname = `/api/tasks/${taskId}/transition`;
    const req = new Request(`http://localhost${pathname}`, { method: 'POST' });
    const thrown = new Error('deliberate test failure — sentry-server.test.ts');
    try {
      await withRouteSpan(req, pathname, async () => {
        throw thrown;
      });
      throw new Error('expected withRouteSpan to rethrow');
    } catch (err) {
      if (err !== thrown) throw err;
      captureServerError(err, { route: routePatternForSpan(pathname), method: req.method });
    }

    await flushServerSentry(5000);

    const bodies = capture.hits().map((h) => h.text);
    const joined = bodies.join('\n');
    expect(joined).toContain('deliberate test failure');
    expect(joined).toContain(release);
    expect(joined).toContain('/api/tasks/:id/transition');
    expect(joined).not.toContain(taskId);
  });

  it("the SDK's own BunServer auto-instrumentation is disabled — a real Bun.serve request produces no second, unredacted transaction", async () => {
    // @sentry/bun's default `BunServer` integration monkey-patches
    // `Bun.serve` itself and names ITS OWN transaction `${method}
    // ${url.pathname}` — the raw path — plus a `url.full` attribute with
    // the full URL. withRouteSpan alone can't prevent that; it has to be
    // disabled in Sentry.init (see sentry.ts). This is the one test in the
    // file that goes through a real `Bun.serve`, so it's the one that would
    // catch a regression here — everything above calls withRouteSpan
    // directly and would stay green even if BunServer leaked a duplicate.
    capture.hits().length = 0;
    const docId = `w-${crypto.randomUUID()}`;
    const testServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        return withRouteSpan(req, pathname, async () => new Response('ok'));
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${testServer.port}/api/docs/${docId}/content`);
      expect(res.status).toBe(200);
    } finally {
      testServer.stop(true);
    }

    await flushServerSentry(5000);

    const bodies = capture.hits().map((h) => h.text);
    const joined = bodies.join('\n');
    // The transaction PAYLOAD itself has its own `"type":"transaction"`
    // field, so counting that substring double-counts every real
    // transaction by one. The envelope ITEM HEADER — a standalone `{"type":
    // "transaction"}` object with no other keys — appears exactly once per
    // transaction sent, so that's what distinguishes "one" from "a
    // duplicate from BunServer".
    const transactionCount = (joined.match(/\{"type":"transaction"\}/g) ?? []).length;
    expect(transactionCount).toBe(1); // not 2 — no duplicate from BunServer
    expect(joined).toContain('GET /api/docs/:id/content');
    expect(joined).not.toContain(docId);
    expect(joined).not.toContain('url.full');
    expect(joined).not.toContain('"url.path"');
  });

  it('the beforeSend/beforeSendTransaction scrub catches a raw URL that withRouteSpan never touched', async () => {
    // Simulates the case the disabled-BunServer fix doesn't cover on its
    // own: some OTHER code path — a future default integration, or a
    // mistake like passing `{ url: req.url }` into extra data instead of
    // the route pattern — attaches a raw URL directly, bypassing
    // withRouteSpan/routePatternForSpan entirely. This only stays green
    // because Sentry.init's beforeSend/beforeSendTransaction run on every
    // outbound payload regardless of source.
    capture.hits().length = 0;
    const secret = crypto.randomUUID();
    const Sentry = await import('@sentry/bun');

    // A raw URL attached to an active span's attributes — the same shape a
    // third-party OTel instrumentation (e.g. an outgoing-fetch integration)
    // would add on its own, with no code in this repo asking for it.
    await Sentry.startSpan({ name: 'GET /api/docs/:id/content', op: 'http.server' }, async () => {
      Sentry.getActiveSpan()?.setAttribute(
        'url.full',
        `http://localhost/api/docs/${secret}/content?user=x`,
      );
    });

    // A raw URL passed as `extra` — the mistake a future call site could
    // make instead of `routePatternForSpan(pathname)`.
    captureServerError(new Error('scrub floor probe'), {
      url: `http://localhost/api/docs/${secret}/content?user=x`,
    });

    await flushServerSentry(5000);

    const joined = capture
      .hits()
      .map((h) => h.text)
      .join('\n');
    expect(joined).not.toContain(secret);
  });

  it('the value-shaped scrub catches a minted id inside an exception message and a span name — not just a url-shaped key', async () => {
    // Team-lead's follow-up: the key-targeted pass finds fields NAMED like a
    // url; it does nothing for an id sitting in an ordinary string value —
    // an exception message ("doc t-... not found"), or a span/transaction
    // name if anything ever names one by raw path instead of
    // routePatternForSpan. This is the end-to-end version of the pure-
    // function tests above, through the real init/beforeSend pipeline.
    capture.hits().length = 0;
    const secretDocId = `t-${crypto.randomUUID()}`;
    const Sentry = await import('@sentry/bun');

    // A raw id in a span NAME — bypassing routePatternForSpan entirely, the
    // way a future direct `Sentry.startSpan({ name: rawPath })` call
    // elsewhere in the codebase could.
    await Sentry.startSpan(
      { name: `GET /api/docs/${secretDocId}/content`, op: 'http.server' },
      async () => {},
    );

    // A raw id in an exception MESSAGE — the plausible mistake team-lead
    // named directly.
    captureServerError(new Error(`doc ${secretDocId} not found`));

    await flushServerSentry(5000);

    const joined = capture
      .hits()
      .map((h) => h.text)
      .join('\n');
    expect(joined).not.toContain(secretDocId);
  });
});
