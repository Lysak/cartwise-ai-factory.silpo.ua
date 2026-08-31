import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { SilpoModule } from './silpo/silpo.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot(), AuthModule, SilpoModule],
  controllers: [HealthController]
})
export class AppModule {}
