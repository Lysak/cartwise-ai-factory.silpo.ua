import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { sessionCookieName, SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string>;
    }>();
    if (SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin;
    const token = request.headers['x-csrf-token'];
    const id = request.cookies?.[sessionCookieName()];
    if (typeof origin !== 'string' || origin !== process.env.APP_ORIGIN || typeof token !== 'string' || !id) {
      throw new ForbiddenException();
    }

    try {
      const session = await this.sessions.resolve(id);
      const actual = Buffer.from(token);
      const expected = Buffer.from(session?.csrfSecret ?? '');
      if (!session || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ForbiddenException();
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ForbiddenException();
    }
  }
}
