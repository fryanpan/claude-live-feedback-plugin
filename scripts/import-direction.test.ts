/**
 * The import-direction gate, exercised on fixtures rather than on this repo:
 * a test that asserted the real tree is clean would go green the day the tree
 * went green and could never tell you the check still WORKS.
 *
 * Every case here is one of the two edges the rule names, and each has its
 * legal twin beside it — the same shape pointing the allowed way — so a check
 * that flagged everything would fail as loudly as one that flagged nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  audit,
  isRoute,
  relativeSpecifiers,
  resolveSpecifier,
  violationsIn,
} from './import-direction';

const dirs: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'import-direction-'));
  dirs.push(root);
  mkdirSync(join(root, 'packages', 'server', 'src', 'routes'), { recursive: true });
  return root;
}

function write(root: string, rel: string, body: string): void {
  writeFileSync(join(root, ...rel.split('/')), body);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('relativeSpecifiers', () => {
  it('reads static, type-only, re-export and dynamic imports', () => {
    const src = [
      "import { a } from './a.ts';",
      "import type { B } from '../b.ts';",
      "export type { C } from './c.ts';",
      "const d = await import('./d.ts');",
    ].join('\n');
    expect(relativeSpecifiers(src)).toEqual(['./a.ts', '../b.ts', './c.ts', './d.ts']);
  });

  it('skips bare specifiers, which cannot name a file in this package', () => {
    const src = "import { x } from '@feedback/core';\nimport { y } from 'node:fs';";
    expect(relativeSpecifiers(src)).toEqual([]);
  });
});

describe('resolveSpecifier', () => {
  it('resolves against the importing file, not the repo root', () => {
    expect(resolveSpecifier('packages/server/src/routes/docs.ts', '../rooms.ts')).toBe(
      'packages/server/src/rooms.ts',
    );
    expect(resolveSpecifier('packages/server/src/routes/docs.ts', './doc-resource.ts')).toBe(
      'packages/server/src/routes/doc-resource.ts',
    );
  });
});

describe('isRoute', () => {
  it('does not mistake a sibling whose name starts with "routes" for the directory', () => {
    expect(isRoute('packages/server/src/routes/docs.ts')).toBe(true);
    expect(isRoute('packages/server/src/routes-legacy.ts')).toBe(false);
  });
});

describe('violationsIn', () => {
  it('flags a route importing server.ts, even as a type', () => {
    const found = violationsIn(
      'packages/server/src/routes/meetings-calendar.ts',
      "import type { ServerOptions } from '../server.ts';",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe('routes-imports-server');
    expect(found[0]?.to).toBe('packages/server/src/server.ts');
  });

  it('flags a service importing out of routes/, even as a type', () => {
    const found = violationsIn(
      'packages/server/src/review-gate.ts',
      "import type { ReviewGate } from './routes/task-routes-context.ts';",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe('non-route-imports-routes');
  });

  it('allows server.ts to import routes/ — it is the router', () => {
    expect(
      violationsIn(
        'packages/server/src/server.ts',
        "import { handleDocRoutes } from './routes/docs.ts';",
      ),
    ).toEqual([]);
  });

  it('allows a route to import a service, and a route to import a route', () => {
    expect(
      violationsIn(
        'packages/server/src/routes/docs.ts',
        "import type { Rooms } from '../rooms.ts';\nimport { x } from './doc-resource.ts';",
      ),
    ).toEqual([]);
  });

  it('allows a service to import another service', () => {
    expect(
      violationsIn('packages/server/src/review-gate.ts', "import { y } from './review-judge.ts';"),
    ).toEqual([]);
  });

  it('ignores files outside the server package', () => {
    expect(
      violationsIn('packages/mcp/src/mcp.ts', "import { z } from './routes/docs.ts';"),
    ).toEqual([]);
  });
});

describe('audit over a tree', () => {
  it('is silent on a tree that points the right way', () => {
    const root = fixture();
    write(root, 'packages/server/src/server.ts', "import { a } from './routes/docs.ts';");
    write(root, 'packages/server/src/routes/docs.ts', "import type { R } from '../rooms.ts';");
    write(root, 'packages/server/src/rooms.ts', 'export const R = 1;');
    expect(audit(root)).toEqual([]);
  });

  it('finds both edges, and names the specifier as written', () => {
    const root = fixture();
    write(root, 'packages/server/src/server.ts', "import { a } from './routes/docs.ts';");
    write(root, 'packages/server/src/routes/docs.ts', "import type { O } from '../server.ts';");
    write(root, 'packages/server/src/review-gate.ts', "import type { G } from './routes/docs.ts';");
    const found = audit(root);
    expect(found.map((v) => v.rule).sort()).toEqual([
      'non-route-imports-routes',
      'routes-imports-server',
    ]);
    expect(found.find((v) => v.rule === 'routes-imports-server')?.specifier).toBe('../server.ts');
  });

  it('answers empty for a tree with no server package rather than throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'import-direction-empty-'));
    dirs.push(root);
    expect(audit(root)).toEqual([]);
  });
});
