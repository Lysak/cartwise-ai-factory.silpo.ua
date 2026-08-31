/** @type {import('@stryker-mutator/api/core').StrykerOptions} */
export default {
  testRunner: 'vitest',
  mutate: ['src/App.tsx'],
  reporters: ['clear-text', 'html'],
  vitest: {
    configFile: 'vite.config.ts',
    related: true,
  },
};
