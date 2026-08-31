import { HttpException, UnauthorizedException } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import { SilpoProductController } from './silpo-product.controller';
import type { SilpoProductService } from './silpo-product.service';

const products = { listBranches: jest.fn() };
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };

const subject = () =>
  new SilpoProductController(
    products as unknown as SilpoProductService,
    sessions as unknown as SessionService
  );

describe('SilpoProductController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    products.listBranches.mockResolvedValue({ branches: [{ silpoBranchId: 'b-1', name: 'Silpo Center' }], nextOffset: null });
  });

  it('is protected by SessionGuard', () => {
    const guards = Reflect.getMetadata('__guards__', SilpoProductController.prototype.branches) ?? [];
    expect(guards).toContain(SessionGuard);
  });

  it('returns the sanitized service response for an authenticated user', async () => {
    const result = await subject().branches({ user: { id: 'user-1' } }, {});

    expect(result).toEqual({ branches: [{ silpoBranchId: 'b-1', name: 'Silpo Center' }], nextOffset: null });
    expect(products.listBranches).toHaveBeenCalledWith('user-1', { limit: undefined, offset: undefined, hasPickup: false });
    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('silpo:branches:user:'), 60);
  });

  it('parses limit, offset and hasPickup from the query string', async () => {
    await subject().branches({ user: { id: 'user-1' } }, { limit: '10', offset: '20', hasPickup: 'true' });

    expect(products.listBranches).toHaveBeenCalledWith('user-1', { limit: 10, offset: 20, hasPickup: true });
  });

  it('rejects a request without a resolved user', async () => {
    await expect(subject().branches({}, {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns 429 past the per-user rate limit', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);

    try {
      await subject().branches({ user: { id: 'user-1' } }, {});
      throw new Error('expected a rate-limit rejection');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
    }
    expect(products.listBranches).not.toHaveBeenCalled();
  });

  it('never returns a token or raw envelope in the body', async () => {
    products.listBranches.mockResolvedValue({ branches: [{ silpoBranchId: 'b-1', name: 'Silpo Center' }], nextOffset: null });

    const serialized = JSON.stringify(await subject().branches({ user: { id: 'user-1' } }, {}));

    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('jsonrpc');
    expect(serialized).not.toContain('silpoExternalId');
  });
});
