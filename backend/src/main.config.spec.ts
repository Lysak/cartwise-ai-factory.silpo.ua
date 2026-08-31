import { trustProxy } from './main.config';

it('uses the loopback default when Compose passes an empty TRUST_PROXY', () => {
  expect(trustProxy('')).toBe('loopback');
});
