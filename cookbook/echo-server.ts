#!/usr/bin/env bun
/**
 * Logs every inbound webhook payload to stdout.
 *
 * Usage:
 *   bun run cookbook/echo-server.ts --port 9001
 *   # then: POST /api/docs {docId, webhookUrl: "http://localhost:9001/"}
 */
const port = Number(Bun.argv[Bun.argv.indexOf('--port') + 1] ?? 9001);

Bun.serve({
  port,
  async fetch(req) {
    if (req.method !== 'POST') return new Response('use POST', { status: 405 });
    const body = await req.json().catch(() => ({ error: 'bad json' }));
    console.log('\n[echo]', new Date().toISOString());
    console.log(JSON.stringify(body, null, 2));
    return new Response('ok');
  },
});

console.log(`[echo-server] listening on http://localhost:${port}`);

export {};
