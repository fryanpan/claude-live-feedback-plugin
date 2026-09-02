/**
 * Pure logic for `scripts/ui-shot.ts`: flag parsing, viewport presets and
 * Chrome-binary resolution. Nothing here spawns a process, so the unit tests
 * run on a machine with no Chrome at all.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Named viewports from docs/product/design-mobile.md. */
export const PRESETS: Record<string, { width: number; height: number }> = {
  /** iPad landscape with the keyboard attached — the primary review device. */
  ipad: { width: 1180, height: 820 },
  /** iPhone 16 Pro Max viewport — the phone width this repo verifies at. */
  phone: { width: 430, height: 932 },
};

/**
 * The mobile tier's upper edge (docs/product/design-mobile.md "Breakpoints").
 * At or below it the emulated device reports touch + a mobile viewport, which
 * is what a phone or a portrait iPad does; above it we model a laptop or the
 * landscape iPad, which lay out like desktop.
 */
export const MOBILE_TIER_MAX_WIDTH = 1100;

/** The stock macOS install location, the last fallback. */
export const DEFAULT_CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export interface ShotOptions {
  url: string;
  width: number;
  height: number;
  /** Emulate a touch device (`Emulation.setDeviceMetricsOverride.mobile`). */
  mobile: boolean;
  /** `deviceScaleFactor`; pinned to 1 by default so a pixel is a CSS px. */
  scale: number;
  /** Screenshot destination; omitted when only `eval` is wanted. */
  out?: string;
  /** Capture the full document height instead of the viewport. */
  fullPage: boolean;
  /** CSS selector to poll for before measuring. */
  waitFor?: string;
  /** Quiet time after load (and after `waitFor` resolves) before measuring. */
  settleMs: number;
  /** Hard ceiling for load + waitFor, in ms. */
  timeoutMs: number;
  /** JS expression evaluated in the page; result is printed as JSON. */
  eval?: string;
  /** Explicit Chrome binary (`--chrome`). */
  chrome?: string;
}

export const DEFAULTS = {
  width: PRESETS.ipad.width,
  height: PRESETS.ipad.height,
  scale: 1,
  settleMs: 1000,
  timeoutMs: 15000,
} as const;

export const USAGE = `usage: bun run ui:shot --url <url> [--preset ipad|phone | --size WxH]
                       [--out shot.png] [--eval '<js expression>'] [--eval-file expr.js]
                       [--wait-for '<css selector>'] [--settle <ms>] [--timeout <ms>]
                       [--full-page] [--mobile | --no-mobile] [--scale <n>] [--chrome <bin>]

  --url         page to load (a data: URL works)          required
  --preset      ipad = 1180x820 (default), phone = 430x932
  --size        arbitrary viewport, e.g. 1366x1024 or 430x932
  --out         PNG path; parent directories are created
  --eval        JS expression run in the page; its value is printed as JSON
  --eval-file   same, expression read from a file (for multi-line probes)
  --wait-for    poll until document.querySelector(sel) matches
  --settle      ms of quiet after load / wait-for before measuring (default ${DEFAULTS.settleMs})
  --timeout     ms ceiling for load + wait-for (default ${DEFAULTS.timeoutMs})
  --full-page   capture beyond the viewport (default: the viewport only)
  --mobile      force touch emulation on/off (default: on at width <= ${MOBILE_TIER_MAX_WIDTH})
  --scale       deviceScaleFactor (default ${DEFAULTS.scale})
  --chrome      Chrome binary; else $CW_CHROME_BIN; else the /Applications path

Prints ONE JSON object on stdout: viewport, innerWidth/innerHeight and
devicePixelRatio as the page saw them, the screenshot path, and \`result\`
for --eval. Diagnostics go to stderr. Exit 2 = usage, 1 = runtime failure.`;

export class UsageError extends Error {}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag}: expected a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseSize(raw: string): { width: number; height: number } {
  const m = /^(\d+)[xX×](\d+)$/.exec(raw.trim());
  if (!m) throw new UsageError(`--size: expected WxH (e.g. 430x932), got ${JSON.stringify(raw)}`);
  return { width: positiveInt(m[1], '--size'), height: positiveInt(m[2], '--size') };
}

