import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * A shim that is missing an export does not fail to build — it ships
 * `undefined` into the middle of somebody else's library and surfaces as a
 * runtime TypeError on a host page, months later, in a stack frame nobody
 * recognises. Since the widget stands two lib0 modules in for the real ones to
 * stay under its bundle budget, the build compares the two export lists and
 * refuses to produce a bundle when they diverge.
 *
 * Direction matters. An export the REAL module has and the shim lacks is the
 * dangerous one and fails the build; the reverse is harmless.
 *
 * The subtlety is WHICH file counts as the real module. `require.resolve`
 * follows the `require` condition and lands on lib0's CommonJS build, whose
 * source declares no `export` statements at all — so the comparison passed
 * against an empty set, for every shim, silently. The widget is bundled for
 * the browser as ESM, so this resolves the same way the bundler does and
 * refuses to compare against a file it read no exports from.
 */

/** The conditions `Bun.build({ target: 'browser', format: 'esm' })` honours. */
const CONDITIONS = ['browser', 'module', 'import', 'default'];

/** Walk a package.json `exports` subpath entry down to a file. */
export function pickCondition(entry: unknown, conditions = CONDITIONS): string | undefined {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const map = entry as Record<string, unknown>;
  for (const c of conditions) {
    if (c in map) {
      const hit = pickCondition(map[c], conditions);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Absolute path to the file a browser ESM bundler would load for `specifier`. */
export function resolveBrowserEsm(specifier: string, fromDir: string): string {
  const [pkg, ...rest] = specifier.startsWith('@')
    ? [specifier.split('/').slice(0, 2).join('/'), ...specifier.split('/').slice(2)]
    : [specifier.split('/')[0], ...specifier.split('/').slice(1)];
  const require = createRequire(join(fromDir, 'noop.js'));
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgDir = dirname(pkgJsonPath);
  const manifest = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  const subpath = rest.length ? `./${rest.join('/')}` : '.';
  const entry = manifest.exports?.[subpath];
  if (entry === undefined) {
    throw new Error(`shim guard: ${pkg} does not export ${subpath}`);
  }
  const rel = pickCondition(entry);
  if (!rel) {
    throw new Error(
      `shim guard: no browser/ESM condition for ${specifier}; exports entry is ${JSON.stringify(entry)}`,
    );
  }
  return join(pkgDir, rel);
}

/** Export names declared by an ES module's source text. */
export function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /^export\s+(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(m[1]);
  }
  // `export { A, B as C } from './x.js'` and bare `export { A, B }`
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.split(/\bas\b/)[1] ?? part;
      const name = alias.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Throws when `shimPath` does not cover everything `specifier` exports. */
export function assertShimCovers(specifier: string, shimPath: string, fromDir: string): void {
  let realPath: string;
  try {
    realPath = resolveBrowserEsm(specifier, fromDir);
  } catch (err) {
    throw new Error(
      `shim guard: cannot resolve ${specifier} to check ${shimPath} against ` +
        `(${(err as Error).message}). Run bun install, or drop the shim if the dependency is gone.`,
    );
  }
  const real = exportedNames(readFileSync(realPath, 'utf8'));
  // Zero exports means the reader failed or this is not the ES source — and a
  // comparison against an empty set passes for every shim. That is the one way
  // this guard could look green while checking nothing, so it is an error.
  if (real.size === 0) {
    throw new Error(
      `shim guard: read no exports from ${realPath}. The export reader is broken or that is ` +
        `not the ES source; the comparison against ${shimPath} would have passed vacuously.`,
    );
  }
  const shim = exportedNames(readFileSync(shimPath, 'utf8'));
  const missing = [...real].filter((n) => !shim.has(n)).sort();
  if (missing.length) {
    throw new Error(
      `shim guard: ${shimPath} is missing ${missing.length} export(s) that ${specifier} declares: ` +
        `${missing.join(', ')}. Add them to the shim (a no-op is fine when nothing calls them) ` +
        'or stop shimming the module — shipping it short puts `undefined` inside lib0.',
    );
  }
}
