import { describe, expect, it } from 'bun:test';
import { DEFAULT_ROOM_TIMINGS, ROOM_TIMINGS, resolveRoomTimings } from '../src/room-timings.ts';

/**
 * `CW_TEST_TIMING_SCALE` exists so the suite can run the server's debounces
 * fast. The whole bargain depends on production never seeing a scaled value,
 * so the first two tests here are about the DEFAULTS, not about the feature.
 */
describe('room timings', () => {
  it('resolves the production cadences when the scale is absent or unusable', () => {
    // Undefined is the production case. The rest are the ways a stray value
    // could reach a real deploy: a blank from a shell expansion, a word, a
    // negative, a zero, and anything that would make the server SLOWER.
    for (const scale of [undefined, '', '   ', 'fast', 'NaN', '-1', '0', '1.5', '10']) {
      expect(resolveRoomTimings(scale)).toEqual(DEFAULT_ROOM_TIMINGS);
    }
    // The numbers themselves, spelled out, so a careless edit to the defaults
    // has to change this line too.
    expect(DEFAULT_ROOM_TIMINGS).toEqual({
      filePollMs: 500,
      readDebounceMs: 150,
      writeBackMs: 800,
      persistMs: 200,
      revisionSettleMs: 1000,
      reanchorMs: 250,
    });
  });

  it('reads the defaults in a process with the variable unset', async () => {
    // This suite runs WITH the scale set (test/timing.preload.ts), so the
    // in-process `ROOM_TIMINGS` cannot answer the question the standard
    // actually asks: what does the server do when nobody set the variable?
    // Only a fresh process can, because the value is resolved at module load.
    // Built by omission rather than by deleting a key: the point of the test
    // is that the child's environment genuinely does not carry the variable.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'CW_TEST_TIMING_SCALE'),
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        [
          "const m = await import('./packages/server/src/room-timings.ts');",
          'console.log(JSON.stringify(m.ROOM_TIMINGS));',
        ].join(''),
      ],
      { cwd: new URL('../../..', import.meta.url).pathname, env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    expect(JSON.parse(out.trim())).toEqual(DEFAULT_ROOM_TIMINGS);
  });

  it('scales every cadence by one factor, preserving their order', () => {
    const t = resolveRoomTimings('0.1');
    expect(t).toEqual({
      filePollMs: 50,
      readDebounceMs: 15,
      writeBackMs: 80,
      persistMs: 20,
      revisionSettleMs: 100,
      reanchorMs: 25,
    });
    // The ORDER is the load-bearing part: the .ydoc persist has to still land
    // before the .md write-back, which is what makes "a crash inside the flush
    // window" a state the tests can build.
    expect(t.persistMs).toBeLessThan(t.writeBackMs);
    expect(t.readDebounceMs).toBeLessThan(t.filePollMs);
  });

  it('floors every cadence so an extreme scale cannot collapse two into one', () => {
    const t = resolveRoomTimings('0.000001');
    for (const ms of Object.values(t)) expect(ms).toBe(5);
  });

  it('runs this suite scaled, which is the only reason the feature exists', () => {
    // A positive control on the preload. Without it, every test above could
    // pass while the suite quietly ran at production speed.
    expect(process.env.CW_TEST_TIMING_SCALE).toBe('0.1');
    expect(ROOM_TIMINGS).toEqual(resolveRoomTimings('0.1'));
    expect(ROOM_TIMINGS).not.toEqual(DEFAULT_ROOM_TIMINGS);
  });
});
