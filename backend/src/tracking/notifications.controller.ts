import { BadRequestException, Controller, Get, HttpException, HttpStatus, Optional, Param, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { TrackingService, type NotificationItem } from './tracking.service';

type RequestLike = { user?: { id: string } };

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly tracking: TrackingService,
    @Optional() private readonly sessions?: SessionService
  ) {}

  @Get()
  @UseGuards(SessionGuard)
  async list(@Req() request: RequestLike): Promise<{ items: NotificationItem[] }> {
    const userId = this.userId(request);
    await this.rateLimit(userId, 'list');
    return this.tracking.notifications(userId);
  }

  @Post(':id/read')
  @UseGuards(SessionGuard, CsrfGuard)
  async read(@Req() request: RequestLike, @Param('id') id: string): Promise<{ status: 'read' }> {
    const userId = this.userId(request);
    if (!validId(id)) throw new BadRequestException('Invalid notification id');
    await this.rateLimit(userId, 'read');
    return this.tracking.readNotification(userId, id);
  }

  private userId(request: RequestLike): string {
    if (!request.user?.id) throw new UnauthorizedException();
    return request.user.id;
  }

  private async rateLimit(userId: string, action: string): Promise<void> {
    if (this.sessions && await this.sessions.incrementRateLimit(`notifications:${action}:user:${hash(userId)}`, 60) > 30) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\s/]/.test(value);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
