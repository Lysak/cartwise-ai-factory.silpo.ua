import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns the API health payload', () => {
    expect(new HealthController().get()).toEqual({ status: 'ok' });
  });
});
