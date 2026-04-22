// ESLint v9 configuration for @juspay/kriya
// Mirrors the balanced-strict ruleset used in sibling Juspay repos
// (neurolink / shooter / yama) so quality bars are consistent across projects.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginPrettier from 'eslint-plugin-prettier';

export default [
  js.configs.recommended,
  // TypeScript-aware config (applies @typescript-eslint/* rules to .ts files)
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // TypeScript source files — strictest ruleset.
  // ---------------------------------------------------------------------------
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      // Base rules replaced by the @typescript-eslint equivalents below.
      'no-unused-vars': 'off',
      'no-undef': 'off',

      // TypeScript-specific rules (matches neurolink's balanced enforcement).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          args: 'after-used',
          vars: 'local',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/prefer-as-const': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Project convention: use `type` exclusively — no `interface`.
      // See CLAUDE.md §"STRICT Code Conventions".
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],

      // Code quality gates.
      'max-depth': ['error', 6],
      'max-lines-per-function': ['warn', 300],
      'max-params': ['error', 6],

      // Security.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],

      // Modern JavaScript.
      'prefer-const': 'warn',
      'no-var': 'error',

      // Correctness.
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],

      // Style (delegated to Prettier).
      indent: 'off',
      quotes: 'off',
      semi: 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Plain JavaScript files (build config, etc.) — relaxed.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'error',
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      indent: 'off',
      quotes: 'off',
      semi: 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Test files — strict on types but relaxed on unused vars / console.
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.ts', 'test/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        ...globals.jest,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      'max-lines-per-function': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Ignore patterns.
  // ---------------------------------------------------------------------------
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '.next/**',
      '.nuxt/**',
      '.rollup.cache/**',
      '.svelte-kit/**',
      '**/*.cjs',
      '**/*.d.ts',
      'site/**',
      '_site/**',
      'docs/**',
      'examples/**',
      '*.config.js',
      '*.config.ts',
    ],
  },
];
