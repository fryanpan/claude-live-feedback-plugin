#!/usr/bin/env bun
/**
 * Headless UI check: load a URL in Chrome at an exact viewport, screenshot it,
 * optionally evaluate a JS probe, print one JSON summary — and never touch a
 * browser window a person is using.
 *
 *   bun run ui:shot --url http://127.0.0.1:8787/ --preset phone --out /tmp/board-430.png
 *   bun run ui:shot --url http://127.0.0.1:8787/ --size 1366x1024 \
 *       --wait-for '#shell' --eval 'document.querySelector("#shell").getBoundingClientRect().toJSON()'
 *
 * Flags (also `--help`):
 *   --url <url>            required; a data: URL works for self-contained probes
 *   --preset ipad|phone    1180x820 (default) or 430x932 — docs/product/design-mobile.md
 *   --size WxH             any viewport instead of a preset
 *   --out <png>            screenshot path; parents are created
 *   --eval <expr>          JS expression evaluated in the page, printed as `result`
 *   --eval-file <path>     the expression from a file (multi-line probes)
 *   --wait-for <selector>  poll until document.querySelector matches
 *   --settle <ms>          quiet time after load / wait-for (default 1000)
 *   --timeout <ms>         ceiling for load + wait-for (default 15000)
 *   --full-page            capture beyond the viewport
 *   --mobile|--no-mobile   touch emulation; default on at width <= 1100 (the mobile tier)
 *   --scale <n>            deviceScaleFactor (default 1)
 *   --chrome <bin>         Chrome binary; else $CW_CHROME_BIN; else the /Applications path
 *
 * Why this exists. Resizing a real Chrome window cannot reach a phone
 * viewport (Chrome floors the window near 500px) and every attempt to drive a
 * real window has landed in the owner's own browser. `--headless=new` with a
 * throwaway `--user-data-dir` under the OS temp dir is a separate browser
 * instance: no shared profile, no shared window, no tab anyone can see.
 * `Emulation.setDeviceMetricsOverride` sets the viewport exactly, so 430 is
 * 430.
 *
 * Two measured failures this script is shaped around:
 *   - devicePixelRatio is pinned (default 1) and REPORTED in the summary. In a
 *     shared browser the same page measured two different scrollbar widths
 *     across runs and the discriminator was zoom (learnings.md "The
 *     scrollbar's width in CSS px depends on browser ZOOM").
 *   - `--hide-scrollbars` is load-bearing: a classic scrollbar eats ~15px of
 *     LAYOUT width (clientWidth 415 at a 430 viewport). iOS uses overlay
 *     scrollbars that take none, so hiding it is what models the device.
 *
 * Cleanup is unconditional: the Chrome process is killed and the profile
 * removed on success, on error, and on SIGINT/SIGTERM.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ShotOptions, USAGE, UsageError, parseArgs, resolveChromeBin } from './ui-shot-lib.ts';

const log = (msg: string) => process.stderr.write(`ui-shot: ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CdpResult = Record<string, unknown>;

/** Minimal CDP client over the page target's WebSocket. */
class Cdp {
  private id = 0;
  private pending = new Map<
    number,
    { resolve: (v: CdpResult) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Array<(params: CdpResult) => void>>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} (code ${m.error.code})`));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not open CDP socket ${url}`));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method: string): Promise<CdpResult> {
    return new Promise((resolve) => {
      const list = this.listeners.get(method) ?? [];
      list.push(resolve);
      this.listeners.set(method, list);
    });
  }

  /** Evaluate in the page; throws on a page-side exception. */
  async evaluate(expression: string): Promise<unknown> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  close() {
    this.ws.close();
  }
}

interface Browser {
  proc: ChildProcess;
  profile: string;
  port: number;
}

/**
 * Port 0 lets Chrome pick a free port and announce it in
 * `<profile>/DevToolsActivePort`; deriving a port from the pid collided once
 * (two widths, same modulus) and two runs attached to each other's browser.
 */
async function launchChrome(bin: string, o: ShotOptions, timeoutMs: number): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'cw-ui-shot-'));
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--hide-scrollbars',
      `--window-size=${o.width},${o.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr?.on('data', (d) => {
    stderr += String(d);
  });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      rmSync(profile, { recursive: true, force: true });
      throw new Error(`Chrome exited with ${proc.exitCode} before CDP came up:\n${stderr.trim()}`);
    }
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return { proc, profile, port };
    }
    await sleep(50);
  }
  proc.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  throw new Error(`CDP never came up within ${timeoutMs}ms:\n${stderr.trim()}`);
}

async function pageSocketUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no page target listed';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {
      lastErr = String(e);
    }
    await sleep(50);
  }
  throw new Error(`no CDP page target on :${port}: ${lastErr}`);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function shoot(o: ShotOptions, cdp: Cdp): Promise<Record<string, unknown>> {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: o.width,
    height: o.height,
    deviceScaleFactor: o.scale,
    mobile: o.mobile,
  });
  if (o.mobile) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

  const started = Date.now();
  const loaded = cdp.once('Page.loadEventFired');
  const nav = await cdp.send('Page.navigate', { url: o.url });
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  await withTimeout(loaded, o.timeoutMs, 'page load');

  if (o.waitFor) {
    const probe = `!!document.querySelector(${JSON.stringify(o.waitFor)})`;
    const deadline = started + o.timeoutMs;
    while (!(await cdp.evaluate(probe))) {
      if (Date.now() > deadline) {
        throw new Error(`--wait-for ${JSON.stringify(o.waitFor)} never matched`);
      }
      await sleep(100);
    }
  }
  await sleep(o.settleMs);

  const summary: Record<string, unknown> = {
    url: o.url,
    viewport: { width: o.width, height: o.height, mobile: o.mobile },
    page: await cdp.evaluate(
      '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, ' +
        'devicePixelRatio: window.devicePixelRatio, clientWidth: document.documentElement.clientWidth, ' +
        'scrollWidth: document.documentElement.scrollWidth, title: document.title })',
    ),
  };

  if (o.eval !== undefined) summary.result = await cdp.evaluate(o.eval);

  if (o.out) {
    const shot = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: o.fullPage,
    })) as { data: string };
    mkdirSync(dirname(o.out), { recursive: true });
    writeFileSync(o.out, Buffer.from(shot.data, 'base64'));
    summary.screenshot = o.out;
  }
  return summary;
}

async function main(argv: string[]): Promise<number> {
  let o: ShotOptions;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message) process.stderr.write(`ui-shot: ${e.message}\n\n`);
      process.stderr.write(`${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  const bin = resolveChromeBin(o.chrome);

  let browser: Browser | undefined;
  let cdp: Cdp | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cdp?.close();
    } catch {}
    if (browser) {
      if (browser.proc.exitCode === null) browser.proc.kill('SIGKILL');
      rmSync(browser.profile, { recursive: true, force: true });
    }
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', cleanup);

  try {
    browser = await launchChrome(bin, o, o.timeoutMs);
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, o.timeoutMs));
    const summary = await shoot(o, cdp);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      log(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
