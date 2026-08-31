import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { sessionCookieName, SessionService } from './session.service';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      cookies?: Record<string, string>;
      user?: { id: string; telegramUserId: string | null };
    }>();
    const id = request.cookies?.[sessionCookieName()];
    if (!id) throw new UnauthorizedException();

    try {
      const session = await this.sessions.resolve(id);
      if (!session) throw new UnauthorizedException();
      request.user = { id: session.userId, telegramUserId: session.telegramUserId };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
