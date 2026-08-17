/**
 * A failed client build keeps the previous release live — "stale beats down" —
 * but until this, the ONLY record of that decision was a line on stderr in a
 * launchd log nobody reads. A build that keeps failing therefore means an
 * ever-older client against an ever-newer server, silently: reproduced by
 * publishing once, failing twice, and finding nothing whatsoever on disk that
 * remembers it happened.
 *
 * So the publish now leaves two readable traces: provenance INSIDE each
 * release (when it was published, and from which source), and a failure ledger
 * beside the releases (how many attempts in a row have failed, since when,
 * with what error). Everything a surface needs to say "your browser is running
 * a client from N days ago and the build has been failing since X" comes from
 * those two files.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLIENT_STALE_AFTER_MS,
  clientReleaseStatus,
  ledgerTmpPath,
  prepareClientRelease,
  publishClientRelease,
  readPublishLedger,
  readReleaseProvenance,
} from '../src/client-release.ts';

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

/** A build whose markdown-app bundle is missing a file it must have — the
 *  shape of a real half-written build. */
function brokenBuild(marker: string): { dir: string; widget: string; markdownApp: string } {
  const b = fakeBuild(marker);
  rmSync(join(b.markdownApp, 'app.js'));
  return b;
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'lf-releases-'));
}

const HOUR = 60 * 60 * 1000;