export function resolvePreset(name: string): { width: number; height: number } {
  const preset = PRESETS[name.trim().toLowerCase()];
  if (!preset) {
    throw new UsageError(
      `--preset: unknown preset ${JSON.stringify(name)}; known: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return preset;
}

/**
 * Parse argv (without the runtime and script path). Throws UsageError on
 * anything malformed so the CLI can print USAGE and exit 2. `readFile` is
 * injected so `--eval-file` can be tested without touching disk.
 */
export function parseArgs(
  argv: readonly string[],
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ShotOptions {
  let url: string | undefined;
  let size: { width: number; height: number } | undefined;
  let preset: string | undefined;
  let mobile: boolean | undefined;
  let scale: number = DEFAULTS.scale;
  let out: string | undefined;
  let fullPage = false;
  let waitFor: string | undefined;
  let settleMs: number = DEFAULTS.settleMs;
  let timeoutMs: number = DEFAULTS.timeoutMs;
  let evalExpr: string | undefined;
  let chrome: string | undefined;

  const takeValue = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('--') && v !== '--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--url':
        url = takeValue(i++, arg);
        break;
      case '--preset':
        preset = takeValue(i++, arg);
        break;
      case '--size':
        size = parseSize(takeValue(i++, arg));
        break;
      case '--out':
        out = takeValue(i++, arg);
        break;
      case '--eval':
        evalExpr = takeValue(i++, arg);
        break;
      case '--eval-file':
        evalExpr = readFile(takeValue(i++, arg));
        break;
      case '--wait-for':
        waitFor = takeValue(i++, arg);
        break;
      case '--settle':
        settleMs = positiveInt(takeValue(i++, arg), arg);
        break;
      case '--timeout':
        timeoutMs = positiveInt(takeValue(i++, arg), arg);
        break;
      case '--scale':
        scale = Number(takeValue(i++, arg));
        if (!Number.isFinite(scale) || scale <= 0) throw new UsageError('--scale: expected > 0');
        break;
      case '--chrome':
        chrome = takeValue(i++, arg);
        break;
      case '--full-page':
        fullPage = true;
        break;
      case '--mobile':
        mobile = true;
        break;
      case '--no-mobile':
        mobile = false;
        break;
      case '--help':
      case '-h':
        throw new UsageError('');
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown flag ${arg}`);
        // One bare positional is the URL, for `ui:shot http://...` ergonomics.
        if (url !== undefined) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
        url = arg;
    }
  }

  if (!url) throw new UsageError('--url is required');
  if (preset !== undefined && size !== undefined) {
    throw new UsageError('--preset and --size are mutually exclusive');
  }
  if (out === undefined && evalExpr === undefined) {
    throw new UsageError('nothing to do: pass --out and/or --eval');
  }
  const { width, height } = size ?? (preset !== undefined ? resolvePreset(preset) : PRESETS.ipad);

  return {
    url,
    width,
    height,
    mobile: mobile ?? width <= MOBILE_TIER_MAX_WIDTH,
    scale,
    out,
    fullPage,
    waitFor,
    settleMs,
    timeoutMs,
    eval: evalExpr,
    chrome,
  };
}

/**
 * Flag, then `CW_CHROME_BIN`, then the stock install path. The first candidate
 * that is SET wins even if it does not exist — a wrong explicit path should
 * fail loudly, not silently fall through to a different browser.
 */
export function resolveChromeBin(
  flag: string | undefined,
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): string {
  const chosen = flag ?? env.CW_CHROME_BIN ?? DEFAULT_CHROME_BIN;
  if (!exists(chosen)) {
    const source = flag ? '--chrome' : env.CW_CHROME_BIN ? 'CW_CHROME_BIN' : 'the default path';
    throw new Error(
      `Chrome binary not found at ${chosen} (from ${source}). ` +
        'Pass --chrome <bin> or set CW_CHROME_BIN.',
    );
  }
  return chosen;
}
