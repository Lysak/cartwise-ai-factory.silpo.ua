import { ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import type { SessionRecord, SessionService } from './session.service';

const session: SessionRecord = {
  userId: 'user-1',
  telegramUserId: '123',
  issuedAt: '2026-08-12T12:00:00.000Z',
  absoluteExpiresAt: '2026-11-10T12:00:00.000Z',
  csrfSecret: 'csrf-secret'
};

describe('CsrfGuard', () => {
  it('requires the exact origin and a matching synchronizer token for unsafe methods', async () => {
    process.env.APP_ORIGIN = 'https://app.example.com';
    const request = {
      method: 'POST',
      headers: { origin: 'https://app.example.com', 'x-csrf-token': 'csrf-secret' },
      cookies: { '__Host-cartwise_session': 'opaque' }
    };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    await expect(new CsrfGuard({ resolve: jest.fn().mockResolvedValue(session) } as unknown as SessionService).canActivate(context))
      .resolves.toBe(true);
  });

  it('rejects an unsafe request with a wrong origin or token', async () => {
    process.env.APP_ORIGIN = 'https://app.example.com';
    const request = {
      method: 'POST',
      headers: { origin: 'https://other.example.com', 'x-csrf-token': 'wrong' },
      cookies: { '__Host-cartwise_session': 'opaque' }
    };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    await expect(new CsrfGuard({ resolve: jest.fn().mockResolvedValue(session) } as unknown as SessionService).canActivate(context))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
