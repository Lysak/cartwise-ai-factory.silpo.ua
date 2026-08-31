import { BadRequestException, Body, Controller, HttpException, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { StoreContextService } from '../catalog/store-context.service';

type RequestLike = { user?: { id: string } };

@Controller('user')
export class UserController {
  constructor(
    private readonly context: StoreContextService,
    private readonly sessions: SessionService
  ) {}

  @Post('branch')
  @UseGuards(SessionGuard, CsrfGuard)
  async branch(@Req() request: RequestLike, @Body() body: unknown): Promise<{ silpoBranchId: string }> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`user:branch:user:${hash(userId)}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (typeof body !== 'object' || body === null || !('silpoBranchId' in body) ||
      typeof (body as { silpoBranchId?: unknown }).silpoBranchId !== 'string' ||
      !(body as { silpoBranchId: string }).silpoBranchId) {
      throw new BadRequestException('Invalid branch');
    }
    return this.context.setPreferredBranch(userId, (body as { silpoBranchId?: unknown }).silpoBranchId);
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
