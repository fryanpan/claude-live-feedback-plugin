#!/usr/bin/env bun
/**
 * Thin share CLI. Calls into the live-feedback server's /api/share REST
 * routes — same path the MCP tools take. The server (started by
 * scripts/serve.ts) owns the actual share state.
 *
 * A WORKSPACE is the unit of sharing (Bryan, 2026-08-17) — there is no
 * `share doc` subcommand, because there is no per-doc share. File the doc on
 * a workspace and share that.
 *
 * Usage:
 *   bun share workspace <workspaceId> --allow-domain @example.com [--allow-domain ...] [--ttl 72h] [--name <slug>]
 *   bun share list
 *   bun share revoke <shareId>
 *
 * Resolution of the server URL matches packages/mcp/src/mcp.ts:
 *   FEEDBACK_BASE_URL → ~/.claude/live-feedback/server.json → fail.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveBaseUrl(): string {
  if (process.env.FEEDBACK_BASE_URL) return process.env.FEEDBACK_BASE_URL;
  const discovery = join(homedir(), '.claude', 'live-feedback', 'server.json');
  if (existsSync(discovery)) {
    try {
      const j = JSON.parse(readFileSync(discovery, 'utf8')) as { port?: number };
      if (j.port) return `http://localhost:${j.port}`;
    } catch {
      // fall through
    }
  }
  throw new Error(
    'live-feedback server not running — start it with `bun run dev` (or set FEEDBACK_BASE_URL).',
  );
}

function parseTtl(s: string): number {
  const m = s.match(/^(\d+)\s*([hms])?$/);
  if (!m) throw new Error(`bad --ttl '${s}' (expected e.g. '72h', '3600s', '120m')`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
}

interface CliArgs {
  positional: string[];
  flags: { allowDomain: string[]; ttl?: number; name?: string };
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const allowDomain: string[] = [];
  let ttl: number | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--allow-domain') {
      const v = argv[++i];
      if (v) allowDomain.push(v);
    } else if (a.startsWith('--allow-domain=')) {
      allowDomain.push(a.slice('--allow-domain='.length));
    } else if (a === '--ttl') {
      ttl = parseTtl(argv[++i] ?? '');
    } else if (a.startsWith('--ttl=')) {
      ttl = parseTtl(a.slice('--ttl='.length));
    } else if (a === '--name') {
      name = argv[++i];
    } else if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { positional, flags: { allowDomain, ttl, name } };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const sub = args.positional[0];
  const base = resolveBaseUrl();

  if (sub === 'doc') {
    usage(
      'per-doc sharing was removed — a workspace is the unit of sharing. File the doc on a workspace and run: bun share workspace <workspaceId> --allow-domain @example.com',
    );
  }

  if (sub === 'workspace') {
    const workspaceId = args.positional[1];
    if (!workspaceId) usage('workspaceId required');
    if (args.flags.allowDomain.length === 0) {
      usage('at least one --allow-domain is required');
    }
    const res = await fetch(`${base}/api/share/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        allowDomains: args.flags.allowDomain,
        ttlSeconds: args.flags.ttl,
        name: args.flags.name,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[share] failed: ${res.status} ${text}`);
      process.exit(1);
    }
    const { share } = JSON.parse(text) as {
      share: { url: string; shareId: string; expiresAt: number; allowDomains: string[] };
    };
    console.log(`[share] ${share.url}`);
    console.log(`[share]   id: ${share.shareId}`);
    console.log(`[share]   allowed: ${share.allowDomains.join(', ')}`);
    console.log(`[share]   expires: ${new Date(share.expiresAt).toISOString()}`);
    console.log('[share] revoke early with: bun share revoke', share.shareId);
    return;
  }

  if (sub === 'list') {
    const res = await fetch(`${base}/api/share`);
    const { shares } = (await res.json()) as {
      shares: { url: string; shareId: string; expiresAt: number }[];
    };
    if (shares.length === 0) {
      console.log('[share] no active shares');
      return;
    }
    for (const s of shares) {
      const left = Math.max(0, Math.floor((s.expiresAt - Date.now()) / 3600 / 1000));
      console.log(`  ${s.shareId}  ${s.url}  (${left}h left)`);
    }
    return;
  }

  if (sub === 'revoke') {
    const shareId = args.positional[1];
    if (!shareId) usage('shareId required');
    const res = await fetch(`${base}/api/share/${encodeURIComponent(shareId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      console.error(`[share] failed: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    console.log(`[share] revoked ${shareId}`);
    return;
  }

  usage();
}

function usage(message?: string): never {
  if (message) console.error(`[share] ${message}\n`);
  console.error(
    [
      'Usage:',
      '  bun share workspace <workspaceId> --allow-domain @example.com [--ttl 72h] [--name <slug>]',
      '  bun share list',
      '  bun share revoke <shareId>',
    ].join('\n'),
  );
  process.exit(1);
}

await main();
