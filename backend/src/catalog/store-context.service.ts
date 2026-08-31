import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { SilpoProductService } from '../silpo/silpo-product.service';

type Queryable = { query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };

export type StoreContext = {
  branchId: string;
  deliveryType: 'SelfPickup';
  timeslotStart: string;
  timeslotEnd: string;
};

@Injectable()
export class StoreContextService {
  constructor(
    private readonly products: SilpoProductService,
    @Optional() private readonly pool: Queryable = new Pool({ connectionString: process.env.DATABASE_URL })
  ) {}

  async setPreferredBranch(userId: string, silpoBranchId: unknown): Promise<{ silpoBranchId: string }> {
    if (typeof silpoBranchId !== 'string' || !silpoBranchId) throw new BadRequestException('Invalid branch');

    const available = await this.products.listBranches(userId, { limit: 500, offset: 0 });
    if (!available.branches.some((branch) => branch.silpoBranchId === silpoBranchId)) {
      throw new BadRequestException('Invalid branch');
    }

    await this.pool.query(
      'UPDATE "User" SET "preferredSilpoBranchId" = $1, "updatedAt" = NOW() WHERE id = $2',
      [silpoBranchId, userId]
    );
    return { silpoBranchId };
  }

  async resolveStoreContext(userId: string): Promise<StoreContext> {
    const result = await this.pool.query<{ preferredSilpoBranchId: string | null }>(
      'SELECT "preferredSilpoBranchId" FROM "User" WHERE id = $1',
      [userId]
    );
    const branchId = result.rows[0]?.preferredSilpoBranchId;
    if (!branchId) throw new ConflictException({ code: 'BRANCH_REQUIRED', message: 'Store branch required' });

    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(12, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    // ponytail: fixed future SelfPickup window; use real slots only if MCP starts returning them reliably.
    return { branchId, deliveryType: 'SelfPickup', timeslotStart: start.toISOString(), timeslotEnd: end.toISOString() };
  }
}
