/**
 * `GET /api/workspaces/<id>` answers a share visitor with a PROJECTION.
 *
 * The route is on the share allowlist, documented there as "workspace name +
 * goal text", and it used to return the stored `HubWorkspace` verbatim. That
 * record is partly a description of the HOST: `notesHome.repoRoot` is an
 * absolute path on this machine, and `retiredBy` carries an actor id that
 * every neighbouring visitor surface strips. A visitor handed one link was
 * handed a filesystem path with it.
 *
 * The assertion is made over the RAW RESPONSE TEXT, not over parsed fields:
 * the leak this pins is "the host path appears in the body at all", and a
 * field-by-field check would pass a payload that carried it somewhere new.
 *
 * The positive control is the same route on the LOCAL surface, which must
 * still carry the whole record — `notesHome` is what the settings panel
 * edits, so a projection applied to everybody would be a regression rather
 * than a fix.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';
const OWNER = { id: 'known-casey', name: 'Casey', kind: 'person' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe('a share visitor reads a projected workspace, not the stored record', () => {
  let tmp: string;
  let dataDir: string;
  let repoRoot: string;
  let handle: ServerHandle;
  let base: string;
  let workspaceId: string;
  let cookie: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    local(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pub = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` },
    });

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ws-visitor-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    repoRoot = join(tmp, 'planning-repo');
    mkdirSync(repoRoot);
    git(repoRoot, 'init', '-b', 'main');
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
    git(repoRoot, 'add', '.');
    git(repoRoot, 'commit', '-m', 'init');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'search-revamp' });
    expect(ws.status).toBe(200);
    workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    // The two host-describing fields, both set through their real routes so
    // this is the record a live board actually holds.
    expect(
      (
        await put(`/api/workspaces/${workspaceId}/settings`, {
          author: OWNER,
          notesHome: { repoRoot, branch: 'main', dir: 'docs/notes' },
        })
      ).status,
    ).toBe(200);
    // Who moved the cap. `lastChange.actor` is a full `{id, name, kind}`
    // in the store, and this is the third host-describing value the read
    // has to project — the SSE feed already reduces the same actor.
    expect(
      (await put(`/api/workspaces/${workspaceId}/parallelism-cap`, { cap: 2, author: OWNER }))
        .status,
    ).toBe(200);
    expect(
      (
        await put(`/api/workspaces/${workspaceId}/retired`, {
          retired: true,
          author: OWNER,
          reason: 'folded into the new board',
        })
      ).status,
    ).toBe(200);

    const share = await post('/api/share/link', { workspaceId });
    expect(share.status, await share.clone().text()).toBe(200);
    const url = ((await share.json()) as { share: { url: string } }).share.url;
    const u = new URL(url);
    const redeemed = await fetch(`${base}${u.pathname}${u.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeemed.status).toBe(302);
    cookie =
      (redeemed.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1] ?? '';
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('positive control: the LOCAL read still carries the whole record', async () => {
    const res = await local(`/api/workspaces/${workspaceId}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // If this ever stops containing the path, the visitor assertion below is
    // vacuous — it would be proving the absence of something nobody serves.
    expect(text).toContain(repoRoot);
    const body = JSON.parse(text) as {
      workspace: { notesHome?: unknown; retiredBy?: unknown };
      parallelismCap?: { lastChange?: { actor?: unknown } };
    };
    expect(body.workspace.notesHome).toEqual({ repoRoot, branch: 'main', dir: 'docs/notes' });
    expect(body.workspace.retiredBy).toBeTruthy();
    // And the cap's actor keeps its id here — the same positive-control
    // role: without this the visitor assertion below proves nothing.
    expect(body.parallelismCap?.lastChange?.actor).toEqual(OWNER);
  });

  it('the visitor read carries no host path and no actor id', async () => {
    const res = await pub(`/api/workspaces/${workspaceId}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(repoRoot);
    expect(text).not.toContain('notesHome');
    expect(text).not.toContain('retiredBy');
    // The cap's `lastChange.actor` is the one actor left on this payload;
    // a visitor gets the display half only, exactly as `displayActor`
    // gives it to them over SSE.
    expect(text).not.toContain(OWNER.id);
    const body = JSON.parse(text) as {
      workspace: { name: string; goals: unknown[]; id: string; retiredAt?: number };
      parallelismCap?: { value?: number; lastChange?: { actor?: unknown; to?: number } };
    };
    expect(body.parallelismCap?.lastChange?.actor).toEqual({ name: OWNER.name, kind: OWNER.kind });
    // Still a fact with an author and a number — reduced, not blanked.
    expect(body.parallelismCap?.lastChange?.to).toBe(2);
    // …and it still carries what the board client renders, so the projection
    // is a redaction rather than a blanking.
    expect(body.workspace.name).toBe('search-revamp');
    expect(body.workspace.id).toBe(workspaceId);
    expect(Array.isArray(body.workspace.goals)).toBe(true);
    expect(typeof body.workspace.retiredAt).toBe('number');
  });
});
