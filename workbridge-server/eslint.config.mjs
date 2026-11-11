// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'prisma/migrations/'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // `async` without `await` is how providers and stubs satisfy a Promise-returning interface
      // (a throw still becomes a rejection). The rule flags those and nothing else here.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Logging goes through `lib/logger.ts` (.claude/rules/notifications-logging.md). The logger itself and the job CLI, whose
  // stdout is its output, are the only places that write to the console.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/lib/logger.ts', 'src/jobs/cli.ts'],
    rules: { 'no-console': 'error' },
  },

  // Express 4 calls handlers without awaiting them, so every async handler and middleware catches
  // its own errors and forwards them with `next(err)`. Registering one is the intended pattern.
  {
    files: ['src/routes/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
    },
  },

  // Controllers stay thin: errors belong to the services (REVIEW #2), so a controller never decides
  // an error response itself.
  {
    files: ['src/controllers/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='AppError']", message: 'Throw AppError in the service, not the controller (REVIEW #2).' },
        { selector: "CallExpression[callee.name='invalidField']", message: 'Throw invalidField in the service, not the controller (REVIEW #2).' },
      ],
    },
  },

  // Supertest types `res.body` as `any`, and vitest mocks are unbound functions and loose casts.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // The seed script is CommonJS run by plain Node.
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
