import { Controller, Get, HttpException, HttpStatus, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { SilpoProductService, type ListBranchesResponse } from './silpo-product.service';

type RequestLike = { user?: { id: string } };
type BranchesQuery = { limit?: string; offset?: string; hasPickup?: string };

@Controller('silpo')
export class SilpoProductController {
  constructor(
    private readonly products: SilpoProductService,
    private readonly sessions: SessionService
  ) {}

  @Get('branches')
  @UseGuards(SessionGuard)
  async branches(@Req() request: RequestLike, @Query() query: BranchesQuery): Promise<ListBranchesResponse> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:branches:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.products.listBranches(userId, {
      limit: toInt(query.limit),
      offset: toInt(query.offset),
      hasPickup: query.hasPickup === 'true'
    });
  }
}

const toInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
