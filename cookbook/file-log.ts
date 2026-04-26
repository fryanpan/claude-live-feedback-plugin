#!/usr/bin/env bun
/**
 * Appends every inbound webhook payload to a JSONL file.
 *
 * Usage:
 *   bun run cookbook/file-log.ts --port 9002 --file feedback.jsonl
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

function arg(name: string, fallback: string): string {
  const i = Bun.argv.indexOf(`--${name}`);
  return i >= 0 && Bun.argv[i + 1] ? (Bun.argv[i + 1] as string) : fallback;
}

const port = Number(arg('port', '9002'));
const file = arg('file', 'feedback.jsonl');
if (!existsSync(file)) writeFileSync(file, '');

Bun.serve({
  port,
  async fetch(req) {
    if (req.method !== 'POST') return new Response('use POST', { status: 405 });
    const body = await req.text();
    appendFileSync(file, body + '\n');
    return new Response('ok');
  },
});

console.log(`[file-log] listening on http://localhost:${port}, writing to ${file}`);

export {};
