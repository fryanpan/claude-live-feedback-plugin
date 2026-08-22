import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * These tests drive scripts/launchd/bootstrap-retry.sh against a stub
 * launchctl. They deliberately do NOT run install.sh end to end: that script
 * looks for a listener on :8787 and kills it, and on this machine that is
 * production. Extracting the two functions into a sourceable file is what
 * makes them reachable without going near real launchd.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'bootstrap-retry.sh');
const INSTALL = join(HERE, 'install.sh');
const INSTALL_TRIAGE = join(HERE, 'install-triage.sh');

const DOMAIN = 'gui/501';
const PLIST = '/synthetic/LaunchAgents/com.example.synthetic.plist';
const SERVICE = `${DOMAIN}/com.example.synthetic`;

/** Marker printed only if the caller survives the bootstrap step. */
const SURVIVED = 'reached-the-line-after-bootstrap';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootstrap-retry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A synthetic launchctl that fails the first `bootstrapFailures` bootstraps
 * with the real error text from the outage, then succeeds. `printExits`
 * drives wait_for_bootout: launchctl print exits 0 while the service is still
 * listed, non-zero once it is gone, so a list of exit codes is a timeline.
 */
function stubLaunchctl(opts: { bootstrapFailures?: number; printExits?: number[] }): string {
  const path = join(dir, 'launchctl');
  const failures = opts.bootstrapFailures ?? 0;
  const printExits = opts.printExits ?? [1];
  writeFileSync(
    path,
    `#!/usr/bin/env bash
# Synthetic launchctl. Records every invocation, then behaves per the fixture.
echo "$*" >> ${JSON.stringify(join(dir, 'calls.log'))}
count_file="${join(dir, '$1.count')}"
n=$(cat "$count_file" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$count_file"

case "$1" in
  bootstrap)
    if [ "$n" -le ${failures} ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    exit 0
    ;;
  print)
    exits=(${printExits.join(' ')})
    idx=$((n - 1))
    if [ "$idx" -ge "\${#exits[@]}" ]; then idx=$(( \${#exits[@]} - 1 )); fi
    exit "\${exits[$idx]}"
    ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return path;
}

function calls(): string[] {
  try {
    return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function bootstrapCalls(): string[] {
  return calls().filter((c) => c.startsWith('bootstrap '));
}

/**
 * Run a bash snippet with the stub on LAUNCHCTL and the sleeps turned down to
 * milliseconds. Returns the exit status plus both streams rather than
 * throwing, because the failure path is half of what is under test.
 */
function runBash(script: string, launchctl: string) {
  const file = join(dir, 'driver.sh');
  writeFileSync(file, script);
  try {
    const stdout = execFileSync('bash', [file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LAUNCHCTL: launchctl,
        BOOTSTRAP_RETRY_DELAY: '0.02',
        BOOTOUT_SETTLE_DELAY: '0.02',
      },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The new shape: source the lib, call the retrying bootstrap. */
function newShape(): string {
  return `set -euo pipefail
. ${JSON.stringify(LIB)}
bootstrap_with_retry ${JSON.stringify(DOMAIN)} ${JSON.stringify(PLIST)}
echo "${SURVIVED}"
`;
}

/** The shape install.sh had before this change: one bare call under set -e. */
function oldShape(): string {
  return `set -euo pipefail
"\${LAUNCHCTL}" bootstrap ${JSON.stringify(DOMAIN)} ${JSON.stringify(PLIST)}
echo "${SURVIVED}"
`;
}

describe('the regression the retry fixes', () => {
  it('RED: the old bare bootstrap aborts on a single transient failure', () => {
    const stub = stubLaunchctl({ bootstrapFailures: 2 });
    const r = runBash(oldShape(), stub);

    expect(r.status).toBe(5);
    expect(r.stderr).toContain('Bootstrap failed: 5: Input/output error');
    // set -e ended the script with the service already booted out.
    expect(r.stdout).not.toContain(SURVIVED);
    expect(bootstrapCalls()).toHaveLength(1);
  });

  it('positive control: the old shape DOES reach the next line when launchctl works', () => {
    // Without this, the assertion above could pass because the stub is broken
    // in some way that fails everything, rather than because set -e aborted.
    const stub = stubLaunchctl({ bootstrapFailures: 0 });
    const r = runBash(oldShape(), stub);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SURVIVED);
    expect(bootstrapCalls()).toHaveLength(1);
  });

  it('GREEN: the same two failures are absorbed and the install continues', () => {
    const stub = stubLaunchctl({ bootstrapFailures: 2 });
    const r = runBash(newShape(), stub);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SURVIVED);
    expect(bootstrapCalls()).toHaveLength(3);
    expect(r.stdout).toContain('bootstrap attempt 1/5 failed');
    expect(r.stdout).toContain('bootstrap attempt 2/5 failed');
    expect(r.stdout).toContain('bootstrap succeeded on attempt 3');
  });
});

describe('bootstrap_with_retry', () => {
  it('calls launchctl once when the first attempt works', () => {
    const stub = stubLaunchctl({ bootstrapFailures: 0 });
    const r = runBash(newShape(), stub);

    expect(r.status).toBe(0);
    expect(bootstrapCalls()).toEqual([`bootstrap ${DOMAIN} ${PLIST}`]);
    // Nothing to report when nothing went wrong.
    expect(r.stdout).not.toContain('bootstrap attempt');
  });

  it('gives up after 5 attempts and reports the service as down, with the fix', () => {
    const stub = stubLaunchctl({ bootstrapFailures: 99 });
    const r = runBash(newShape(), stub);

    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain(SURVIVED);
    expect(bootstrapCalls()).toHaveLength(5);

    // The point of the message: state, then the exact command to restore it.
    expect(r.stderr).toContain('THE SERVICE IS NOT RUNNING');
    expect(r.stderr).toContain(`${stub} bootstrap ${DOMAIN} ${PLIST}`);
  });

  it('stops retrying the moment an attempt succeeds', () => {
    const stub = stubLaunchctl({ bootstrapFailures: 4 });
    const r = runBash(newShape(), stub);

    expect(r.status).toBe(0);
    expect(bootstrapCalls()).toHaveLength(5);
    expect(r.stdout).toContain('bootstrap succeeded on attempt 5');
  });
});

describe('wait_for_bootout', () => {
  const driver = `set -euo pipefail
. ${JSON.stringify(LIB)}
wait_for_bootout ${JSON.stringify(SERVICE)}
echo "settled"
`;

  it('returns as soon as launchd stops listing the service', () => {
    // Listed for the first two polls, gone on the third.
    const stub = stubLaunchctl({ printExits: [0, 0, 1] });
    const r = runBash(driver, stub);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('settled');
    expect(calls().filter((c) => c.startsWith('print '))).toHaveLength(3);
  });

  it('does not poll at all when the service is already gone', () => {
    const stub = stubLaunchctl({ printExits: [1] });
    const r = runBash(driver, stub);

    expect(r.status).toBe(0);
    expect(calls().filter((c) => c.startsWith('print '))).toHaveLength(1);
  });

  it('warns but still proceeds when the service never clears', () => {
    // Aborting here would leave the machine with the old instance booted out
    // and no new one — the exact state the retry exists to avoid.
    const stub = stubLaunchctl({ printExits: [0] });
    const r = runBash(`BOOTOUT_SETTLE_ATTEMPTS=3\n${driver}`, stub);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('still listed');
    expect(r.stdout).toContain('settled');
    expect(calls().filter((c) => c.startsWith('print '))).toHaveLength(3);
  });
});

describe.each([
  ['install.sh', INSTALL],
  ['install-triage.sh', INSTALL_TRIAGE],
])('%s wiring', (_name, file) => {
  // A guard, not a behaviour test: neither installer can be executed here —
  // install.sh kills whatever holds :8787, which on this machine is
  // production. This only proves each one still reaches the tested functions
  // rather than the bare call that caused the outage.
  const source = readFileSync(file, 'utf8');

  it('sources the lib and bootstraps through the retry', () => {
    expect(source).toContain('bootstrap-retry.sh');
    expect(source).toContain('bootstrap_with_retry "${DOMAIN}" "${PLIST_DEST}"');
    expect(source).toContain('wait_for_bootout "${DOMAIN}/${LABEL}"');
  });

  it('has no un-retried launchctl bootstrap left', () => {
    expect(source).not.toMatch(/^\s*(launchctl|"\$\{LAUNCHCTL\}")\s+bootstrap\b/m);
  });
});
