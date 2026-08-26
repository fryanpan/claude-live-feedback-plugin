import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The board's load time was a memory ("10+ seconds on the iPad", t-scWMQmOZcpu1)
// until the server grew /load-reports. This is the client half: after boot the
// board reports how long its own first paint and first ydoc projection took,
// once per page load, so slowness is a recorded fact with phase attribution.
// hub-app has no boot harness — pins on the source, same as lazy-events.
describe('the board reports its own load time (t-scWMQmOZcpu1)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

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
    // on the first tasksMap observer fire — the two phases the diagnosis
    // actually needed to tell apart (REST paint vs ydoc sync).
    expect(src).toMatch(/msToBoot = Math.round\(performance\.now\(\)\)/);
    expect(src).toMatch(/msToFirstProjection = Math.round\(performance\.now\(\)\)/);
  });

  it('includes what the network actually moved', () => {
    // Resource transfer sums make "slow because big" vs "slow because far"
    // distinguishable in the report itself.
    expect(src).toMatch(/getEntriesByType\('resource'\)/);
  });
});
