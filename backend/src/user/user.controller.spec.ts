import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import type { StoreContextService } from '../catalog/store-context.service';
import { UserController } from './user.controller';

const context = { setPreferredBranch: jest.fn().mockResolvedValue({ silpoBranchId: 'branch-1' }) };
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };
const subject = () => new UserController(
  context as unknown as StoreContextService,
  sessions as unknown as SessionService
);

describe('UserController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is protected by the existing session and CSRF guards', () => {
    const guards = Reflect.getMetadata('__guards__', UserController.prototype.branch) ?? [];
    expect(guards).toEqual(expect.arrayContaining([SessionGuard, CsrfGuard]));
  });

  it('writes the selected branch for the authenticated user', async () => {
    await expect(subject().branch(
      { user: { id: 'user-1' } },
      { silpoBranchId: 'branch-1' }
    )).resolves.toEqual({ silpoBranchId: 'branch-1' });

    expect(context.setPreferredBranch).toHaveBeenCalledWith('user-1', 'branch-1');
  });

  it('returns 429 before writing when the per-user rate limit is exceeded', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);

    await expect(subject().branch(
      { user: { id: 'user-1' } },
      { silpoBranchId: 'branch-1' }
    )).rejects.toMatchObject({ status: 429 });

    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('user:branch:user:'), 60);
    expect(context.setPreferredBranch).not.toHaveBeenCalled();
  });

  it('rejects missing sessions and malformed bodies with generic errors', async () => {
    const controller = subject();

    await expect(controller.branch({}, { silpoBranchId: 'branch-1' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.branch({ user: { id: 'user-1' } }, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.branch({ user: { id: 'user-1' } }, { silpoBranchId: 1 })).rejects.toBeInstanceOf(BadRequestException);
    expect(context.setPreferredBranch).not.toHaveBeenCalled();
  });
});
