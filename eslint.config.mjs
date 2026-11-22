// Root ESLint flat config: lint with `npm run lint`, autofix with
// `npm run lint:fix`. Covers every checked-in JS/MJS/CJS/TS file; generated,
// vendored, and retained-evidence paths are ignored below.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/artifacts/**', '.run/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Dependency-free CommonJS fixture: require() is the module system there.
    files: ['tests/fixtures/repository/**/*.js', 'tests/fixtures/repository/**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
