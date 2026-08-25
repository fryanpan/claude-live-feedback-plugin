import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Preact JSX for .tsx files (mirrors jsx/jsxImportSource in tsconfig.base.json).
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
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
