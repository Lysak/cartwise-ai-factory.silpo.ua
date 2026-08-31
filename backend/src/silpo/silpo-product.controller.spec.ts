import { BadRequestException, ConflictException, HttpException, UnauthorizedException } from '@nestjs/common';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import { SilpoProductController } from './silpo-product.controller';
import type { SilpoProductService } from './silpo-product.service';
import type { TrackingService } from '../tracking/tracking.service';

const products = { listBranches: jest.fn(), searchProducts: jest.fn(), getProductDetails: jest.fn() };
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };
const tracking = {
  findSubscriptionId: jest.fn().mockResolvedValue('subscription-1'),
  updateImageUrl: jest.fn().mockResolvedValue(undefined),
  backfillInitialPrice: jest.fn().mockResolvedValue(undefined)
};

const subject = () =>
  new (SilpoProductController as unknown as new (
    products: SilpoProductService,
    sessions: SessionService,
    tracking: TrackingService
  ) => SilpoProductController)(
    products as unknown as SilpoProductService,
    sessions as unknown as SessionService,
    tracking as unknown as TrackingService
  );

describe('SilpoProductController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    products.listBranches.mockResolvedValue({ branches: [{ silpoBranchId: 'b-1', name: 'Silpo Center' }], nextOffset: null });
    products.searchProducts.mockResolvedValue({ products: [{ slug: 'milk-1', name: 'Milk' }] });
    products.getProductDetails.mockResolvedValue({ product: { slug: 'milk-1', name: 'Milk', externalProductId: 'product-1' }, attributes: {} });
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

  it('uses the cached full branch list for in-memory token filtering', async () => {
    await subject().branches({ user: { id: 'user-1' } }, { q: 'Kyiv main' });

    expect(products.listBranches).toHaveBeenCalledWith('user-1', { limit: 500, offset: 0, q: 'Kyiv main', hasPickup: false });
  });

  it('retains pickup filtering while token-filtering branches', async () => {
    await subject().branches({ user: { id: 'user-1' } }, { q: 'Kyiv', hasPickup: 'true' });

    expect(products.listBranches).toHaveBeenCalledWith('user-1', { limit: 500, offset: 0, q: 'Kyiv', hasPickup: true });
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

  it('protects product search and passes the authenticated user and query to the service', async () => {
    const controller = subject();
    const guards = Reflect.getMetadata('__guards__', SilpoProductController.prototype.search) ?? [];
    expect(guards).toContain(SessionGuard);

    await expect(controller.search({ user: { id: 'user-1' } }, { q: ' milk ', limit: '200' })).resolves.toEqual({
      products: [{ slug: 'milk-1', name: 'Milk' }]
    });
    expect(products.searchProducts).toHaveBeenCalledWith('user-1', { q: ' milk ', limit: 200 });
    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('silpo:products:user:'), 60);
  });

  it('rejects product search without a query or authenticated user', async () => {
    const controller = subject();
    await expect(controller.search({ user: { id: 'user-1' } }, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.search({}, { q: 'milk' })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(products.searchProducts).not.toHaveBeenCalled();
  });

  it('returns 429 before product search after the per-user limit', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);

    await expect(subject().search({ user: { id: 'user-1' } }, { q: 'milk' })).rejects.toMatchObject({
      status: 429
    });
    expect(products.searchProducts).not.toHaveBeenCalled();
  });

  it('protects detail reads, validates slug, and preserves reauth conflicts', async () => {
    const controller = subject();
    const guards = Reflect.getMetadata('__guards__', SilpoProductController.prototype.detail) ?? [];
    expect(guards).toContain(SessionGuard);

    await expect(controller.detail({ user: { id: 'user-1' } }, 'milk-1')).resolves.toEqual({
      product: { slug: 'milk-1', name: 'Milk', externalProductId: 'product-1' }, attributes: {}, trackingId: 'subscription-1'
    });
    expect(products.getProductDetails).toHaveBeenCalledWith('user-1', 'milk-1');
    expect(tracking.findSubscriptionId).toHaveBeenCalledWith('user-1', 'product-1');

    await expect(controller.detail({ user: { id: 'user-1' } }, 'bad slug!')).rejects.toBeInstanceOf(BadRequestException);
    products.getProductDetails.mockRejectedValueOnce(new ConflictException({ code: 'SILPO_REAUTH_REQUIRED' }));
    await expect(controller.detail({ user: { id: 'user-1' } }, 'milk-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('backfills an existing tracked item image from the already-loaded product detail', async () => {
    products.getProductDetails.mockResolvedValueOnce({
      product: { slug: 'milk-1', name: 'Milk', externalProductId: 'product-1', image: 'https://img.test/milk.jpg' }, attributes: {}
    });

    await subject().detail({ user: { id: 'user-1' } }, 'milk-1');

    expect(tracking.updateImageUrl).toHaveBeenCalledWith('user-1', 'subscription-1', 'https://img.test/milk.jpg');
  });

  it('backfills an existing tracked item price from the already-loaded product detail', async () => {
    products.getProductDetails.mockResolvedValueOnce({
      product: { slug: 'milk-1', name: 'Milk', externalProductId: 'product-1', price: 58.49 }, attributes: {}
    });

    await subject().detail({ user: { id: 'user-1' } }, 'milk-1');

    expect(tracking.backfillInitialPrice).toHaveBeenCalledWith('user-1', 'subscription-1', 58.49);
  });

  it('converts unexpected provider failures to a generic 502', async () => {
    products.getProductDetails.mockRejectedValueOnce(new Error('raw provider secret'));

    try {
      await subject().detail({ user: { id: 'user-1' } }, 'milk-1');
      throw new Error('expected a provider failure');
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(502);
      expect(JSON.stringify((error as HttpException).getResponse())).not.toContain('raw provider secret');
    }
  });
});
