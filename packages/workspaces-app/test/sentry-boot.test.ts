import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser's Sentry entry, exercised rather than pattern-matched.
 *
 * `/app/sentry.js` is the only place any page loads the SDK — board, doc,
 * mockup, landing — so what it reads off the shell and what it hands
 * `Sentry.init` is the whole contract behind "compare load times across page
 * types". The SDK is mocked; everything else (the meta tags, the module's own
 * gate, the scrub it installs) is the real code path.
 *
 * The unconfigured case is asserted with a positive control: the same
 * `init` spy must fire when a DSN IS present, otherwise "init was not called"
 * is satisfied by a module that never ran at all.
 */
const init = vi.fn();
const browserTracingIntegration = vi.fn(() => ({ name: 'BrowserTracing' }));

vi.mock('@sentry/browser', () => ({
  init,
  browserTracingIntegration,
  setMeasurement: vi.fn(),
}));

type InitOptions = {
  dsn: string;
  release?: string;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  initialScope: { tags: Record<string, string> };
  beforeSend: (e: unknown) => unknown;
  beforeSendTransaction: (e: unknown) => unknown;
};

function shell(tags: Record<string, string>): void {
  document.head.innerHTML = Object.entries(tags)
    .map(([name, content]) => `<meta name="${name}" content="${content}">`)
    .join('');
}

async function boot(): Promise<void> {
  vi.resetModules();
  await import('../src/sentry-boot.ts');
}

const DSN = 'https://examplekey@o0.ingest.sentry.io/0';

/** A short synthetic workspace id — route templates match on POSITION, so
 *  nothing here needs a realistic-length one. */
const WS_ID = 'w-abc123';

describe('the page Sentry entry', () => {
  beforeEach(() => {
    init.mockClear();
    document.head.innerHTML = '';
    // Removed, not set to undefined: the next test must see a page where the
    // module never ran, which is the state an unconfigured box is in.
    Reflect.deleteProperty(window, '__cwSentry');
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('does nothing at all when the shell names no DSN', async () => {
    shell({ 'sentry-page-type': 'doc' });
    await boot();
    expect(init).not.toHaveBeenCalled();
    expect((window as unknown as Record<string, unknown>).__cwSentry).toBeUndefined();
  });

  it('inits once when the shell names a DSN (the control for the case above)', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    expect(init).toHaveBeenCalledTimes(1);
    expect((init.mock.calls[0]?.[0] as InitOptions).dsn).toBe(DSN);
    expect((window as unknown as Record<string, unknown>).__cwSentry).toBeDefined();
  });

  it.each(['board', 'doc', 'mockup', 'landing'])(
    'tags the page type the shell named: %s',
    async (pageType) => {
      shell({ 'sentry-dsn': DSN, 'sentry-page-type': pageType });
      await boot();
      expect((init.mock.calls[0]?.[0] as InitOptions).initialScope.tags.page_type).toBe(pageType);
    },
  );

  it('tags an unnamed page type rather than omitting it', async () => {
    // A page that fell through the shell wiring must show up IN the same
    // group-by as the four real types, not be absent from it.
    shell({ 'sentry-dsn': DSN });
    await boot();
    expect((init.mock.calls[0]?.[0] as InitOptions).initialScope.tags.page_type).toBe('unknown');
  });

  it('names the deploy as the release, and keeps the build id as a tag', async () => {
    shell({
      'sentry-dsn': DSN,
      'sentry-page-type': 'board',
      'sentry-release': 'v0.1.0-33-gdec854b',
    });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    // The release is the DEPLOY, not the bundle hash — that is what lets a
    // regression be attributed to the deploy it arrived with.
    expect(opts.release).toBe('v0.1.0-33-gdec854b');
    expect(opts.initialScope.tags.build_id).toBeTruthy();
  });

  it('omits the release rather than guessing when the shell names none', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'board' });
    await boot();
    expect((init.mock.calls[0]?.[0] as InitOptions).release).toBeUndefined();
  });

  it('scrubs every event and every transaction on the way out', async () => {
    shell({ 'sentry-dsn': DSN, 'sentry-page-type': 'doc' });
    await boot();
    const opts = init.mock.calls[0]?.[0] as InitOptions;
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(1);
    const needle = 'quarterly-comp-review.md';
    for (const hook of [opts.beforeSend, opts.beforeSendTransaction]) {
      const event = {
        transaction: `/workspaces/${WS_ID}/docs/${needle}`,
        request: { url: `https://example.test/review/${needle}` },
      };
      expect(JSON.stringify(event)).toContain(needle); // the needle IS there
      expect(JSON.stringify(hook(event))).not.toContain(needle);
    }
  });
});

/**
 * Two invariants a unit test cannot see, because they are about what ends up
 * in a BUNDLE rather than what a function returns. Source pins, deliberately
 * — and each names the failure it is standing in for.
 */
describe('the page bundles stay out of the SDK', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const hubSrc = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');
  const appSrc = readFileSync(join(__dirname, '..', 'src', 'app.ts'), 'utf8');

  it('neither entry imports @sentry/browser', () => {
    // `app.ts` builds with splitting OFF, so an import here — static or
    // dynamic — lands the whole SDK in the file every doc load fetches,
    // configured or not. `hub.js` used to carry it as a chunk; now nothing
    // but sentry.js references the SDK at all.
    expect(hubSrc).not.toContain('@sentry/browser');
    expect(appSrc).not.toContain('@sentry/browser');
  });

  it('the board still feeds its load phases into the pageload trace', () => {
    // The built-in load recorder and Sentry have to tell one story: the same
    // msToBoot / msToFirstProjection the report posts land as measurements.
    expect(hubSrc).toMatch(/setMeasurement\('ms_to_boot'/);
    expect(hubSrc).toMatch(/setMeasurement\('ms_to_first_projection'/);
    expect(hubSrc).toContain('pageSentry()');
  });
});
