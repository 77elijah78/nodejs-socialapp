import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.cache/**', 'admin/**'] },
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], rules: {
    // Existing HTTP/socket boundaries use any and Function; tighten separately.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unsafe-function-type': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  } },
);
