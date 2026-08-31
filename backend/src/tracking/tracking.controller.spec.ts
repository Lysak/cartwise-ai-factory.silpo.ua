import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import { TrackingController } from './tracking.controller';
import type { TrackingService } from './tracking.service';

const tracking = {
  heart: jest.fn().mockResolvedValue({ id: 'subscription-1' }),
  unheart: jest.fn().mockResolvedValue({ status: 'untracked' }),
  list: jest.fn().mockResolvedValue({ items: [] }),
  history: jest.fn().mockResolvedValue({ items: [] })
};
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };
const subject = () => new TrackingController(
  tracking as unknown as TrackingService,
  sessions as unknown as SessionService
);

beforeEach(() => jest.clearAllMocks());

describe('TrackingController', () => {
  it('protects writes with the existing session and CSRF guards', () => {
    expect(Reflect.getMetadata('__guards__', TrackingController.prototype.heart)).toEqual(
      expect.arrayContaining([SessionGuard, CsrfGuard])
    );
    expect(Reflect.getMetadata('__guards__', TrackingController.prototype.unheart)).toEqual(
      expect.arrayContaining([SessionGuard, CsrfGuard])
    );
    expect(Reflect.getMetadata('__guards__', TrackingController.prototype.list)).toContain(SessionGuard);
    expect(Reflect.getMetadata('__guards__', TrackingController.prototype.history)).toContain(SessionGuard);
  });

  it('passes only the authenticated user to heart and list', async () => {
    await expect(subject().heart({ user: { id: 'user-1' } }, {
      externalProductId: 'product-1', slug: 'milk-1', name: 'Молоко'
    })).resolves.toEqual({ id: 'subscription-1' });
    await expect(subject().list({ user: { id: 'user-1' } })).resolves.toEqual({ items: [] });
    expect(tracking.heart).toHaveBeenCalledWith('user-1', expect.objectContaining({ externalProductId: 'product-1' }));
    expect(tracking.list).toHaveBeenCalledWith('user-1');
  });

  it('rejects a request without a session or with an invalid body', async () => {
    const controller = subject();
    await expect(controller.heart({}, {})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.heart({ user: { id: 'user-1' } }, null)).rejects.toBeInstanceOf(BadRequestException);
    expect(tracking.heart).not.toHaveBeenCalled();
  });

  it('passes the subscription id and authenticated user to unheart', async () => {
    await expect(subject().unheart({ user: { id: 'user-1' } }, 'subscription-1')).resolves.toEqual({ status: 'untracked' });
    expect(tracking.unheart).toHaveBeenCalledWith('user-1', 'subscription-1');
  });

  it('passes the subscription id and authenticated user to history', async () => {
    await expect(subject().history({ user: { id: 'user-1' } }, 'subscription-1')).resolves.toEqual({ items: [] });
    expect(tracking.history).toHaveBeenCalledWith('user-1', 'subscription-1');
    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('tracking:history:user:'), 60);
  });

  it('returns 429 and skips the service when tracking reads exceed the limit', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(31);

    await subject().list({ user: { id: 'user-1' } }).then(
      () => { throw new Error('expected a rate-limit rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    );
    expect(tracking.list).not.toHaveBeenCalled();
  });
});
