import { Controller, HttpException, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { SilpoBenefitsDiscoveryService, type BenefitDiscoveryReport, type PersonalBenefitsReport } from './silpo-benefits-discovery.service';

type RequestLike = { user?: { id: string } };

@Controller('silpo/benefits')
export class SilpoBenefitsDiscoveryController {
  constructor(
    private readonly discovery: SilpoBenefitsDiscoveryService,
    private readonly sessions: SessionService
  ) {}

  @Post('discovery')
  @UseGuards(SessionGuard, CsrfGuard)
  async discover(@Req() request: RequestLike): Promise<BenefitDiscoveryReport> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:benefits-discovery:user:${hash(userId)}`, 60) > 3) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.discovery.discover(userId);
  }

  @Post('personal')
  @UseGuards(SessionGuard, CsrfGuard)
  async listPersonalBenefits(@Req() request: RequestLike): Promise<PersonalBenefitsReport> {
    const userId = request.user?.id;
    if (!userId) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:personal-benefits:user:${hash(userId)}`, 60) > 3) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.discovery.listPersonalBenefits(userId);
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
