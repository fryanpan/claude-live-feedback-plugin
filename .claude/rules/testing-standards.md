# Testing standards

What a test in this repo has to do to be worth its runtime. Each standard
names the check that enforces it. `bun run test:audit` is the mechanical half;
it counts proxies for three of these and ratchets the counts down via
`scripts/test-audit.baseline.json`. A count may only fall — lower the baseline
in the same commit that lowers the count.

It reads untracked files as well as tracked ones, so a test you have written
but not staged is judged locally exactly as CI will judge it once committed.
It used to enumerate with `git ls-files` alone, which made the gate blind to
the new tests it exists to check.

## 1. Assert behaviour, not source shape

Drive the thing and assert what it did. A regex over a bundle, a source file
or a stylesheet's text is not a test of behaviour: it passes when the string
survives a rename that breaks the feature, and fails when a refactor moves a
declaration that still works. For layout and styling, render the page and read
the computed value — `bun run ui:shot` gives you a real browser.

*Check:* `test:audit` counts source/bundle/stylesheet reads in test files that
assert with `toContain`/`toMatch`. It cannot tell a legitimate read (a
generator's output, a fixture) from an illegitimate one, so the count is a
ceiling, not a verdict.

## 2. No fixed sleeps in the server suite

A `sleep(1100)` waiting on the ~1s doc write-back is both slow and flaky: it
pays the full second every run and still loses on a loaded machine. Poll for
the observable the test is actually waiting on — a flushed file, a socket
message, a log line, a row appearing. The house pattern is `waitFor` in
`packages/server/test/wait-for.ts`; `waitForBlock` in `server.test.ts` is the
older hand-rolled form of the same loop.

A wait that is itself the assertion — proving nothing happens inside a debounce
window, or that a TTL has not yet expired — is legitimate. Inject the clock
where the module allows it; otherwise keep the sleep and mark it `// timed:`
with the window it is proving, which exempts it from the audit.

*Check:* `test:audit` counts `sleep(N)` and `setTimeout(fn, N)` with N >= 500
in `packages/server/test`, minus the `// timed:` ones.

### The cadences are scaled, so never write one as a literal

Polling cannot shorten a debounce the server itself schedules, and the suite
crosses that chain hundreds of times. So `CW_TEST_TIMING_SCALE` multiplies
every room cadence in `packages/server/src/room-timings.ts` by one factor.
`packages/server/test/timing.preload.ts` sets it to `0.1` for every `bun test`
run, which is why the documented gate needs no extra flag.

One factor, not one knob per cadence: the ORDER of these debounces is
load-bearing — the `.ydoc` persists before the `.md` write-back, which is what
makes "a crash inside the flush window" a state a test can build. A uniform
scale preserves every ratio. Unset, malformed, or above 1 gives the
production defaults unchanged, asserted by
`packages/server/test/room-timings.test.ts` in a subprocess with the variable
removed from the environment.

The consequence for tests: a `// timed:` wait must DERIVE its window from
those constants. `packages/server/test/wait-for.ts` exports the four —
`pastWriteBack`, `pastExternalRead`, `insideWriteBack`, `pastReanchor`, plus
`afterPersist` for the gap between the two debounces. A literal `700` meant to
sit inside an 800ms window sits far outside an 80ms one, which silently turns
the race a test builds into no race at all.

*Check:* no check yet. The audit cannot tell a literal that rides a scaled
cadence from one that rides an unscaled timer elsewhere in the server.

## 3. No wall-clock assertions

`expect(Date.now() - t0).toBeLessThan(2000)` fails on a loaded CI runner and
passes on a broken fast path. Assert the order of events, the number of calls,
or the state a scheduler reached — not how long the machine took. Where timing
genuinely is the behaviour under test, inject a clock and advance it.

*Check:* `test:audit` counts `expect()` on a `Date.now()`/`performance.now()`
value or on a variable assigned from a now() delta.

## 4. Every new server module ships with a unit test

A new file under `packages/server/src` lands in the same commit as a test that
exercises it directly, not only through a route that happens to reach it.

*Check:* no check yet. Reviewer's eye on the diff.

## 5. Browser and layout checks run headless

Never drive a human's browser window. `bun run ui:shot` opens headless
Chromium against a throwaway profile. Verify at **1180x820** (tablet/laptop,
where height is the scarce axis) and **430** wide, per
[docs/product/design-mobile.md](../../docs/product/design-mobile.md).

*Check:* no check yet.

## 6. The four gates, and what each one catches

Four separate commands. None is a subset of another — run all four before you
push.

| Gate | Catches what the others miss |
| --- | --- |
| `bunx vitest run` | unit + client suites (markdown-app, core, widget) |
| `bun test packages/server/test` | the server suite; vitest does not run it |
| `bun run typecheck` | type errors; neither runner typechecks |
| `bun run lint` | biome; nothing else formats |

`bun run test:audit` is the fifth check and runs in CI alongside them.
