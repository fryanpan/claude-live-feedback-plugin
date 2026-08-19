#!/usr/bin/env bun
/**
 * Bundle packages/mcp/src/mcp.ts into a self-contained `mcp.js` that
 * can run under plain Node. Dependencies (@modelcontextprotocol/sdk)
 * are bundled in; runtime has zero external node_modules after install.
 *
 * Two output locations:
 *
 *   packages/mcp/dist/mcp.js           — canonical build artifact, the
 *                                        `bin` target of the published
 *                                        npm package (`claude-workspaces-mcp`).
 *
 *   packages/plugin/mcp/index.js       — vendored copy bundled INTO the
 *                                        plugin tree so `.mcp.json` can
 *                                        invoke it via a relative path
 *                                        without depending on a global
 *                                        symlink. Solves #52: no more
 *                                        `npm link` step in the install
 *                                        path, no more "Failed to
 *                                        reconnect" after `bun install`
 *                                        wipes the symlink.
 *
 * Usage:  bun run packages/mcp/scripts/build.ts
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const srcEntry = join(pkgRoot, 'src', 'mcp.ts');

const distOutFile = join(pkgRoot, 'dist', 'mcp.js');
const pluginOutFile = join(repoRoot, 'packages', 'plugin', 'mcp', 'index.js');

mkdirSync(dirname(distOutFile), { recursive: true });
mkdirSync(dirname(pluginOutFile), { recursive: true });

const result = await Bun.build({
  entrypoints: [srcEntry],
  target: 'node',
  format: 'esm',
  minify: false,
});

if (!result.success || result.outputs.length === 0) {
  console.error(result.logs.join('\n'));
  throw new Error('mcp build failed');
}
const out = result.outputs[0];
if (!out) throw new Error('mcp build produced no output');
const code = await out.text();

// Re-prepend the shebang (Bun.build strips the one in source because it's a
// source-comment). Needed so the file can be exec'd directly.
const finalCode = `#!/usr/bin/env node\n${code.replace(/^#!.*\n/, '')}`;

for (const target of [distOutFile, pluginOutFile]) {
  await Bun.write(target, finalCode);
  chmodSync(target, 0o755);
  console.log(`[mcp] built → ${target}`);
}
