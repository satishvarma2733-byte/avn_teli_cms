import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const alias = [
  {
    find: /^server-only$/,
    replacement: fileURLToPath(new URL('./tests/setup/server-only.ts', import.meta.url)),
  },
  { find: /^@\//, replacement: fileURLToPath(new URL('./apps/web/src/', import.meta.url)) },
];

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
          setupFiles: ['tests/setup/unit.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: [
            'packages/**/*.int.test.ts',
            'apps/**/*.int.test.ts',
            'tests/integration/**/*.int.test.ts',
          ],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          globalSetup: ['tests/setup/integration-global.ts'],
          setupFiles: ['tests/setup/integration.ts'],
          // One database: test files run one after another.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
