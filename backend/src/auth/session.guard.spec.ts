import { UnauthorizedException } from '@nestjs/common';
import { SessionGuard } from './session.guard';
import { sessionCookieName, type SessionRecord, type SessionService } from './session.service';

const session: SessionRecord = {
  userId: 'user-1',
  telegramUserId: '123',
  issuedAt: '2026-08-12T12:00:00.000Z',
  absoluteExpiresAt: '2026-11-10T12:00:00.000Z',
  csrfSecret: 'csrf'
};

describe('SessionGuard', () => {
  it('attaches only the authenticated user identity', async () => {
    const resolve = jest.fn().mockResolvedValue(session);
    const request = { cookies: { [sessionCookieName()]: 'opaque' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    await expect(new SessionGuard({ resolve } as unknown as SessionService).canActivate(context)).resolves.toBe(true);

    expect(request).toMatchObject({ user: { id: 'user-1', telegramUserId: '123' } });
  });

  it('attaches a Silpo-first user without inventing a Telegram ID', async () => {
    const silpoSession: SessionRecord = { ...session, telegramUserId: null };
    const resolve = jest.fn().mockResolvedValue(silpoSession);
    const request = { cookies: { [sessionCookieName()]: 'opaque' } };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    await expect(new SessionGuard({ resolve } as unknown as SessionService).canActivate(context)).resolves.toBe(true);

    expect(request).toMatchObject({ user: { id: 'user-1', telegramUserId: null } });
  });

  it('fails closed when Redis does not resolve the session', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ cookies: {} }) }) } as never;

    await expect(new SessionGuard({ resolve: jest.fn().mockResolvedValue(null) } as unknown as SessionService).canActivate(context))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });
});
