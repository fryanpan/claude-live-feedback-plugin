import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The board only observes itself with Sentry when the server injected a DSN
// meta tag (box config — the public repo carries no DSN). The SDK arrives by
// dynamic import so an unconfigured page ships zero Sentry bytes: the hub
// entry builds with splitting on, so the import is its own chunk fetched
// only when the tag is present. Source pins, same pattern as load-beacon.
describe('the board loads Sentry only when the shell names a DSN (t-scWMQmOZcpu1)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('reads the DSN from the shell meta tag', () => {
    expect(src).toMatch(/meta\[name="sentry-dsn"\]/);
  });

  it('imports the SDK dynamically, gated on the tag', () => {
    expect(src).toMatch(/if \(sentryDsn\) \{\s*\n\s*void import\('@sentry\/browser'\)/);
  });

  it('enables errors and tracing, stamped with the build id as release', () => {
    expect(src).toMatch(/browserTracingIntegration\(\)/);
    expect(src).toMatch(/tracesSampleRate/);
    expect(src).toMatch(/release: BUILD_ID/);
  });

  it('feeds the load-phase numbers into the pageload trace', () => {
    // The built-in recorder and Sentry must tell one story: the same
    // msToBoot / msToFirstProjection the report posts also land on the
    // pageload transaction as measurements, best-effort.
    expect(src).toMatch(/setMeasurement\('ms_to_boot'/);
    expect(src).toMatch(/setMeasurement\('ms_to_first_projection'/);
  });
});
