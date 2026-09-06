#!/usr/bin/env bun
/**
 * The nightly browser run: boot a throwaway server, render the board and a doc
 * in headless Chrome through `ui:shot`, and judge what came back.
 *
 *   bun run ui:nightly [--port 8899] [--out-dir .ui-nightly] [--keep]
 *
 * WHY THIS EXISTS RATHER THAN A WORKFLOW STEP THAT CALLS `ui:shot` DIRECTLY.
 * `ui:shot` renders and reports; it has no notion of a wrong answer, so a
 * workflow that only calls it is green on a page that laid out entirely wrong.
 * The verdicts live in `ui-nightly-lib.ts`, where they are unit tested against
 * recorded payloads — this file is the plumbing that gets a real page in front
 * of them.
 *
 * WHY IT IS NIGHTLY AND NOT A PR GATE (Bryan, 2026-09-05). It wants a Chrome
 * binary, a server process and four full page renders. That is the expensive
 * kind of job, and the regressions it catches are the kind that can wait a day.
 * The stylesheet-reading tests in packages/workspaces-app/test stay on every
 * PR; this does not replace them, it stands behind them with a layout engine.
 *
 * THE SERVER POSTURE IT MEASURES. `CW_REQUIRE_SIGNIN_TO_WRITE=0`, i.e. what a
 * signed-in person sees. The anonymous posture inserts `.signin-bar` as a
 * fourth in-flow child of `#shell` and switches `#shell` to a four-track grid
 * (`body.signin-gated #shell` in styles.css), which is a different layout and
 * deserves its own checks; measuring both in one pass would report one page's
 * bug against the other's expectations.
 *
 * Everything it creates — the data dir, the seeded workspace, the sample file,
 * the server process — is thrown away on exit, including on a signal. `--keep`
 * leaves the data dir behind when something needs looking at by hand.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ProbeReading,
  SHOTS,
  type Shot,
  exitCode,
  formatReport,
  judge,
} from './ui-nightly-lib.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const PROBE = resolve(here, 'ui-nightly-probe.js');

const log = (msg: string) => process.stderr.write(`ui-nightly: ${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.CW_UI_NIGHTLY_PORT ?? '8899'));
const OUT_DIR = resolve(repoRoot, arg('out-dir', '.ui-nightly'));
const KEEP = argv.includes('--keep');

/** How long the server gets to answer its first request. */
const BOOT_TIMEOUT_MS = 60_000;

interface Seeded {
  workspaceId: string;
  docId: string;
}

/** `GET /` answers — which is what "listening" means, not "the pid is alive". */
async function waitForServer(base: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited with ${proc.exitCode} before it listened`);
    }
    try {
      const r = await fetch(base, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`server never answered ${base} within ${BOOT_TIMEOUT_MS}ms`);
}

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${url} → ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * One board and one markdown doc — the two shells this suite renders. A doc is
 * file-backed by design, so the sample lives in the throwaway data dir and dies
 * with it.
 */
async function seed(base: string, dataDir: string): Promise<Seeded> {
  const ws = (await post(`${base}/workspaces`, {
    name: 'Nightly UI check',
    author: { id: 'a-nightly-ui', name: 'Nightly UI', kind: 'agent' },
  })) as { workspace: { id: string } };

  const samplePath = join(dataDir, 'nightly-ui-sample.md');
  writeFileSync(
    samplePath,
    '# Nightly UI check\n\nA short document, so the shell is measured against content that does\nnot fill it — which is the case the grid bug needed.\n',
  );
  const doc = (await post(`${base}/api/docs`, {
    docId: 'nightly-ui-sample',
    type: 'markdown',
    title: 'Nightly UI sample',
    sourceUrl: samplePath,
    hubWorkspaceId: ws.workspace.id,
  })) as { docId: string };

  return { workspaceId: ws.workspace.id, docId: doc.docId };
}

/**
 * `?as=agent` is not decoration: every `ui:shot` run uses a THROWAWAY Chrome
 * profile, so every run is a first arrival, and a first arrival gets the
 * "Who's reviewing?" modal over the whole page — `.board-nav` never renders
 * behind it and the shot times out on its `--wait-for`. A known `?as=` name
 * settles identity without UI (`needsNamePrompt` in packages/core/src/identity.ts),
 * which is the supported way to say "this browser already knows who it is".
 */
function urlFor(shot: Shot, base: string, seeded: Seeded): string {
  const path =
    shot.page === 'board'
      ? `/workspaces/${seeded.workspaceId}`
      : `/workspaces/${seeded.workspaceId}/docs/${seeded.docId}`;
  return `${base}${path}?as=agent`;
}

/**
 * One `ui:shot` run: a PNG on disk and a probe payload back.
 *
 * It shells out to the script rather than importing it, on purpose — the thing
 * this job is supposed to keep working is `bun run ui:shot`, so that is what it
 * runs. A refactor that breaks the CLI should turn this red.
 */
async function takeShot(shot: Shot, url: string): Promise<ProbeReading> {
  const out = join(OUT_DIR, `${shot.id}.png`);
  const proc = Bun.spawn(
    [
      'bun',
      'run',
      resolve(here, 'ui-shot.ts'),
      '--url',
      url,
      '--preset',
      shot.preset,
      '--wait-for',
      shot.waitFor,
      '--eval-file',
      PROBE,
      '--out',
      out,
    ],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ui:shot exited ${code}: ${stderr.trim() || stdout.trim()}`);
  const summary = JSON.parse(stdout) as { result?: ProbeReading };
  if (!summary.result) throw new Error(`ui:shot returned no probe result: ${stdout.slice(0, 400)}`);
  return summary.result;
}

async function main(): Promise<number> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-ui-nightly-'));
  mkdirSync(OUT_DIR, { recursive: true });

  let server: ChildProcess | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (server && server.exitCode === null) server.kill('SIGKILL');
    if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  const base = `http://localhost:${PORT}`;
  log(`data dir ${dataDir}`);
  log(`booting the server on :${PORT}`);
  server = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages/server/src/bin.ts'),
      '--port',
      String(PORT),
      '--data-dir',
      dataDir,
    ],
    {
      cwd: repoRoot,
      // Signed-in posture — see the header. Everything else is inherited so a
      // runner's PATH and HOME still work.
      env: { ...process.env, CW_REQUIRE_SIGNIN_TO_WRITE: '0' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );

  try {
    await waitForServer(base, server);
    const seeded = await seed(base, dataDir);
    log(`seeded workspace ${seeded.workspaceId}, doc ${seeded.docId}`);

    const readings = new Map<string, ProbeReading | Error>();
    for (const shot of SHOTS) {
      const url = urlFor(shot, base, seeded);
      const started = Date.now();
      try {
        readings.set(shot.id, await takeShot(shot, url));
        log(`${shot.id} rendered in ${Date.now() - started}ms`);
      } catch (e) {
        readings.set(shot.id, e instanceof Error ? e : new Error(String(e)));
        log(`${shot.id} FAILED after ${Date.now() - started}ms: ${String(e)}`);
      }
    }

    const verdicts = judge(readings);
    process.stdout.write(`${formatReport(verdicts)}\n`);
    log(`screenshots in ${OUT_DIR}`);
    return exitCode(verdicts);
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
