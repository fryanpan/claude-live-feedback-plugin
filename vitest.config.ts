import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Preact JSX for .tsx files (mirrors jsx/jsxImportSource in tsconfig.base.json).
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    // One uncapped `vitest run` forks a worker per core (~10-19 processes);
    // two builders' gate runs on a 16GB box already hosting a dozen Claude
    // sessions froze the machine on 2026-08-31 (load 97, swap exhausted).
    // Four forks keeps a full run under a minute while leaving the box alive
    // no matter how many runs overlap.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    maxWorkers: 4,
    environment: 'happy-dom',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/*/test/**/*.test.{ts,tsx}',
      'packages/*/src/**/*.test.{ts,tsx}',
      // Repo-level scripts are gates (release, leak, bundle size); they need
      // covering too, and they are not under packages/.
      'scripts/**/*.test.ts',
    ],
    exclude: ['packages/server/test/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', 'packages/*/src/bin.ts'],
    },
  },
});
