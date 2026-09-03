import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The activity log is ~1000 rows (~590KB decompressed on the live hub board)
// and only two surfaces read it: the Activity view and an open detail panel.
// It used to be fetched unconditionally at boot AND re-fetched on every SSE
// task event — dead weight on exactly the load Bryan measured at 10+ seconds
// on his iPad (t-scWMQmOZcpu1). hub-app has no boot harness, so these pin the
// source (same pattern as home-nav-reset.test.ts).
describe('the activity log loads only when something reads it', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('loadEvents gates on an active consumer', () => {
    expect(src).toMatch(
      /async function loadEvents\(\): Promise<void> \{\s*\n\s*if \(!eventsConsumerActive\(\)\) return;/,
    );
  });

  it('boot no longer fetches the log unconditionally', () => {
    // The unconditional call sat between loadAgents and loadReviewItems in
    // the boot sequence — the detail panel's own comment already said
    // "fetched on open rather than at boot", and boot contradicted it.
    expect(src).not.toMatch(
      /renderAll\(\);\s*\n\s*void loadAgents\(\);\s*\n\s*void loadEvents\(\);/,
    );
  });

  it('opening the Activity view still loads it', () => {
    expect(src).toMatch(/if \(nav === 'activity'\) void loadEvents\(\);/);
  });
});
