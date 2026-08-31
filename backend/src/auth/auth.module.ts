import { forwardRef, MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import * as express from 'express';
import { CsrfGuard } from './csrf.guard';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { AuthController } from './auth.controller';
import { TelegramInitDataService } from './telegram-init-data.service';
import { SilpoModule } from '../silpo/silpo.module';

@Module({
  imports: [forwardRef(() => SilpoModule)],
  controllers: [AuthController],
  providers: [SessionService, SessionGuard, CsrfGuard, TelegramInitDataService],
  exports: [SessionService, SessionGuard, CsrfGuard]
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(express.text({ type: 'text/plain', limit: '8kb' })).forRoutes({
      path: 'auth/telegram/bootstrap',
      method: RequestMethod.POST
    });
  }
}
