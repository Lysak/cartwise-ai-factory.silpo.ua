import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SilpoModule } from '../silpo/silpo.module';
import { TrackingController } from './tracking.controller';
import { NotificationsController } from './notifications.controller';
import { PricePollerService } from './price-poller.service';
import { TelegramNotificationService } from './telegram-notification.service';
import { TrackingService } from './tracking.service';

@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => SilpoModule)],
  controllers: [TrackingController, NotificationsController],
  providers: [TrackingService, PricePollerService, TelegramNotificationService],
  exports: [TrackingService, TelegramNotificationService]
})
export class TrackingModule {}
