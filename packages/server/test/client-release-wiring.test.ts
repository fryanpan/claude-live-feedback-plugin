import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareClientRelease, publishClientRelease } from '../src/client-release.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

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
  return { dir, widget, markdownApp };
}

/**
 * `prepareClientRelease` is the whole prod decision: publish if the build is
 * good, otherwise keep serving whatever is already live. "Stale beats down."
 */
describe('prepareClientRelease', () => {
  it('publishes a good build and reports it fresh', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-releases-'));
    const build = fakeBuild('gen-1');
    try {
      const got = prepareClientRelease({ root, sources: build });
      expect(got.stale).toBe(false);
      expect(got.markdownApp).toBe(join(got.releaseDir as string, 'markdown-app'));
      expect(got.error).toBeUndefined();
    } finally {
      for (const d of [root, build.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('keeps the live release when the new build is broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-releases-'));
    const good = fakeBuild('gen-1');
    const broken = fakeBuild('gen-2');
    rmSync(join(broken.markdownApp, 'app.js'));
    try {
      const first = publishClientRelease({ root, sources: good });
      const got = prepareClientRelease({ root, sources: broken });
      expect(got.stale).toBe(true);
      expect(got.error).toBeDefined();
      expect(got.releaseDir).toBe(realpathSync(first.releaseDir));
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports nothing serveable when the first ever build is broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-releases-'));
    const broken = fakeBuild('gen-1');
    rmSync(join(broken.widget, 'widget.iife.js'));
    try {
      const got = prepareClientRelease({ root, sources: broken });
      expect(got.releaseDir).toBeNull();
      expect(got.markdownApp).toBeNull();
      expect(got.error).toBeDefined();
    } finally {
      for (const d of [root, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/**
 * The layer nothing type-checks: bin.ts hand-parses argv, so a flag can be
 * declared and silently dropped (this repo has shipped exactly that bug at
 * the REST-route layer). Drive the real entrypoint and read the bytes back
 * over HTTP.
 */
describe('bin.ts --markdown-app-dist / --widget-dist', () => {
  it('serves the release passed on the command line, not the repo dist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-releases-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'lf-data-'));
    const build = fakeBuild('published-release-marker');
    const rel = publishClientRelease({ root, sources: build });
    const port = 9100 + Math.floor(Math.random() * 400);

    const child = spawn(
      'bun',
      [
        'run',
        join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
        '--port',
        String(port),
        '--data-dir',
        dataDir,
        '--markdown-app-dist',
        rel.markdownAppDir,
        '--widget-dist',
        rel.widgetDir,
      ],
      { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, LF_SUMMARIES: '0' } },
    );

    try {
      let appJs: string | null = null;
      let widgetJs: string | null = null;
      for (let i = 0; i < 100 && appJs === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/app/app.js`);
          if (res.ok) {
            appJs = await res.text();
            widgetJs = await (await fetch(`http://127.0.0.1:${port}/widget.iife.js`)).text();
          }
        } catch {}
      }
      // Positive control: the probe reached a server at all. Without this,
      // "the repo bundle wasn't served" would be true of a dead port too.
      expect(appJs).not.toBeNull();
      expect(appJs).toContain('published-release-marker');
      expect(widgetJs).toContain('published-release-marker');
    } finally {
      child.kill('SIGTERM');
      for (const d of [root, dataDir, build.dir]) rmSync(d, { recursive: true, force: true });
    }
  }, 20_000);
});
