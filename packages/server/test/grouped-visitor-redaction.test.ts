/**
 * `/grouped` is the diff review's default sidebar, and it was the one review
 * nav route on the share-visitor allowlist that never redacted.
 *
 * `docSubrouteAllowed` admits `tree`, `grouped`, `threads` and `files` for a
 * visitor. `/tree` and `/files` pass their payload through
 * `redactWorkspaceTreeForVisitor` / `redactWorkspaceFilesForVisitor`;
 * `/grouped` returned `listGroupedDiff` verbatim. Every file node in it
 * carries the same absolute `reviewUrl` the other two build — the tailnet
 * hostname and port, plus the workspace id of whichever board holds the doc
 * first, which need not be the board the visitor was shared.
 *
 * Every assertion is an absence, so each is paired with the owner's own copy
 * of the same route, which must still CONTAIN the field — otherwise "the
 * visitor doesn't see the hostname" would pass on a route returning nothing.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('a share visitor’s /grouped leaks no hostname and no other board', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let boardId: string;
  let reviewId: string;
  let cookie: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const visitor = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `${SHARE_COOKIE}=${cookie}`,
      },
    });

  /** Every absolute http(s) host appearing anywhere in a JSON payload. */
  const hostsIn = (raw: string): string[] => [
    ...new Set([...raw.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1] as string)),
  ];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'grouped-redact-data-'));
    repo = mkdtempSync(join(tmpdir(), 'grouped-redact-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'alpha.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'beta.ts'), 'export const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'alpha.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'beta.ts'), 'export const b = 2;\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    boardId = (
      (await local('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: 'Grouped board' }),
      }).then((r) => r.json())) as { workspace: { id: string } }
    ).workspace.id;
    expect(boardId).toBeTruthy();

    const diff = (await local('/api/diffs', {
      method: 'POST',
      body: JSON.stringify({ repo, base: repoBase, hubWorkspaceId: boardId }),
    }).then((r) => r.json())) as { reviewId: string };
    reviewId = diff.reviewId;
    expect(reviewId).toBeTruthy();

    const share = (await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    }).then((r) => r.json())) as { share: { url: string } };
    const u = new URL(share.share.url);
    const redeemed = await fetch(`${base}${u.pathname}${u.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
    });
    expect(redeemed.status).toBe(302);
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('CONTROL: the owner’s /grouped carries an absolute reviewUrl with a host', async () => {
    // The host is whatever `publicHost()` resolves on the machine running
    // this — a tailnet name in prod. The assertion is the SHAPE, because the
    // name is the very thing that must not be written down anywhere.
    const raw = await local(`/api/workspaces/${reviewId}/grouped`).then((r) => r.text());
    expect(raw).toContain('alpha.ts'); // the payload really has file nodes
    expect(hostsIn(raw).length).toBeGreaterThan(0);
  });

  it('CONTROL: the visitor really reaches /grouped, with the same files', async () => {
    const r = await visitor(`/api/workspaces/${reviewId}/grouped`);
    expect(r.status).toBe(200);
    const raw = await r.text();
    // Nothing below can be a vacuous pass on an empty or refused body.
    expect(raw).toContain('alpha.ts');
    expect(raw).toContain('beta.ts');
  });

  it('the visitor’s /grouped exposes no hostname at all', async () => {
    const raw = await visitor(`/api/workspaces/${reviewId}/grouped`).then((r) => r.text());
    expect(hostsIn(raw)).toEqual([]);
    // The two shapes a tailnet / LAN name arrives in, independently of the
    // host-extracting regex above.
    expect(raw).not.toContain('.ts.net');
    expect(raw).not.toContain('.local:');
  });

  it('every reviewUrl stays usable, relative, and under the board actually shared', async () => {
    const raw = await visitor(`/api/workspaces/${reviewId}/grouped`).then((r) => r.text());
    const urls = [...raw.matchAll(/"reviewUrl":"([^"]+)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0); // control: there ARE reviewUrls
    for (const u of urls) {
      expect(u.startsWith(`/workspaces/${boardId}/`), u).toBe(true);
    }
  });

  it('the owner’s copy is untouched — this redaction is the visitor’s alone', async () => {
    const raw = await local(`/api/workspaces/${reviewId}/grouped`).then((r) => r.text());
    const urls = [...raw.matchAll(/"reviewUrl":"([^"]+)"/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('http')).toBe(true);
  });
});
