import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { TelegramLinkController } from './telegram-link.controller';
import type { TelegramLinkService } from './telegram-link.service';
import type { SessionService } from '../auth/session.service';

type RequestLike = { user?: { id: string } };
type PoolLike = { query: jest.Mock };

describe('TelegramLinkController', () => {
  const link = { createLink: jest.fn() };
  const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };
  const pool: PoolLike = { query: jest.fn() };
  const controller = new TelegramLinkController(
    link as unknown as TelegramLinkService,
    sessions as unknown as SessionService,
    pool as never
  );

  beforeEach(() => jest.clearAllMocks());

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_USERNAME;
  });

  it('rejects a request without an authenticated user', async () => {
    await expect(controller.start({} as RequestLike)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(link.createLink).not.toHaveBeenCalled();
  });

  it('rejects a user whose Telegram account is already connected', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ telegramUserId: '123' }] });

    await expect(controller.start({ user: { id: 'user-1' } })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(link.createLink).not.toHaveBeenCalled();
  });

  it('returns a t.me deep link built from the raw token for an unconnected user', async () => {
    process.env.TELEGRAM_BOT_USERNAME = '@SiploSmartBasketBot';
    pool.query.mockResolvedValueOnce({ rows: [{ telegramUserId: null }] });
    link.createLink.mockResolvedValueOnce('raw-token-value');

    await expect(controller.start({ user: { id: 'user-1' } })).resolves.toEqual({
      deepLink: 'https://t.me/SiploSmartBasketBot?start=link_raw-token-value'
    });
    expect(link.createLink).toHaveBeenCalledWith('user-1');
  });

  it('does not create a token when TELEGRAM_BOT_USERNAME is not configured', async () => {
    delete process.env.TELEGRAM_BOT_USERNAME;
    pool.query.mockResolvedValueOnce({ rows: [{ telegramUserId: null }] });

    await expect(controller.start({ user: { id: 'user-1' } })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(link.createLink).not.toHaveBeenCalled();
  });

  it('rate limits repeated link requests per user', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);

    await controller.start({ user: { id: 'user-1' } }).then(
      () => { throw new Error('Expected rate limit rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    );
    expect(link.createLink).not.toHaveBeenCalled();
  });
});
