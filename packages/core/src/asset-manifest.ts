/**
 * Content-addressed names for the assets an HTML shell loads.
 *
 * The entry bundles used to live at permanent URLs — `/app/app.js`,
 * `/app/hub.js` — and the only thing standing between a tab and last week's
 * code was `Cache-Control: no-cache`, which is a REQUEST to revalidate, not a
 * guarantee. When a browser declined to revalidate (iOS Safari, and a Home
 * Screen web app most of all, which keeps its own cache partition), the tab
 * reloaded straight back onto the bundle it was already running. The stale
 * banner then reappeared on every reload, correctly: the tab really was still
 * old, and reloading it did not change that.
 *
 * A content-addressed name removes the browser from the decision. New bytes
 * get a new URL, and a URL a cache has never seen cannot be answered from it.
 * The shell that names the URL is what must stay fresh — `no-store` — and it
 * is two kilobytes.
 *
 * Node-only (`node:crypto`), and deliberately NOT re-exported from
 * `@feedback/core`'s index: the build script and the server import it, and
 * pulling it into the browser bundle's import graph would be a regression all
 * of its own.
 */
import { createHash } from 'node:crypto';

/** Where the build writes the mapping, inside the markdown-app dist. */
export const ASSET_MANIFEST_FILE = 'asset-manifest.json';

/** Logical name (`app.js`) → the content-addressed name actually emitted. */
export type AssetManifest = Record<string, string>;

/**
 * The assets a shell references BY NAME, and so the ones that must be
 * content-addressed.
 *
 * `sw.js` is deliberately absent. A service worker's URL is its identity —
 * the browser tracks the registration by it and re-fetches that exact path on
 * its own schedule — so hashing its name would orphan every existing
 * registration on every deploy. It is also the one asset browsers already
 * refuse to serve from cache for longer than a day.
 */
export const SHELL_ASSETS = [
  'app.js',
  'hub.js',
  'landing.js',
  'signin.js',
  'sentry.js',
  'styles.css',
  'hub.css',
  'signin.css',
  'tokens.css',
] as const;

/**
 * `app.js` + its bytes → `app-<16 hex>.js`.
 *
 * The extension is preserved because the server picks the content-type off it,
 * and the base name is preserved because a build log, a devtools network tab
 * and a sourcemap all read better with it.
 */
export function hashedAssetName(name: string, bytes: Uint8Array | string): string {
  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `${base}-${hash}${ext}`;
}

/**
 * Does this filename carry a content hash?
 *
 * Decides whether the server may serve it `immutable`, so it has to answer NO
 * for anything whose bytes can change under a fixed name. It matches the
 * bundler's own lazy chunks too (`architecture-YZFGNWBL-rfecyfr5.js`) — those
 * are content-addressed by the same argument and have been all along, they
 * just never got the caching that earns.
 *
 * Sourcemaps end `.js.map` and do not match: they are fetched by devtools on
 * demand and there is nothing to win by pinning them.
 */
const CONTENT_HASHED = /-[0-9a-z]{8,}\.(?:js|css)$/;
export function isContentHashedAsset(name: string): boolean {
  return CONTENT_HASHED.test(name);
}

/**
 * Reads the manifest, answering `{}` for anything that is not one.
 *
 * A missing or malformed manifest must degrade to "use the plain names",
 * which still works — that is the pre-hash behaviour, and it is what a server
 * pointed at a dist from an older build has to fall back to.
 */
export function parseAssetManifest(text: string): AssetManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AssetManifest = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/** The URL a shell should reference for a logical asset name. */
export function assetHref(manifest: AssetManifest, name: string): string {
  return `/app/${manifest[name] ?? name}`;
}

/**
 * Point every `/app/<name>` in an HTML shell at its content-addressed name.
 *
 * The lookahead is load-bearing: without it `/app/app.js` also matches inside
 * `/app/app.js.map`, and the sourcemap URL would be rewritten to a file that
 * was never emitted.
 */
export function rewriteAssetRefs(html: string, manifest: AssetManifest): string {
  let out = html;
  for (const [name, emitted] of Object.entries(manifest)) {
    if (name === emitted) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`/app/${escaped}(?![\\w.-])`, 'g'), `/app/${emitted}`);
  }
  return out;
}
