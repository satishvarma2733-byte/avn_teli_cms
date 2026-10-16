import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint, including the architecture boundaries from docs/MODULE_STRUCTURE.md:
 *  - the owner (RLS-bypassing) client only in auth, platform, intake-credential lookup, worker
 *    system jobs, the db package itself, tests and scripts;
 *  - the generated Prisma client only inside packages/db;
 *  - pages and components never touch the database layer directly (they call core services).
 */
const OWNER_ALLOWED = [
  'packages/db/**',
  'packages/auth/**',
  'packages/core/src/platform/**',
  'packages/core/src/webLeads/credentials.ts',
  'apps/worker/src/jobs.ts',
  'tests/**',
  'scripts/**',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      'packages/db/generated/**',
      '**/next-env.d.ts',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: OWNER_ALLOWED,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@avn-cms/db/owner',
              message: 'The owner client bypasses RLS: only auth, platform and system jobs may use it.',
            },
          ],
          patterns: [
            {
              group: ['@prisma/client', '@prisma/client/*'],
              message: 'Import database types from @avn-cms/db.',
            },
            {
              group: ['**/generated/prisma*', '**/generated/prisma/**'],
              message: 'Import database types from @avn-cms/db.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/app/**/*.tsx', 'apps/web/src/components/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@avn-cms/db',
              message:
                'Pages and components call @avn-cms/core services; only @avn-cms/db/enums is allowed here.',
            },
            { name: '@avn-cms/db/owner', message: 'The owner client bypasses RLS.' },
          ],
        },
      ],
    },
  },
);
