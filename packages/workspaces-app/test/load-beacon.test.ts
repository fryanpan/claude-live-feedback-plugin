import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HUB_BOOT_SOURCES } from './support/hub-boot-sources.ts';

// The board's load time was a memory ("10+ seconds on the iPad")
// until the server grew /load-reports. This is the client half: after boot the
// board reports how long its own first paint and first ydoc projection took,
// once per page load, so slowness is a recorded fact with phase attribution.
// Pinned on the source: the board's boot is driveable (hub-boot.test.ts),
// but what this asserts is which PHASES the beacon reports, and a report
// that names them is easier to read off the call than to reconstruct.
describe('the board reports its own load time', () => {
  const src = HUB_BOOT_SOURCES.map((m) =>
    readFileSync(join(__dirname, '..', 'src', 'hub', `${m}.ts`), 'utf8'),
  ).join('\n');

  it('posts one report to the load-reports route', () => {
    expect(src).toMatch(
      /fetch\(`\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/load-reports`,\s*\{\s*\n\s*method: 'POST'/,
    );
  });

  it('fires once — a sent guard, not a repeat on every projection', () => {
    expect(src).toMatch(/let loadReportSent = false;/);
    expect(src).toMatch(/if \(loadReportSent\) return;\s*\n\s*loadReportSent = true;/);
  });

  it('measures boot paint and first projection separately', () => {
    // msToBoot is stamped right after the boot renderAll; msToFirstProjection
    // on the client's initial-sync callback — NOT the tasksMap observer,
    // which never fires for an empty workspace and fires for any later
    // mutation (codex review on PR 384).
    expect(src).toMatch(/msToBoot = Math.round\(performance\.now\(\)\)/);
    expect(src).toMatch(
      /client\.onReady\(\(\) => \{\s*\n\s*if \(msToFirstProjection === null\) \{\s*\n\s*msToFirstProjection = Math.round\(performance\.now\(\)\)/,
    );
  });

  it('includes what the network actually moved', () => {
    // Resource transfer sums make "slow because big" vs "slow because far"
    // distinguishable in the report itself.
    expect(src).toMatch(/getEntriesByType\('resource'\)/);
  });
});
