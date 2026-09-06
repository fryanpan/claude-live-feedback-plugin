import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clientReleaseRoot,
  currentClientRelease,
  publishClientRelease,
  resolveClientDists,
} from '../src/client-release.ts';

/**
 * Prod used to serve `packages/workspaces-app/dist` out of the primary checkout,
 * per request. That made "build the bundles" and "deploy to everyone" the same
 * act, and made the served client depend on whichever commit that working tree
 * happened to be sitting on.
 *
 * These cover the replacement: bundles are COPIED into an immutable, numbered
 * release directory outside any working tree, published by rename, and pointed
 * at by a symlink that is swapped by rename. Nothing ever writes into the
 * directory being served.
 */

/** A plausible pair of built bundle dirs. `marker` lands in every file so a
 *  test can tell one generation of the build from the next. */
function fakeBuild(marker: string): { dir: string; widget: string; markdownApp: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cw-build-'));
  const widget = join(dir, 'widget');
  const markdownApp = join(dir, 'workspaces-app');
  mkdirSync(widget, { recursive: true });
  mkdirSync(markdownApp, { recursive: true });
  writeFileSync(join(widget, 'widget.iife.js'), `//${marker}\n`);
  writeFileSync(join(widget, 'widget.esm.js'), `//${marker}\n`);
  writeFileSync(join(markdownApp, 'app.js'), `//${marker}\n`);
  writeFileSync(join(markdownApp, 'board.js'), `//${marker}\n`);
  writeFileSync(join(markdownApp, 'index.html'), `<!--${marker}-->\n`);
  writeFileSync(join(markdownApp, 'styles.css'), `/*${marker}*/\n`);
  writeFileSync(join(markdownApp, 'BUILD_INFO.txt'), `built ${marker}\n`);
  // Part of a complete build: a release without them publishes a page whose
  // notifications silently never arrive.
  writeFileSync(join(markdownApp, 'sw.js'), `/*${marker}*/\n`);
  writeFileSync(join(markdownApp, 'manifest.webmanifest'), '{"name":"Claude Workspaces"}\n');
  return { dir, widget, markdownApp };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cw-releases-'));
}

