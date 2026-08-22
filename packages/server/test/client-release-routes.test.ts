/**
 * "The browser is running an old client" reaching a surface a person reads.
 *
 * The unit tests prove the disk traces and the arming rule. They cannot prove
 * the answer survives the trip to a caller, and the trip is where this repo's
 * bugs live: every REST handler hand-copies fields into its payload, so a
 * value can be computed correctly and dropped on the way out (`groups` was
 * accepted, returned ok:true, and discarded exactly that way).
 *
 * It rides the attachments read because the board already makes it — the same
 * read that names which agents are behind on the plugin now also says what the
 * browser itself is running. Nobody has to think to check.
 *
 * Fixtures are synthetic.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClientRelease, publishClientRelease } from '../src/client-release.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

function fakeBuild(marker: string): { dir: string; widget: string; markdownApp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lf-build-'));
  const widget = join(dir, 'widget');
  const markdownApp = join(dir, 'markdown-app');
  mkdirSync(widget, { recursive: true });
  mkdirSync(markdownApp, { recursive: true });
  writeFileSync(join(widget, 'widget.iife.js'), `//${marker}\n`);
  writeFileSync(join(widget, 'widget.esm.js'), `//${marker}\n`);
  writeFileSync(join(markdownApp, 'app.js'), `//${marker}\n`);
  writeFileSync(join(markdownApp, 'index.html'), `<!--${marker}-->\n`);
  // Part of a complete build: a release without them publishes a page whose
  // notifications silently never arrive.
  writeFileSync(join(markdownApp, 'sw.js'), `/*${marker}*/\n`);
  writeFileSync(join(markdownApp, 'manifest.webmanifest'), '{"name":"Claude Workspaces"}\n');
  return { dir, widget, markdownApp };
}

interface ClientReleaseBody {
  clientRelease?: {
    releaseId: string | null;
    publishedAt: number | null;
    ageMs: number | null;
    sourceRef: string | null;
    stale: boolean;
    consecutiveFailures: number;
    failingSince: number | null;
    lastError: string | null;
  };
}

const trash: string[] = [];
let handle: ServerHandle | null = null;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  trash.push(d);
  return d;
}

afterEach(async () => {
  await handle?.stop();
  handle = null;
  while (trash.length > 0) rmSync(trash.pop() as string, { recursive: true, force: true });
});

/** A server plus a workspace to read the strip of. */
async function startWith(
  opts: { clientReleaseRootDir?: string | null; share?: boolean } = {},
): Promise<{ base: string; port: number; workspaceId: string }> {
  const server = createServer({
    port: 0,
    dataDir: tmp('lf-crr-data-'),
    ...(opts.clientReleaseRootDir !== undefined
      ? { clientReleaseRootDir: opts.clientReleaseRootDir }
      : {}),
    ...(opts.share ? { share: { config: { publicHostname: PUBLIC_HOST } } } : {}),
  });
  handle = server;
  const base = `http://localhost:${server.port}`;
  const res = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { host: `localhost:${server.port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'release-hub', goal: 'Ship it.' }),
  });
  const workspaceId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  return { base, port: server.port, workspaceId };
}

function owner(base: string, port: number, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { host: `localhost:${port}` } });
}

describe('client release over the attachments route', () => {
  it('reports a stale client, its age, and why the build failed', async () => {
    const root = tmp('lf-crr-releases-');
    const good = fakeBuild('gen-1');
    trash.push(good.dir);
    const broken = fakeBuild('gen-2');
    trash.push(broken.dir);
    rmSync(join(broken.markdownApp, 'app.js'));

    const published = Date.now() - 3 * 24 * 60 * 60 * 1000;
    publishClientRelease({
      root,
      sources: good,
      now: new Date(published),
      sourceRef: 'c0ffee1',
    });
    prepareClientRelease({ root, sources: broken, now: published + 1000 });
    prepareClientRelease({ root, sources: broken, now: published + 2000 });

    const { base, port, workspaceId } = await startWith({ clientReleaseRootDir: root });
    const body = (await (
      await owner(base, port, `/api/workspaces/${workspaceId}/attachments`)
    ).json()) as ClientReleaseBody;

    expect(body.clientRelease?.stale).toBe(true);
    expect(body.clientRelease?.publishedAt).toBe(published);
    // The signal has to carry the age itself — "stale" alone does not say
    // whether the split is minutes or a week.
    expect(body.clientRelease?.ageMs).toBeGreaterThan(2 * 24 * 60 * 60 * 1000);
    expect(body.clientRelease?.sourceRef).toBe('c0ffee1');
    expect(body.clientRelease?.consecutiveFailures).toBe(2);
    expect(body.clientRelease?.failingSince).toBe(published + 1000);
    expect(body.clientRelease?.lastError).toContain('app.js');
  });

  it('reports a healthy deployment as not stale', async () => {
    const root = tmp('lf-crr-releases-');
    const good = fakeBuild('gen-1');
    trash.push(good.dir);
    prepareClientRelease({ root, sources: good });

    const { base, port, workspaceId } = await startWith({ clientReleaseRootDir: root });
    const body = (await (
      await owner(base, port, `/api/workspaces/${workspaceId}/attachments`)
    ).json()) as ClientReleaseBody;

    expect(body.clientRelease?.stale).toBe(false);
    expect(body.clientRelease?.releaseId).not.toBeNull();
    expect(body.clientRelease?.consecutiveFailures).toBe(0);
  });

  it('says nothing at all when this server did not publish the client it serves', async () => {
    // `bun run dev` and `bun run staging` serve their own checkout's dist and
    // never publish a release — but they share this machine's default release
    // root with prod. Reading it there would report PROD's staleness on a
    // server that is not serving prod's client at all. Only the process that
    // published passes the root, which is the same seam the plugin refresher
    // uses.
    const root = tmp('lf-crr-releases-');
    const good = fakeBuild('gen-1');
    trash.push(good.dir);
    const broken = fakeBuild('gen-2');
    trash.push(broken.dir);
    rmSync(join(broken.markdownApp, 'app.js'));
    publishClientRelease({ root, sources: good, now: new Date(1000) });
    prepareClientRelease({ root, sources: broken, now: 2000 });
    prepareClientRelease({ root, sources: broken, now: 3000 });

    // Positive control: handed the root, this same state DOES report stale.
    const armed = await startWith({ clientReleaseRootDir: root });
    const armedBody = (await (
      await owner(armed.base, armed.port, `/api/workspaces/${armed.workspaceId}/attachments`)
    ).json()) as ClientReleaseBody;
    expect(armedBody.clientRelease?.stale).toBe(true);
    await handle?.stop();
    handle = null;

    const { base, port, workspaceId } = await startWith();
    const body = (await (
      await owner(base, port, `/api/workspaces/${workspaceId}/attachments`)
    ).json()) as ClientReleaseBody;
    expect(body.clientRelease).toBeUndefined();
  });

  it('withholds the deploy state from a share visitor', async () => {
    // `lastError` is a build error from this machine — it carries absolute
    // paths of the host filesystem — and the release id is a fact about the
    // host's deploy rather than workspace content. Same line the endpoint
    // redaction already draws.
    const root = tmp('lf-crr-releases-');
    const good = fakeBuild('gen-1');
    trash.push(good.dir);
    const broken = fakeBuild('gen-2');
    trash.push(broken.dir);
    rmSync(join(broken.markdownApp, 'app.js'));
    publishClientRelease({ root, sources: good, now: new Date(1000) });
    prepareClientRelease({ root, sources: broken, now: 2000 });
    prepareClientRelease({ root, sources: broken, now: 3000 });

    const { base, port, workspaceId } = await startWith({
      clientReleaseRootDir: root,
      share: true,
    });

    // Positive control: the owner's read DOES carry it, so the visitor's
    // absence below is redaction rather than an empty payload.
    const ownerBody = (await (
      await owner(base, port, `/api/workspaces/${workspaceId}/attachments`)
    ).json()) as ClientReleaseBody;
    expect(ownerBody.clientRelease?.stale).toBe(true);

    const share = (await (
      await fetch(`${base}/api/share/link`, {
        method: 'POST',
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
    ).json()) as { share: { slug: string } };
    const redeemed = await fetch(`${base}/s/${share.share.slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
    });
    const cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();

    const raw = await (
      await fetch(`${base}/api/workspaces/${workspaceId}/attachments`, {
        redirect: 'manual',
        headers: {
          host: PUBLIC_HOST,
          'x-forwarded-proto': 'https',
          cookie: `${SHARE_COOKIE}=${cookie}`,
        },
      })
    ).text();
    expect(raw).toContain('attachments');
    expect(raw).not.toContain('clientRelease');
    expect(raw).not.toContain('app.js');
  });
});
