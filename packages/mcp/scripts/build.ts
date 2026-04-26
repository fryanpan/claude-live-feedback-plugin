#!/usr/bin/env bun
/**
 * Bundle packages/mcp/src/mcp.ts into a self-contained dist/mcp.js
 * that can run under plain Node via `npx`. Dependencies (@modelcontextprotocol/sdk)
 * are bundled in; runtime has zero external node_modules after install.
 *
 * Usage:  bun run packages/mcp/scripts/build.ts
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcEntry = join(pkgRoot, 'src', 'mcp.ts');
const outDir = join(pkgRoot, 'dist');
const outFile = join(outDir, 'mcp.js');

mkdirSync(outDir, { recursive: true });

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
// source-comment). Needed so npx can exec the file directly.
await Bun.write(outFile, `#!/usr/bin/env node\n${code.replace(/^#!.*\n/, '')}`);
chmodSync(outFile, 0o755);
console.log(`[mcp] built → ${outFile}`);
