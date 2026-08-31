import { BadGatewayException, BadRequestException, Controller, Get, HttpException, HttpStatus, Param, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { TrackingService } from '../tracking/tracking.service';
import { SilpoProductService, type ListBranchesResponse } from './silpo-product.service';

type RequestLike = { user?: { id: string } };
type BranchesQuery = { limit?: string; offset?: string; hasPickup?: string; q?: string };
type ProductsQuery = { q?: string; limit?: string };

@Controller('silpo')
export class SilpoProductController {
  constructor(
    private readonly products: SilpoProductService,
    private readonly sessions: SessionService,
    private readonly tracking: TrackingService
  ) {}

  @Get('branches')
  @UseGuards(SessionGuard)
  async branches(@Req() request: RequestLike, @Query() query: BranchesQuery): Promise<ListBranchesResponse> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:branches:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (query.q !== undefined) {
      return this.products.listBranches(userId, { limit: 500, offset: 0, q: query.q, hasPickup: query.hasPickup === 'true' });
    }
    return this.products.listBranches(userId, {
      limit: toInt(query.limit),
      offset: toInt(query.offset),
      hasPickup: query.hasPickup === 'true'
    });
  }

  @Get('products')
  @UseGuards(SessionGuard)
  async search(@Req() request: RequestLike, @Query() query: ProductsQuery): Promise<unknown> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:products:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (typeof query.q !== 'string' || !query.q.trim()) throw new BadRequestException('Invalid product query');
    return this.safeRead(() => this.products.searchProducts(userId, { q: query.q, limit: toInt(query.limit) }));
  }

  @Get('products/:slug')
  @UseGuards(SessionGuard)
  async detail(@Req() request: RequestLike, @Param('slug') slug: string): Promise<unknown> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:products:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!validSlug(slug)) throw new BadRequestException('Invalid product slug');
    return this.safeRead(async () => {
      const detail = await this.products.getProductDetails(userId, slug);
      const trackingId = detail.product.externalProductId
        ? await this.tracking.findSubscriptionId(userId, detail.product.externalProductId)
        : null;
      if (trackingId && typeof detail.product.image === 'string') {
        await this.tracking.updateImageUrl(userId, trackingId, detail.product.image).catch(() => undefined);
      }
      if (trackingId && typeof detail.product.price === 'number') {
        await this.tracking.backfillInitialPrice(userId, trackingId, detail.product.price).catch(() => undefined);
      }
      return { ...detail, trackingId };
    });
  }

  private async safeRead<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadGatewayException('Silpo products unavailable');
    }
  }
}

const toInt = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const validSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s/]/.test(value);