describe('publishClientRelease', () => {
  it('publishes both bundles into a release the sources do not own', () => {
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      const rel = publishClientRelease({ root, sources: build });

      // audit: not-source — `rel.*Dir` is a tmpdir publishClientRelease just
      // copied into; this catches a publish that creates the release
      // directory without putting the bundles in it.
      expect(readFileSync(join(rel.markdownAppDir, 'app.js'), 'utf8')).toContain('gen-1');
      // audit: not-source — same tmpdir release; catches a publish that copies
      // the app bundle and silently leaves the widget behind.
      expect(readFileSync(join(rel.widgetDir, 'widget.iife.js'), 'utf8')).toContain('gen-1');
      expect(readFileSync(join(rel.markdownAppDir, 'index.html'), 'utf8')).toContain('gen-1');

      // The release is a copy: deleting the build tree leaves it serveable.
      rmSync(build.dir, { recursive: true, force: true });
      expect(existsSync(join(rel.markdownAppDir, 'app.js'))).toBe(true);

      // ...and it lives outside the source tree entirely.
      expect(rel.releaseDir.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(build.dir, { recursive: true, force: true });
    }
  });

  it('never writes a second release into the directory the first one serves', () => {
    // The tearing hazard, stated as a test: publish twice and hold the first
    // release's path across the second publish. If the switchover were a
    // copy-in-place, gen-1's app.js would now read gen-2 (and would have been
    // briefly truncated on the way there).
    const root = tmpRoot();
    const first = fakeBuild('gen-1');
    const second = fakeBuild('gen-2');
    try {
      const a = publishClientRelease({ root, sources: first });
      const b = publishClientRelease({ root, sources: second });

      expect(b.releaseDir).not.toBe(a.releaseDir);
      // audit: not-source — reads the FIRST release's tmpdir after a second
      // publish; catches a switchover that copies in place and rewrites the
      // directory being served.
      expect(readFileSync(join(a.markdownAppDir, 'app.js'), 'utf8')).toContain('gen-1');
      // audit: not-source — the second release's own tmpdir; the control that
      // keeps the line above from passing on a publish that wrote nothing.
      expect(readFileSync(join(b.markdownAppDir, 'app.js'), 'utf8')).toContain('gen-2');
    } finally {
      for (const d of [root, first.dir, second.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('leaves no half-populated directory where a release is expected', () => {
    // Whatever intermediate the copy uses must not be mistakable for a
    // release: after publishing, every entry under releases/ is a complete
    // release. (Staging names are dot-prefixed and renamed into place.)
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      publishClientRelease({ root, sources: build });
      const entries = readdirSync(join(root, 'releases'));
      expect(entries.length).toBe(1);
      for (const e of entries) {
        expect(existsSync(join(root, 'releases', e, 'workspaces-app', 'app.js'))).toBe(true);
        expect(existsSync(join(root, 'releases', e, 'widget', 'widget.iife.js'))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(build.dir, { recursive: true, force: true });
    }
  });

  it('points `current` at the new release, and it is a symlink (swappable by rename)', () => {
    const root = tmpRoot();
    const first = fakeBuild('gen-1');
    const second = fakeBuild('gen-2');
    try {
      const a = publishClientRelease({ root, sources: first });
      const link = join(root, 'current');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(a.releaseDir));

      const b = publishClientRelease({ root, sources: second });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(b.releaseDir));
      // audit: not-source — reads through the tmpdir `current` symlink;
      // catches a swap that repoints the link at a release whose bundles are
      // still the previous generation's.
      expect(readFileSync(join(link, 'workspaces-app', 'app.js'), 'utf8')).toContain('gen-2');
    } finally {
      for (const d of [root, first.dir, second.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses to publish a half-built source, leaving `current` on the last good release', () => {
    // Positive control first: the good publish must actually be visible, or
    // "current still points at gen-1" would prove nothing.
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const broken = fakeBuild('gen-2');
    rmSync(join(broken.markdownApp, 'app.js'));
    try {
      const a = publishClientRelease({ root, sources: good });
      // audit: not-source — the tmpdir release just published; this is the
      // positive control that makes "current still points at gen-1" mean
      // something, so it must read what was served, not repo text.
      expect(readFileSync(join(root, 'current', 'workspaces-app', 'app.js'), 'utf8')).toContain(
        'gen-1',
      );

      expect(() => publishClientRelease({ root, sources: broken })).toThrow(/app\.js/);

      expect(realpathSync(join(root, 'current'))).toBe(realpathSync(a.releaseDir));
      expect(readdirSync(join(root, 'releases')).length).toBe(1);
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('refuses a build with no service worker — the failure that is otherwise silent', () => {
    // A missing app.js is a blank page and gets reported within a minute. A
    // missing sw.js is a page that looks entirely healthy and simply never
    // notifies anyone, which is why it belongs in the same check rather than
    // being left to whoever eventually notices nothing arriving.
    const root = tmpRoot();
    const broken = fakeBuild('gen-1');
    rmSync(join(broken.markdownApp, 'sw.js'));
    try {
      expect(() => publishClientRelease({ root, sources: broken })).toThrow(/sw\.js/);
    } finally {
      for (const d of [root, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('prunes old releases but never the one being served', () => {
    const root = tmpRoot();
    const builds = ['g1', 'g2', 'g3', 'g4', 'g5'].map(fakeBuild);
    try {
      let last = '';
      for (const b of builds) last = publishClientRelease({ root, sources: b, keep: 2 }).releaseDir;
      const entries = readdirSync(join(root, 'releases'));
      expect(entries.length).toBe(2);
      expect(entries).toContain(last.split('/').pop() as string);
      expect(realpathSync(join(root, 'current'))).toBe(realpathSync(last));
      // audit: not-source — the surviving tmpdir release after five publishes
      // with keep:2; catches a prune that keeps the right COUNT of releases
      // while deleting the contents of the one being served.
      expect(readFileSync(join(root, 'current', 'workspaces-app', 'app.js'), 'utf8')).toContain(
        'g5',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const b of builds) rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

describe('currentClientRelease', () => {
  it('is null before anything has been published', () => {
    const root = tmpRoot();
    try {
      expect(currentClientRelease(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves to the real release directory, not the symlink path', () => {
    // The server is handed a resolved path so no request ever races a swap.
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      const rel = publishClientRelease({ root, sources: build });
      const cur = currentClientRelease(root);
      expect(cur).not.toBeNull();
      expect(cur?.releaseDir).toBe(realpathSync(rel.releaseDir));
      expect(cur?.releaseDir.includes('current')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(build.dir, { recursive: true, force: true });
    }
  });
});

describe('resolveClientDists', () => {
  it('prefers an explicit release over the repo working tree', () => {
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      const rel = publishClientRelease({ root, sources: build });
      const got = resolveClientDists({
        widgetDist: rel.widgetDir,
        markdownAppDist: rel.markdownAppDir,
        repoRoot: '/nonexistent-repo',
      });
      expect(got.widget).toBe(rel.widgetDir);
      expect(got.markdownApp).toBe(rel.markdownAppDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(build.dir, { recursive: true, force: true });
    }
  });

  it('falls back to the repo dist dirs when no release is given', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    const w = join(repoRoot, 'packages', 'widget', 'dist');
    const m = join(repoRoot, 'packages', 'workspaces-app', 'dist');
    mkdirSync(w, { recursive: true });
    mkdirSync(m, { recursive: true });
    try {
      const got = resolveClientDists({ repoRoot });
      expect(got.widget).toBe(w);
      expect(got.markdownApp).toBe(m);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('is null for a dist dir that does not exist', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    try {
      expect(resolveClientDists({ repoRoot }).markdownApp).toBeNull();
      expect(
        resolveClientDists({ markdownAppDist: join(repoRoot, 'gone'), repoRoot }).markdownApp,
      ).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('clientReleaseRoot', () => {
  it('honours an explicit override', () => {
    expect(clientReleaseRoot({ CW_CLIENT_ROOT: '/srv/cw-client' }, '/home/u')).toBe(
      '/srv/cw-client',
    );
  });

  it('defaults under the XDG state dir, outside any checkout', () => {
    expect(clientReleaseRoot({}, '/home/u')).toBe('/home/u/.local/state/claude-workspaces/client');
    expect(clientReleaseRoot({ XDG_STATE_HOME: '/var/state' }, '/home/u')).toBe(
      '/var/state/claude-workspaces/client',
    );
  });
});
