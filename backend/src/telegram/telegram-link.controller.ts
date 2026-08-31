import { Controller, HttpException, HttpStatus, Optional, Post, Req, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { TelegramLinkService } from './telegram-link.service';

type RequestLike = { user?: { id: string } };
type Queryable = { query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };

@Controller('telegram/link')
export class TelegramLinkController {
  constructor(
    private readonly link: TelegramLinkService,
    private readonly sessions: SessionService,
    @Optional() private readonly pool: Queryable = new Pool({ connectionString: process.env.DATABASE_URL })
  ) {}

  @Post('start')
  @UseGuards(SessionGuard, CsrfGuard)
  async start(@Req() request: RequestLike): Promise<{ deepLink: string }> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`telegram:link:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.pool.query<{ telegramUserId: string | null }>('SELECT "telegramUserId" FROM "User" WHERE id = $1', [userId]);
    // 401 (not 409) for "already connected" is an explicit plan.md decision
    // (accepted decisions section), not an oversight.
    if (user.rows[0]?.telegramUserId) throw new UnauthorizedException('Telegram is already connected');

    const username = process.env.TELEGRAM_BOT_USERNAME;
    if (!username) throw new ServiceUnavailableException('TELEGRAM_BOT_USERNAME is required');

    const rawToken = await this.link.createLink(userId);
    return { deepLink: `https://t.me/${username.replace(/^@/, '')}?start=link_${rawToken}` };
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
