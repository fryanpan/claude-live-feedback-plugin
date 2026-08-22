/**
 * Tests for the open-PR version collector.
 *
 * The collector's whole job is to answer one question for the release gate —
 * "what plugin version does every other open PR declare right now" — and the
 * only interesting behaviour is what it says when it CANNOT answer. A stub
 * `gh` on GH_BIN is what makes that testable: the real one needs a network and
 * a token, and a test that skipped when either was missing would be a test
 * that never ran.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const COLLECTOR = resolve(process.cwd(), 'scripts/collect-open-pr-versions.ts');

const built: string[] = [];

afterEach(() => {
  for (const dir of built.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type StubPr = { number: number; headRefName: string; headRefOid: string };

/**
 * A stand-in `gh` that serves two subcommands from files on disk:
 *   gh pr list …   → prs.json   (or exits 1 when `listFails`)
 *   gh api …?ref=X → manifest-X.json, or a 404 when that file is absent
 */
function stubGh(opts: {
  prs: StubPr[];
  manifests: Record<string, string | undefined>;
  listFails?: boolean;
}): { bin: string; lastPrArgs: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
  built.push(dir);
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/prs.json'), JSON.stringify(opts.prs));
  for (const [ref, version] of Object.entries(opts.manifests)) {
    if (version === undefined) continue;
    writeFileSync(
      join(dir, `data/manifest-${ref}.json`),
      JSON.stringify({ name: 'example-plugin', version }),
    );
  }

  const bin = join(dir, 'gh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `DATA="${join(dir, 'data')}"`,
      'case "$1" in',
      '  pr)',
      '    printf "%s\\n" "$*" > "$DATA/last-pr-args";',
      opts.listFails
        ? '    echo "gh: could not reach github.com" >&2; exit 1;;'
        : '    cat "$DATA/prs.json";;',
      '  api)',
      '    ref=$(printf "%s" "$2" | sed "s/.*ref=//")',
      '    f="$DATA/manifest-$ref.json"',
      '    if [ -f "$f" ]; then cat "$f"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi;;',
      '  *)',
      '    echo "gh stub: unexpected $*" >&2; exit 2;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(bin, 0o755);
  return { bin, lastPrArgs: () => readFileSync(join(dir, 'data/last-pr-args'), 'utf8').trim() };
}

type Payload =
  | { status: 'ok'; prs: { number: number; headRefName: string; version: string | null }[] }
  | { status: 'unavailable'; reason: string };

function run(bin: string, ...args: string[]): { code: number; payload: Payload; err: string } {
  const r = spawnSync('bun', ['run', COLLECTOR, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_BIN: bin },
  });
  let payload: Payload;
  try {
    payload = JSON.parse(r.stdout ?? '');
  } catch {
    throw new Error(`collector did not print JSON.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  return { code: r.status ?? -1, payload, err: r.stderr ?? '' };
}

describe('open-PR version collector', () => {
  it('reports the version every other open PR declares', () => {
    const { bin } = stubGh({
      prs: [
        { number: 176, headRefName: 'feat/one', headRefOid: 'aaa' },
        { number: 178, headRefName: 'feat/two', headRefOid: 'bbb' },
        { number: 180, headRefName: 'feat/self', headRefOid: 'ccc' },
      ],
      manifests: { aaa: '0.1.43', bbb: '0.1.43', ccc: '0.1.44' },
    });

    const { code, payload } = run(bin, '--exclude', '180');
    expect(code).toBe(0);
    expect(payload).toEqual({
      status: 'ok',
      prs: [
        { number: 176, headRefName: 'feat/one', version: '0.1.43' },
        { number: 178, headRefName: 'feat/two', version: '0.1.43' },
      ],
    });
  }, 30_000);

  // An empty `prs` list and a failed lookup are the same JSON shape unless the
  // failure says so, and the gate must not read one as the other: "no other PR
  // claims this number" is the answer that lets a collision merge.
  it('says UNAVAILABLE rather than empty when the PR list cannot be fetched', () => {
    const { bin } = stubGh({ prs: [], manifests: {}, listFails: true });

    const { code, payload } = run(bin, '--exclude', '180');
    expect(code).toBe(0); // a network flake must not go red on an unrelated PR
    expect(payload.status).toBe('unavailable');
    if (payload.status !== 'unavailable') throw new Error('unreachable');
    expect(payload.reason).toContain('could not reach github.com');
  }, 30_000);

  // Distinct from the case above: the list came back, so the answer is usable
  // for every PR whose manifest DID resolve. Only the unreadable one is unknown.
  it('marks one unreadable manifest as null and keeps the rest', () => {
    const { bin } = stubGh({
      prs: [
        { number: 176, headRefName: 'feat/one', headRefOid: 'aaa' },
        { number: 177, headRefName: 'feat/no-manifest', headRefOid: 'zzz' },
      ],
      manifests: { aaa: '0.1.43' },
    });

    const { code, payload } = run(bin, '--exclude', '180');
    expect(code).toBe(0);
    expect(payload.status).toBe('ok');
    if (payload.status !== 'ok') throw new Error('unreachable');
    expect(payload.prs).toEqual([
      { number: 176, headRefName: 'feat/one', version: '0.1.43' },
      { number: 177, headRefName: 'feat/no-manifest', version: null },
    ]);
  }, 30_000);

  // Only PRs merging into the same branch can collide over its version. A
  // stacked PR targets its parent branch and inherits the parent's version, so
  // an unscoped list reads the parent as a collision with its own child.
  it('asks only for PRs targeting the given base branch', () => {
    const stub = stubGh({
      prs: [{ number: 176, headRefName: 'feat/one', headRefOid: 'aaa' }],
      manifests: { aaa: '0.1.43' },
    });

    run(stub.bin, '--exclude', '180', '--base', 'main');
    expect(stub.lastPrArgs()).toContain('--base main');
  }, 30_000);

  it('keeps every PR when nothing is excluded', () => {
    const { bin } = stubGh({
      prs: [{ number: 176, headRefName: 'feat/one', headRefOid: 'aaa' }],
      manifests: { aaa: '0.1.43' },
    });

    const { payload } = run(bin);
    expect(payload.status).toBe('ok');
    if (payload.status !== 'ok') throw new Error('unreachable');
    expect(payload.prs.map((p) => p.number)).toEqual([176]);
  }, 30_000);
});