describe('release provenance', () => {
  it('records when a release was published and what it was built from', () => {
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      const now = Date.UTC(2026, 7, 14, 9, 0, 0);
      const rel = publishClientRelease({
        root,
        sources: build,
        now: new Date(now),
        sourceRef: 'abc1234',
      });
      const prov = readReleaseProvenance(rel.releaseDir);
      expect(prov?.publishedAt).toBe(now);
      expect(prov?.sourceRef).toBe('abc1234');
      expect(prov?.id).toBe(rel.id);
    } finally {
      for (const d of [root, build.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('records which paths were modified, including ones that did not set -dirty', () => {
    // The suffix alone cannot be judged later. A clean `sourceRef` next to a
    // modified doc has to read as a decision, so the paths ride along — see
    // deploy-source.ts for which of them earn the suffix.
    const root = tmpRoot();
    const build = fakeBuild('gen-dirty');
    try {
      const rel = publishClientRelease({
        root,
        sources: build,
        sourceRef: 'abc1234',
        dirtyPaths: ['docs/product/plans/some-plan.md'],
        dirtyPathCount: 3,
      });
      const prov = readReleaseProvenance(rel.releaseDir);
      expect(prov?.sourceRef).toBe('abc1234');
      expect(prov?.dirtyPaths).toEqual(['docs/product/plans/some-plan.md']);
      expect(prov?.dirtyPathCount).toBe(3);
    } finally {
      for (const d of [root, build.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('dates a release published before provenance existed, from its id', () => {
    // Every release already live on the day this ships has no release.json.
    // Falling back to "age unknown" would make the first failed build after
    // the rollout shout on a client that is in fact minutes old.
    const root = tmpRoot();
    const build = fakeBuild('gen-1');
    try {
      const now = Date.UTC(2026, 7, 14, 9, 0, 0);
      const rel = publishClientRelease({ root, sources: build, now: new Date(now) });
      rmSync(join(rel.releaseDir, 'release.json'));
      expect(readReleaseProvenance(rel.releaseDir)?.publishedAt).toBe(now);
      expect(readReleaseProvenance(rel.releaseDir)?.sourceRef).toBeUndefined();
    } finally {
      for (const d of [root, build.dir]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('the publish ledger', () => {
  it('counts consecutive failures and remembers when they started', () => {
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const first = brokenBuild('gen-2');
    const second = brokenBuild('gen-3');
    try {
      publishClientRelease({ root, sources: good, now: new Date(1000) });
      prepareClientRelease({ root, sources: first, now: 2000 });
      prepareClientRelease({ root, sources: second, now: 3000 });

      const ledger = readPublishLedger(root);
      expect(ledger?.consecutiveFailures).toBe(2);
      expect(ledger?.firstFailureAt).toBe(2000);
      expect(ledger?.lastAttemptAt).toBe(3000);
      expect(ledger?.lastError).toContain('app.js');
    } finally {
      for (const d of [root, good.dir, first.dir, second.dir])
        rmSync(d, { recursive: true, force: true });
    }
  });

  it('resets the streak when a build finally publishes again', () => {
    const root = tmpRoot();
    const broken = brokenBuild('gen-1');
    const good = fakeBuild('gen-2');
    try {
      prepareClientRelease({ root, sources: broken, now: 1000 });
      // Positive control: the streak was real before the good build landed.
      expect(readPublishLedger(root)?.consecutiveFailures).toBe(1);

      const got = prepareClientRelease({ root, sources: good, now: 2000 });
      expect(got.stale).toBe(false);
      const ledger = readPublishLedger(root);
      expect(ledger?.consecutiveFailures).toBe(0);
      expect(ledger?.firstFailureAt).toBeUndefined();
    } finally {
      for (const d of [root, broken.dir, good.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('stages each write under its own name, and leaves nothing behind', () => {
    // Two supervisors can start against the same release root — a launchd
    // respawn overlapping a manual start. A fixed temp name lets one rename
    // commit the other's outcome, which loses a failure or clears a streak
    // that is still live.
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const broken = brokenBuild('gen-2');
    try {
      expect(ledgerTmpPath(root)).not.toBe(ledgerTmpPath(root));
      prepareClientRelease({ root, sources: broken, now: 1000 });
      prepareClientRelease({ root, sources: good, now: 2000 });
      expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('records a build that failed before a publish was even attempted', () => {
    // serve.ts knows the bundler exited non-zero; a dist that LOOKS complete
    // must not be published in that case, and the failure still has to count.
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const looksFine = fakeBuild('gen-2');
    try {
      const first = publishClientRelease({ root, sources: good, now: new Date(1000) });
      const got = prepareClientRelease({
        root,
        sources: looksFine,
        buildError: 'widget build FAILED',
        now: 2000,
      });
      expect(got.stale).toBe(true);
      expect(got.error).toBe('widget build FAILED');
      // The live release is untouched — nothing from the bad build shipped.
      expect(clientReleaseStatus(root, 2000).releaseId).toBe(first.id);
      expect(readPublishLedger(root)?.consecutiveFailures).toBe(1);
    } finally {
      for (const d of [root, good.dir, looksFine.dir]) rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('clientReleaseStatus — what a surface gets to say', () => {
  it('says how old the served client is, and what it was built from', () => {
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const broken = brokenBuild('gen-2');
    try {
      const published = Date.UTC(2026, 7, 10, 12, 0, 0);
      publishClientRelease({
        root,
        sources: good,
        now: new Date(published),
        sourceRef: 'deadbee',
      });
      const failedAt = published + 50 * HOUR;
      prepareClientRelease({ root, sources: broken, now: failedAt });
      prepareClientRelease({ root, sources: broken, now: failedAt + HOUR });

      const now = failedAt + 2 * HOUR;
      const status = clientReleaseStatus(root, now);
      expect(status.stale).toBe(true);
      expect(status.publishedAt).toBe(published);
      expect(status.ageMs).toBe(now - published);
      expect(status.sourceRef).toBe('deadbee');
      expect(status.consecutiveFailures).toBe(2);
      expect(status.failingSince).toBe(failedAt);
      expect(status.lastError).toContain('app.js');
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('says nothing when the last build published', () => {
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    try {
      prepareClientRelease({ root, sources: good, now: 5000 });
      const status = clientReleaseStatus(root, 6000);
      expect(status.stale).toBe(false);
      expect(status.consecutiveFailures).toBe(0);
      // Still reports WHAT is being served — the age is useful either way.
      expect(status.releaseId).not.toBeNull();
      expect(status.ageMs).toBe(1000);
    } finally {
      for (const d of [root, good.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('does not cry wolf on a single transient failure over a fresh client', () => {
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const broken = brokenBuild('gen-2');
    try {
      const published = 10 * HOUR;
      publishClientRelease({ root, sources: good, now: new Date(published) });
      const failedAt = published + 5 * 60_000;
      prepareClientRelease({ root, sources: broken, now: failedAt });

      const status = clientReleaseStatus(root, failedAt + 60_000);
      expect(status.stale).toBe(false);
      // …and it is not silent about the failure, just not alarming about it.
      expect(status.consecutiveFailures).toBe(1);

      // Positive control: a SECOND failed attempt is no longer transient.
      prepareClientRelease({ root, sources: broken, now: failedAt + 120_000 });
      expect(clientReleaseStatus(root, failedAt + 180_000).stale).toBe(true);
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports a single failure once the served client is genuinely old', () => {
    // One failure and no further restarts is the shape that widens quietly:
    // nothing ever attempts again, so a count-only rule would stay silent
    // forever while the gap grows.
    const root = tmpRoot();
    const good = fakeBuild('gen-1');
    const broken = brokenBuild('gen-2');
    try {
      publishClientRelease({ root, sources: good, now: new Date(0) });
      prepareClientRelease({ root, sources: broken, now: 60_000 });
      expect(clientReleaseStatus(root, CLIENT_STALE_AFTER_MS - HOUR).stale).toBe(false);
      expect(clientReleaseStatus(root, CLIENT_STALE_AFTER_MS + HOUR).stale).toBe(true);
    } finally {
      for (const d of [root, good.dir, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports the worst case — a failed build with nothing to fall back on', () => {
    const root = tmpRoot();
    const broken = brokenBuild('gen-1');
    try {
      const got = prepareClientRelease({ root, sources: broken, now: 1000 });
      expect(got.releaseDir).toBeNull();
      const status = clientReleaseStatus(root, 2000);
      expect(status.stale).toBe(true);
      expect(status.releaseId).toBeNull();
      expect(status.ageMs).toBeNull();
    } finally {
      for (const d of [root, broken.dir]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('is quiet about a root that has never published anything', () => {
    // A dev box, or a fresh install. Nothing has failed, so nothing is wrong.
    const root = tmpRoot();
    try {
      expect(existsSync(join(root, 'releases'))).toBe(false);
      const status = clientReleaseStatus(root, 1000);
      expect(status.stale).toBe(false);
      expect(status.releaseId).toBeNull();
      expect(status.consecutiveFailures).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
