import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { TelegramInitDataService } from './telegram-init-data.service';

const botToken = 'synthetic-bot-token';
const user = JSON.stringify({ id: 123456789012, username: 'test_user', first_name: 'Test', language_code: 'uk' });

function signedInitData(values: Record<string, string>): string {
  const dataCheckString = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

describe('TelegramInitDataService', () => {
  const service = new TelegramInitDataService(botToken);

  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-08-12T12:00:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('validates a signed Telegram user', () => {
    expect(service.validate(signedInitData({ auth_date: '1786535940', query_id: 'test-query', user }))).toEqual({
      telegramUserId: '123456789012',
      username: 'test_user',
      firstName: 'Test',
      lastName: undefined,
      languageCode: 'uk'
    });
  });

  it('fails closed without a bot token', () => {
    expect(() => new TelegramInitDataService('').validate(signedInitData({ auth_date: '1786535940', user })))
      .toThrow(BadRequestException);
  });

  it.each([
    ['stale', signedInitData({ auth_date: '1786535640', user })],
    ['future', signedInitData({ auth_date: '1786536031', user })],
    ['tampered', `${signedInitData({ auth_date: '1786535940', user })}&query_id=tampered`],
    ['duplicated', `${signedInitData({ auth_date: '1786535940', user })}&auth_date=1786535940`],
    ['malformed user', signedInitData({ auth_date: '1786535940', user: '{' })],
    ['wrong-length hash', new URLSearchParams({ auth_date: '1786535940', user, hash: 'a' }).toString()]
  ])('rejects %s input', (_name, raw) => {
    expect(() => service.validate(raw)).toThrow(BadRequestException);
  });
});
