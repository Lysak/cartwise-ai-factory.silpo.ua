import { BadRequestException, Body, Controller, Delete, Get, HttpException, HttpStatus, Optional, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { TrackingService, type HistoryItem, type TrackingItem } from './tracking.service';

type RequestLike = { user?: { id: string } };

@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly tracking: TrackingService,
    @Optional() private readonly sessions?: SessionService
  ) {}

  @Post()
  @UseGuards(SessionGuard, CsrfGuard)
  async heart(@Req() request: RequestLike, @Body() body: unknown): Promise<TrackingItem> {
    const userId = this.userId(request);
    if (!isBody(body)) throw new BadRequestException('Invalid product');
    await this.rateLimit(userId, 'heart');
    return this.tracking.heart(userId, body);
  }

  @Delete(':id')
  @UseGuards(SessionGuard, CsrfGuard)
  async unheart(@Req() request: RequestLike, @Param('id') id: string): Promise<{ status: 'untracked' }> {
    const userId = this.userId(request);
    await this.rateLimit(userId, 'unheart');
    return this.tracking.unheart(userId, id);
  }

  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() request: RequestLike): Promise<{ items: TrackingItem[] }> {
    const userId = this.userId(request);
    await this.rateLimit(userId, 'list');
    return this.tracking.list(userId);
  }

  @Get(':id/history')
  @UseGuards(SessionGuard)
  async history(@Req() request: RequestLike, @Param('id') id: string): Promise<{ items: HistoryItem[] }> {
    const userId = this.userId(request);
    await this.rateLimit(userId, 'history');
    return this.tracking.history(userId, id);
  }

  private userId(request: RequestLike): string {
    if (!request.user?.id) throw new UnauthorizedException();
    return request.user.id;
  }

  private async rateLimit(userId: string, action: string): Promise<void> {
    if (this.sessions && await this.sessions.incrementRateLimit(`tracking:${action}:user:${hash(userId)}`, 60) > 30) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

const isBody = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
