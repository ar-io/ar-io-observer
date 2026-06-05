import eslintPluginTs from '@typescript-eslint/eslint-plugin';
import parserTs from '@typescript-eslint/parser';
import prettierPlugin from 'eslint-plugin-prettier';
import mochaPlugin from 'eslint-plugin-mocha';
import unicornPlugin from 'eslint-plugin-unicorn';
import jestFormattingPlugin from 'eslint-plugin-jest-formatting';
import headerPlugin from 'eslint-plugin-header';
import eslintJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import eslintPluginHeader from 'eslint-plugin-header';
import globals from 'globals';
import fs from 'node:fs';
const licenseHeader = fs
  .readFileSync('./resources/license.header.js', 'utf-8')
  .replace(/^\/\*+|\*+\/$/g, '') // strip /* */
  .split('\n')
  .map((line) => line.replace(/^\s*\* ?/, '').trim());

export default [
  eslintJs.configs.recommended,
  prettierConfig,
  {
    files: ['src/**/*.ts'],
    ignores: ['resources/license.header.js'],
    languageOptions: {
      parser: parserTs,
      parserOptions: {
        project: 'tsconfig.json',
      },
      globals: {
        ...globals.node,
        ...globals.commonjs,
        ...globals.mocha,
      },
    },
    plugins: {
      '@typescript-eslint': eslintPluginTs,
      header: headerPlugin,
      'jest-formatting': jestFormattingPlugin,
      mocha: mochaPlugin,
      prettier: prettierPlugin,
      unicorn: unicornPlugin,
      header: headerPlugin,
    },
    rules: {
      ...eslintPluginTs.configs['recommended'].rules,
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowNullableObject: true,
          allowNullableBoolean: true,
          allowAny: true,
        },
      ],
      eqeqeq: 'error',
      'jest-formatting/padding-around-describe-blocks': 'error',
      'jest-formatting/padding-around-test-blocks': 'error',
      'mocha/max-top-level-suites': 'off',
      'mocha/no-exports': 'off',
      'mocha/no-mocha-arrows': 'off',
      'no-console': 'off',
      'no-return-await': 'error',
      'no-unneeded-ternary': 'error',
      'no-unused-vars': 'off',
      'prettier/prettier': 'error',
      'unicorn/prefer-node-protocol': 'error',
    },
  },
];
