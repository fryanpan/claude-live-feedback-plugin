/**
 * The 2026-08-29 outage in one sentence: a bind probe that resolved `false`
 * on any error told the supervisor that 50 ports were occupied when in fact
 * the host had run out of network buffers, and the supervisor's response to
 * "occupied" was to throw, which under launchd means relaunch in 10s — 393
 * times, each one re-running two client builds and re-hydrating 5,622 docs.
 *
 * These tests pin the three decisions that failure needed, so none of them
 * can quietly regress: what a bind error means, how long to wait before
 * trying again, and whether moving to a different port is allowed at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  BIND_RETRY_BASE_MS,
  BIND_RETRY_CAP_MS,
  type BindErrorKind,
  acquirePort,
  bindRetryDelayMs,
  classifyBindError,
  probeLocalPort,
  shouldWalkPorts,
} from '../src/port-bind';

function errWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(`listen ${code} 127.0.0.1:8787`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('classifyBindError', () => {
  test('EADDRINUSE is the only "someone else has this port" answer', () => {
    expect(classifyBindError(errWithCode('EADDRINUSE'))).toBe('in-use');
  });

  test('ENOBUFS is a host-resource failure, NOT a busy port', () => {
    // The outage. If this ever returns 'in-use' again, a supervisor will walk
    // 50 ports, "find" none free, and hand launchd a crash loop.
    expect(classifyBindError(errWithCode('ENOBUFS'))).toBe('unavailable');
  });

  test.each(['ENOMEM', 'EADDRNOTAVAIL', 'EMFILE', 'ENFILE', 'EAGAIN', 'ENETDOWN', 'ENETUNREACH'])(
    '%s is unavailable, not in-use',
    (code) => {
      expect(classifyBindError(errWithCode(code))).toBe('unavailable');
    },
  );

  test('an unrecognised failure is fatal rather than silently retried', () => {
    expect(classifyBindError(errWithCode('EPERM'))).toBe('fatal');
    expect(classifyBindError(new Error('something else entirely'))).toBe('fatal');
    expect(classifyBindError(null)).toBe('fatal');
    expect(classifyBindError(undefined)).toBe('fatal');
  });

  test('reads the code out of the message when `code` is unset', () => {
    // Bun.serve does not always populate `.code`, and a code we can plainly
    // read must not be downgraded to `fatal`.
    expect(classifyBindError(new Error('listen EADDRINUSE 127.0.0.1:8787'))).toBe('in-use');
    expect(classifyBindError(new Error('bind failed: ENOBUFS'))).toBe('unavailable');
  });

  test('matches whole tokens, so a lookalike is not mistaken for a code', () => {
    expect(classifyBindError(new Error('EADDRINUSEXX is not a code'))).toBe('fatal');
    expect(classifyBindError(new Error('XENOBUFS'))).toBe('fatal');
  });
});

describe('bindRetryDelayMs', () => {
  test('doubles from the base', () => {
    expect(bindRetryDelayMs(1)).toBe(1_000);
    expect(bindRetryDelayMs(2)).toBe(2_000);
    expect(bindRetryDelayMs(3)).toBe(4_000);
    expect(bindRetryDelayMs(4)).toBe(8_000);
    expect(bindRetryDelayMs(5)).toBe(16_000);
    expect(bindRetryDelayMs(6)).toBe(32_000);
  });

  test('caps at 60s and stays there', () => {
    expect(bindRetryDelayMs(7)).toBe(BIND_RETRY_CAP_MS);
    expect(bindRetryDelayMs(50)).toBe(BIND_RETRY_CAP_MS);
    // The exponent overflows to Infinity here; the cap must still hold.
    expect(bindRetryDelayMs(5_000)).toBe(BIND_RETRY_CAP_MS);
  });

  test('never returns 0 or a negative delay, which would spin the loop', () => {
    for (const attempt of [Number.NaN, Number.NEGATIVE_INFINITY, -10, 0, 1]) {
      expect(bindRetryDelayMs(attempt)).toBe(BIND_RETRY_BASE_MS);
    }
  });

  test('the schedule is strictly slower than launchd relaunching us', () => {
    // ThrottleInterval is 10s. Backing off inside the process is only an
    // improvement if it is cheaper than the thing it replaces, and after the
    // third attempt every wait exceeds a relaunch cycle — without paying for
    // two client builds and a full hydration.
    expect(bindRetryDelayMs(5)).toBeGreaterThan(10_000);
  });
});

describe('shouldWalkPorts', () => {
  test('dev walks: two agents on one machine must not fight over 8787', () => {
    expect(shouldWalkPorts([])).toBe(true);
    expect(shouldWalkPorts(['--port', '8787'])).toBe(true);
  });

  test('--no-watch (what launchd runs) must NEVER walk', () => {
    expect(shouldWalkPorts(['--no-watch'])).toBe(false);
    expect(shouldWalkPorts(['--port', '8787', '--no-watch', '--deploy'])).toBe(false);
  });

  test('--no-port-walk pins the port without implying prod mode', () => {
    expect(shouldWalkPorts(['--no-port-walk'])).toBe(false);
  });
});

describe('acquirePort', () => {
  /** A probe that answers from a script, recording which port it was asked. */
  function scriptedProbe(answers: (BindErrorKind | null)[]) {
    const ports: number[] = [];
    return {
      ports,
      probe: async (port: number) => {
        ports.push(port);
        return answers.shift() ?? null;
      },
    };
  }

  test('returns immediately when the port is free — no sleeping', async () => {
    const slept: number[] = [];
    const { probe } = scriptedProbe([null]);
    const result = await acquirePort({
      port: 8787,
      probe,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.attempts).toBe(1);
    expect(result.waitedMs).toBe(0);
    expect(slept).toEqual([]);
  });

  test('waits on a busy port with the backoff schedule and never changes port', async () => {
    const slept: number[] = [];
    const { probe, ports } = scriptedProbe(['in-use', 'in-use', 'in-use', null]);
    const result = await acquirePort({
      port: 8787,
      probe,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([1_000, 2_000, 4_000]);
    expect(result.attempts).toBe(4);
    expect(result.waitedMs).toBe(7_000);
    // The whole point: same port every time.
    expect(ports).toEqual([8787, 8787, 8787, 8787]);
  });

  test('a host-resource failure also waits in place — it does not walk', async () => {
    const { probe, ports } = scriptedProbe(['unavailable', 'unavailable', null]);
    await acquirePort({ port: 8787, probe, sleep: async () => {} });
    expect(ports).toEqual([8787, 8787, 8787]);
  });

  test('logs name the cause, so the log says which failure this was', async () => {
    const lines: string[] = [];
    const { probe } = scriptedProbe(['in-use', 'unavailable', null]);
    await acquirePort({
      port: 8787,
      probe,
      sleep: async () => {},
      log: (m) => lines.push(m),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('held by another process');
    expect(lines[0]).toContain('not walking to another port');
    expect(lines[1]).toContain('host resources, not the port');
  });

  test('a fatal probe result throws instead of looping forever', async () => {
    const { probe } = scriptedProbe(['fatal']);
    await expect(acquirePort({ port: 8787, probe, sleep: async () => {} })).rejects.toThrow(
      /unrecognised bind failure/,
    );
  });

  test('maxAttempts bounds the loop and does not sleep after the last try', async () => {
    const slept: number[] = [];
    const { probe, ports } = scriptedProbe(['in-use', 'in-use']);
    await expect(
      acquirePort({
        port: 8787,
        probe,
        sleep: async (ms) => {
          slept.push(ms);
        },
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/gave up waiting for :8787 after 2 attempt/);
    expect(ports).toEqual([8787, 8787]);
    expect(slept).toEqual([1_000]);
  });
});

describe('probeLocalPort', () => {
  /**
   * The probe this replaces bound `node:net` to `127.0.0.1` and `::1`, which
   * on BSD succeeds against a wildcard listener thanks to SO_REUSEADDR — so
   * it reported "free" for a port a real server was holding. That is how the
   * supervisor came to hand a busy 8787 to its child on 2026-08-29. A pure
   * test cannot catch this; only binding for real can.
   *
   * Ports come from the OS (`port: 0`), never a constant — a fixed port makes
   * this suite fail whenever anything else on the machine happens to hold it.
   */
  test('sees a running Bun.serve on the port', async () => {
    const holder = Bun.serve({ port: 0, fetch: () => new Response('held') });
    try {
      expect(await probeLocalPort(holder.port)).toBe('in-use');
    } finally {
      holder.stop(true);
    }
  });

  test('reports a free port as free', async () => {
    // Positive control for the assertion above: without it, a probe that
    // answered "in-use" for everything would pass that test vacuously.
    // Borrow an OS-assigned port, release it, then ask about it.
    const borrowed = Bun.serve({ port: 0, fetch: () => new Response('x') });
    const port = borrowed.port;
    borrowed.stop(true);
    expect(await probeLocalPort(port)).toBeNull();
  });
});
