import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['build/**', 'node_modules/**', 'native/**', '.local/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
);
