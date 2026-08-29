/**
 * The process half shared by the two note hooks: stdin, the discovery file,
 * the one-time shape marker, stderr. Everything decided is in
 * `./agent-notes.ts`; this file only wires the process to it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type NoteKind, runHook } from './agent-notes.ts';

/** The server publishes its live port here at boot; the MCP child reads
 *  the same file (newest name first). Spelled here because the installed
 *  plugin cannot import `@feedback/core`. */
const DISCOVERY_DIRS = ['claude-workspaces', 'live-feedback'];

function discoveryPort(): number | undefined {
  for (const dir of DISCOVERY_DIRS) {
    const path = join(homedir(), '.claude', dir, 'server.json');
    if (!existsSync(path)) continue;
    const j = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown };
    if (typeof j.port === 'number') return j.port;
  }
  return undefined;
}

/** A marker per hook so the live payload's key names are logged once per
 *  machine, not once per turn. Best effort: an unwritable marker means the
 *  line repeats, which is noise, not harm. */
function shapeSeen(kind: NoteKind): boolean {
  try {
    const dir = join(homedir(), '.claude', DISCOVERY_DIRS[0]);
    const marker = join(dir, `hook-shape-${kind}.seen`);
    if (existsSync(marker)) return true;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);
    return false;
  } catch {
    return true;
  }
}

export async function hookMain(kind: NoteKind): Promise<never> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
    await runHook(kind, Buffer.concat(chunks).toString('utf8'), {
      env: process.env,
      discoveryPort,
      shapeSeen,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch {
    // fail open
  }
  process.exit(0);
}
