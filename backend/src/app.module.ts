import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { SilpoModule } from './silpo/silpo.module';
import { UserController } from './user/user.controller';
import { TrackingModule } from './tracking/tracking.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot(), AuthModule, SilpoModule, TrackingModule, TelegramModule],
  controllers: [HealthController, UserController]
})
export class AppModule {}
