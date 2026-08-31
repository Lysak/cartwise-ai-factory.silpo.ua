import { Body, Controller, Get, HttpException, HttpStatus, Optional, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { Response } from 'express';
import { SilpoOauthService } from '../silpo/silpo-oauth.service';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';
import { sessionCookieName, sessionCookieOptions, SessionService } from './session.service';
import { TelegramInitDataService } from './telegram-init-data.service';

type SilpoStatus = 'active' | 'reauth_required' | 'missing';
type RequestLike = { ip?: string; cookies?: Record<string, string>; user?: { id: string } };
type Queryable = { query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };

export type BootstrapResponse =
  | { status: 'authenticated'; csrfToken: string; silpoStatus: SilpoStatus }
  | { status: 'oauth_required'; authorizationUrl: string };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionService,
    private readonly telegram: TelegramInitDataService,
    private readonly oauth: SilpoOauthService,
    @Optional() private readonly pool: Queryable = new Pool({ connectionString: process.env.DATABASE_URL })
  ) {}

  @Post('telegram/bootstrap')
  async bootstrap(@Body() raw: unknown, @Req() request: RequestLike, @Res({ passthrough: true }) response: Response): Promise<BootstrapResponse> {
    if (typeof raw !== 'string') throw new UnauthorizedException();
    await this.requireRateLimit(`telegram:ip:${hash(request.ip ?? '')}`);
    const verified = this.telegram.validate(raw);
    await this.requireRateLimit(`telegram:user:${hash(verified.telegramUserId)}`);

    const currentId = request.cookies?.[sessionCookieName()];
    if (currentId) {
      const session = await this.sessions.resolve(currentId);
      if (session?.telegramUserId === verified.telegramUserId) {
        return { status: 'authenticated', csrfToken: session.csrfSecret, silpoStatus: await this.silpoStatus(session.userId) };
      }
      if (session) await this.sessions.destroy(currentId);
    }

    const user = await this.pool.query<{ id: string; status: SilpoStatus | null }>(
      'SELECT "User".id, "SilpoConnection".status FROM "User" LEFT JOIN "SilpoConnection" ON "SilpoConnection"."userId" = "User".id WHERE "User"."telegramUserId" = $1',
      [verified.telegramUserId]
    );
    const existing = user.rows[0];
    if (!existing) return { status: 'oauth_required', authorizationUrl: await this.oauth.createFirstAuthorization(verified) };

    const session = await this.sessions.create({ userId: existing.id, telegramUserId: verified.telegramUserId });
    response.cookie(sessionCookieName(), session.id, sessionCookieOptions());
    return { status: 'authenticated', csrfToken: session.csrfToken, silpoStatus: normalizeSilpoStatus(existing.status) };
  }

  @Get('session')
  @UseGuards(SessionGuard)
  async session(@Req() request: RequestLike): Promise<Extract<BootstrapResponse, { status: 'authenticated' }>> {
    const id = request.cookies?.[sessionCookieName()];
    if (!id) throw new UnauthorizedException();
    const session = await this.sessions.resolve(id);
    if (!session) throw new UnauthorizedException();
    return { status: 'authenticated', csrfToken: session.csrfSecret, silpoStatus: await this.silpoStatus(session.userId) };
  }

  @Post('logout')
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(@Req() request: RequestLike, @Res({ passthrough: true }) response: Response): Promise<{ status: 'logged_out' }> {
    const id = request.cookies?.[sessionCookieName()];
    if (!id) throw new UnauthorizedException();
    await this.sessions.destroy(id);
    await this.pool.query('DELETE FROM "OAuthState" WHERE "initiatingSessionHash" = $1', [sessionHash(id)]);
    response.clearCookie(sessionCookieName(), { ...sessionCookieOptions(), maxAge: 0 });
    return { status: 'logged_out' };
  }

  private async requireRateLimit(key: string): Promise<void> {
    if (await this.sessions.incrementRateLimit(key, 60) > 10) throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async silpoStatus(userId: string): Promise<SilpoStatus> {
    const connection = await this.pool.query<{ status: SilpoStatus | null }>('SELECT status FROM "SilpoConnection" WHERE "userId" = $1', [userId]);
    return normalizeSilpoStatus(connection.rows[0]?.status);
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const sessionHash = (value: string): string => createHash('sha256').update(value).digest('base64url');
const normalizeSilpoStatus = (status: SilpoStatus | null | undefined): SilpoStatus =>
  status === 'active' || status === 'reauth_required' ? status : 'missing';
