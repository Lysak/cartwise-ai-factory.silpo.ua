import { BadRequestException, HttpException, UnauthorizedException } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import { NotificationsController } from './notifications.controller';
import type { TrackingService } from './tracking.service';

const tracking = {
  notifications: jest.fn().mockResolvedValue({ items: [] }),
  readNotification: jest.fn().mockResolvedValue({ status: 'read' })
};
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };
const subject = () => new NotificationsController(
  tracking as unknown as TrackingService,
  sessions as unknown as SessionService
);

beforeEach(() => jest.clearAllMocks());

describe('NotificationsController', () => {
  it('protects notification reads with session and CSRF guards', () => {
    expect(Reflect.getMetadata('__guards__', NotificationsController.prototype.list)).toContain(SessionGuard);
    expect(Reflect.getMetadata('__guards__', NotificationsController.prototype.read)).toEqual(
      expect.arrayContaining([SessionGuard, CsrfGuard])
    );
  });

  it('passes only the authenticated user and applies per-user rate limits', async () => {
    await expect(subject().list({ user: { id: 'user-1' } })).resolves.toEqual({ items: [] });
    await expect(subject().read({ user: { id: 'user-1' } }, 'event-1')).resolves.toEqual({ status: 'read' });

    expect(tracking.notifications).toHaveBeenCalledWith('user-1');
    expect(tracking.readNotification).toHaveBeenCalledWith('user-1', 'event-1');
    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('notifications:list:user:'), 60);
    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('notifications:read:user:'), 60);
  });

  it('rejects requests without an authenticated user', async () => {
    const controller = subject();
    await expect(controller.list({})).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.read({ user: { id: '' } }, 'event-1')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tracking.notifications).not.toHaveBeenCalled();
    expect(tracking.readNotification).not.toHaveBeenCalled();
  });

  it('rejects malformed notification ids before calling the service', async () => {
    const controller = subject();
    await expect(controller.read({ user: { id: 'user-1' } }, '')).rejects.toBeInstanceOf(BadRequestException);
    expect(tracking.readNotification).not.toHaveBeenCalled();
  });

  it('returns 429 and skips the service when notification reads exceed the limit', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(31);

    await subject().list({ user: { id: 'user-1' } }).then(
      () => { throw new Error('expected a rate-limit rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    );
    expect(tracking.notifications).not.toHaveBeenCalled();
  });
});
