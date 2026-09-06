/**
 * Pure logic for `scripts/ui-shot.ts`: flag parsing, viewport presets,
 * Chrome-binary resolution and throwaway-profile naming. Nothing here spawns a
 * process, so the unit tests run on a machine with no Chrome at all.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

$CW_CHROME_ARGS adds extra Chrome launch flags (space separated, each --flag).

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

/**
 * Tell Blink this browser HAS a fine, hover-capable pointer.
 *
 * Chrome answers `(hover:)` and `(pointer:)` from the host's real input
 * devices, so the same page at the same preset reports `hover: hover` on a Mac
 * with a trackpad and `hover: none` on a headless Linux CI runner, which has no
 * pointing device at all. A tool whose media queries depend on whose desk ran
 * it is reporting the desk, not the device — and it is `Emulation`'s blind
 * spot: `setEmulatedMedia` applies `prefers-color-scheme` and ignores these two
 * (measured, 2026-09-05).
 *
 * Setting it does NOT make every shot claim a mouse. Touch emulation still
 * wins on the `--mobile` path, which is the whole reason this can be a
 * constant. Verified both ways on one machine with this flag set:
 * `--preset ipad` → hover true / coarse false, `--preset phone` → hover false /
 * coarse true.
 *
 * The values are Blink's enums: hover none=1 hover=2, pointer none=1 coarse=2
 * fine=4.
 */
export const HOVER_CAPABLE_BLINK_SETTINGS =
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4';

/** Env var carrying extra Chrome flags, space separated. */
export const CHROME_ARGS_ENV = 'CW_CHROME_ARGS';

/**
 * Extra flags to hand Chrome, from `CW_CHROME_ARGS`.
 *
 * It exists for CI containers, where the sandbox has no usable namespace and
 * `/dev/shm` is small — `--no-sandbox --disable-dev-shm-usage` is the standard
 * pair, and both WEAKEN the browser, which is why they are opt-in through the
 * environment rather than baked into the launch. On a person's machine the
 * variable is unset and the sandbox stays on.
 *
 * Only `--flags` are accepted. A bare word in this variable would be handed to
 * Chrome as a URL to open, so a typo becoming a navigation is refused rather
 * than passed along.
 */
export function extraChromeArgs(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env[CHROME_ARGS_ENV] ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(/\s+/);
  const bad = parts.filter((p) => !p.startsWith('--'));
  if (bad.length > 0) {
    throw new UsageError(
      `${CHROME_ARGS_ENV}: every entry must be a --flag; got ${bad
        .map((b) => JSON.stringify(b))
        .join(', ')}`,
    );
  }
  return parts;
}

/**
 * The full Chrome command line for one shot.
 *
 * Pure and exported so the launch line can be ASSERTED rather than eyeballed:
 * a flag this file drops is a behaviour change with no other symptom, and
 * HOVER_CAPABLE_BLINK_SETTINGS in particular is invisible on a machine whose
 * real input devices already agree with the model.
 */
export function chromeLaunchArgs(
  o: Pick<ShotOptions, 'width' | 'height'>,
  profile: string,
  extra: readonly string[] = extraChromeArgs(),
): string[] {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--hide-scrollbars',
    HOVER_CAPABLE_BLINK_SETTINGS,
    `--window-size=${o.width},${o.height}`,
    ...extra,
    'about:blank',
  ];
}

/* ===== Throwaway Chrome profiles ===== */

/** Every throwaway profile lives under the OS temp dir with this prefix. */
export const PROFILE_PREFIX = 'cw-ui-shot-';

/**
 * Env var carrying a run id, which the full name stamps in:
 * `cw-ui-shot-<runId>-<mkdtemp suffix>`. The id is what makes a leftover
 * profile attributable. Without it the only available check is a count of
 * `cw-ui-shot-*`, and a count is wrong in both directions: a profile some
 * other agent leaked yesterday fails a clean run, and a run that starts while
 * yours is finishing hides your own leak.
 */
export const RUN_ID_ENV = 'CW_UI_SHOT_RUN_ID';

/** Past this age, the run that made a profile is long gone. */
export const STALE_PROFILE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Alphanumerics only. The `-` before mkdtemp's random suffix is the boundary
 * of the run id, so an id may not contain one: with `-` allowed, run `ab`
 * would claim run `abc`'s directories as its own leaks.
 */
export function sanitizeRunId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
}

/** The env's run id if it survives sanitizing, else one derived from the pid. */
export function resolveRunId(
  env: Record<string, string | undefined> = process.env,
  pid: number = process.pid,
): string {
  return sanitizeRunId(env[RUN_ID_ENV] ?? '') || `pid${pid}`;
}

/** The `mkdtemp` prefix for one run: `cw-ui-shot-<runId>-`. */
export function profilePrefix(runId: string): string {
  return `${PROFILE_PREFIX}${runId}-`;
}

/** The entries of `names` this run created — never anybody else's. */
export function profilesOfRun(names: readonly string[], runId: string): string[] {
  return names.filter((n) => n.startsWith(profilePrefix(runId)));
}

export interface StaleProfile {
  name: string;
  ageMs: number;
}

/**
 * Profiles in `dir` older than the cutoff, newest last. Injectable readers so
 * the unit tests need no clock tricks; `dir` is scanned, never modified.
 */
export function findStaleProfiles(
  dir: string,
  opts: {
    now?: number;
    maxAgeMs?: number;
    readdir?: (d: string) => string[];
    mtimeMs?: (p: string) => number;
  } = {},
): StaleProfile[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? STALE_PROFILE_AGE_MS;
  const readdir = opts.readdir ?? ((d: string) => readdirSync(d));
  const mtimeMs = opts.mtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  const out: StaleProfile[] = [];
  for (const name of readdir(dir)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    let ageMs: number;
    try {
      ageMs = now - mtimeMs(join(dir, name));
    } catch {
      continue; // removed by its owner mid-scan; not our business either way
    }
    if (ageMs >= maxAgeMs) out.push({ name, ageMs });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * One line per stale profile, by NAME. A count tells whoever reads it nothing
 * they can act on, and this report is deliberately not a delete: a day-old
 * directory can still belong to a session that is still running, on a machine
 * where several agents drive this script at once.
 */
export function describeStaleProfiles(stale: readonly StaleProfile[], dir: string): string {
  if (stale.length === 0) return '';
  const lines = stale.map((s) => `  ${s.name}  ${Math.floor(s.ageMs / 3_600_000)}h old`);
  return [
    `ui-shot: ${stale.length} stale Chrome profile(s) under ${dir}, left by runs that are gone.`,
    'Not deleted — one may belong to a run still going. Remove by name once you have checked:',
    ...lines,
  ].join('\n');
}
