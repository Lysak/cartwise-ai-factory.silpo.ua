import { ConflictException, BadRequestException } from '@nestjs/common';
import type { SilpoProductService } from '../silpo/silpo-product.service';
import { StoreContextService } from './store-context.service';

const branches = [{
  silpoBranchId: 'branch-1',
  externalId: '100',
  city: 'Kyiv',
  address: 'Main street 1',
  latitude: null,
  longitude: null,
  hasPickup: true
}];

const subject = (preferredSilpoBranchId: string | null = 'branch-1') => {
  const products = { listBranches: jest.fn().mockResolvedValue({ branches, nextOffset: null }) };
  const pool = {
    query: jest.fn().mockResolvedValue({ rows: [{ preferredSilpoBranchId }] })
  };
  return {
    service: new StoreContextService(products as unknown as SilpoProductService, pool),
    products,
    pool
  };
};

describe('StoreContextService', () => {
  it('rejects an unknown branch ID', async () => {
    const { service } = subject();

    await expect(service.setPreferredBranch('user-1', 'missing')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string branch ID', async () => {
    const { service } = subject();

    await expect(service.setPreferredBranch('user-1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('persists a branch only after validating the sanitized list', async () => {
    const { service, products, pool } = subject();

    await expect(service.setPreferredBranch('user-1', 'branch-1')).resolves.toEqual({ silpoBranchId: 'branch-1' });
    expect(products.listBranches).toHaveBeenCalledWith('user-1', { limit: 500, offset: 0 });
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE "User" SET "preferredSilpoBranchId" = $1, "updatedAt" = NOW() WHERE id = $2',
      ['branch-1', 'user-1']
    );
  });

  it('rejects context resolution without a selected branch', async () => {
    const { service } = subject(null);

    await expect(service.resolveStoreContext('user-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a future SelfPickup window exactly 30 minutes long', async () => {
    const { service } = subject();
    const now = Date.now();

    const context = await service.resolveStoreContext('user-1');

    expect(context.branchId).toBe('branch-1');
    expect(context.deliveryType).toBe('SelfPickup');
    expect(new Date(context.timeslotStart).getTime()).toBeGreaterThan(now);
    expect(new Date(context.timeslotEnd).getTime() - new Date(context.timeslotStart).getTime()).toBe(30 * 60 * 1000);
  });
});
