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
 * binary, TWO server processes and six full page renders. That is the expensive
 * kind of job, and the regressions it catches are the kind that can wait a day.
 * The stylesheet-reading tests in packages/workspaces-app/test stay on every
 * PR; this does not replace them, it stands behind them with a layout engine.
 *
 * THE SERVER POSTURES IT MEASURES — BOTH OF THEM, one server each.
 * `CW_REQUIRE_SIGNIN_TO_WRITE=0` is what a signed-in person sees; `=1` with a
 * browser that has proven nobody is what a reader following a shared link
 * gets, and it inserts `.signin-bar` as a fourth in-flow child of `#shell` and
 * re-declares the shell's track list (`body.signin-gated #shell` in
 * styles.css). This file used to run only the first and say in this paragraph
 * that the second "deserves its own checks" — which was true, and was standing
 * in for a check that did not exist. The signed-out doc then shipped the exact
 * dead band `shell-main-reaches-bottom` is named after while this job was
 * green every night on a page it never rendered.
 *
 * `--port` names the FIRST port; each further posture takes the next one up.
 *
 * Everything it creates — a data dir, a seeded workspace and a sample file per
 * posture, and the server processes — is thrown away on exit, including on a
 * signal, and each posture's server is stopped as soon as its shots are taken.
 * `--keep` leaves the data dirs behind when something needs looking at by hand.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Posture,
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

/**
 * One posture's server, alive for as long as its shots need it.
 *
 * A posture is a SERVER setting (`CW_REQUIRE_SIGNIN_TO_WRITE`), so covering
 * both means two servers rather than two URLs. They run one after the other on
 * two ports with their own data dirs: nothing is shared, and a run that dies
 * part-way leaves neither behind. Sequential rather than concurrent because
 * the expensive part is Chrome, not the servers, and two headless browsers
 * competing on a CI runner is how a render starts timing out.
 */
interface BootedPosture {
  base: string;
  seeded: Seeded;
  stop: () => void;
}

async function bootPosture(posture: Posture, port: number): Promise<BootedPosture> {
  const dataDir = mkdtempSync(join(tmpdir(), `cw-ui-nightly-${posture}-`));
  const base = `http://localhost:${port}`;
  log(`[${posture}] data dir ${dataDir}`);
  log(`[${posture}] booting the server on :${port}`);
  const proc = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages/server/src/bin.ts'),
      '--port',
      String(port),
      '--data-dir',
      dataDir,
    ],
    {
      cwd: repoRoot,
      // The whole difference between the two postures. Everything else is
      // inherited so a runner's PATH and HOME still work.
      env: { ...process.env, CW_REQUIRE_SIGNIN_TO_WRITE: posture === 'signed-out' ? '1' : '0' },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  const stop = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await waitForServer(base, proc);
    const seeded = await seed(base, dataDir);
    log(`[${posture}] seeded workspace ${seeded.workspaceId}, doc ${seeded.docId}`);
    return { base, seeded, stop };
  } catch (e) {
    stop();
    throw e;
  }
}

async function main(): Promise<number> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Registered before anything starts, and emptied as each posture is torn
  // down: a signal arriving mid-boot must find the servers that already exist.
  const running: Array<() => void> = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const stop of running.splice(0)) stop();
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    const readings = new Map<string, ProbeReading | Error>();
    const postures = [...new Set(SHOTS.map((s) => s.posture))];
    for (const [i, posture] of postures.entries()) {
      const port = PORT + i;
      let posted: BootedPosture;
      try {
        posted = await bootPosture(posture, port);
      } catch (e) {
        // A posture that never booted fails ITS shots and lets the other one
        // still report. `judge` turns a missing reading into a failure of every
        // check that wanted it, so nothing is quietly skipped.
        const err = e instanceof Error ? e : new Error(String(e));
        log(`[${posture}] FAILED to boot: ${err.message}`);
        for (const shot of SHOTS.filter((s) => s.posture === posture)) {
          readings.set(shot.id, err);
        }
        continue;
      }
      running.push(posted.stop);
      for (const shot of SHOTS.filter((s) => s.posture === posture)) {
        const url = urlFor(shot, posted.base, posted.seeded);
        const started = Date.now();
        try {
          readings.set(shot.id, await takeShot(shot, url));
          log(`${shot.id} rendered in ${Date.now() - started}ms`);
        } catch (e) {
          readings.set(shot.id, e instanceof Error ? e : new Error(String(e)));
          log(`${shot.id} FAILED after ${Date.now() - started}ms: ${String(e)}`);
        }
      }
      // This posture is done with; free the port and the data dir before the
      // next one boots rather than holding every server to the end of the run.
      posted.stop();
      running.splice(running.indexOf(posted.stop), 1);
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
