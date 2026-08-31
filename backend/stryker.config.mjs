/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'jest',
  concurrency: 2,
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  mutate: ['src/security/token-cipher.service.ts'],
  reporters: ['clear-text', 'html'],
  coverageAnalysis: 'perTest',
};
